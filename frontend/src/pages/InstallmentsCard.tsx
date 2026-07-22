import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, money } from '../lib/format';
import type { Installment, Submission } from '../lib/types';

const PAYMENT_METHODS = [
  'Bank Transfer / Wire', 'Credit Card', 'Stripe', 'PayPal',
  'Cheque', 'Cash', 'Sponsored — No Charge',
];

const INTERVALS = [
  { key: 'monthly', label: 'Monthly', months: 1, days: 0 },
  { key: 'fortnightly', label: 'Every 2 weeks', months: 0, days: 14 },
  { key: 'weekly', label: 'Weekly', months: 0, days: 7 },
] as const;

// --- Money on this screen is integer cents ------------------------------------
// The server is the only thing allowed to decide what a sale costs, but a plan
// builder has to add up rows as the user types them. Doing that in cents means
// three instalments of a 8,624.00 balance land on 2,874.66 / 2,874.67 / 2,874.67
// and not on 8,623.99 — and the equality check against the balance is exact.

const toCents = (v: string | number): number => Math.round(Number(v || 0) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

/** Split `cents` into `n` parts; the last absorbs the rounding remainder. */
function splitEvenly(cents: number, n: number): number[] {
  const each = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? cents - each * (n - 1) : each));
}

/** Step a yyyy-mm-dd date forward, clamping to the end of a short month. */
function step(date: string, months: number, days: number): string {
  const d = new Date(date + 'T00:00:00');
  if (months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    // "The 31st, monthly" means the 30th in a 30-day month, not the 1st of the next.
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  if (days) d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (i: Installment) =>
  i.status === 'PENDING' && i.dueDate.slice(0, 10) < today();

/**
 * The payment plan: how a client has agreed to pay this sale down, and how far
 * through it they are.
 *
 * Everyone who can open the sale sees this card — a rep should not have to ask
 * Accounting whether their designer is up to date. Setting the schedule and
 * marking a line done are Accounting's, because marking one done posts a real
 * payment to the ledger and moves the balance.
 */
export function InstallmentsCard({ sub, onChanged }: { sub: Submission; onChanged: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState<Installment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canPlan = can('installment.plan', user?.role);
  const canMark = can('installment.mark', user?.role);
  const settled = sub.status === 'REJECTED' || sub.status === 'VOIDED';

  const plan = sub.installments ?? [];
  const paid = plan.filter((i) => i.status === 'PAID');
  const pending = plan.filter((i) => i.status === 'PENDING');

  const paidCents = paid.reduce((t, i) => t + toCents(i.amount), 0);
  const planCents = plan.reduce((t, i) => t + toCents(i.amount), 0);
  const pendingCents = pending.reduce((t, i) => t + toCents(i.amount), 0);
  // The schedule is meant to cover the balance exactly. It can fall out of step
  // if the sale was re-priced (a tax profile change) or a payment was recorded
  // by hand after the plan was drawn up — so say so rather than quietly showing
  // a schedule that no longer settles the sale.
  const driftCents = pendingCents - toCents(sub.balance);

  const unmark = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/submissions/${sub.id}/installments/${id}/unmark`, {}),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });

  const clear = useMutation({
    mutationFn: () => api.del(`/api/submissions/${sub.id}/installments`),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });

  const busy = unmark.isPending || clear.isPending;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="hd">
        <h3>Payment plan</h3>
        <div className="sp" />
        {plan.length > 0 && (
          <span className="sm mut" style={{ marginRight: 10 }}>
            {paid.length} of {plan.length} paid · {money(fromCents(paidCents), sub.currency)} of{' '}
            {money(fromCents(planCents), sub.currency)}
          </span>
        )}
        {canPlan && !settled && (
          <button className="btn sm" onClick={() => { setError(null); setOpen(true); }}>
            {pending.length ? 'Edit schedule' : '+ Set up plan'}
          </button>
        )}
      </div>
      <div className="bd">
        {error && <div className="note bad" style={{ marginBottom: 12 }}>{error}</div>}

        {!plan.length ? (
          <div className="empty">
            <h3>No payment plan</h3>
            <p>
              {canPlan && !settled
                ? 'Split the outstanding balance into instalments the client pays on a schedule.'
                : 'This sale is not being paid in instalments.'}
            </p>
          </div>
        ) : (
          <>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Due</th><th>Detail</th>
                    <th className="num">Amount</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {plan.map((i) => (
                    <tr key={i.id}>
                      <td className="mono sm mut">{i.seq}</td>
                      <td className={'sm' + (isOverdue(i) ? ' plan-late' : '')}>
                        {fmtDate(i.dueDate)}
                        {isOverdue(i) && <span className="sm"> · overdue</span>}
                      </td>
                      <td className="sm">
                        {i.label || <span className="mut">—</span>}
                        {i.method && <span className="mut"> · {i.method}</span>}
                        {i.status === 'PAID' && i.paidBy && (
                          <div className="sm mut">
                            Marked by {i.paidBy.name} · {fmtDateTime(i.paidAt)}
                          </div>
                        )}
                      </td>
                      <td className="num">{money(i.amount, i.currency)}</td>
                      <td><span className={'pill ' + i.status}>{i.status === 'PAID' ? 'Paid' : 'Due'}</span></td>
                      <td>
                        {canMark && !settled && (
                          i.status === 'PENDING' ? (
                            <button
                              className="btn sm"
                              disabled={busy}
                              onClick={() => { setError(null); setMarking(i); }}
                            >
                              Mark paid
                            </button>
                          ) : (
                            <button
                              className="btn sm"
                              disabled={busy}
                              title="Reverses the payment this posted, with a negative ledger entry"
                              onClick={() => {
                                setError(null);
                                if (
                                  window.confirm(
                                    `Reopen instalment ${i.seq}? The ${money(i.amount, i.currency)} ` +
                                      'payment it posted stays on the ledger and is reversed by a ' +
                                      'matching negative entry.',
                                  )
                                ) {
                                  unmark.mutate(i.id);
                                }
                              }}
                            >
                              Undo
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {driftCents !== 0 && pending.length > 0 && (
              <div className="note warn" style={{ marginTop: 12 }}>
                <b>The schedule no longer matches the balance.</b> The unpaid instalments come to{' '}
                {money(fromCents(pendingCents), sub.currency)} against a balance of{' '}
                {money(sub.balance, sub.currency)}
                {driftCents > 0
                  ? ` — ${money(fromCents(driftCents), sub.currency)} too much.`
                  : ` — ${money(fromCents(-driftCents), sub.currency)} short.`}
                {canPlan ? ' Edit the schedule to bring it back in line.' : ''}
              </div>
            )}

            {!pending.length && (
              <div className="note good" style={{ marginTop: 12 }}>
                Every instalment on this plan has been marked paid.
              </div>
            )}

            <div className="note lock" style={{ marginTop: 12 }}>
              Marking an instalment paid records a payment against this sale — the balance and pay
              status follow from the ledger, never from the plan.
            </div>

            {canPlan && !settled && pending.length > 0 && (
              <div className="rowflex" style={{ marginTop: 12 }}>
                <button
                  className="btn sm dgr"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    if (window.confirm('Remove the unpaid instalments? Paid ones are kept.')) {
                      clear.mutate();
                    }
                  }}
                >
                  {clear.isPending ? 'Removing…' : 'Remove schedule'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {open && (
        <PlanModal
          sub={sub}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); onChanged(); }}
        />
      )}
      {marking && (
        <MarkModal
          sub={sub}
          inst={marking}
          onClose={() => setMarking(null)}
          onDone={() => { setMarking(null); onChanged(); }}
        />
      )}
    </div>
  );
}

/**
 * Confirm an instalment as received. This posts a payment, so it asks for the
 * three things a reconciliation needs — when it landed, how, and the bank
 * reference — rather than assuming the schedule was right. The amount is not
 * editable: an instalment paid for a different amount is a payment, not this
 * instalment, and belongs on the ledger through "Record payment".
 */
function MarkModal({
  sub, inst, onClose, onDone,
}: {
  sub: Submission;
  inst: Installment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState(inst.method ?? sub.paymentMethod ?? PAYMENT_METHODS[0]);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      api.post(`/api/submissions/${sub.id}/installments/${inst.id}/mark`, {
        date,
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
          <h3>Mark instalment {inst.seq} paid</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="totals" style={{ marginBottom: 12 }}>
            <div className="r">
              <span>{inst.label || `Instalment ${inst.seq}`}</span>
              <span>due {fmtDate(inst.dueDate)}</span>
            </div>
            <div className="r big">
              <span>Amount</span>
              <span>{money(inst.amount, inst.currency)}</span>
            </div>
          </div>

          <div className="fields">
            <div className="f">
              <label>Received on</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="f">
              <label>Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="f wide">
              <label>Reference</label>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="WIRE-00000"
              />
            </div>
          </div>

          <div className="note lock" style={{ marginTop: 12 }}>
            This records a payment of {money(inst.amount, inst.currency)} against {sub.ref}. The
            balance and pay status follow from the ledger.
          </div>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={run.isPending || !date}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending ? 'Recording…' : 'Mark paid'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DraftLine {
  label: string;
  dueDate: string;
  amount: string;
  method: string;
}

/**
 * Build the schedule. The generator ("4 instalments, monthly from…") is the fast
 * path; every row stays editable afterwards because real terms are rarely even —
 * a deposit up front and the rest split three ways is the common shape.
 *
 * Save stays disabled until the rows add up to the balance exactly. The server
 * enforces the same rule; this only means the user finds out while they are
 * still looking at the numbers.
 */
function PlanModal({
  sub, onClose, onDone,
}: {
  sub: Submission;
  onClose: () => void;
  onDone: () => void;
}) {
  const balanceCents = toCents(sub.balance);
  const defaultMethod = sub.paymentMethod ?? PAYMENT_METHODS[0];

  const [count, setCount] = useState(3);
  const [start, setStart] = useState(today());
  const [cadence, setCadence] = useState<(typeof INTERVALS)[number]['key']>('monthly');
  const [error, setError] = useState<string | null>(null);

  const [lines, setLines] = useState<DraftLine[]>(() => {
    // Seed from the existing unpaid schedule so "Edit schedule" opens on what is
    // actually there, rather than throwing the user's terms away.
    const pending = (sub.installments ?? []).filter((i) => i.status === 'PENDING');
    if (pending.length) {
      return pending.map((i) => ({
        label: i.label ?? '',
        dueDate: i.dueDate.slice(0, 10),
        amount: Number(i.amount).toFixed(2),
        method: i.method ?? defaultMethod,
      }));
    }
    return generate(3, today(), 'monthly', balanceCents, defaultMethod);
  });

  function generate(
    n: number,
    from: string,
    every: (typeof INTERVALS)[number]['key'],
    cents: number,
    method: string,
  ): DraftLine[] {
    const spec = INTERVALS.find((i) => i.key === every) ?? INTERVALS[0];
    const amounts = splitEvenly(cents, n);
    let due = from;
    return amounts.map((a, idx) => {
      if (idx > 0) due = step(due, spec.months, spec.days);
      return {
        label: `Instalment ${idx + 1} of ${n}`,
        dueDate: due,
        amount: fromCents(a),
        method,
      };
    });
  }

  const scheduledCents = lines.reduce((t, l) => t + toCents(l.amount), 0);
  const remaining = balanceCents - scheduledCents;
  const complete = lines.length > 0 && remaining === 0 && lines.every((l) => l.dueDate);

  function patch(idx: number, field: keyof DraftLine, value: string) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }

  /** Push whatever is left (or over) onto one row, so a hand-edited plan can still tie out. */
  function absorb(idx: number) {
    setLines((ls) =>
      ls.map((l, i) => (i === idx ? { ...l, amount: fromCents(toCents(l.amount) + remaining) } : l)),
    );
  }

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/submissions/${sub.id}/installments`, {
        installments: lines.map((l) => ({
          label: l.label || undefined,
          dueDate: l.dueDate,
          amount: Number(l.amount),
          method: l.method || undefined,
        })),
      }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box wide" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Payment plan for {sub.ref}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="note" style={{ marginBottom: 12 }}>
            Scheduling the outstanding balance of <b>{money(sub.balance, sub.currency)}</b>. Anything
            already paid — deposit or otherwise — is out of this plan.
          </div>

          <div className="fields">
            <div className="f">
              <label>Instalments</label>
              <input
                type="number" min={1} max={24}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
              />
            </div>
            <div className="f">
              <label>First due</label>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="f">
              <label>Then</label>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
                {INTERVALS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
              </select>
            </div>
            <div className="f">
              <label>&nbsp;</label>
              <button
                className="btn"
                onClick={() =>
                  setLines(generate(count, start, cadence, balanceCents, defaultMethod))
                }
              >
                Split evenly
              </button>
            </div>
          </div>

          <div className="tbl-wrap" style={{ marginTop: 12 }}>
            <table className="plan-grid">
              <thead>
                <tr>
                  <th>#</th><th>Due</th><th>Label</th><th>Method</th>
                  <th className="num">Amount ({sub.currency})</th><th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="mono sm mut">{idx + 1}</td>
                    <td>
                      <input
                        type="date"
                        value={l.dueDate}
                        onChange={(e) => patch(idx, 'dueDate', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={l.label}
                        placeholder="Deposit, on signing…"
                        onChange={(e) => patch(idx, 'label', e.target.value)}
                      />
                    </td>
                    <td>
                      <select value={l.method} onChange={(e) => patch(idx, 'method', e.target.value)}>
                        {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="num">
                      <input
                        type="number" step="0.01" min="0.01"
                        style={{ textAlign: 'right' }}
                        value={l.amount}
                        onChange={(e) => patch(idx, 'amount', e.target.value)}
                      />
                    </td>
                    <td>
                      <div className="rowflex" style={{ gap: 4 }}>
                        {remaining !== 0 && (
                          <button
                            className="btn sm"
                            title="Put the remainder on this instalment"
                            onClick={() => absorb(idx)}
                          >
                            {remaining > 0 ? '+' : '−'}{fromCents(Math.abs(remaining))}
                          </button>
                        )}
                        {lines.length > 1 && (
                          <button
                            className="btn sm"
                            onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rowflex" style={{ marginTop: 10, gap: 8 }}>
            <button
              className="btn sm"
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  {
                    label: '',
                    dueDate: ls.length
                      ? step(ls[ls.length - 1].dueDate, 1, 0)
                      : start,
                    // A new row starts on whatever is still unscheduled, which is
                    // usually exactly what the user is adding it for.
                    amount: fromCents(Math.max(0, remaining)),
                    method: defaultMethod,
                  },
                ])
              }
            >
              + Add instalment
            </button>
          </div>

          <div className="totals" style={{ marginTop: 12 }}>
            <div className="r">
              <span>Scheduled</span>
              <span>{money(fromCents(scheduledCents), sub.currency)}</span>
            </div>
            <div className="r">
              <span>Balance</span>
              <span>{money(sub.balance, sub.currency)}</span>
            </div>
            <div className={'r big' + (remaining !== 0 ? ' due' : '')}>
              <span>{remaining === 0 ? 'Ties out' : remaining > 0 ? 'Still to schedule' : 'Over-scheduled'}</span>
              <span>{money(fromCents(Math.abs(remaining)), sub.currency)}</span>
            </div>
          </div>

          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!complete || save.isPending}
            title={complete ? undefined : 'The instalments must add up to the balance'}
            onClick={() => { setError(null); save.mutate(); }}
          >
            {save.isPending ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
