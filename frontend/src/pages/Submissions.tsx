import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, money, STATUS_LABEL } from '../lib/format';
import type { Submission } from '../lib/types';
import { ExportMenu } from '../shell/ExportMenu';
import { Page } from '../shell/Shell';

export function StatusPill({ status }: { status: Submission['status'] }) {
  return <span className={'pill ' + status}>{STATUS_LABEL[status]}</span>;
}

export function SubmissionsTable({ rows }: { rows: Submission[] }) {
  if (!rows.length) {
    return (
      <div className="empty">
        <h3>Nothing here yet</h3>
        <p>Submissions will appear as they are created.</p>
      </div>
    );
  }
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Brand</th>
            <th>Show</th>
            <th>Package</th>
            <th>Rep</th>
            <th className="num">Total</th>
            <th>Status</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="mono">
                <Link to={`/submissions/${s.id}`}>{s.ref}</Link>
              </td>
              <td>
                <b>{s.contact.brand}</b>
                <div className="sm mut">{s.contact.designer}</div>
              </td>
              <td>
                <span className={'tag ' + s.event.brand}>{s.event.brand}</span>{' '}
                <span className="sm">{s.event.city.name}</span>
              </td>
              <td className="sm">{s.package.name}</td>
              <td className="sm">{s.rep.name}</td>
              <td className="num">{money(s.total, s.currency)}</td>
              <td><StatusPill status={s.status} /></td>
              <td className="sm mut">{fmtDate(s.submittedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Submissions() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const created = params.get('created');

  const { data, isLoading } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => api.get<Submission[]>('/api/submissions'),
  });

  // Voided sales are hidden from the main list; the roles that can restore them
  // get a toggle to review them and open one to restore.
  const canVoid = can('submission.void', user?.role);
  const [showVoided, setShowVoided] = useState(false);
  const { data: voided, isLoading: voidedLoading } = useQuery({
    queryKey: ['submissions', 'voided'],
    queryFn: () => api.get<Submission[]>('/api/submissions/voided'),
    enabled: canVoid && showVoided,
  });

  const scope = can('submission.viewAll', user?.role)
    ? 'Every submission across all shows.'
    : 'Your own customers only.';

  return (
    <Page crumb="Work" title="Submissions">
      {created && (
        <div className="note good" style={{ marginBottom: 16 }}>
          <b className="mono">{created}</b> was sent to Accounting for approval.
        </div>
      )}
      <div className="card">
        <div className="hd">
          <h3>{showVoided ? 'Voided submissions' : 'Submissions'}</h3>
          <div className="sp" />
          {canVoid && (
            <button className="btn sm" onClick={() => setShowVoided((v) => !v)}>
              {showVoided ? 'Back to active' : 'Show voided'}
            </button>
          )}
          {/* Exports what this table shows — the server re-applies the same
              scope, so a rep's file holds only their own customers. */}
          {!showVoided && (
            <ExportMenu dataset="submissions" disabled={isLoading || !data?.length} />
          )}
          <span className="sm mut">{showVoided ? 'Soft-deleted — open one to restore.' : scope}</span>
        </div>
        {showVoided ? (
          voidedLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : voided?.length ? (
            <SubmissionsTable rows={voided} />
          ) : (
            <div className="empty"><h3>Nothing voided</h3><p>No submissions have been voided.</p></div>
          )
        ) : isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : (
          <SubmissionsTable rows={data ?? []} />
        )}
      </div>
    </Page>
  );
}
