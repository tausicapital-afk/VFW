import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AttendanceStatus, Currency, PayrollInvoiceStatus, PayType, Prisma, UserStatus,
} from '@prisma/client';
import { Decimal } from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { can } from '../common/acl';
import { AuthUser } from '../common/auth.guard';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { avatarUrl } from '../profile/avatar';
import { currentMonth, dayKey, parseDay, summarise } from '../attendance/attendance.service';
import { buildPayslipPdf, type PayslipPdfData } from './payslip-pdf';
import { EditPayrollInvoiceDto, PayrollQueryDto, RejectPayrollInvoiceDto, SubmitPayrollDto } from './dto';

/**
 * Inclusive `from`/`to` → the half-open range Prisma's date columns need.
 * `to` is a whole day, so the exclusive upper bound is the day after it.
 */
function periodRange(from: string, to: string): { gte: Date; lt: Date } {
  const gte = parseDay(from);
  const end = parseDay(to);
  if (end < gte) throw new BadRequestException('A period cannot end before it starts');
  return { gte, lt: new Date(end.getTime() + 24 * 60 * 60 * 1000) };
}

/** The calendar month a caller who named no period almost certainly meant,
 *  spelled as the inclusive range every other period is. */
function defaultPeriod(now = new Date()): { from: string; to: string } {
  const month = currentMonth(now);
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * A period is both bounds or neither. Defaults to the current calendar month
 * when the caller named none — the same default `GET /api/payroll` has always
 * had — and refuses a lone `from` or `to` as the screen bug it would be rather
 * than guessing which end was meant.
 */
function resolvePeriod(query: { from?: string; to?: string }): { from: string; to: string } {
  if (query.from && query.to) return { from: query.from, to: query.to };
  if (query.from || query.to) {
    throw new BadRequestException('A period needs both a start date and an end date');
  }
  return defaultPeriod();
}

/** Whether `from`/`to` is exactly the 1st through the last day of one month —
 *  the range every period was, before a custom one could be anything else. */
function isCalendarMonth(from: string, to: string): boolean {
  if (!from.endsWith('-01')) return false;
  const [y, m] = from.slice(0, 7).split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return to === `${from.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * The whole person, which is what a payroll statement needs. Every other screen
 * shows a slice; this is the one place where somebody's role, title, department,
 * employee number, pay setup and commission rate all have to be legible together,
 * because that combination is what the figure below them is derived from.
 */
const PERSON_FIELDS = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  title: true,
  department: true,
  employeeId: true,
  colour: true,
  avatarKey: true,
  status: true,
  createdAt: true,
  payType: true,
  baseRate: true,
  earnsCommission: true,
  commissionPct: true,
  target: true,
} satisfies Prisma.UserSelect;

type Person = Prisma.UserGetPayload<{ select: typeof PERSON_FIELDS }>;

/** One day off the timesheet, reduced to what the pay maths needs. */
type AttendanceDay = { status: AttendanceStatus; hours: string };

interface RepSales {
  count: number;
  revenue: Decimal;
  invoiced: Decimal;
  collected: Decimal;
  outstanding: Decimal;
  commission: Decimal;
  commissionUnpaid: Decimal;
  /** The same month split by who it was sold to, keyed by contact id. */
  clients: Map<string, ClientSales>;
}

interface ClientSales {
  brand: string;
  designer: string;
  deals: number;
  revenue: Decimal;
  invoiced: Decimal;
  collected: Decimal;
  outstanding: Decimal;
}

/**
 * Payroll: what each person earned in a month, and where it came from.
 *
 * Three sources feed one number, and keeping them visibly separate is the whole
 * design — a gross figure nobody can take apart is a figure nobody will trust
 * enough to pay from:
 *
 *   base       from the account's pay type and rate (× hours, if hourly)
 *   commission from the sales they closed, at the rate on each sale
 *   gross      base + commission
 *
 * **The pay basis is two fields, not one.** `payType` decides how base pay is
 * worked out; `earnsCommission` decides whether there is commission at all. An
 * administrator sets both, which is what lets someone be on commission, on a
 * salary, or on both — and both is the arrangement every account had before the
 * second field existed, because commission used to be added on top regardless.
 * Note where the second one bites: it is applied when a sale is CREATED, where
 * the rate is stamped onto the Submission, not here. By the time payroll reads
 * a sale, a salaried rep's commission is already 0 and nothing below has to
 * treat them as a special case.
 *
 * **Commission is earned on approval.** A sale counts in the month Accounting
 * approved it, not the month the client's money arrives. That matches what
 * Reports → *Sales representative performance* has always shown, so the two
 * screens cannot disagree about what a rep earned. The trade-off is real and is
 * not hidden: `commissionUnpaid` reports how much of the month's commission sits
 * against invoices the client has not settled, and the screen shows it beside
 * the total rather than in a footnote.
 *
 * Nothing here is stored. A payroll period is derived on every read from the
 * sales, the attendance and the pay setup as they stand — so correcting a
 * timesheet or amending a sale is reflected the next time the month is opened,
 * with no second copy of the figures to go stale. The moment payroll needs to be
 * *approved and frozen*, that becomes a table with its own lifecycle; it is not
 * one yet, and pretending otherwise would be the expensive kind of wrong.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    /** The Test data switch — see ConfigService.testDataMode. */
    private readonly config: ConfigService,
  ) {}

  /**
   * Whose pay this request is about — the same shape as attendance's, because it
   * is the same rule with a stricter permission behind it. Your own always
   * passes; anyone else's needs `payroll.viewAll`.
   */
  private async subject(userId: string | undefined, actor: AuthUser): Promise<string> {
    if (!userId || userId === actor.id) return actor.id;

    if (!can('payroll.viewAll', actor.role)) {
      throw new ForbiddenException("Your role cannot open someone else's pay");
    }

    const exists = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');
    return exists.id;
  }

  /**
   * FX to CAD, the reporting currency, read from the same `Settings.fxRates`
   * table Reports consolidates through — so a rate Accounting sets (or the live
   * fetch writes) moves payroll and reports together.
   *
   * A missing rate throws rather than defaulting to 1. Silently valuing a JPY
   * sale as though yen were dollars would overstate somebody's commission by two
   * orders of magnitude, and it would look entirely plausible on the screen.
   */
  private async fxRates(): Promise<Record<Currency, Decimal>> {
    const settings = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const src = (settings.fxRates ?? {}) as Record<string, unknown>;
    const rates = {} as Record<Currency, Decimal>;

    for (const cur of Object.values(Currency)) {
      if (cur === Currency.CAD) {
        rates[cur] = new Decimal(1);
        continue;
      }
      const raw = src[cur];
      const rate = typeof raw === 'number' || typeof raw === 'string' ? new Decimal(raw) : null;
      if (!rate || rate.lte(0)) {
        throw new BadRequestException(
          `No FX rate for ${cur} in Settings. Accounting must set one before payroll can be totalled in CAD.`,
        );
      }
      rates[cur] = rate;
    }
    return rates;
  }

  /**
   * Base pay for the period.
   *
   * A salary is a salary: it does not move with the hours on the timesheet, and
   * making it do so would turn every unrecorded day into a pay cut for someone
   * who is not paid by the hour. Hours still appear on the statement, because a
   * salaried person's attendance is worth seeing — it is just not what they are
   * paid on.
   */
  private basePay(payType: PayType, baseRate: Decimal, hours: Decimal): Decimal {
    switch (payType) {
      case PayType.SALARY:
        return baseRate;
      case PayType.HOURLY:
        return baseRate.times(hours);
      case PayType.COMMISSION_ONLY:
        return new Decimal(0);
    }
  }

  /**
   * Commission and sales for a month, per rep, in CAD.
   *
   * Dated by `approvedAt`, which is the one date that means "this was earned".
   * The reports elsewhere date a sale by when it was *submitted*, because they
   * answer a different question — how the pipeline is moving — and a sale
   * submitted in March and approved in April belongs to March's activity but to
   * April's pay.
   *
   * `repId` narrows it to one person without changing any of the arithmetic —
   * `monthSales` below is the same figures for a single account, not a second
   * opinion about them.
   */
  private async salesByRep(
    range: { gte: Date; lt: Date },
    fx: Record<Currency, Decimal>,
    repId?: string,
  ) {
    const sales = await this.prisma.submission.findMany({
      where: {
        status: { in: ['APPROVED', 'EXPORTED'] },
        approvedAt: range,
        ...(repId ? { repId } : {}),
      },
      select: {
        repId: true,
        currency: true,
        taxable: true,
        total: true,
        paidAmount: true,
        balance: true,
        commissionAmount: true,
        payStatus: true,
        contact: { select: { id: true, brand: true, designer: true } },
      },
    });

    const zero = (): RepSales => ({
      count: 0,
      revenue: new Decimal(0),
      invoiced: new Decimal(0),
      collected: new Decimal(0),
      outstanding: new Decimal(0),
      commission: new Decimal(0),
      commissionUnpaid: new Decimal(0),
      clients: new Map(),
    });
    const byRep = new Map<string, RepSales>();

    for (const sale of sales) {
      const rate = fx[sale.currency];
      const cad = (v: { toString(): string }) => new Decimal(v.toString()).times(rate);
      const acc = byRep.get(sale.repId) ?? zero();
      const commission = cad(sale.commissionAmount);
      const revenue = cad(sale.taxable);
      const invoiced = cad(sale.total);
      const collected = cad(sale.paidAmount);
      // An overpayment leaves a negative balance. It is not negative debt, so it
      // is floored rather than allowed to cancel out another invoice's arrears.
      const outstanding = Decimal.max(cad(sale.balance), 0);

      acc.count += 1;
      acc.revenue = acc.revenue.plus(revenue);
      acc.invoiced = acc.invoiced.plus(invoiced);
      acc.collected = acc.collected.plus(collected);
      acc.outstanding = acc.outstanding.plus(outstanding);
      acc.commission = acc.commission.plus(commission);
      // Earned, but sitting against an invoice the client has not settled. Not
      // deducted — just declared, so whoever signs the run can see the exposure.
      if (sale.payStatus !== 'PAID') {
        acc.commissionUnpaid = acc.commissionUnpaid.plus(commission);
      }

      const client = acc.clients.get(sale.contact.id) ?? {
        brand: sale.contact.brand,
        designer: sale.contact.designer,
        deals: 0,
        revenue: new Decimal(0),
        invoiced: new Decimal(0),
        collected: new Decimal(0),
        outstanding: new Decimal(0),
      };
      client.deals += 1;
      client.revenue = client.revenue.plus(revenue);
      client.invoiced = client.invoiced.plus(invoiced);
      client.collected = client.collected.plus(collected);
      client.outstanding = client.outstanding.plus(outstanding);
      acc.clients.set(sale.contact.id, client);

      byRep.set(sale.repId, acc);
    }

    return byRep;
  }

  /** Hours and days from the Attendance module, per person, for the month. */
  private async attendanceByUser(
    range: { gte: Date; lt: Date },
    userIds: string[],
  ): Promise<Map<string, AttendanceDay[]>> {
    const entries = await this.prisma.attendanceEntry.findMany({
      where: { userId: { in: userIds }, date: range },
      select: { userId: true, status: true, hours: true },
    });

    const byUser = new Map<string, AttendanceDay[]>();
    for (const entry of entries) {
      const list = byUser.get(entry.userId) ?? [];
      list.push({ status: entry.status, hours: entry.hours.toString() });
      byUser.set(entry.userId, list);
    }
    return byUser;
  }

  private async statement(
    person: Person,
    sales: RepSales | undefined,
    attendance: AttendanceDay[] | undefined,
    lifetimeEarned: Decimal | undefined,
  ) {
    const summary = summarise(attendance ?? []);
    const hours = new Decimal(summary.hours);
    const baseRate = new Decimal(person.baseRate.toString());

    const base = this.basePay(person.payType, baseRate, hours).toDecimalPlaces(2);
    const commission = (sales?.commission ?? new Decimal(0)).toDecimalPlaces(2);
    const { avatarKey, ...profile } = person;

    return {
      // The "full profile" the screen shows beside the money — payroll is the one
      // place someone needs the whole person on one page.
      user: {
        ...profile,
        // Fixed to the column's own scale rather than left to Decimal's
        // toString(), which drops trailing zeros and would hand the screen "8"
        // for one rate and "8.25" for the next. Reports normalises the same way;
        // a payroll payload where some figures are two-decimal and others are
        // not is one where every consumer has to re-round, and one of them won't.
        commissionPct: person.commissionPct.toFixed(2),
        target: person.target.toFixed(2),
        baseRate: person.baseRate.toFixed(2),
        avatarUrl: await avatarUrl(this.storage, avatarKey),
        // Every APPROVED payroll invoice's gross, summed — "since starting" in
        // effect, since nothing here reaches back further than the account
        // itself.
        lifetimeEarned: (lifetimeEarned ?? new Decimal(0)).toFixed(2),
      },
      attendance: {
        days: summary.days,
        daysWorked: summary.daysWorked,
        hours: summary.hours,
        avgHours: summary.avgHours,
      },
      sales: {
        count: sales?.count ?? 0,
        revenue: (sales?.revenue ?? new Decimal(0)).toFixed(2),
        invoiced: (sales?.invoiced ?? new Decimal(0)).toFixed(2),
      },
      pay: {
        payType: person.payType,
        baseRate: person.baseRate.toFixed(2),
        // What the base was actually worked out from, so the number on screen can
        // show its own arithmetic ("$32.00 × 142.50 h") rather than asserting it.
        baseHours: person.payType === PayType.HOURLY ? summary.hours : null,
        base: base.toFixed(2),
        // The other half of the pay basis, carried so the screen can say which
        // kind of zero a zero is. It is NOT a filter on the figure below it:
        // commission is frozen onto each sale at the rate it was struck, so a
        // rep taken off commission last week is still owed what they closed the
        // week before. Their next sale stamps 0%, and this line stops the
        // statement claiming a rate they are no longer on.
        earnsCommission: person.earnsCommission,
        commission: commission.toFixed(2),
        commissionUnpaid: (sales?.commissionUnpaid ?? new Decimal(0)).toFixed(2),
        gross: base.plus(commission).toFixed(2),
      },
    };
  }

  /** One person's statement for the period. */
  async statementFor(query: PayrollQueryDto, actor: AuthUser) {
    const userId = await this.subject(query.userId, actor);
    const { from, to } = resolvePeriod(query);
    const range = periodRange(from, to);

    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PERSON_FIELDS,
    });
    if (!person) throw new NotFoundException('User not found');

    const fx = await this.fxRates();
    const sales = (await this.salesByRep(range, fx)).get(userId);
    const attendance = (await this.attendanceByUser(range, [userId])).get(userId);
    const lifetime = (await this.lifetimeEarnedByUser([userId])).get(userId);
    // This period's payroll invoice, if one has been submitted — lets the
    // screen show a status pill and compare the frozen snapshot against the
    // live figure.
    const invoice = await this.prisma.payrollInvoice.findUnique({
      where: {
        userId_periodStart_periodEnd: { userId, periodStart: parseDay(from), periodEnd: parseDay(to) },
      },
    });

    return {
      from,
      to,
      self: userId === actor.id,
      invoice,
      ...(await this.statement(person, sales, attendance, lifetime)),
    };
  }

  /**
   * One person's month as a payslip — the same statement, as a document.
   *
   * Everything here comes off `statementFor`, and that is the whole design. Two
   * things fall out of it, both of which would have been worth the indirection
   * on their own:
   *
   *   - **The permission is inherited, not restated.** `statementFor` resolves
   *     the subject through `subject()`, which lets you have your own and
   *     demands `payroll.viewAll` for anybody else's. A payslip route that
   *     checked that itself would be a second copy of the rule, and a second
   *     copy is the one that drifts — the copy that gets forgotten is always the
   *     one on the endpoint that hands out a file.
   *   - **The arithmetic is inherited too.** Not one figure is recomputed below;
   *     the mapping only relabels. A payslip that disagreed with the screen it
   *     was downloaded from would be the worst possible bug in this module,
   *     because the printed copy is the one that gets forwarded and argued from.
   *
   * The reviewer's name is the one thing the statement does not carry — the
   * screen renders a status pill and never needed it — so it costs one extra
   * lookup, and only when a reviewed invoice exists.
   */
  async payslip(
    query: PayrollQueryDto,
    actor: AuthUser,
  ): Promise<{ buffer: Buffer; filename: string; data: PayslipPdfData }> {
    const sheet = await this.statementFor(query, actor);
    const settings = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });

    const reviewer = sheet.invoice?.reviewedById
      ? await this.prisma.user.findUnique({
          where: { id: sheet.invoice.reviewedById },
          select: { name: true },
        })
      : null;

    const data: PayslipPdfData = {
      companyName: settings.company,
      period: { from: sheet.from, to: sheet.to },
      issuedAt: new Date(),
      // Payroll consolidates everything to CAD before it totals anything, so the
      // document states one currency rather than implying a per-person one.
      currency: Currency.CAD,
      person: {
        name: sheet.user.name,
        employeeId: sheet.user.employeeId,
        role: sheet.user.role,
        title: sheet.user.title,
        department: sheet.user.department,
        email: sheet.user.email,
      },
      basis: {
        payType: sheet.pay.payType,
        earnsCommission: sheet.pay.earnsCommission,
        baseRate: sheet.pay.baseRate,
        commissionPct: sheet.user.commissionPct,
      },
      attendance: sheet.attendance,
      sales: { count: sheet.sales.count, revenue: sheet.sales.revenue, invoiced: sheet.sales.invoiced },
      pay: {
        base: sheet.pay.base,
        baseHours: sheet.pay.baseHours,
        commission: sheet.pay.commission,
        commissionUnpaid: sheet.pay.commissionUnpaid,
        gross: sheet.pay.gross,
      },
      invoice: sheet.invoice
        ? {
            status: sheet.invoice.status,
            submittedAt: sheet.invoice.submittedAt,
            reviewedAt: sheet.invoice.reviewedAt,
            reviewedBy: reviewer?.name ?? null,
            note: sheet.invoice.note,
            // Normalised to the column's own scale for the same reason the
            // statement normalises its own strings: the document compares this
            // against the live gross, and "4800" never equals "4800.00".
            gross: sheet.invoice.gross.toFixed(2),
          }
        : null,
      preparedBy: actor.name,
    };

    /**
     * Audited, including when it is your own.
     *
     * A payslip is not a screen — it is a file that leaves the system and gets
     * forwarded, and the question it eventually provokes is always "who produced
     * this copy, of whose pay, for which month". A trail that recorded only
     * somebody-else's downloads could not answer that for the copy most likely
     * to be in dispute, which is the one a person pulled of their own pay.
     *
     * Awaited rather than fire-and-forget: unlike the telemetry line on a bulk
     * export, this is the financial trail, and the only realistic way this write
     * fails is a database that `statementFor` above has already failed against.
     */
    await this.audit.log({
      actorId: actor.id,
      action: 'PAYSLIP_GENERATED',
      detail: `Payslip generated for ${sheet.user.name} — ${sheet.from} to ${sheet.to}`,
      payload: {
        from: sheet.from,
        to: sheet.to,
        userId: sheet.user.id,
        self: sheet.self,
        gross: sheet.pay.gross,
      },
    });

    // Named after the person and the period, not after "payslip": these end up
    // in one folder, and a download that collides with an earlier one is a
    // download somebody silently overwrites. A period that is exactly a
    // calendar month keeps the old, shorter '2026-08' slug; a genuinely custom
    // range spells out both ends.
    const who = (sheet.user.employeeId ?? sheet.user.name)
      .normalize('NFKD')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const period = isCalendarMonth(sheet.from, sheet.to)
      ? sheet.from.slice(0, 7)
      : `${sheet.from}_${sheet.to}`;

    return {
      buffer: await buildPayslipPdf(data),
      filename: `payslip-${who || 'employee'}-${period}.pdf`,
      data,
    };
  }

  /**
   * Everyone's period, one statement each, plus the run total.
   *
   * Includes accounts that earned nothing — a payroll run that silently omitted
   * someone is the failure mode that matters here, and it is the one nobody
   * notices until a person is not paid.
   */
  async run(query: PayrollQueryDto, actor: AuthUser) {
    if (!can('payroll.viewAll', actor.role)) {
      throw new ForbiddenException('Your role cannot view the payroll run');
    }

    const { from, to } = resolvePeriod(query);
    const range = periodRange(from, to);

    const people = await this.prisma.user.findMany({
      where: { deletedAt: null, hidden: false, status: UserStatus.ACTIVE },
      select: PERSON_FIELDS,
      orderBy: { name: 'asc' },
    });

    const fx = await this.fxRates();
    const sales = await this.salesByRep(range, fx);
    const attendance = await this.attendanceByUser(range, people.map((p) => p.id));
    const lifetime = await this.lifetimeEarnedByUser(people.map((p) => p.id));

    const rows = await Promise.all(
      people.map((person) =>
        this.statement(person, sales.get(person.id), attendance.get(person.id), lifetime.get(person.id)),
      ),
    );

    const total = (pick: (r: (typeof rows)[number]) => string) =>
      rows.reduce((sum, row) => sum.plus(new Decimal(pick(row))), new Decimal(0)).toFixed(2);

    return {
      from,
      to,
      rows,
      totals: {
        people: rows.length,
        base: total((r) => r.pay.base),
        commission: total((r) => r.pay.commission),
        commissionUnpaid: total((r) => r.pay.commissionUnpaid),
        gross: total((r) => r.pay.gross),
        hours: total((r) => r.attendance.hours),
      },
    };
  }

  /** Every APPROVED invoice's gross, summed per person, in one query. */
  private async lifetimeEarnedByUser(userIds: string[]): Promise<Map<string, Decimal>> {
    const rows = await this.prisma.payrollInvoice.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: PayrollInvoiceStatus.APPROVED },
      _sum: { gross: true },
    });
    return new Map(rows.map((r) => [r.userId, new Decimal(r._sum.gross ?? 0)]));
  }

  /**
   * One account's period of sales, in CAD, and the clients it came from.
   *
   * Two screens read this — Payroll, under the statement, and Administration,
   * under the user's details — and they read the same thing. It is deliberately
   * the same `salesByRep` the run above pays from rather than a fresh query with
   * its own idea of what a sale is worth: whoever compares the two screens for a
   * period must not find two answers, so the dating (approvedAt), the FX table
   * and the commission are one definition, in one place.
   *
   * Any period, not just the current month. The figures are derived on every
   * read from sales that are already on the books, so an older period is simply
   * an older range — there is no snapshot to have missed and nothing to backfill.
   *
   * Note what it is not: this is what the account *sold*, not what it will be
   * paid. Base pay, hours and the payroll invoice lifecycle stay on Payroll.
   */
  async periodSales(userId: string, from: string, to: string) {
    const person = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, name: true, commissionPct: true, target: true },
    });
    if (!person) throw new NotFoundException('User not found');

    const fx = await this.fxRates();
    const sales = (await this.salesByRep(periodRange(from, to), fx, userId)).get(userId);

    const clients = [...(sales?.clients.values() ?? [])]
      .sort((a, b) => b.revenue.comparedTo(a.revenue) || b.deals - a.deals)
      .map((c) => ({
        brand: c.brand,
        designer: c.designer,
        deals: c.deals,
        revenue: c.revenue.toFixed(2),
        invoiced: c.invoiced.toFixed(2),
        collected: c.collected.toFixed(2),
        outstanding: c.outstanding.toFixed(2),
      }));

    return {
      from,
      to,
      user: { id: person.id, name: person.name },
      // The rate and target on the account NOW, which is what the next sale will
      // earn — not what any of the sales below were struck at. Each of those
      // carries its own rate; see the note on Submission.commissionPct.
      commissionPct: person.commissionPct.toFixed(2),
      target: person.target.toFixed(2),
      count: sales?.count ?? 0,
      revenue: (sales?.revenue ?? new Decimal(0)).toFixed(2),
      invoiced: (sales?.invoiced ?? new Decimal(0)).toFixed(2),
      collected: (sales?.collected ?? new Decimal(0)).toFixed(2),
      outstanding: (sales?.outstanding ?? new Decimal(0)).toFixed(2),
      commission: (sales?.commission ?? new Decimal(0)).toFixed(2),
      commissionUnpaid: (sales?.commissionUnpaid ?? new Decimal(0)).toFixed(2),
      clients,
    };
  }

  /**
   * The same period, for whoever asked. `subject` is what decides whose: your
   * own always, anyone else's only with `payroll.viewAll` — the identical rule
   * the statement itself is resolved under, so the panel beneath a statement
   * can never be readable when the statement above it is not.
   */
  async salesFor(query: PayrollQueryDto, actor: AuthUser) {
    const userId = await this.subject(query.userId, actor);
    const { from, to } = resolvePeriod(query);
    return this.periodSales(userId, from, to);
  }

  /** Single-person convenience — used by the Profile screen. */
  async lifetimeEarned(userId: string): Promise<string> {
    const total = (await this.lifetimeEarnedByUser([userId])).get(userId) ?? new Decimal(0);
    return total.toFixed(2);
  }

  // ---------------------------------------------------------------------------
  // Payroll invoices — the submit/approve lifecycle on top of the statement
  // above. See the schema comment on PayrollInvoice for why the figures are a
  // frozen snapshot rather than a live re-derivation.
  // ---------------------------------------------------------------------------

  /**
   * Submitting your own period as a payroll invoice. Idempotent: resubmitting a
   * SUBMITTED or REJECTED period upserts the same row with a fresh snapshot and
   * clears any previous review; an already-APPROVED period is a decided,
   * frozen record and refuses a second submission the same way an approved
   * Submission refuses a plain resubmit — an admin edits it directly instead.
   */
  async submitMine(dto: SubmitPayrollDto, actor: AuthUser) {
    periodRange(dto.from, dto.to); // validates the bounds before anything else runs
    if (dto.to > dayKey(new Date())) {
      throw new BadRequestException('You cannot submit payroll for a period that has not finished yet');
    }

    const periodStart = parseDay(dto.from);
    const periodEnd = parseDay(dto.to);

    const existing = await this.prisma.payrollInvoice.findUnique({
      where: { userId_periodStart_periodEnd: { userId: actor.id, periodStart, periodEnd } },
    });
    if (existing?.status === PayrollInvoiceStatus.APPROVED) {
      throw new BadRequestException(
        'This period has already been approved — an admin can edit it directly if it needs to change',
      );
    }

    const sheet = await this.statementFor({ from: dto.from, to: dto.to }, actor);

    return this.prisma.$transaction(async (tx) => {
      const snapshot = {
        payType: sheet.pay.payType,
        baseRate: sheet.pay.baseRate,
        hours: sheet.attendance.hours,
        base: sheet.pay.base,
        commissionPct: sheet.user.commissionPct,
        earnsCommission: sheet.pay.earnsCommission,
        commission: sheet.pay.commission,
        gross: sheet.pay.gross,
      };
      const invoice = await tx.payrollInvoice.upsert({
        where: { userId_periodStart_periodEnd: { userId: actor.id, periodStart, periodEnd } },
        // The flag is set on the first submit only, and left alone on the
        // resubmission branch below: a real period someone resubmits during a
        // demo is still a real period, and it is the one people get paid from.
        create: {
          userId: actor.id,
          periodStart,
          periodEnd,
          status: PayrollInvoiceStatus.SUBMITTED,
          isTestData: this.config.testDataMode,
          ...snapshot,
        },
        update: {
          ...snapshot,
          status: PayrollInvoiceStatus.SUBMITTED,
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedById: null,
          note: null,
        },
      });

      await this.audit.log(
        {
          actorId: actor.id,
          action: 'PAYROLL_SUBMITTED',
          detail: `Payroll submitted for ${dto.from} to ${dto.to}`,
          payload: { from: dto.from, to: dto.to, gross: invoice.gross.toString() },
        },
        tx,
      );
      return invoice;
    });
  }

  /** Your own submission history, most recent period first. */
  async mine(actor: AuthUser) {
    return this.prisma.payrollInvoice.findMany({
      where: { userId: actor.id },
      orderBy: { periodStart: 'desc' },
    });
  }

  /** Everyone's invoices awaiting review, oldest first — the payroll Queue. */
  async pending(actor: AuthUser) {
    if (!can('payroll.approve', actor.role)) {
      throw new ForbiddenException('Your role cannot review payroll submissions');
    }
    const invoices = await this.prisma.payrollInvoice.findMany({
      where: { status: PayrollInvoiceStatus.SUBMITTED },
      include: { user: { select: { id: true, name: true, colour: true, avatarKey: true, role: true } } },
      orderBy: { submittedAt: 'asc' },
    });
    return Promise.all(
      invoices.map(async ({ user, ...invoice }) => {
        const { avatarKey, ...profile } = user;
        return { ...invoice, user: { ...profile, avatarUrl: await avatarUrl(this.storage, avatarKey) } };
      }),
    );
  }

  /**
   * An admin correcting the frozen figures before sign-off — e.g. a manual
   * bonus, or a correction the person's own statement could not have known
   * about. Refused once approved: that is an amendment, not a pre-approval
   * edit, and this system does not yet have a lifecycle for amending a paid
   * month.
   */
  async editInvoice(id: string, dto: EditPayrollInvoiceDto, actor: AuthUser) {
    if (!can('payroll.approve', actor.role)) {
      throw new ForbiddenException('Your role cannot edit a payroll submission');
    }
    const invoice = await this.prisma.payrollInvoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Payroll invoice not found');
    if (invoice.status === PayrollInvoiceStatus.APPROVED) {
      throw new BadRequestException('This invoice is already approved and cannot be edited');
    }

    const base = dto.base != null ? new Decimal(dto.base).toDecimalPlaces(2) : invoice.base;
    const commission = dto.commission != null ? new Decimal(dto.commission).toDecimalPlaces(2) : invoice.commission;
    const gross = base.plus(commission);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payrollInvoice.update({
        where: { id },
        data: { base: base.toFixed(2), commission: commission.toFixed(2), gross: gross.toFixed(2), note: dto.note },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'PAYROLL_INVOICE_EDITED',
          detail: `Payroll figures edited for ${dayKey(invoice.periodStart)} to ${dayKey(invoice.periodEnd)}: ${dto.note}`,
          payload: {
            from: dayKey(invoice.periodStart),
            to: dayKey(invoice.periodEnd),
            userId: invoice.userId,
            before: {
              base: invoice.base.toString(),
              commission: invoice.commission.toString(),
              gross: invoice.gross.toString(),
            },
            after: { base: updated.base.toString(), commission: updated.commission.toString(), gross: updated.gross.toString() },
          },
        },
        tx,
      );
      return updated;
    });
  }

  async approveInvoice(id: string, actor: AuthUser) {
    if (!can('payroll.approve', actor.role)) {
      throw new ForbiddenException('Your role cannot approve payroll');
    }
    const invoice = await this.prisma.payrollInvoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Payroll invoice not found');
    if (invoice.status !== PayrollInvoiceStatus.SUBMITTED) {
      throw new BadRequestException(`Only a submitted invoice can be approved — this one is ${invoice.status}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payrollInvoice.update({
        where: { id },
        data: { status: PayrollInvoiceStatus.APPROVED, reviewedAt: new Date(), reviewedById: actor.id },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'PAYROLL_APPROVED',
          detail: `Payroll approved for ${dayKey(invoice.periodStart)} to ${dayKey(invoice.periodEnd)}`,
          payload: {
            from: dayKey(invoice.periodStart),
            to: dayKey(invoice.periodEnd),
            userId: invoice.userId,
            gross: invoice.gross.toString(),
          },
        },
        tx,
      );
      return updated;
    });
  }

  async rejectInvoice(id: string, dto: RejectPayrollInvoiceDto, actor: AuthUser) {
    if (!can('payroll.approve', actor.role)) {
      throw new ForbiddenException('Your role cannot reject payroll');
    }
    const invoice = await this.prisma.payrollInvoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Payroll invoice not found');
    if (invoice.status !== PayrollInvoiceStatus.SUBMITTED) {
      throw new BadRequestException(`Only a submitted invoice can be rejected — this one is ${invoice.status}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payrollInvoice.update({
        where: { id },
        data: { status: PayrollInvoiceStatus.REJECTED, reviewedAt: new Date(), reviewedById: actor.id, note: dto.reason },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'PAYROLL_REJECTED',
          detail: `Payroll rejected for ${dayKey(invoice.periodStart)} to ${dayKey(invoice.periodEnd)}: ${dto.reason}`,
          payload: { from: dayKey(invoice.periodStart), to: dayKey(invoice.periodEnd), userId: invoice.userId },
        },
        tx,
      );
      return updated;
    });
  }
}
