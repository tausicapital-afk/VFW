import { Global, Injectable, Module } from '@nestjs/common';
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
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
