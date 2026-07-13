import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { AuditPage } from '../lib/types';
import { Page } from '../shell/Shell';

/**
 * The global audit trail. Append-only and read-only: there is nothing on this
 * screen that edits or deletes an entry, because there is no endpoint that
 * would, for any role.
 */

const PAGE = 50;

// The action names double as pill classes where one exists (SUBMITTED, APPROVED,
// REJECTED…); anything else falls back to the neutral DRAFT pill, as the mockup
// does rather than inventing a class.
const PILL = ['DRAFT', 'PENDING', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPORTED'];
const pillFor = (action: string) => (PILL.includes(action) ? action : 'DRAFT');

export function Audit() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);

  const { data: actions } = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () => api.get<string[]>('/api/audit/actions'),
    staleTime: 60 * 1000,
  });

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q.trim()) params.set('q', q.trim());
  if (action) params.set('action', action);

  const { data, isLoading } = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => api.get<AuditPage>(`/api/audit?${params.toString()}`),
    // Keep the current page on screen while the next one loads, so paging and
    // typing in the search box do not blank the table.
    placeholderData: keepPreviousData,
  });

  const rows = data?.entries ?? [];
  const total = data?.total ?? 0;
  const to = Math.min(offset + PAGE, total);

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <Page crumb="Insight" title="Audit trail">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search actions, users, records…"
          value={q}
          onChange={(e) => reset(() => setQ(e.target.value))}
        />
        <select value={action} onChange={(e) => reset(() => setAction(e.target.value))}>
          <option value="">All actions</option>
          {(actions ?? []).map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
        </select>
        <button className="btn sm" onClick={() => reset(() => { setQ(''); setAction(''); })}>
          Clear
        </button>
        <div style={{ flex: 1 }} />
        <span className="sm mut">{total} events · append-only</span>
      </div>

      <div className="card">
        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <h3>No events</h3>
              <p>Nothing matches this filter. Every state change in the system lands here.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Detail</th>
                  <th>User</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    className={e.submission ? 'clickable' : undefined}
                    onClick={() => e.submission && navigate(`/submissions/${e.submission.id}`)}
                  >
                    <td className="sm mut mono">{fmtDateTime(e.createdAt)}</td>
                    <td>
                      <span className={`pill ${pillFor(e.action)}`}>
                        {e.action.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="sm b">
                      {e.submission ? (
                        <>
                          {e.submission.ref}{' '}
                          <span className="mut">{e.submission.contact.brand}</span>
                        </>
                      ) : '—'}
                    </td>
                    <td className="sm">{e.detail ?? '—'}</td>
                    <td className="sm mut">{e.actor?.name ?? 'System'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {total > PAGE && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            ← Newer
          </button>
          <button
            className="btn sm"
            disabled={to >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Older →
          </button>
          <div style={{ flex: 1 }} />
          <span className="sm mut">{offset + 1}–{to} of {total}</span>
        </div>
      )}
    </Page>
  );
}
