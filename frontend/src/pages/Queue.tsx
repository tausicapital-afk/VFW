import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import { effectivePackage } from '../lib/pricing';
import { TestTag, useTestRow } from '../lib/testData';
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

// Discount% for a sale, measured against the PACKAGE price — matches
// PricingService.discountApproval (discountAmount / packagePrice), never the
// subtotal. See the comment on the table cell below for why.
function discountPct(s: Submission): number {
  return Number(s.packagePrice) > 0
    ? (Number(s.discountAmount) / Number(s.packagePrice)) * 100
    : 0;
}

type Action = { kind: 'approve' | 'reject' | 'return'; sub: Submission };

export function Queue() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { user } = useAuth();
  const testRow = useTestRow();
  const [action, setAction] = useState<Action | null>(null);

  // A rep reads this screen to track their own submissions; deciding on one is
  // Accounting's job. The server enforces it either way — this only keeps a rep
  // from being offered a button that would 403.
  const canDecide = can('submission.approve', user?.role);

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
            <h3>{canDecide ? 'Queue is clear' : 'Nothing of yours is waiting'}</h3>
            <p>
              {canDecide
                ? 'Every submission has been reviewed.'
                : 'None of your submissions are waiting on accounting.'}
            </p>
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
                  {canDecide && <th />}
                </tr>
              </thead>
              <tbody>
                {pending.map((s) => {
                  // Surface a deep discount here rather than making Accounting
                  // open the record to find it.
                  //
                  // Measured against the PACKAGE price, not the subtotal, because
                  // that is the basis the approval threshold uses
                  // (PricingService: discountAmount / packagePrice). Dividing by
                  // the subtotal made every sale with add-ons look cheaper than
                  // the rule considers it — a sale 15.4% off the package could
                  // render as under the threshold and then be refused at
                  // approval, quoting a percentage the approver was never shown.
                  const pct = discountPct(s);
                  const threshold = Number(catalog?.discountApprovalPct ?? 0);
                  const overThreshold = pct > threshold;
                  // Someone (maybe this user) has already asked for the second
                  // sign-off this sale needs. Defense in depth: the backend
                  // refuses a self-confirm with a 400 regardless, but the
                  // requester should never even be offered the button.
                  const awaitingSignoff = overThreshold && !!s.discountOverrideRequestedById;
                  const isOwnRequest = s.discountOverrideRequestedById === user?.id;
                  return (
                    <tr key={s.id} className={testRow(s)}>
                      <td className="mono">
                        {s.ref}
                        <TestTag on={s.isTestData} />
                        {s.packageCustomized && (
                          <div><span className="pill RETURNED" style={{ marginTop: 4 }}>Custom package</span></div>
                        )}
                      </td>
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
                          overThreshold
                            ? <span className="pill REJECTED">{pct.toFixed(1)}%</span>
                            : pct.toFixed(1) + '%'
                        ) : '—'}
                        {awaitingSignoff && (
                          <div style={{ marginTop: 4 }}>
                            <span className="pill PENDING" title={fmtDate(s.discountOverrideRequestedAt)}>
                              {isOwnRequest
                                ? 'Awaiting 2nd sign-off (you asked)'
                                : `Awaiting 2nd sign-off — ${s.discountOverrideRequestedBy?.name ?? 'requested'}`}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="num">{money(s.total, s.currency)}</td>
                      <td className="sm mut">{fmtDate(s.submittedAt)}</td>
                      {canDecide && (
                        <td>
                          <div className="rowflex" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn sm" onClick={() => nav(`/submissions/${s.id}/edit`)}>
                              Edit
                            </button>
                            {/* The maker cannot also be the checker — don't even
                                offer a way to confirm your own override request. */}
                            {!isOwnRequest && (
                              <button className="btn sm primary" onClick={() => setAction({ kind: 'approve', sub: s })}>
                                {awaitingSignoff ? 'Confirm' : overThreshold ? 'Request sign-off' : 'Approve'}
                              </button>
                            )}
                            <button className="btn sm" onClick={() => setAction({ kind: 'return', sub: s })}>
                              Return
                            </button>
                            <button className="btn sm dgr" onClick={() => setAction({ kind: 'reject', sub: s })}>
                              Reject
                            </button>
                          </div>
                        </td>
                      )}
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
                  <tr key={s.id} className={testRow(s)}>
                    <td className="mono">{s.ref}<TestTag on={s.isTestData} /></td>
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
  const { user } = useAuth();
  // Default to the GL account the package is mapped to; Accounting can override.
  const [gl, setGl] = useState(sub.package.glCode);
  const [costCentre, setCostCentre] = useState(COST_CENTRES[0]);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [note, setNote] = useState('');
  const [ackCustomPackage, setAckCustomPackage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two-person sign-off on an over-threshold discount (Settings.discountApprovalPct,
  // via catalog — see the Queue table for why this is fetched live rather than
  // hardcoded). Four approve states: a normal under-threshold sale; the FIRST
  // touch on an over-threshold one (this call only *requests* sign-off); a
  // SECOND, different approver confirming an outstanding request; and — defense
  // in depth, since the Queue table already hides this modal's Approve button
  // from whoever made the request — the requester somehow reaching this modal
  // for their own request, which is blocked client-side too.
  const pct = discountPct(sub);
  const overThreshold = pct > Number(catalog?.discountApprovalPct ?? 0);
  const selfBlocked = overThreshold && sub.discountOverrideRequestedById === user?.id;
  const confirmingSignoff = overThreshold && !!sub.discountOverrideRequestedById && !selfBlocked;
  const requestingSignoff = overThreshold && !sub.discountOverrideRequestedById;

  const run = useMutation({
    mutationFn: () => {
      if (kind === 'approve') {
        return api.post(`/api/submissions/${sub.id}/approve`, {
          glAccount: gl,
          costCentre,
          ...(sub.packageCustomized ? { acknowledgeCustomPackage: ackCustomPackage } : {}),
        });
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
    kind === 'approve'
      ? requestingSignoff
        ? `Request sign-off — ${sub.ref}`
        : confirmingSignoff
          ? `Confirm and approve ${sub.ref}`
          : `Approve ${sub.ref}`
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

          {kind === 'approve' && overThreshold && (
            <div className={'note ' + (selfBlocked ? 'bad' : 'warn')} style={{ marginBottom: 16 }}>
              {selfBlocked ? (
                <>
                  <b>You requested this override — you cannot confirm it yourself.</b>
                  <div className="sm" style={{ marginTop: 6 }}>
                    This sale is discounted <b>{pct.toFixed(2)}%</b>, above the{' '}
                    <b>{Number(catalog?.discountApprovalPct ?? 0).toFixed(2)}%</b> that needs
                    accounting sign-off. You asked for sign-off on{' '}
                    {fmtDate(sub.discountOverrideRequestedAt)}; a different ACCT/ADMIN must confirm it.
                  </div>
                </>
              ) : confirmingSignoff ? (
                <>
                  <b>Second sign-off needed.</b>
                  <div className="sm" style={{ marginTop: 6 }}>
                    This sale is discounted <b>{pct.toFixed(2)}%</b>, above the{' '}
                    <b>{Number(catalog?.discountApprovalPct ?? 0).toFixed(2)}%</b> that needs
                    accounting sign-off. <b>{sub.discountOverrideRequestedBy?.name ?? 'A colleague'}</b>{' '}
                    requested this on {fmtDate(sub.discountOverrideRequestedAt)}. Confirming below
                    approves the sale.
                  </div>
                </>
              ) : (
                <>
                  <b>This discount needs a second person's sign-off.</b>
                  <div className="sm" style={{ marginTop: 6 }}>
                    This sale is discounted <b>{pct.toFixed(2)}%</b>, above the{' '}
                    <b>{Number(catalog?.discountApprovalPct ?? 0).toFixed(2)}%</b> threshold. Continuing
                    will record your request and notify accounting — it will NOT approve the sale.
                    A different ACCT/ADMIN will need to confirm it before it is final.
                  </div>
                </>
              )}
            </div>
          )}

          {kind === 'approve' && sub.packageCustomized && (
            <div className="note warn" style={{ marginBottom: 16 }}>
              <b>This sale uses a customized/non-catalogue package.</b>
              <div className="sm" style={{ marginTop: 6 }}>
                Rate card: <b>{sub.package.name}</b> · {sub.package.looks} looks ·{' '}
                {money(
                  sub.package.prices.find((p) => p.cityId === sub.event.cityId)?.price ?? sub.packagePrice,
                  sub.currency,
                )}
              </div>
              <div className="sm">
                Actually charged: <b>{effectivePackage(sub).name}</b> · {effectivePackage(sub).looks} looks ·{' '}
                {money(sub.packagePrice, sub.currency)}
              </div>
              <label className="chk" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={ackCustomPackage}
                  onChange={(e) => setAckCustomPackage(e.target.checked)}
                />
                <span className="t">
                  I acknowledge this customized/non-catalogue package and approve it as priced.
                </span>
              </label>
            </div>
          )}

          {kind === 'approve' && !requestingSignoff && !selfBlocked && (
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
            disabled={
              run.isPending ||
              (kind === 'return' && !note.trim()) ||
              // The custom-package sign-off only gates an actual approval —
              // requesting the discount override does not approve anything yet,
              // so it doesn't need this acknowledgment (the backend agrees: that
              // check runs after the override-request branch returns).
              (kind === 'approve' && sub.packageCustomized && !ackCustomPackage && !requestingSignoff) ||
              // The core guarantee of the two-person flow, enforced client-side
              // too: the requester cannot submit a confirmation of their own request.
              (kind === 'approve' && selfBlocked)
            }
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending
              ? 'Working…'
              : kind === 'approve' && requestingSignoff
                ? 'Request sign-off'
                : title}
          </button>
        </div>
      </div>
    </div>
  );
}
