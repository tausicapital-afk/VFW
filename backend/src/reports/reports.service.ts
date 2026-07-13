import { BadRequestException, Injectable } from '@nestjs/common';
import { Currency, Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { RepStats, ScoreWeights, parseWeights, rating, score, scoreParts } from './score';

/**
 * Reporting. Every figure here is READ-ONLY over data the rest of the system
 * already wrote — this module never prices, never posts and never mutates.
 *
 * Two rules shape all of it:
 *
 * 1. Aggregate in SQL. Postgres is where the sums belong; pulling every
 *    submission into Node and reduce()-ing it would be slower, and it would put
 *    money arithmetic back in JavaScript, where floats live.
 *
 * 2. Never add two currencies. The company sells in five. Every consolidated
 *    figure is converted to CAD (the reporting currency) with the rates in
 *    Settings.fxRates BEFORE it is summed — inside the SUM(), not after it. The
 *    rates live in the database so Accounting can change them without a deploy,
 *    so they are read on every request and never hardcoded here.
 */

export const REPORTS = {
  revenue: 'Revenue analysis',
  event: 'Sales by event',
  city: 'Sales by city',
  package: 'Package popularity',
  retention: 'Customer retention',
  ar: 'Outstanding receivables',
  collection: 'Payment collection',
  rep: 'Sales representative performance',
  feedback: 'Designer feedback trends',
  internal: 'Internal operational comments',
} as const;

export type ReportKey = keyof typeof REPORTS;
export const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[];

export interface ReportFilters {
  from?: string;
  to?: string;
  eventId?: string;
  cityId?: string;
}

export interface ReportCol {
  label: string;
  /** Right-aligned and thousands-separated by the client. */
  num?: boolean;
  /** A money column: always shown to 2dp, even when the amount is whole. An
   *  accountant reading 21,459 where 21,459.00 was meant is a bug. */
  money?: boolean;
}

/** Money columns are numeric AND carry cents. Counts and scores are not. */
const cash = (label: string): ReportCol => ({ label, num: true, money: true });

/** Money crosses the wire as a string, as everywhere else in this API. */
export type ReportCell = string | number | null;

export interface ReportTable {
  key: ReportKey;
  name: string;
  cols: ReportCol[];
  rows: ReportCell[][];
}

/**
 * Invoices in this business are Net 30 from approval. The Submission model has
 * no dueDate column, so receivables age from approvedAt rather than inventing
 * one — if terms ever become per-deal, this is the line that changes.
 */
const NET_TERMS_DAYS = 30;

const money = (v: unknown): string => new Decimal((v as Decimal.Value) ?? 0).toFixed(2);
const int = (v: unknown): number => Number(v ?? 0);

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async settings() {
    const s = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    return {
      fx: this.parseRates(s.fxRates),
      weights: parseWeights(s.scoreWeights),
    };
  }

  /** Settings.fxRates is JSON, so it is not type-checked. CAD is pinned at 1. */
  private parseRates(raw: unknown): Record<Currency, Decimal> {
    const src = (raw ?? {}) as Record<string, unknown>;
    const rates = {} as Record<Currency, Decimal>;
    for (const cur of Object.values(Currency)) {
      const v = src[cur];
      const rate = typeof v === 'number' || typeof v === 'string' ? new Decimal(v) : null;
      rates[cur] = cur === Currency.CAD ? new Decimal(1) : (rate ?? new Decimal(0));
      if (rates[cur].lte(0) && cur !== Currency.CAD) {
        throw new BadRequestException(
          `No FX rate for ${cur} in Settings. Accounting must set one before this report can be consolidated.`,
        );
      }
    }
    return rates;
  }

  /**
   * The rate table, as a joinable relation. Converting inside SQL is what keeps
   * the conversion inside the SUM — a submission's own currency is multiplied by
   * its own rate, and only CAD amounts are ever added together.
   */
  private fxSql(rates: Record<Currency, Decimal>): Prisma.Sql {
    const rows = Object.entries(rates).map(
      ([cur, rate]) => Prisma.sql`(${cur}::text, ${rate.toString()}::numeric)`,
    );
    return Prisma.sql`(VALUES ${Prisma.join(rows)}) AS fx(cur, rate)`;
  }

  /** Booked revenue is approved or exported. A draft or a quote is not revenue. */
  private where(f: ReportFilters, scope: 'booked' | 'live'): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      scope === 'booked'
        ? Prisma.sql`s.status IN ('APPROVED', 'EXPORTED')`
        : Prisma.sql`s.status <> 'DRAFT'`,
    ];
    // The mockup dates a submission by when it was sent, falling back to when it
    // was created (a draft has never been sent).
    if (f.from) {
      parts.push(Prisma.sql`COALESCE(s."submittedAt", s."createdAt")::date >= ${f.from}::date`);
    }
    if (f.to) {
      parts.push(Prisma.sql`COALESCE(s."submittedAt", s."createdAt")::date <= ${f.to}::date`);
    }
    if (f.eventId) parts.push(Prisma.sql`s."eventId" = ${f.eventId}`);
    if (f.cityId) parts.push(Prisma.sql`s."cityId" = ${f.cityId}`);
    return Prisma.join(parts, ' AND ');
  }

  async summary(key: ReportKey, f: ReportFilters): Promise<ReportTable> {
    if (!REPORT_KEYS.includes(key)) throw new BadRequestException(`Unknown report "${key}"`);
    const { fx, weights } = await this.settings();

    const build: Record<ReportKey, () => Promise<Omit<ReportTable, 'key' | 'name'>>> = {
      revenue: () => this.revenue(f),
      event: () => this.byDimension(f, fx, 'event'),
      city: () => this.byDimension(f, fx, 'city'),
      package: () => this.packages(f, fx),
      retention: () => this.retention(f, fx),
      ar: () => this.receivables(f),
      collection: () => this.collection(f, fx, weights),
      rep: () => this.repPerformance(f, fx, weights),
      feedback: () => this.feedback(),
      internal: () => this.internal(),
    };

    const table = await build[key]();
    return { key, name: REPORTS[key], ...table };
  }

  /** Per-deal detail, each row in the currency it was actually sold in. */
  private async revenue(f: ReportFilters) {
    const rows = await this.prisma.$queryRaw<
      {
        event: string;
        package: string;
        currency: string;
        net: Decimal;
        tax: Decimal;
        gross: Decimal;
        collected: Decimal;
        outstanding: Decimal;
      }[]
    >(Prisma.sql`
      SELECT e.name AS event, p.name AS package, s.currency::text AS currency,
             s.taxable AS net, s."taxAmount" AS tax, s.total AS gross,
             s."paidAmount" AS collected, GREATEST(s.balance, 0) AS outstanding
      FROM "Submission" s
      JOIN "Event" e ON e.id = s."eventId"
      JOIN "Package" p ON p.id = s."packageId"
      WHERE ${this.where(f, 'booked')}
      ORDER BY COALESCE(s."submittedAt", s."createdAt") DESC
    `);

    return {
      cols: [
        { label: 'Event' },
        { label: 'Package' },
        { label: 'Currency' },
        cash('Net revenue'),
        cash('Tax'),
        cash('Gross'),
        cash('Collected'),
        cash('Outstanding'),
      ],
      rows: rows.map((r) => [
        r.event,
        r.package,
        r.currency,
        money(r.net),
        money(r.tax),
        money(r.gross),
        money(r.collected),
        money(r.outstanding),
      ]),
    };
  }

  /** Sales by event / by city — the same aggregate over a different dimension. */
  private async byDimension(
    f: ReportFilters,
    fx: Record<Currency, Decimal>,
    dimension: 'event' | 'city',
  ) {
    const label = dimension === 'event' ? 'Event' : 'City';
    const key =
      dimension === 'event' ? Prisma.sql`e.name` : Prisma.sql`c.name`;

    const rows = await this.prisma.$queryRaw<
      { k: string; deals: number; net: Decimal; tax: Decimal; gross: Decimal; paid: Decimal }[]
    >(Prisma.sql`
      SELECT ${key} AS k,
             COUNT(*)::int AS deals,
             ROUND(SUM(s.taxable      * fx.rate), 2) AS net,
             ROUND(SUM(s."taxAmount"  * fx.rate), 2) AS tax,
             ROUND(SUM(s.total        * fx.rate), 2) AS gross,
             ROUND(SUM(s."paidAmount" * fx.rate), 2) AS paid
      FROM "Submission" s
      JOIN "Event" e ON e.id = s."eventId"
      JOIN "City" c ON c.id = s."cityId"
      JOIN ${this.fxSql(fx)} ON fx.cur = s.currency::text
      WHERE ${this.where(f, 'booked')}
      GROUP BY ${key}
      ORDER BY net DESC
    `);

    return {
      cols: [
        { label },
        { label: 'Deals', num: true },
        cash('Net (CAD)'),
        cash('Tax (CAD)'),
        cash('Gross (CAD)'),
        cash('Collected (CAD)'),
        cash('Outstanding (CAD)'),
      ],
      rows: rows.map((r) => [
        r.k,
        r.deals,
        money(r.net),
        money(r.tax),
        money(r.gross),
        money(r.paid),
        money(new Decimal(r.gross ?? 0).minus(r.paid ?? 0)),
      ]),
    };
  }

  private async packages(f: ReportFilters, fx: Record<Currency, Decimal>) {
    const rows = await this.prisma.$queryRaw<
      { k: string; units: number; net: Decimal; avg: Decimal }[]
    >(Prisma.sql`
      SELECT p.name AS k,
             COUNT(*)::int AS units,
             ROUND(SUM(s.taxable * fx.rate), 2) AS net,
             ROUND(AVG(s.taxable * fx.rate), 2) AS avg
      FROM "Submission" s
      JOIN "Package" p ON p.id = s."packageId"
      JOIN ${this.fxSql(fx)} ON fx.cur = s.currency::text
      WHERE ${this.where(f, 'booked')}
      GROUP BY p.name
      ORDER BY units DESC, net DESC
    `);

    return {
      cols: [
        { label: 'Package' },
        { label: 'Units sold', num: true },
        cash('Net revenue (CAD)'),
        cash('Average deal (CAD)'),
      ],
      rows: rows.map((r) => [r.k, r.units, money(r.net), money(r.avg)]),
    };
  }

  /**
   * Retention counts every live submission (a rejected deal still means the
   * customer came back), but lifetime value counts only what was booked.
   */
  private async retention(f: ReportFilters, fx: Record<Currency, Decimal>) {
    const rows = await this.prisma.$queryRaw<
      { brand: string; bookings: number; net: Decimal; rep: string }[]
    >(Prisma.sql`
      SELECT ct.brand AS brand,
             COUNT(*)::int AS bookings,
             ROUND(
               SUM(CASE WHEN s.status IN ('APPROVED', 'EXPORTED')
                        THEN s.taxable * fx.rate ELSE 0 END), 2) AS net,
             (array_agg(u.name ORDER BY s."createdAt" DESC))[1] AS rep
      FROM "Submission" s
      JOIN "Contact" ct ON ct.id = s."contactId"
      JOIN "User" u ON u.id = s."repId"
      JOIN ${this.fxSql(fx)} ON fx.cur = s.currency::text
      WHERE ${this.where(f, 'live')}
      GROUP BY ct.brand
      ORDER BY bookings DESC, net DESC
    `);

    return {
      cols: [
        { label: 'Customer' },
        { label: 'Bookings', num: true },
        cash('Lifetime net (CAD)'),
        { label: 'Rep' },
        { label: 'Returning' },
      ],
      rows: rows.map((r) => [
        r.brand,
        r.bookings,
        money(r.net),
        r.rep,
        r.bookings > 1 ? 'Yes' : 'No',
      ]),
    };
  }

  /** Open receivables, oldest due first. Each row stays in its own currency. */
  private async receivables(f: ReportFilters) {
    const rows = await this.prisma.$queryRaw<
      {
        ref: string;
        brand: string;
        due: Date | null;
        daysToDue: number | null;
        total: Decimal;
        paid: Decimal;
        balance: Decimal;
        currency: string;
      }[]
    >(Prisma.sql`
      SELECT s.ref,
             ct.brand,
             (COALESCE(s."approvedAt", s."createdAt") + ${`${NET_TERMS_DAYS} days`}::interval)::date AS due,
             ((COALESCE(s."approvedAt", s."createdAt") + ${`${NET_TERMS_DAYS} days`}::interval)::date
               - CURRENT_DATE)::int AS "daysToDue",
             s.total, s."paidAmount" AS paid, s.balance, s.currency::text AS currency
      FROM "Submission" s
      JOIN "Contact" ct ON ct.id = s."contactId"
      WHERE ${this.where(f, 'booked')} AND s.balance > 0.01
      ORDER BY due ASC
    `);

    return {
      cols: [
        { label: 'Ref' },
        { label: 'Customer' },
        { label: `Due (Net ${NET_TERMS_DAYS})` },
        { label: 'Days to due', num: true },
        cash('Total'),
        cash('Paid'),
        cash('Outstanding'),
        { label: 'Currency' },
      ],
      rows: rows.map((r) => [
        r.ref,
        r.brand,
        r.due ? r.due.toISOString().slice(0, 10) : null,
        r.daysToDue,
        money(r.total),
        money(r.paid),
        money(r.balance),
        r.currency,
      ]),
    };
  }

  private async collection(
    f: ReportFilters,
    fx: Record<Currency, Decimal>,
    weights: ScoreWeights,
  ) {
    const reps = await this.repRows(f, fx, weights);
    return {
      cols: [
        { label: 'Representative' },
        cash('Invoiced (CAD)'),
        cash('Collected (CAD)'),
        cash('Outstanding (CAD)'),
        { label: 'Collection rate', num: true },
      ],
      rows: reps.map((r) => [
        r.name,
        r.invoiced,
        r.collected,
        r.outstanding,
        `${Math.round(r.parts.collection * 100)}%`,
      ]),
    };
  }

  private async repPerformance(
    f: ReportFilters,
    fx: Record<Currency, Decimal>,
    weights: ScoreWeights,
  ) {
    const reps = await this.repRows(f, fx, weights);
    return {
      cols: [
        { label: 'Representative' },
        { label: 'Submissions', num: true },
        { label: 'Approved', num: true },
        { label: 'Rejected', num: true },
        cash('Net revenue (CAD)'),
        cash('Target'),
        { label: 'Target %', num: true },
        { label: 'Score', num: true },
        { label: 'Rating' },
      ],
      rows: reps.map((r) => [
        r.name,
        r.count,
        r.approvedCount,
        r.rejectedCount,
        r.revenue,
        r.target,
        `${r.targetPct}%`,
        r.score,
        r.rating.label,
      ]),
    };
  }

  private async feedback() {
    const rows = await this.prisma.designerFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        contact: { select: { brand: true, designer: true } },
        recordedBy: { select: { name: true } },
      },
    });

    return {
      cols: [
        { label: 'Brand' },
        { label: 'Designer' },
        { label: 'Rating', num: true },
        { label: 'Notes' },
        { label: 'Recorded by' },
        { label: 'Date' },
      ],
      rows: rows.map((r) => [
        r.contact.brand,
        r.contact.designer || '—',
        r.rating,
        r.body ?? '—',
        r.recordedBy.name,
        r.createdAt.toISOString().slice(0, 10),
      ]),
    };
  }

  private async internal() {
    const rows = await this.prisma.internalComment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        submission: {
          select: { ref: true, contact: { select: { brand: true } }, rep: { select: { name: true } } },
        },
        author: { select: { name: true } },
      },
    });

    return {
      cols: [
        { label: 'Department' },
        { label: 'Deal' },
        { label: 'Rep' },
        { label: 'Observation' },
        { label: 'Logged by' },
        { label: 'Date' },
      ],
      rows: rows.map((c) => [
        c.department,
        `${c.submission.ref} · ${c.submission.contact.brand}`,
        c.submission.rep.name,
        c.body,
        c.author.name,
        c.createdAt.toISOString().slice(0, 10),
      ]),
    };
  }

  /**
   * The leaderboard, and the source of the `rep` and `collection` reports —
   * one definition of a rep's numbers, not three that can drift apart.
   *
   * Note what this query touches: Submission, User, Contact. It does not join
   * InternalComment or DesignerFeedback, and it could not use them if it wanted
   * to — score() has no parameter for them. Coaching inputs do not move the
   * ranking, and this is where that promise is kept.
   */
  async repRows(f: ReportFilters, fx: Record<Currency, Decimal>, weights: ScoreWeights) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        employeeId: string | null;
        colour: string;
        target: Decimal;
        count: number;
        approvedCount: number;
        rejectedCount: number;
        pendingCount: number;
        decidedCount: number;
        revenue: Decimal;
        invoiced: Decimal;
        collected: Decimal;
        outstanding: Decimal;
        commission: Decimal;
        commissionPending: Decimal;
        customerCount: number;
        repeatCount: number;
      }[]
    >(Prisma.sql`
      WITH live AS (
        SELECT s.*, fx.rate
        FROM "Submission" s
        JOIN ${this.fxSql(fx)} ON fx.cur = s.currency::text
        WHERE ${this.where(f, 'live')}
      ),
      -- A customer is "returning" when they have booked more than once with the
      -- same rep. Counted per rep, in SQL, not by reducing rows in Node.
      customers AS (
        SELECT "repId", "contactId", COUNT(*)::int AS bookings
        FROM live GROUP BY "repId", "contactId"
      ),
      per_rep AS (
        SELECT "repId",
               COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE status IN ('APPROVED', 'EXPORTED'))::int AS "approvedCount",
               COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS "rejectedCount",
               COUNT(*) FILTER (WHERE status IN ('PENDING', 'RETURNED'))::int AS "pendingCount",
               COUNT(*) FILTER (WHERE status IN ('APPROVED', 'EXPORTED', 'REJECTED'))::int AS "decidedCount",
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') THEN taxable * rate ELSE 0 END), 2) AS revenue,
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') THEN total * rate ELSE 0 END), 2) AS invoiced,
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') THEN "paidAmount" * rate ELSE 0 END), 2) AS collected,
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') THEN GREATEST(balance, 0) * rate ELSE 0 END), 2) AS outstanding,
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') THEN "commissionAmount" * rate ELSE 0 END), 2) AS commission,
               ROUND(SUM(CASE WHEN status IN ('APPROVED', 'EXPORTED') AND "payStatus" <> 'PAID'
                              THEN "commissionAmount" * rate ELSE 0 END), 2) AS "commissionPending"
        FROM live GROUP BY "repId"
      ),
      per_rep_customers AS (
        SELECT "repId",
               COUNT(*)::int AS "customerCount",
               COUNT(*) FILTER (WHERE bookings > 1)::int AS "repeatCount"
        FROM customers GROUP BY "repId"
      )
      SELECT u.id, u.name, u."employeeId", u.colour, u.target,
             COALESCE(r.count, 0) AS count,
             COALESCE(r."approvedCount", 0) AS "approvedCount",
             COALESCE(r."rejectedCount", 0) AS "rejectedCount",
             COALESCE(r."pendingCount", 0) AS "pendingCount",
             COALESCE(r."decidedCount", 0) AS "decidedCount",
             COALESCE(r.revenue, 0) AS revenue,
             COALESCE(r.invoiced, 0) AS invoiced,
             COALESCE(r.collected, 0) AS collected,
             COALESCE(r.outstanding, 0) AS outstanding,
             COALESCE(r.commission, 0) AS commission,
             COALESCE(r."commissionPending", 0) AS "commissionPending",
             COALESCE(c."customerCount", 0) AS "customerCount",
             COALESCE(c."repeatCount", 0) AS "repeatCount"
      FROM "User" u
      LEFT JOIN per_rep r ON r."repId" = u.id
      LEFT JOIN per_rep_customers c ON c."repId" = u.id
      WHERE u.role = 'SALES' AND u.status = 'ACTIVE'
    `);

    return rows
      .map((r) => {
        const stats: RepStats = {
          revenue: r.revenue ?? 0,
          invoiced: r.invoiced ?? 0,
          collected: r.collected ?? 0,
          decidedCount: int(r.decidedCount),
          approvedCount: int(r.approvedCount),
          customerCount: int(r.customerCount),
          repeatCount: int(r.repeatCount),
          target: r.target ?? 0,
        };
        const sc = score(stats, weights);
        const target = new Decimal(r.target ?? 0);
        return {
          id: r.id,
          name: r.name,
          employeeId: r.employeeId,
          colour: r.colour,
          count: int(r.count),
          approvedCount: int(r.approvedCount),
          rejectedCount: int(r.rejectedCount),
          pendingCount: int(r.pendingCount),
          decidedCount: int(r.decidedCount),
          revenue: money(r.revenue),
          invoiced: money(r.invoiced),
          collected: money(r.collected),
          outstanding: money(r.outstanding),
          commission: money(r.commission),
          commissionPending: money(r.commissionPending),
          customerCount: int(r.customerCount),
          repeatCount: int(r.repeatCount),
          target: money(target),
          targetPct: target.gt(0)
            ? Math.round(new Decimal(r.revenue ?? 0).dividedBy(target).times(100).toNumber())
            : 0,
          parts: scoreParts(stats),
          score: sc,
          rating: rating(sc),
        };
      })
      .sort((a, b) => b.score - a.score || Number(b.revenue) - Number(a.revenue))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  async leaderboard(f: ReportFilters) {
    const { fx, weights } = await this.settings();
    const reps = await this.repRows(f, fx, weights);
    return { weights, reps };
  }
}
