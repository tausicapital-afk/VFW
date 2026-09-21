import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Currency, EmailKind } from '@prisma/client';
import { Decimal } from 'decimal.js';
import {
  EmailService,
  PAYMENT_REMINDER_SUBJECT_PREFIX,
  RENEWAL_NUDGE_SUBJECT_PREFIX,
} from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivableRow, ReportsService, RetentionRow } from '../reports/reports.service';

/**
 * Two scheduled nudges, built directly on ReportsService's own queries
 * (`receivablesRows()` / `retentionRows()` — see reports.service.ts) rather
 * than re-deriving "overdue" or "lapsed" from scratch. That is the whole
 * point: these numbers can never disagree with what Reports → Outstanding
 * receivables / Customer retention shows on screen, because it is the same
 * SQL underneath.
 *
 * Both jobs follow inbound.service.ts's conventions: a `running` guard against
 * an overlapping tick, and a quiet failure — a warning in the log, never a
 * throw out of the `@Cron` handler. A broken reminder run is an operational
 * fact, not an outage; the next tick tries again.
 *
 * Both use EmailKind.OTHER (see the builders in common/email.ts) rather than a
 * dedicated `REMINDER` kind — adding one would need a Prisma migration, out of
 * scope here. The natural follow-up, once schema changes are back on the
 * table, is a real `EmailKind.REMINDER` (and ideally a `remindedAt` marker
 * instead of the string-matching de-dupe below).
 */

/** Don't re-remind the same overdue invoice more than once inside this window. */
const OVERDUE_REMINDER_COOLDOWN_DAYS = 7;
/** Don't re-nudge the same rep about the same contact more than once inside this window. */
const RENEWAL_NUDGE_COOLDOWN_DAYS = 30;

/**
 * A contact needs at least two live bookings before "their usual pattern"
 * means anything. One booking has no cadence to compare against, so it is
 * never flagged — better to miss a genuinely lapsed one-time buyer than to
 * nudge a rep about someone who has no history to be lapsed relative to.
 */
const MIN_BOOKINGS_FOR_RENEWAL_SIGNAL = 2;
/**
 * How far past the contact's own average gap before it counts as "hasn't
 * booked in a while" — 50% beyond their usual cadence, not the moment they
 * cross it exactly, so a rep isn't nudged about someone who is one week later
 * than usual.
 */
const RENEWAL_OVERDUE_MULTIPLIER = 1.5;
/**
 * A floor under that multiplier, so a contact with a very tight historical
 * cadence (e.g. two bookings three weeks apart) doesn't get flagged after a
 * trivially short gap.
 */
const RENEWAL_MIN_GAP_DAYS = 60;

const DAY_MS = 86_400_000;

@Injectable()
export class RemindersService {
  private readonly log = new Logger(RemindersService.name);
  // Two independent guards — the two jobs run on different schedules and must
  // not block each other, only themselves against their own next tick.
  private runningOverdue = false;
  private runningRenewal = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly email: EmailService,
  ) {}

  // ---------------------------------------------------------------------
  // Overdue-payment reminder — daily, to the contact.
  // ---------------------------------------------------------------------

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async overduePaymentReminders(): Promise<void> {
    if (this.runningOverdue) return;
    this.runningOverdue = true;
    try {
      await this.runOverduePaymentReminders();
    } catch (err) {
      this.log.warn(
        `Overdue-payment reminder run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.runningOverdue = false;
    }
  }

  private async runOverduePaymentReminders(): Promise<void> {
    // No filters: every open, booked submission across the whole book — the
    // same universe Reports → Outstanding receivables shows with no filter set.
    const rows = await this.reports.receivablesRows({});
    // receivables() already restricts to balance > 0.01; "overdue" narrows
    // that further to rows whose Net-terms due date has actually passed.
    const overdue = rows.filter((r) => (r.daysToDue ?? 0) < 0);

    for (const row of overdue) {
      try {
        await this.remindOne(row);
      } catch (err) {
        this.log.warn(
          `Overdue reminder for ${row.ref} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async remindOne(row: ReceivableRow): Promise<void> {
    // No email on file for this contact — nothing to send, and nothing to log
    // as a failure; this is a data-completeness gap, not an error.
    if (!row.contactEmail) return;

    // De-dupe: has a payment reminder already gone out for THIS submission
    // within the cooldown window? submissionId + kind OTHER + this subject
    // prefix is a marker nothing else in the system writes (see
    // common/email.ts), so it is safe to key off directly — no new column
    // needed. A week's cooldown means a daily cron nudges the same invoice
    // roughly weekly, not every single day it stays unpaid.
    const since = new Date(Date.now() - OVERDUE_REMINDER_COOLDOWN_DAYS * DAY_MS);
    const already = await this.prisma.emailMessage.findFirst({
      where: {
        submissionId: row.submissionId,
        kind: EmailKind.OTHER,
        subject: { startsWith: PAYMENT_REMINDER_SUBJECT_PREFIX },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (already) return;

    const daysOverdue = Math.abs(row.daysToDue ?? 0);
    await this.email.send(
      this.email.paymentReminder({
        to: row.contactEmail,
        submissionId: row.submissionId,
        ref: row.ref,
        brand: row.brand,
        daysOverdue,
        dueDate: row.due ? row.due.toISOString().slice(0, 10) : '',
        balance: new Decimal(row.balance ?? 0).toFixed(2),
        currency: row.currency,
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Renewal nudge — weekly, to the rep (internal), not the contact.
  //
  // A past client should not be cold-emailed "you should buy again" with no
  // human in the loop — Reports → Customer retention already names a "Rep"
  // per contact (the rep most recently on the account), so that person is the
  // natural, and safer, recipient: they decide whether and how to reach out.
  // ---------------------------------------------------------------------

  @Cron(CronExpression.EVERY_WEEK)
  async renewalNudges(): Promise<void> {
    if (this.runningRenewal) return;
    this.runningRenewal = true;
    try {
      await this.runRenewalNudges();
    } catch (err) {
      this.log.warn(
        `Renewal-nudge run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.runningRenewal = false;
    }
  }

  private async runRenewalNudges(): Promise<void> {
    // retentionRows() joins an fx rate table to compute lifetime net value for
    // the on-screen report, but the lapsed/not-lapsed decision below never
    // reads `net` — only booking count and dates. A live rate lookup (which
    // can throw if Accounting hasn't set one for some currency — see
    // ReportsService.parseRates) would be a real dependency this job does not
    // need, so an identity map (rate 1 for every currency) is passed instead.
    const identityFx = Object.fromEntries(
      Object.values(Currency).map((c) => [c, new Decimal(1)]),
    ) as Record<Currency, Decimal>;
    const rows = await this.reports.retentionRows({}, identityFx);

    for (const row of rows) {
      const signal = this.renewalSignal(row);
      if (!signal) continue;
      try {
        await this.nudgeOne(row, signal);
      } catch (err) {
        this.log.warn(
          `Renewal nudge for ${row.brand} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Null when there is no historical pattern to compare against, or the
   * contact is still within it. Otherwise the numbers the email/de-dupe need.
   */
  private renewalSignal(
    row: RetentionRow,
  ): { avgGapDays: number; daysSinceLast: number } | null {
    if (row.bookings < MIN_BOOKINGS_FOR_RENEWAL_SIGNAL) return null;

    const first = new Date(row.firstBooking).getTime();
    const last = new Date(row.lastBooking).getTime();
    // The average gap across their whole history, from only its two ends —
    // the aggregate query has no per-booking date list to average properly,
    // and first/last is enough to answer "is now unusual for them".
    const avgGapDays = (last - first) / (row.bookings - 1) / DAY_MS;
    const daysSinceLast = (Date.now() - last) / DAY_MS;
    const threshold = Math.max(avgGapDays * RENEWAL_OVERDUE_MULTIPLIER, RENEWAL_MIN_GAP_DAYS);

    return daysSinceLast > threshold ? { avgGapDays, daysSinceLast } : null;
  }

  private async nudgeOne(
    row: RetentionRow,
    signal: { avgGapDays: number; daysSinceLast: number },
  ): Promise<void> {
    // Every live submission has a repId (NOT NULL FK), so repEmail is always
    // populated here — this guard is defensive, not an expected path.
    if (!row.repEmail) return;

    // De-dupe: EmailMessage carries no contactId (a renewal nudge isn't tied
    // to one submission the way a reminder is), so the key here is
    // (toAddress, subject) instead — the subject embeds the brand via
    // RENEWAL_NUDGE_SUBJECT_PREFIX, which nothing else in the system writes.
    const subject = `${RENEWAL_NUDGE_SUBJECT_PREFIX} ${row.brand}`;
    const since = new Date(Date.now() - RENEWAL_NUDGE_COOLDOWN_DAYS * DAY_MS);
    const already = await this.prisma.emailMessage.findFirst({
      where: {
        toAddress: row.repEmail,
        kind: EmailKind.OTHER,
        subject,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (already) return;

    await this.email.send(
      this.email.renewalNudge({
        to: row.repEmail,
        repName: row.repName,
        brand: row.brand,
        bookings: row.bookings,
        lastBookingDate: new Date(row.lastBooking).toISOString().slice(0, 10),
        daysSinceLastBooking: Math.round(signal.daysSinceLast),
        avgGapDays: Math.round(signal.avgGapDays),
      }),
    );
  }
}
