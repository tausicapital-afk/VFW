import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, money, PAY_LABEL, shortMoney } from '../lib/format';
import { TestTag, useTestRow } from '../lib/testData';
import type { Submission, SubmissionStatus } from '../lib/types';
import { Page } from '../shell/Shell';
import { SubmissionsTable } from './Submissions';

/**
 * Fixed status order and identity colour, matching the pill palette used
 * everywhere else (see .pill.* in console.css). Colour follows the status,
 * never its rank, so a status keeps its colour whichever others are present.
 * VOIDED is left out — it never appears in /api/submissions (soft-deleted).
 */
const STATUS_ORDER: SubmissionStatus[] = ['PENDING', 'RETURNED', 'APPROVED', 'EXPORTED', 'REJECTED', 'DRAFT'];
const STATUS_SHORT: Record<SubmissionStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  RETURNED: 'Returned',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPORTED: 'Exported',
  VOIDED: 'Voided',
};
const STATUS_COLOR: Record<SubmissionStatus, string> = {
  DRAFT: 'var(--muted)',
  PENDING: 'var(--amber)',
  RETURNED: 'var(--violet)',
  APPROVED: 'var(--green)',
  REJECTED: 'var(--red)',
  EXPORTED: 'var(--blue)',
  VOIDED: 'var(--ink-3)',
};

/** Shared chart chrome so all three charts read as one system. */
const tooltipStyle = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  fontSize: 12,
  boxShadow: 'var(--shadow)',
};
const axisTick = { fill: 'var(--muted)', fontSize: 11 };

/** Live FX to CAD (the reporting currency), served by /api/fx with a manual
 *  fallback. The dashboard converts each figure through these before summing. */
interface FxResponse {
  rates: Record<string, number>;
  source: 'live' | 'manual';
  asOf: string;
}

function Kpi({
  label, value, sub, accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'accent' | 'ok' | 'amber' | 'red';
}) {
  return (
    <div className={'kpi' + (accent ? ' ' + accent : '')}>
      <div className="lb">{label}</div>
      <div className="vl">{value}</div>
      {sub && <div className="dt">{sub}</div>}
    </div>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const testRow = useTestRow();

  const { data: subs, isLoading } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => api.get<Submission[]>('/api/submissions'),
  });

  const { data: fx } = useQuery({
    queryKey: ['fx'],
    queryFn: () => api.get<FxResponse>('/api/fx'),
    staleTime: 30 * 60 * 1000,
  });

  const rates = fx?.rates ?? { CAD: 1 };
  const toCAD = (v: string, cur: string) => Number(v) * (rates[cur] ?? 1);

  // The list is already rep-scoped by the server, so for a sales rep every figure
  // below is *their own*; for Accounting/Managers it is the whole book.
  const rows = subs ?? [];
  const approved = rows.filter((s) => s.status === 'APPROVED' || s.status === 'EXPORTED');
  const pending = rows.filter((s) => s.status === 'PENDING');

  const revenue = approved.reduce((t, s) => t + toCAD(s.taxable, s.currency), 0);
  const collected = approved.reduce((t, s) => t + toCAD(s.paidAmount, s.currency), 0);
  const outstanding = approved.reduce((t, s) => t + toCAD(s.balance, s.currency), 0);
  const paymentsMade = approved.reduce((t, s) => t + s.payments.length, 0);

  const isAccounting = can('submission.approve', user?.role);
  // Same row-scoping /api/submissions already applies server-side (scopeFor in
  // submissions.service.ts): ACCT/MGR/ADMIN get every rep's rows, everyone else
  // gets only their own. This just decides how the charts below are labelled.
  const seesAll = can('submission.viewAll', user?.role);

  // Upcoming debt collection: approved sales still owing, soonest show first so
  // the money that has to be chased before its show sits at the top.
  const owing = approved
    .filter((s) => Number(s.balance) > 0)
    .sort((a, b) => {
      const ad = a.showDate ? Date.parse(a.showDate) : Number.POSITIVE_INFINITY;
      const bd = b.showDate ? Date.parse(b.showDate) : Number.POSITIVE_INFINITY;
      return ad - bd;
    });

  // --- Chart data, all derived client-side from the same `rows` already in
  // memory — no extra endpoint. Dated the same way reports.service.ts dates
  // "booked" revenue: submittedAt, since a submission is only ever approved
  // after being sent.
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-CA', { month: 'short' }) };
  });
  const revenueTrend = months.map(({ key, label }) => ({
    month: label,
    revenue: approved.reduce((t, s) => {
      if (!s.submittedAt) return t;
      const d = new Date(s.submittedAt);
      return `${d.getFullYear()}-${d.getMonth()}` === key ? t + toCAD(s.taxable, s.currency) : t;
    }, 0),
  }));
  const hasRevenueTrend = revenueTrend.some((m) => m.revenue > 0);

  const statusBreakdown = STATUS_ORDER
    .map((status) => ({ status, label: STATUS_SHORT[status], count: rows.filter((s) => s.status === status).length }))
    .filter((d) => d.count > 0);

  const packageTotals = new Map<string, number>();
  approved.forEach((s) => {
    const name = s.packageNameOverride || s.package.name;
    packageTotals.set(name, (packageTotals.get(name) ?? 0) + toCAD(s.taxable, s.currency));
  });
  const topPackages = Array.from(packageTotals, ([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return (
    <Page
      crumb="Console"
      title="Dashboard"
      actions={
        can('submission.create', user?.role) ? (
          <Link className="btn primary" to="/new">New submission</Link>
        ) : null
      }
    >
      <div className="kpis">
        <Kpi
          label={isAccounting ? 'Net revenue (approved)' : 'My net revenue'}
          value={shortMoney(revenue, 'CAD')}
          sub={`${approved.length} approved · CAD`}
          accent="accent"
        />
        <Kpi
          label="Collected"
          value={shortMoney(collected, 'CAD')}
          sub={`${paymentsMade} payment${paymentsMade === 1 ? '' : 's'} recorded`}
          accent="ok"
        />
        <Kpi
          label="Upcoming debt collection"
          value={shortMoney(outstanding, 'CAD')}
          sub={owing.length ? `${owing.length} sale${owing.length === 1 ? '' : 's'} owing` : 'Nothing outstanding'}
          accent={outstanding > 0 ? 'amber' : 'ok'}
        />
        <Kpi
          label={isAccounting ? 'Awaiting your approval' : 'Awaiting accounting'}
          value={String(pending.length)}
          sub={pending.length ? 'Needs review' : 'Queue is clear'}
          accent={pending.length ? 'red' : 'ok'}
        />
      </div>

      <div className="charts" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="hd">
            <h3>{seesAll ? 'Revenue trend' : 'My revenue trend'}</h3>
            <div className="sp" />
            <span className="sm mut">Last 6 months · CAD</span>
          </div>
          <div className="bd">
            {isLoading ? (
              <div className="empty"><h3>Loading…</h3></div>
            ) : !hasRevenueTrend ? (
              <div className="empty">
                <h3>No booked revenue yet</h3>
                <p>Approved sales will chart here once they come in.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={revenueTrend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="var(--blue)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                  <XAxis
                    dataKey="month" tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={axisTick}
                  />
                  <YAxis
                    tickLine={false} axisLine={false} width={56} tick={axisTick}
                    tickFormatter={(v: number) => shortMoney(v, 'CAD')}
                  />
                  <Tooltip
                    formatter={(v) => [money(Number(v), 'CAD'), seesAll ? 'Revenue' : 'My revenue']}
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: 'var(--text)', marginBottom: 4 }}
                    cursor={{ stroke: 'var(--line)' }}
                  />
                  <Area
                    type="monotone" dataKey="revenue" stroke="var(--blue)" strokeWidth={2}
                    fill="url(#revenueFill)" dot={{ r: 3, fill: 'var(--blue)', strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card">
          <div className="hd">
            <h3>Submission status</h3>
            <div className="sp" />
            <span className="sm mut">{rows.length} total</span>
          </div>
          <div className="bd">
            {isLoading ? (
              <div className="empty"><h3>Loading…</h3></div>
            ) : statusBreakdown.length === 0 ? (
              <div className="empty"><h3>Nothing yet</h3></div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={statusBreakdown} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={axisTick} />
                  <YAxis
                    type="category" dataKey="label" tickLine={false} axisLine={false} width={90}
                    tick={{ fill: 'var(--text)', fontSize: 12 }}
                  />
                  <Tooltip
                    formatter={(v) => [`${v} submission${Number(v) === 1 ? '' : 's'}`, '']}
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: 'var(--text)', marginBottom: 4 }}
                    cursor={{ fill: 'var(--line-soft)' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22}>
                    {statusBreakdown.map((d) => <Cell key={d.status} fill={STATUS_COLOR[d.status]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {topPackages.length > 0 && (
          <div className="card">
            <div className="hd">
              <h3>Top packages</h3>
              <div className="sp" />
              <span className="sm mut">By booked revenue · CAD</span>
            </div>
            <div className="bd">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={topPackages} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
                  <XAxis
                    type="number" tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={axisTick}
                    tickFormatter={(v: number) => shortMoney(v, 'CAD')}
                  />
                  <YAxis
                    type="category" dataKey="name" tickLine={false} axisLine={false} width={120}
                    tick={{ fill: 'var(--text)', fontSize: 12 }}
                  />
                  <Tooltip
                    formatter={(v) => [money(Number(v), 'CAD'), 'Net revenue']}
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: 'var(--text)', marginBottom: 4 }}
                    cursor={{ fill: 'var(--line-soft)' }}
                  />
                  <Bar dataKey="revenue" fill="var(--violet)" radius={[0, 4, 4, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>Upcoming debt collection</h3>
          <div className="sp" />
          {fx && (
            <span className="sm mut">
              FX {fx.source === 'live' ? 'live' : 'manual'} · {fmtDate(fx.asOf)}
            </span>
          )}
        </div>
        {isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : owing.length === 0 ? (
          <div className="empty">
            <h3>All settled</h3>
            <p>No approved sale has an outstanding balance right now.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Customer</th>
                  <th>Show date</th>
                  <th>Payment</th>
                  <th className="num">Balance due</th>
                </tr>
              </thead>
              <tbody>
                {owing.slice(0, 8).map((s) => (
                  <tr key={s.id} className={testRow(s)}>
                    <td className="mono">
                      <Link to={`/submissions/${s.id}`}>{s.ref}</Link>
                      <TestTag on={s.isTestData} />
                    </td>
                    <td>
                      <b>{s.contact.brand}</b>
                      <div className="sm mut">{s.contact.designer}</div>
                    </td>
                    <td className="sm">{s.showDate ? fmtDate(s.showDate) : '—'}</td>
                    <td><span className={'pill ' + s.payStatus}>{PAY_LABEL[s.payStatus]}</span></td>
                    <td className="num">{money(s.balance, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{isAccounting ? 'Awaiting approval' : 'My submissions'}</h3>
          <div className="sp" />
          {isAccounting && pending.length > 0 && (
            <Link className="btn sm" to="/queue">Open queue</Link>
          )}
        </div>
        {isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : (
          <SubmissionsTable rows={(isAccounting ? pending : rows).slice(0, 8)} />
        )}
      </div>
    </Page>
  );
}
