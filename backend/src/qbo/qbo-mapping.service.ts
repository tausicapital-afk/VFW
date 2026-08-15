import { BadRequestException, Injectable } from '@nestjs/common';
import { QboMappingKind } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { QboApiService } from './qbo-api.service';

/** The QBO entity each mapping kind is browsed and resolved against. */
const ENTITY: Record<QboMappingKind, string> = {
  TAX: 'TaxCode',
  GL: 'Account',
  // Intuit's "Location" tracking feature is exposed via the `Department`
  // entity and `DepartmentRef` in the Accounting API — a historical naming
  // that predates Locations, but it's what the invoice payload actually needs.
  DEPARTMENT: 'Department',
};

export interface QboBrowseOption {
  id: string;
  name: string;
  /** Account only: lets the admin screen tell an income account from an expense one. */
  subType?: string;
}

/**
 * The local-code -> QBO-object-id mappings an admin fills in once per code
 * (VFW's tax profiles, GL accounts, departments) so export can resolve a real
 * QuickBooks ref instead of guessing. See QboMapping in schema.prisma for why
 * this can't be inferred automatically.
 */
@Injectable()
export class QboMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly api: QboApiService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.qboMapping.findMany({ orderBy: [{ kind: 'asc' }, { localCode: 'asc' }] });
  }

  /** The live list of QBO objects for a kind, for the admin screen's picker. */
  async browse(kind: QboMappingKind): Promise<QboBrowseOption[]> {
    const entity = ENTITY[kind];
    const where = kind === 'GL' ? "Active = true AND AccountType != 'Accounts Receivable'" : 'Active = true';
    const rows = await this.api.query<{ Id: string; Name: string; AccountSubType?: string }>(entity, where);
    return rows.map((r) => ({ id: r.Id, name: r.Name, subType: r.AccountSubType }));
  }

  async set(kind: QboMappingKind, localCode: string, qboId: string, qboLabel: string, actor: AuthUser) {
    if (!localCode.trim() || !qboId.trim() || !qboLabel.trim()) {
      throw new BadRequestException('A mapping needs a local code and a QuickBooks object to point at.');
    }
    const mapping = await this.prisma.qboMapping.upsert({
      where: { kind_localCode: { kind, localCode } },
      create: { kind, localCode, qboId, qboLabel, updatedById: actor.id },
      update: { qboId, qboLabel, updatedById: actor.id },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'QBO_MAPPING_SET',
      detail: `Mapped ${kind} "${localCode}" to QuickBooks ${qboLabel}`,
      payload: { kind, localCode, qboId, qboLabel },
    });
    return mapping;
  }

  async remove(id: string, actor: AuthUser) {
    const mapping = await this.prisma.qboMapping.delete({ where: { id } });
    await this.audit.log({
      actorId: actor.id,
      action: 'QBO_MAPPING_REMOVED',
      detail: `Removed the ${mapping.kind} mapping for "${mapping.localCode}"`,
      payload: { kind: mapping.kind, localCode: mapping.localCode },
    });
    return mapping;
  }

  /** Throws with a message that tells the admin exactly what to go map. */
  async resolve(kind: QboMappingKind, localCode: string): Promise<string> {
    const mapping = await this.prisma.qboMapping.findUnique({ where: { kind_localCode: { kind, localCode } } });
    if (!mapping) {
      throw new BadRequestException(
        `"${localCode}" has no QuickBooks mapping yet. Map it under Administration → Configuration → QuickBooks before exporting.`,
      );
    }
    return mapping.qboId;
  }
}
