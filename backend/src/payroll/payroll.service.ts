import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Currency, PayType, Prisma, UserStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { can } from '../common/acl';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { avatarUrl } from '../profile/avatar';
import { currentMonth, monthRange, summarise } from '../attendance/attendance.service';
import { PayrollQueryDto } from './dto';

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
  commission: Decimal;
  commissionUnpaid: Decimal;
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
   */
  private async salesByRep(range: { gte: Date; lt: Date }, fx: Record<Currency, Decimal>) {
    const sales = await this.prisma.submission.findMany({
      where: {
        status: { in: ['APPROVED', 'EXPORTED'] },
        approvedAt: range,
      },
      select: {
        repId: true,
        currency: true,
        taxable: true,
        total: true,
        commissionAmount: true,
        payStatus: true,
      },
    });

    const zero = () => ({
      count: 0,
      revenue: new Decimal(0),
      invoiced: new Decimal(0),
      commission: new Decimal(0),
      commissionUnpaid: new Decimal(0),
    });
    const byRep = new Map<string, ReturnType<typeof zero>>();

    for (const sale of sales) {
      const rate = fx[sale.currency];
      const acc = byRep.get(sale.repId) ?? zero();
      const commission = new Decimal(sale.commissionAmount.toString()).times(rate);

      acc.count += 1;
      acc.revenue = acc.revenue.plus(new Decimal(sale.taxable.toString()).times(rate));
      acc.invoiced = acc.invoiced.plus(new Decimal(sale.total.toString()).times(rate));
      acc.commission = acc.commission.plus(commission);
      // Earned, but sitting against an invoice the client has not settled. Not
      // deducted — just declared, so whoever signs the run can see the exposure.
      if (sale.payStatus !== 'PAID') {
        acc.commissionUnpaid = acc.commissionUnpaid.plus(commission);
      }

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
        commission: commission.toFixed(2),
        commissionUnpaid: (sales?.commissionUnpaid ?? new Decimal(0)).toFixed(2),
        gross: base.plus(commission).toFixed(2),
      },
    };
  }

  /** One person's statement for the month. */
  async statementFor(query: PayrollQueryDto, actor: AuthUser) {
    const userId = await this.subject(query.userId, actor);
    const month = query.month ?? currentMonth();
    const range = monthRange(month);

    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PERSON_FIELDS,
    });
    if (!person) throw new NotFoundException('User not found');

    const fx = await this.fxRates();
    const sales = (await this.salesByRep(range, fx)).get(userId);
    const attendance = (await this.attendanceByUser(range, [userId])).get(userId);

    return {
      month,
      self: userId === actor.id,
      ...(await this.statement(person, sales, attendance)),
    };
  }

  /**
   * Everyone's month, one statement each, plus the run total.
   *
   * Includes accounts that earned nothing — a payroll run that silently omitted
   * someone is the failure mode that matters here, and it is the one nobody
   * notices until a person is not paid.
   */
  async run(query: PayrollQueryDto, actor: AuthUser) {
    if (!can('payroll.viewAll', actor.role)) {
      throw new ForbiddenException('Your role cannot view the payroll run');
    }

    const month = query.month ?? currentMonth();
    const range = monthRange(month);

    const people = await this.prisma.user.findMany({
      where: { deletedAt: null, hidden: false, status: UserStatus.ACTIVE },
      select: PERSON_FIELDS,
      orderBy: { name: 'asc' },
    });

    const fx = await this.fxRates();
    const sales = await this.salesByRep(range, fx);
    const attendance = await this.attendanceByUser(range, people.map((p) => p.id));

    const rows = await Promise.all(
      people.map((person) =>
        this.statement(person, sales.get(person.id), attendance.get(person.id)),
      ),
    );

    const total = (pick: (r: (typeof rows)[number]) => string) =>
      rows.reduce((sum, row) => sum.plus(new Decimal(pick(row))), new Decimal(0)).toFixed(2);

    return {
      month,
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
}
