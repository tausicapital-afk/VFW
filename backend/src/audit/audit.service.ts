import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Append-only. There is deliberately no update() and no delete() on this
 * service — the UI promises "nothing on this record is ever deleted" and
 * Accounting relies on that when they reconcile.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pass `tx` when the audit entry must land in the same transaction as the
   * change it describes. An approval that commits without its audit row, or an
   * audit row without its approval, is worse than either failing outright.
   */
  async log(
    entry: {
      submissionId?: string;
      actorId?: string;
      action: string;
      detail?: string;
      payload?: Prisma.InputJsonValue;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.auditEntry.create({ data: entry });
  }

  async forSubmission(submissionId: string) {
    return this.prisma.auditEntry.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, name: true, role: true } } },
    });
  }

  /**
   * The global trail: every entry ever written, newest first, filtered and
   * paged. Read-only — there is no counterpart to this that edits or removes a
   * row, and there never will be, not even for an admin. The count is returned
   * alongside the page so the UI can say how many events exist in total.
   */
  /**
   * The filter, built once. The export reads the same trail through the same
   * predicate as the screen — a second copy of this would be a file that quietly
   * disagreed with the table it was pulled from the first time either changed.
   */
  private whereFor(filter: AuditFilter): Prisma.AuditEntryWhereInput {
    const where: Prisma.AuditEntryWhereInput = {};
    if (filter.action) where.action = filter.action;
    if (filter.submissionId) where.submissionId = filter.submissionId;
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: new Date(filter.from) } : {}),
        // An inclusive "to" date means the whole of that day.
        ...(filter.to ? { lt: new Date(new Date(filter.to).getTime() + 86_400_000) } : {}),
      };
    }
    const q = filter.q?.trim();
    if (q) {
      where.OR = [
        { action: { contains: q, mode: 'insensitive' } },
        { detail: { contains: q, mode: 'insensitive' } },
        { actor: { name: { contains: q, mode: 'insensitive' } } },
        { submission: { ref: { contains: q, mode: 'insensitive' } } },
        { submission: { contact: { brand: { contains: q, mode: 'insensitive' } } } },
      ];
    }
    return where;
  }

  /**
   * The same trail as search(), unpaged, for an export.
   *
   * `limit` is the caller's ceiling plus one: the export refuses a file it would
   * have to truncate, and it can only tell it is over the line if the query is
   * allowed to return one row past it. Nothing here loads the whole table.
   */
  async searchAll(filter: AuditFilter, limit: number) {
    return this.prisma.auditEntry.findMany({
      where: this.whereFor(filter),
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: { id: true, name: true, role: true } },
        submission: {
          select: { id: true, ref: true, contact: { select: { brand: true } } },
        },
      },
    });
  }

  async search(filter: AuditFilter) {
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const where = this.whereFor(filter);

    const [total, entries] = await this.prisma.$transaction([
      this.prisma.auditEntry.count({ where }),
      this.prisma.auditEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          actor: { select: { id: true, name: true, role: true } },
          submission: {
            select: { id: true, ref: true, contact: { select: { brand: true } } },
          },
        },
      }),
    ]);

    return { total, limit, offset, entries };
  }

  /** The distinct actions on record, so the UI can offer them as a filter. */
  async actions(): Promise<string[]> {
    const rows = await this.prisma.auditEntry.groupBy({
      by: ['action'],
      orderBy: { action: 'asc' },
    });
    return rows.map((r) => r.action);
  }
}

export interface AuditFilter {
  q?: string;
  action?: string;
  submissionId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
