import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, money, PAY_LABEL } from '../lib/format';
import type { AuditEntry, Catalog, Submission } from '../lib/types';
import { Page } from '../shell/Shell';
import { StatusPill } from './Submissions';

const PAYMENT_METHODS = [
  'Bank Transfer / Wire', 'Credit Card', 'Stripe', 'PayPal',
  'Cheque', 'Cash', 'Sponsored — No Charge',
];
const COST_CENTRES = ['CC-100 Vancouver', 'CC-200 Kids', 'CC-300 Global', 'CC-400 Media'];
const DEPARTMENTS = ['Sales', 'International', 'Kids', 'Marketing', 'Media', 'Events'];

function Row({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className={'r' + (cls ? ' ' + cls : '')}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: sub, isLoading, error } = useQuery({
    queryKey: ['submission', id],
    queryFn: () => api.get<Submission>(`/api/submissions/${id}`),
  });

  const { data: audit } = useQuery({
    queryKey: ['submission', id, 'audit'],
    queryFn: () => api.get<AuditEntry[]>(`/api/submissions/${id}/audit`),
    enabled: !!sub,
  });

  const { data: catalog } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.get<Catalog>('/api/catalog'),
    staleTime: Infinity,
    enabled: !!sub && can('accounting.fields', user?.role),
  });

  const [payOpen, setPayOpen] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['submission', id] });
    void qc.invalidateQueries({ queryKey: ['submissions'] });
    void qc.invalidateQueries({ queryKey: ['queue'] });
  }

  const invoice = useMutation({
    mutationFn: () => api.post(`/api/submissions/${id}/invoice`),
    onSuccess: refresh,
  });

  if (isLoading) {
    return <Page crumb="Work" title="Submission"><div className="empty"><h3>Loading…</h3></div></Page>;
  }

  // A rep asking for another rep's record gets the same 404 as a record that
  // does not exist, so this one branch covers both.
  if (error || !sub) {
    return (
      <Page crumb="Work" title="Not found">
        <div className="empty">
          <h3>Submission not found</h3>
          <p>It may have been opened from a stale link, or it belongs to another representative.</p>
        </div>
      </Page>
    );
  }

  const isAcct = can('accounting.fields', user?.role);
  const canEditSales =
    sub.rep.id === user?.id &&
    ['DRAFT', 'RETURNED'].includes(sub.status) &&
    can('submission.editOwn', user?.role);

  const actions = (
    <>
      <StatusPill status={sub.status} />
      {canEditSales && (
        <button className="btn primary" onClick={() => nav(`/submissions/${sub.id}/edit`)}>
          Edit &amp; resubmit
        </button>
      )}
      {sub.status === 'APPROVED' && can('invoice.generate', user?.role) && !sub.invoiceNo && (
        <button className="btn" disabled={invoice.isPending} onClick={() => invoice.mutate()}>
          {invoice.isPending ? 'Generating…' : 'Generate invoice'}
        </button>
      )}
      {(sub.status === 'APPROVED' || sub.status === 'EXPORTED') &&
        can('quickbooks.export', user?.role) && (
          <Link className="btn blue" to="/qbo">
            {sub.status === 'EXPORTED' ? 'View export' : 'Export to QuickBooks'}
          </Link>
        )}
    </>
  );

  const depositShown = Number(sub.deposit) > 0;

  return (
    <Page crumb="Work / Submissions" title={sub.ref} actions={actions}>
      {sub.status === 'RETURNED' && sub.returnNote && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <b>Returned by Accounting:</b> {sub.returnNote}
        </div>
      )}
      {sub.status === 'REJECTED' && sub.rejectReason && (
        <div className="note bad" style={{ marginBottom: 16 }}>
          <b>Rejected:</b> {sub.rejectReason}
        </div>
      )}
      {invoice.error && (
        <div className="note bad" style={{ marginBottom: 16 }}>{(invoice.error as Error).message}</div>
      )}

      <div className="split">
        <div>
          <div className="card">
            <div className="hd"><h3>Customer</h3></div>
            <div className="bd">
              <div className="totals">
                <Row label="Brand" value={sub.contact.brand} />
                <Row label="Designer" value={sub.contact.designer} />
                {sub.contact.company && <Row label="Company" value={sub.contact.company} />}
                {sub.contact.email && <Row label="Email" value={sub.contact.email} />}
                {sub.contact.country && <Row label="Country" value={sub.contact.country} />}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd">
              <h3>Event &amp; package</h3>
              <div className="sp" />
              <span className={'tag ' + sub.event.brand}>{sub.event.brand}</span>
            </div>
            <div className="bd">
              <div className="totals">
                <Row label="Show" value={sub.event.name} />
                <Row label="City" value={`${sub.event.city.name}, ${sub.event.city.country}`} />
                <Row label="Runs" value={`${fmtDate(sub.event.start)} – ${fmtDate(sub.event.end)}`} />
                <Row label="Package" value={`${sub.package.name} · ${sub.package.looks} looks`} />
                {sub.addons.length > 0 && (
                  <Row label="Add-ons" value={sub.addons.map((a) => a.addon.name).join(', ')} />
                )}
              </div>
            </div>
          </div>

          {sub.notes && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="hd"><h3>Sales notes</h3></div>
              <div className="bd"><p className="sm">{sub.notes}</p></div>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd">
              <h3>Payments received</h3>
              <div className="sp" />
              {isAcct && sub.status !== 'REJECTED' && (
                <button className="btn sm" onClick={() => setPayOpen(true)}>+ Record payment</button>
              )}
            </div>
            <div className="bd">
              {!sub.payments.length && !depositShown ? (
                <div className="empty">
                  <h3>No payments recorded</h3>
                  <p>Record the deposit or a wire to update the balance.</p>
                </div>
              ) : (
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr><th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th></tr>
                    </thead>
                    <tbody>
                      {depositShown && (
                        <tr>
                          <td className="sm mut">—</td>
                          <td className="sm">{sub.paymentMethod ?? '—'}</td>
                          <td className="mono sm">Deposit</td>
                          <td className="num">{money(sub.deposit, sub.currency)}</td>
                        </tr>
                      )}
                      {sub.payments.map((p) => (
                        <tr key={p.id}>
                          <td className="sm">{fmtDate(p.date)}</td>
                          <td className="sm">{p.method}</td>
                          <td className="mono sm">{p.reference || '—'}</td>
                          <td className="num">{money(p.amount, p.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd">
              <h3>Audit trail</h3>
              <div className="sp" />
              <span className="sm mut">Append-only. Nothing on this record is ever deleted.</span>
            </div>
            <div className="bd">
              {!audit?.length ? (
                <p className="sm mut">No entries yet.</p>
              ) : (
                <div className="log">
                  {audit.map((a) => (
                    <div className="e" key={a.id}>
                      <div className="t">
                        <b>{a.action}</b>
                        {a.detail && <> — {a.detail}</>}
                      </div>
                      <div className="m">
                        {a.actor?.name ?? 'System'} · {fmtDateTime(a.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="hd">
              <h3>Money</h3>
              <div className="sp" />
              <span className={'pill ' + sub.payStatus}>{PAY_LABEL[sub.payStatus]}</span>
            </div>
            <div className="bd">
              <div className="totals">
                <Row label="Package" value={money(sub.packagePrice, sub.currency)} />
                <Row label="Add-ons" value={money(sub.addonTotal, sub.currency)} />
                <Row label="Subtotal" value={money(sub.subtotal, sub.currency)} />
                {Number(sub.discountAmount) > 0 && (
                  <Row label="Discount" value={'− ' + money(sub.discountAmount, sub.currency)} />
                )}
                <Row label="Net revenue" value={money(sub.taxable, sub.currency)} />
                <Row label={`Tax (${sub.taxRate}%)`} value={money(sub.taxAmount, sub.currency)} />
                <Row label="Total" value={money(sub.total, sub.currency)} cls="big" />
                <Row label="Paid" value={money(sub.paidAmount, sub.currency)} />
                <Row
                  label="Balance"
                  value={money(sub.balance, sub.currency)}
                  cls={Number(sub.balance) > 0 ? 'due' : undefined}
                />
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd"><h3>Commission</h3></div>
            <div className="bd">
              <div className="totals">
                <Row label="Rate" value={`${sub.commissionPct}%`} />
                <Row label="On net revenue" value={money(sub.commissionAmount, sub.currency)} />
              </div>
              <div className="note lock" style={{ marginTop: 12 }}>
                Commission is struck on net revenue, never on tax.
              </div>
            </div>
          </div>

          {isAcct ? (
            <AccountingCard sub={sub} catalog={catalog} onSaved={refresh} />
          ) : (
            sub.glCode && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="hd"><h3>Accounting</h3></div>
                <div className="bd">
                  <div className="totals">
                    <Row label="GL account" value={sub.glCode} />
                    {sub.costCentre && <Row label="Cost centre" value={sub.costCentre} />}
                    {sub.invoiceNo && <Row label="Invoice" value={sub.invoiceNo} />}
                    <Row label="Approved" value={fmtDateTime(sub.approvedAt)} />
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {payOpen && <PaymentModal sub={sub} onClose={() => setPayOpen(false)} onDone={() => { setPayOpen(false); refresh(); }} />}
    </Page>
  );
}

function AccountingCard({
  sub, catalog, onSaved,
}: {
  sub: Submission;
  catalog?: Catalog;
  onSaved: () => void;
}) {
  const [glAccount, setGl] = useState(sub.glCode ?? '');
  const [costCentre, setCostCentre] = useState(sub.costCentre ?? '');
  const [taxCode, setTaxCode] = useState(sub.taxCode);
  const [department, setDepartment] = useState(sub.department ?? '');
  const [error, setError] = useState<string | null>(null);

  const dirty =
    glAccount !== (sub.glCode ?? '') ||
    costCentre !== (sub.costCentre ?? '') ||
    taxCode !== sub.taxCode ||
    department !== (sub.department ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/submissions/${sub.id}`, { glAccount, costCentre, taxCode, department }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="hd">
        <h3>Accounting</h3>
        <div className="sp" />
        <span className="sm mut">Every change is written to the audit trail.</span>
      </div>
      <div className="bd">
        <div className="fields">
          <div className="f">
            <label>Revenue / GL account</label>
            <select value={glAccount} onChange={(e) => setGl(e.target.value)}>
              <option value="">— none —</option>
              {catalog?.glAccounts.map((g) => (
                <option key={g.code} value={g.code}>{g.code} · {g.name}</option>
              ))}
            </select>
          </div>
          <div className="f">
            <label>Cost centre</label>
            <select value={costCentre} onChange={(e) => setCostCentre(e.target.value)}>
              <option value="">— none —</option>
              {COST_CENTRES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="f">
            <label>Department</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">— none —</option>
              {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="f">
            <label>Tax profile</label>
            <select value={taxCode} onChange={(e) => setTaxCode(e.target.value)}>
              {catalog?.taxes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
            {taxCode !== sub.taxCode && (
              <div className="help">Changing the tax profile re-prices the sale.</div>
            )}
          </div>
        </div>

        {sub.invoiceNo && (
          <div className="totals" style={{ marginTop: 12 }}>
            <Row label="Invoice" value={sub.invoiceNo} />
            {sub.qbDocNumber && <Row label="QuickBooks doc" value={sub.qbDocNumber} />}
          </div>
        )}

        {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}

        <div className="rowflex" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            disabled={!dirty || save.isPending}
            onClick={() => { setError(null); save.mutate(); }}
          >
            {save.isPending ? 'Saving…' : 'Save accounting'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({
  sub, onClose, onDone,
}: {
  sub: Submission;
  onClose: () => void;
  onDone: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState<string>(sub.balance);
  const [method, setMethod] = useState(sub.paymentMethod ?? PAYMENT_METHODS[0]);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      api.post(`/api/submissions/${sub.id}/payments`, {
        date,
        amount: Number(amount),
        method,
        reference: reference || undefined,
      }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Record payment</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="fields">
            <div className="f">
              <label>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="f">
              <label>Amount ({sub.currency})</label>
              <input
                type="number" step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <div className="help">A refund or correction is recorded as a negative amount.</div>
            </div>
            <div className="f">
              <label>Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="f">
              <label>Reference</label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="WIRE-00000" />
            </div>
          </div>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={run.isPending || amount === ''}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
