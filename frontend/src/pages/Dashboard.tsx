import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { shortMoney } from '../lib/format';
import type { Submission } from '../lib/types';
import { Page } from '../shell/Shell';
import { SubmissionsTable } from './Submissions';

// Consolidated figures are converted to CAD, the reporting currency. These
// rates live in Settings on the server so Accounting can change them without a
// deploy — the dashboard will read them from there once /api/reports lands.
const FX: Record<string, number> = { CAD: 1, USD: 1.37, GBP: 1.74, EUR: 1.49, JPY: 0.0092 };
const toCAD = (v: string, cur: string) => Number(v) * (FX[cur] ?? 1);

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="lb">{label}</div>
      <div className="vl mono">{value}</div>
      {sub && <div className="sb">{sub}</div>}
    </div>
  );
}

export function Dashboard() {
  const { user } = useAuth();

  const { data: subs, isLoading } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => api.get<Submission[]>('/api/submissions'),
  });

  const rows = subs ?? [];
  const approved = rows.filter((s) => s.status === 'APPROVED' || s.status === 'EXPORTED');
  const pending = rows.filter((s) => s.status === 'PENDING');

  const revenue = approved.reduce((t, s) => t + toCAD(s.taxable, s.currency), 0);
  const outstanding = approved.reduce((t, s) => t + toCAD(s.balance, s.currency), 0);
  const commission = approved.reduce((t, s) => t + toCAD(s.commissionAmount, s.currency), 0);

  const isAccounting = can('submission.approve', user?.role);

  return (
    <Page
      crumb="Console"
      title="Dashboard"
      actions={
        can('submission.create', user?.role) ? (
          <Link className="btn pri" to="/new">New submission</Link>
        ) : null
      }
    >
      <div className="kpis">
        <Kpi
          label="Net revenue (approved)"
          value={shortMoney(revenue, 'CAD')}
          sub={`${approved.length} approved · CAD`}
        />
        <Kpi
          label="Outstanding balance"
          value={shortMoney(outstanding, 'CAD')}
          sub="Approved but not collected"
        />
        <Kpi
          label={isAccounting ? 'Awaiting your approval' : 'Awaiting accounting'}
          value={String(pending.length)}
          sub={pending.length ? 'Needs review' : 'Queue is clear'}
        />
        <Kpi
          label="Commission on net"
          value={shortMoney(commission, 'CAD')}
          sub="Never struck on tax"
        />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{isAccounting ? 'Approval queue' : 'My submissions'}</h3>
          <div className="sp" style={{ flex: 1 }} />
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
