import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import type { Catalog, Submission } from '../lib/types';
import { Page } from '../shell/Shell';

const REJECT_REASONS = [
  'Pricing does not match approved rate card',
  'Discount exceeds authority',
  'Missing signed contract',
  'Tax treatment incorrect',
  'Duplicate submission',
  'Customer not credit-approved',
];

const COST_CENTRES = ['CC-100 Vancouver', 'CC-200 Kids', 'CC-300 Global', 'CC-400 Media'];

// Above this, the discount needs explicit sign-off (Settings.discountApprovalPct).
const DISCOUNT_THRESHOLD = 15;

type Action = { kind: 'approve' | 'reject' | 'return'; sub: Submission };

export function Queue() {
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);

  const { data: queue, isLoading } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Submission[]>('/api/submissions/queue'),
  });

  const { data: catalog } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.get<Catalog>('/api/catalog'),
    staleTime: Infinity,
  });

  const pending = queue?.filter((s) => s.status === 'PENDING') ?? [];
  const returned = queue?.filter((s) => s.status === 'RETURNED') ?? [];

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['queue'] });
    void qc.invalidateQueries({ queryKey: ['submissions'] });
    setAction(null);
  }

  return (
    <Page crumb="Work" title="Approval queue">
      <div className="card">
        <div className="hd">
          <h3>Pending accounting approval</h3>
          <div className="sp" />
          <span className="sm mut">{pending.length} waiting</span>
        </div>

        {isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : pending.length === 0 ? (
          <div className="empty">
            <h3>Queue is clear</h3>
            <p>Every submission has been reviewed.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Brand</th>
                  <th>Show</th>
                  <th>Rep</th>
                  <th className="num">Discount</th>
                  <th className="num">Total</th>
                  <th>Submitted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((s) => {
                  // Surface a deep discount here rather than making Accounting
                  // open the record to find it.
                  const pct = Number(s.subtotal) > 0
                    ? (Number(s.discountAmount) / Number(s.subtotal)) * 100
                    : 0;
                  return (
                    <tr key={s.id}>
                      <td className="mono">{s.ref}</td>
                      <td>
                        <b>{s.contact.brand}</b>
                        <div className="sm mut">{s.contact.designer}</div>
                      </td>
                      <td>
                        <span className={'tag ' + s.event.brand}>{s.event.brand}</span>{' '}
                        <span className="sm">{s.event.city.name}</span>
                      </td>
                      <td className="sm">{s.rep.name}</td>
                      <td className="num">
                        {pct > 0 ? (
                          pct > DISCOUNT_THRESHOLD
                            ? <span className="pill REJECTED">{pct.toFixed(1)}%</span>
                            : pct.toFixed(1) + '%'
                        ) : '—'}
                      </td>
                      <td className="num">{money(s.total, s.currency)}</td>
                      <td className="sm mut">{fmtDate(s.submittedAt)}</td>
                      <td>
                        <div className="rowflex" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn sm primary" onClick={() => setAction({ kind: 'approve', sub: s })}>
                            Approve
                          </button>
                          <button className="btn sm" onClick={() => setAction({ kind: 'return', sub: s })}>
                            Return
                          </button>
                          <button className="btn sm dgr" onClick={() => setAction({ kind: 'reject', sub: s })}>
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {returned.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="hd"><h3>Returned to sales</h3></div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Ref</th><th>Brand</th><th>Rep</th><th>Note</th></tr>
              </thead>
              <tbody>
                {returned.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.ref}</td>
                    <td>{s.contact.brand}</td>
                    <td className="sm">{s.rep.name}</td>
                    <td className="sm mut">{s.returnNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {action && (
        <ActionModal
          action={action}
          catalog={catalog}
          onClose={() => setAction(null)}
          onDone={refresh}
        />
      )}
    </Page>
  );
}

function ActionModal({
  action, catalog, onClose, onDone,
}: {
  action: Action;
  catalog?: Catalog;
  onClose: () => void;
  onDone: () => void;
}) {
  const { kind, sub } = action;
  // Default to the GL account the package is mapped to; Accounting can override.
  const [gl, setGl] = useState(sub.package.glCode);
  const [costCentre, setCostCentre] = useState(COST_CENTRES[0]);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => {
      if (kind === 'approve') {
        return api.post(`/api/submissions/${sub.id}/approve`, { glAccount: gl, costCentre });
      }
      if (kind === 'reject') {
        return api.post(`/api/submissions/${sub.id}/reject`, { reason, note: note || undefined });
      }
      return api.post(`/api/submissions/${sub.id}/return`, { note });
    },
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  const title =
    kind === 'approve' ? `Approve ${sub.ref}`
    : kind === 'reject' ? `Reject ${sub.ref}`
    : `Return ${sub.ref} to sales`;

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>{title}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>

        <div className="bd">
          <div className="totals" style={{ marginBottom: 16 }}>
            <div className="r"><span>{sub.contact.brand}</span><span>{sub.package.name}</span></div>
            <div className="r"><span>Net revenue</span><span>{money(sub.taxable, sub.currency)}</span></div>
            <div className="r"><span>Tax ({sub.taxRate}%)</span><span>{money(sub.taxAmount, sub.currency)}</span></div>
            <div className="r big"><span>Total</span><span>{money(sub.total, sub.currency)}</span></div>
          </div>

          {kind === 'approve' && (
            <div className="fields">
              <div className="f">
                <label>GL account</label>
                <select value={gl} onChange={(e) => setGl(e.target.value)}>
                  {catalog?.glAccounts.map((g) => (
                    <option key={g.code} value={g.code}>{g.code} — {g.name}</option>
                  ))}
                </select>
              </div>
              <div className="f">
                <label>Cost centre</label>
                <select value={costCentre} onChange={(e) => setCostCentre(e.target.value)}>
                  {COST_CENTRES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}

          {kind === 'reject' && (
            <>
              <div className="f">
                <label>Reason</label>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REJECT_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="f" style={{ marginTop: 10 }}>
                <label>Note to the sales representative</label>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </>
          )}

          {kind === 'return' && (
            <div className="f">
              <label>What needs to change?</label>
              <textarea
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Be specific — the rep sees this text on their form."
              />
            </div>
          )}

          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={'btn ' + (kind === 'reject' ? 'dgr' : 'primary')}
            disabled={run.isPending || (kind === 'return' && !note.trim())}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending ? 'Working…' : title}
          </button>
        </div>
      </div>
    </div>
  );
}
