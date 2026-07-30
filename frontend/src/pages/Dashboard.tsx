import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, money, PAY_LABEL, shortMoney } from '../lib/format';
import type { Submission } from '../lib/types';
import { Page } from '../shell/Shell';
import { SubmissionsTable } from './Submissions';

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

  // Upcoming debt collection: approved sales still owing, soonest show first so
  // the money that has to be chased before its show sits at the top.
  const owing = approved
    .filter((s) => Number(s.balance) > 0)
    .sort((a, b) => {
      const ad = a.showDate ? Date.parse(a.showDate) : Number.POSITIVE_INFINITY;
      const bd = b.showDate ? Date.parse(b.showDate) : Number.POSITIVE_INFINITY;
      return ad - bd;
    });

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
                  <tr key={s.id}>
                    <td className="mono"><Link to={`/submissions/${s.id}`}>{s.ref}</Link></td>
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
