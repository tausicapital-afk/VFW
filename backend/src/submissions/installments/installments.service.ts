import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InstallmentStatus, Prisma, SubmissionStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../audit/audit.service';
import { AuthUser } from '../../common/auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmissionsService } from '../submissions.service';
import { MarkInstallmentDto, SetPlanDto } from './dto';

/** Money rounds to 2dp, half-up — the same convention as PricingService. */
const r2 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** The default a payment falls back to when neither the plan nor the sale says. */
const FALLBACK_METHOD = 'Bank Transfer / Wire';

/**
 * Payment plans: the schedule a client has agreed to pay a sale down by.
 *
 * Two rules carry this module:
 *
 *  1. **The pending instalments sum to the balance.** Enforced on every plan
 *     write. A schedule that does not add up to what is owed is not a plan, it
 *     is a guess, and Accounting would end up reconciling it by hand.
 *
 *  2. **Marking one done posts a real Payment.** The instalment does not hold a
 *     second, private opinion about how much has been paid — it puts its amount
 *     on the ledger and lets SubmissionsService.recomputeMoney derive the
 *     balance, exactly as a hand-entered payment does. That is what keeps rule 1
 *     self-maintaining: the balance falls by the same amount that just left the
 *     pending set.
 *
 * Undoing a mark does not delete the payment. It posts a reversing negative
 * entry alongside it, because the ledger is append-only evidence.
 */
@Injectable()
export class InstallmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly submissions: SubmissionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Row-scoped read of the parent sale. Goes through SubmissionsService.findOne
   * so a rep gets the same 404 they would get anywhere else rather than a 403
   * that confirms the record exists.
   */
  private async loadSale(submissionId: string, user: AuthUser) {
    const submission = await this.submissions.findOne(submissionId, user);
    if (submission.status === SubmissionStatus.REJECTED) {
      throw new BadRequestException('A rejected submission cannot carry a payment plan');
    }
    if (submission.status === SubmissionStatus.VOIDED) {
      throw new BadRequestException('A voided submission cannot carry a payment plan');
    }
    return submission;
  }

  async list(submissionId: string, user: AuthUser) {
    // The scope check is the point of this call — a rep must not be able to read
    // another rep's schedule by guessing a submission id.
    await this.submissions.findOne(submissionId, user);
    return this.prisma.installment.findMany({
      where: { submissionId },
      orderBy: { seq: 'asc' },
      include: { paidBy: { select: { id: true, name: true } } },
    });
  }

  /**
   * Replace the outstanding schedule. Instalments already marked paid are
   * untouched: they have money behind them and rewriting them would rewrite the
   * ledger's story. The lines sent here must cover the current balance exactly.
   */
  async setPlan(submissionId: string, dto: SetPlanDto, user: AuthUser) {
    const sale = await this.loadSale(submissionId, user);

    const balance = new Decimal(sale.balance.toString());
    if (balance.lte(0)) {
      throw new BadRequestException(
        'This sale has nothing left to schedule — its balance is already settled.',
      );
    }

    const lines = dto.installments.map((l) => ({ ...l, amount: r2(l.amount) }));
    const scheduled = lines.reduce<Decimal>((t, l) => t.plus(l.amount), new Decimal(0));
    if (!scheduled.equals(balance)) {
      const diff = scheduled.minus(balance);
      throw new BadRequestException(
        `The plan must add up to the outstanding balance of ${balance.toFixed(2)} ` +
          `${sale.currency}. These instalments total ${scheduled.toFixed(2)} — ` +
          `${diff.gt(0) ? diff.toFixed(2) + ' too much' : diff.abs().toFixed(2) + ' short'}.`,
      );
    }

    const existing = await this.prisma.installment.findMany({
      where: { submissionId },
      orderBy: { seq: 'asc' },
    });
    const paid = existing.filter((i) => i.status === InstallmentStatus.PAID);
    // New lines are numbered after every instalment that has already been paid,
    // so the sequence a customer has been quoted ("instalment 2 of 4") never
    // gets reused for a different amount.
    const firstSeq = paid.reduce((max, i) => Math.max(max, i.seq), 0) + 1;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.installment.deleteMany({
        where: { submissionId, status: InstallmentStatus.PENDING },
      });
      await tx.installment.createMany({
        data: lines.map((l, i) => ({
          submissionId,
          seq: firstSeq + i,
          label: l.label || null,
          dueDate: new Date(l.dueDate),
          amount: l.amount.toFixed(2),
          currency: sale.currency,
          method: l.method || sale.paymentMethod || null,
        })),
      });

      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'PLAN_SET',
          detail:
            `${lines.length} instalment${lines.length === 1 ? '' : 's'} totalling ` +
            `${scheduled.toFixed(2)} ${sale.currency}`,
          payload: {
            before: existing
              .filter((i) => i.status === InstallmentStatus.PENDING)
              .map((i) => ({
                seq: i.seq,
                dueDate: i.dueDate.toISOString().slice(0, 10),
                amount: i.amount.toString(),
              })),
            after: lines.map((l, i) => ({
              seq: firstSeq + i,
              dueDate: l.dueDate.slice(0, 10),
              amount: l.amount.toFixed(2),
            })),
            balance: balance.toFixed(2),
            currency: sale.currency,
          },
        },
        tx,
      );

      return tx.installment.findMany({
        where: { submissionId },
        orderBy: { seq: 'asc' },
        include: { paidBy: { select: { id: true, name: true } } },
      });
    });

    return updated;
  }

  /** Drop the outstanding schedule entirely. Paid instalments survive. */
  async clearPlan(submissionId: string, user: AuthUser) {
    const sale = await this.loadSale(submissionId, user);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.installment.deleteMany({
        where: { submissionId, status: InstallmentStatus.PENDING },
      });
      if (count === 0) {
        throw new BadRequestException('There is no outstanding schedule to clear');
      }
      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'PLAN_CLEARED',
          detail: `${count} unpaid instalment${count === 1 ? '' : 's'} removed`,
          payload: { removed: count, currency: sale.currency },
        },
        tx,
      );
      return tx.installment.findMany({
        where: { submissionId },
        orderBy: { seq: 'asc' },
        include: { paidBy: { select: { id: true, name: true } } },
      });
    });
  }

  /**
   * Mark an instalment done: post its amount to the ledger and let the balance
   * follow. The date and method may be overridden — money lands when it lands,
   * not when the schedule hoped it would.
   */
  async mark(
    submissionId: string,
    installmentId: string,
    dto: MarkInstallmentDto,
    user: AuthUser,
  ) {
    const sale = await this.loadSale(submissionId, user);
    const inst = await this.prisma.installment.findUnique({ where: { id: installmentId } });
    if (!inst || inst.submissionId !== submissionId) {
      throw new NotFoundException('Instalment not found');
    }
    if (inst.status === InstallmentStatus.PAID) {
      throw new BadRequestException('That instalment is already marked done');
    }

    const amount = new Decimal(inst.amount.toString());
    const method = dto.method || inst.method || sale.paymentMethod || FALLBACK_METHOD;
    const date = dto.date ? new Date(dto.date) : new Date();

    return this.prisma.$transaction(async (tx) => {
      // Claim the instalment before any money is written. Two people clicking
      // "mark done" at the same moment must not post the amount twice, and the
      // loser of the race has to fail before it creates a Payment.
      const claimed = await tx.installment.updateMany({
        where: { id: installmentId, status: InstallmentStatus.PENDING },
        data: { status: InstallmentStatus.PAID, paidAt: new Date(), paidById: user.id },
      });
      if (claimed.count === 0) {
        throw new ConflictException('That instalment was just marked done by someone else');
      }

      const payment = await tx.payment.create({
        data: {
          submissionId,
          date,
          amount: amount.toFixed(2),
          currency: sale.currency,
          method,
          reference: dto.reference || null,
          recordedById: user.id,
        },
      });
      await tx.installment.update({
        where: { id: installmentId },
        data: { paymentId: payment.id },
      });

      const { priced } = await this.submissions.recomputeMoney(tx, submissionId);

      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'INSTALLMENT_PAID',
          detail:
            `Instalment ${inst.seq}${inst.label ? ` (${inst.label})` : ''} — ` +
            `${amount.toFixed(2)} ${sale.currency} by ${method}` +
            (dto.reference ? ` (ref ${dto.reference})` : ''),
          payload: {
            installmentSeq: inst.seq,
            amount: amount.toFixed(2),
            currency: sale.currency,
            paymentId: payment.id,
            paidAmount: priced.paidAmount.toFixed(2),
            balance: priced.balance.toFixed(2),
            payStatus: priced.payStatus,
          },
        },
        tx,
      );

      return tx.installment.findMany({
        where: { submissionId },
        orderBy: { seq: 'asc' },
        include: { paidBy: { select: { id: true, name: true } } },
      });
    });
  }

  /**
   * Undo a mark. The original payment stays on the ledger and a reversing
   * negative entry joins it, so the correction is visible rather than silent —
   * the same treatment a mis-keyed hand payment gets.
   */
  async unmark(submissionId: string, installmentId: string, user: AuthUser) {
    const sale = await this.loadSale(submissionId, user);
    const inst = await this.prisma.installment.findUnique({ where: { id: installmentId } });
    if (!inst || inst.submissionId !== submissionId) {
      throw new NotFoundException('Instalment not found');
    }
    if (inst.status !== InstallmentStatus.PAID) {
      throw new BadRequestException('That instalment is not marked done');
    }

    const amount = new Decimal(inst.amount.toString());

    return this.prisma.$transaction(async (tx) => {
      const released = await tx.installment.updateMany({
        where: { id: installmentId, status: InstallmentStatus.PAID },
        data: {
          status: InstallmentStatus.PENDING,
          paidAt: null,
          paidById: null,
          paymentId: null,
        },
      });
      if (released.count === 0) {
        throw new ConflictException('That instalment was just changed by someone else');
      }

      // Only reverse if the mark actually posted money. An instalment can be
      // unlinked (paymentId null) if it was marked, undone and marked again in a
      // way that lost the link; reversing a payment that is not there would
      // credit the customer twice.
      if (inst.paymentId) {
        await tx.payment.create({
          data: {
            submissionId,
            date: new Date(),
            amount: amount.negated().toFixed(2),
            currency: sale.currency,
            method: inst.method || sale.paymentMethod || FALLBACK_METHOD,
            reference: `Reversal of instalment ${inst.seq}`,
            recordedById: user.id,
          },
        });
      }

      const { priced } = await this.submissions.recomputeMoney(tx, submissionId);

      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'INSTALLMENT_UNPAID',
          detail:
            `Instalment ${inst.seq}${inst.label ? ` (${inst.label})` : ''} reopened — ` +
            `${amount.toFixed(2)} ${sale.currency} reversed`,
          payload: {
            installmentSeq: inst.seq,
            reversed: amount.negated().toFixed(2),
            currency: sale.currency,
            reversedPaymentId: inst.paymentId,
            paidAmount: priced.paidAmount.toFixed(2),
            balance: priced.balance.toFixed(2),
            payStatus: priced.payStatus,
          },
        },
        tx,
      );

      return tx.installment.findMany({
        where: { submissionId },
        orderBy: { seq: 'asc' },
        include: { paidBy: { select: { id: true, name: true } } },
      });
    });
  }
}
