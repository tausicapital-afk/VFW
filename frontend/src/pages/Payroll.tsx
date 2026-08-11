import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { can } from '../lib/acl';
import { monthKey, monthLabel, shiftMonth } from '../lib/attendance';
import { downloadFile } from '../lib/export';
import { fmtDate, money } from '../lib/format';
import { TestTag, useTestRow } from '../lib/testData';
import type {
  PayrollInvoiceRow, PayrollInvoiceStatus, PayrollRun, PayrollSheet, PayrollStatement, PayType,
} from '../lib/types';
import { Avatar } from '../shell/Avatar';
import { ExportMenu } from '../shell/ExportMenu';
import { Page, ROLE_LABEL } from '../shell/Shell';

const INVOICE_PILL: Record<PayrollInvoiceStatus, string> = {
  SUBMITTED: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
};
const INVOICE_LABEL: Record<PayrollInvoiceStatus, string> = {
  SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected',
};

const PAY_TYPE_LABEL: Record<PayType, string> = {
  SALARY: 'Salary',
  HOURLY: 'Hourly',
  COMMISSION_ONLY: 'Commission only',
};

/**
 * The pay basis in one phrase. `payType` alone cannot say it: commission is the
 * other half, and "Salary" against a $0.00 commission line is the pill that has
 * someone opening a ticket to ask why they were not paid it.
 */
const payBasis = (payType: PayType, earnsCommission: boolean): string => {
  if (payType === 'COMMISSION_ONLY') return PAY_TYPE_LABEL[payType];
  return earnsCommission ? `${PAY_TYPE_LABEL[payType]} + commission` : PAY_TYPE_LABEL[payType];
};

/** Everything on this screen is consolidated to the reporting currency. */
const cad = (v: string) => money(v, 'CAD');

export function Payroll() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'mine' | 'run' | 'approvals'>('mine');
  const showRun = can('payroll.viewAll', user?.role);
  const showApprovals = can('payroll.approve', user?.role);

  return (
    <Page crumb="People" title="Payroll">
      {(showRun || showApprovals) && (
        <div className="tabs">
          <button className={'tab' + (tab === 'mine' ? ' on' : '')} onClick={() => setTab('mine')}>
            My pay
          </button>
          {showRun && (
            <button className={'tab' + (tab === 'run' ? ' on' : '')} onClick={() => setTab('run')}>
              Payroll run
            </button>
          )}
          {showApprovals && (
            <button
              className={'tab' + (tab === 'approvals' ? ' on' : '')}
              onClick={() => setTab('approvals')}
            >
              Approvals
            </button>
          )}
        </div>
      )}

      {tab === 'run' && showRun ? <Run /> : tab === 'approvals' && showApprovals ? <Approvals /> : <MyPay />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// One person's statement
// ---------------------------------------------------------------------------

function MyPay({ userId }: { userId?: string } = {}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [payslipError, setPayslipError] = useState<string | null>(null);
  const mine = !userId || userId === user?.id;

  const { data: sheet, error } = useQuery({
    queryKey: ['payroll', month, userId ?? 'me'],
    queryFn: () =>
      api.get<PayrollSheet>(`/api/payroll?month=${month}` + (userId ? `&userId=${userId}` : '')),
  });

  const submit = useMutation({
    mutationFn: () => api.post<PayrollInvoiceRow>('/api/payroll/submit', { month }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll'] }),
  });

  const future = month > monthKey(new Date());
  const invoice = sheet?.invoice ?? null;
  const staleSnapshot = invoice != null && invoice.gross !== sheet?.pay.gross;

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(month)}</b>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        {invoice && (
          <span className={`pill ${INVOICE_PILL[invoice.status]}`}>{INVOICE_LABEL[invoice.status]}</span>
        )}
        <div className="sp" style={{ flex: 1 }} />
        <PayslipButton month={month} userId={userId} disabled={!sheet} onError={setPayslipError} />
        {mine && (
          <button
            className="btn sm primary"
            disabled={future || invoice?.status === 'APPROVED' || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? 'Submitting…' : invoice ? 'Resubmit this month' : 'Submit this month'}
          </button>
        )}
      </div>

      {payslipError && (
        <div className="errbox" style={{ marginBottom: 12 }}>{payslipError}</div>
      )}
      {submit.isError && (
        <div className="errbox" style={{ marginBottom: 12 }}>{(submit.error as Error).message}</div>
      )}
      {error && <div className="errbox" style={{ marginBottom: 12 }}>{(error as Error).message}</div>}

      {sheet && invoice && staleSnapshot && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          The submitted figure ({money(invoice.gross, 'CAD')}) no longer matches this month's live
          statement below ({money(sheet.pay.gross, 'CAD')}) — an attendance day or a sale was
          corrected since it was submitted. {mine ? 'Resubmit to update it.' : ''}
        </div>
      )}
      {invoice?.status === 'REJECTED' && invoice.note && (
        <div className="note bad" style={{ marginBottom: 14 }}>
          <b>Rejected:</b> {invoice.note}
        </div>
      )}
      {invoice?.status === 'APPROVED' && (
        <div className="note" style={{ marginBottom: 14 }}>
          Approved {invoice.reviewedAt ? fmtDate(invoice.reviewedAt) : ''} — {money(invoice.gross, 'CAD')}.
        </div>
      )}

      {sheet && (
        <div className="split">
          <Statement statement={sheet} month={month} />
          <ProfileCard statement={sheet} />
        </div>
      )}
    </>
  );
}

/**
 * Download this month as a payslip.
 *
 * Not an `<ExportMenu>`: that renders a *table* in three formats, and a payslip
 * is one person's month with the arithmetic shown beside each figure — the two
 * spreadsheet formats would be a two-column Item/Value sheet nobody asked for.
 * So it is a single button onto a single document, the way the invoice PDF on a
 * submission is, and it goes through `downloadFile` for the same reason that one
 * does: the bytes need the session cookie, so it cannot be a bare `<a href>`.
 *
 * The error surfaces to the caller rather than inside the button, because the
 * one that matters is a 403 on somebody else's month, and that belongs beside
 * the statement it was refused for, not in a tooltip.
 */
function PayslipButton({
  month, userId, disabled, onError,
}: {
  month: string;
  userId?: string;
  disabled?: boolean;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    onError(null);
    try {
      // The server names the file (Content-Disposition); this is only the
      // fallback for a browser that cannot read the header.
      await downloadFile(
        `/api/payroll/payslip.pdf?month=${month}` + (userId ? `&userId=${userId}` : ''),
        `payslip-${month}.pdf`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not build the payslip');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="btn sm" disabled={disabled || busy} onClick={() => void run()}>
      <span className="ic">↓</span> {busy ? 'Preparing…' : 'Payslip (PDF)'}
    </button>
  );
}

/** The money, shown as arithmetic rather than as a total to be taken on faith. */
function Statement({ statement, month }: { statement: PayrollStatement; month: string }) {
  const { pay, sales, attendance } = statement;
  const unpaid = Number(pay.commissionUnpaid);

  return (
    <div className="card">
      <div className="hd">
        <h3>{monthLabel(month)}</h3>
        <div className="sp" style={{ flex: 1 }} />
        <span className={`pill ${pay.payType === 'COMMISSION_ONLY' ? 'DRAFT' : 'EXPORTED'}`}>
          {payBasis(pay.payType, pay.earnsCommission)}
        </span>
      </div>
      <div className="bd">
        <div className="totals">
          <div className="r">
            <span>
              Base pay
              {pay.payType === 'HOURLY' && (
                <span className="mut sm"> · {cad(pay.baseRate)}/h × {pay.baseHours} h</span>
              )}
              {pay.payType === 'SALARY' && <span className="mut sm"> · monthly</span>}
              {pay.payType === 'COMMISSION_ONLY' && (
                <span className="mut sm"> · not paid a base</span>
              )}
            </span>
            <span>{cad(pay.base)}</span>
          </div>
          <div className="r">
            <span>
              Commission
              <span className="mut sm">
                {/* Someone not on commission still closed the sales, so the count
                    stays; what changes is the claim about a rate they are not on.
                    A bare "0 at 8%" here is the line that gets queried. */}
                {pay.earnsCommission ? (
                  <>
                    {' '}· {sales.count} sale{sales.count === 1 ? '' : 's'} approved,{' '}
                    {cad(sales.revenue)} net at {Number(statement.user.commissionPct).toFixed(2)}%
                  </>
                ) : (
                  <>
                    {' '}· not on commission
                    {Number(pay.commission) > 0 && ' · earned before the change'}
                    {' '}· {sales.count} sale{sales.count === 1 ? '' : 's'} approved,{' '}
                    {cad(sales.revenue)} net
                  </>
                )}
              </span>
            </span>
            <span>{cad(pay.commission)}</span>
          </div>
          <div className="r big">
            <span>Gross</span>
            <span>{cad(pay.gross)}</span>
          </div>
        </div>

        {unpaid > 0 && (
          <div className="note warn" style={{ marginTop: 14 }}>
            <b>{cad(pay.commissionUnpaid)}</b> of this commission is on invoices the client has not
            settled. Commission is earned when a sale is approved, not when it is paid — so this part
            of the total is money the company has not collected yet.
          </div>
        )}

        <div className="sect" style={{ marginTop: 22 }}>
          <div className="hd"><h3>What it was worked out from</h3></div>
        </div>
        <div className="kpis">
          <Kpi label="Days worked" value={String(attendance.daysWorked)} note={`${attendance.days} recorded`} />
          <Kpi label="Hours" value={attendance.hours} note={`${attendance.avgHours}h average day`} />
          <Kpi label="Sales approved" value={String(sales.count)} note={cad(sales.invoiced) + ' invoiced'} />
          <Kpi label="Net revenue" value={cad(sales.revenue)} note="commission is struck on this" accent />
        </div>
        <div className="note" style={{ marginTop: 14 }}>
          Hours come from the <a href="/attendance">Attendance</a> module. Commission is struck on net
          revenue — never on tax — at the rate recorded on each sale when it was created, so changing
          someone's rate today moves their next sale and not one already on the books.
        </div>
      </div>
    </div>
  );
}

/** The full profile, which is the other half of what a payroll screen is for. */
function ProfileCard({ statement }: { statement: PayrollStatement }) {
  const u = statement.user;
  return (
    <div className="card">
      <div className="hd"><h3>{u.name}</h3></div>
      <div className="bd">
        <div className="rowflex" style={{ gap: 14, marginBottom: 18 }}>
          <Avatar name={u.name} colour={u.colour} src={u.avatarUrl} size={56} />
          <div style={{ minWidth: 0 }}>
            <div className="b" style={{ fontSize: 15 }}>{u.title ?? ROLE_LABEL[u.role]}</div>
            <div className="mut sm">{u.department ?? '—'}</div>
          </div>
        </div>

        <div className="fields">
          <Field label="Role" value={ROLE_LABEL[u.role]} />
          <Field label="Employee ID" value={u.employeeId ?? '—'} />
          <Field label="Email" value={u.email} />
          <Field label="Phone" value={u.phone ?? '—'} />
          <Field label="Joined" value={fmtDate(u.createdAt)} />
          <Field label="Paid on" value={payBasis(statement.pay.payType, statement.pay.earnsCommission)} />
          <Field
            label="Base rate"
            value={
              statement.pay.payType === 'COMMISSION_ONLY'
                ? '—'
                : cad(u.baseRate) + (statement.pay.payType === 'HOURLY' ? ' / hour' : ' / month')
            }
          />
          <Field
            label="Commission"
            value={statement.pay.earnsCommission ? `${Number(u.commissionPct).toFixed(2)}%` : '—'}
          />
          <Field label="Sales target" value={cad(u.target)} />
          <Field label="Total earned since joining" value={cad(u.lifetimeEarned)} />
        </div>

        <div className="note lock" style={{ marginTop: 14 }}>
          Pay setup is changed in Administration → Users &amp; roles.
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="f">
      <label>{label}</label>
      <input value={value} readOnly />
    </div>
  );
}

function Kpi({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className={'kpi' + (accent ? ' accent' : '')}>
      <div className="lb">{label}</div>
      <div className="vl">{value}</div>
      <div className="dt">{note}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function Run() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  const { data: run, error } = useQuery({
    queryKey: ['payroll', 'run', month],
    queryFn: () => api.get<PayrollRun>(`/api/payroll/run?month=${month}`),
  });

  if (open) {
    return (
      <>
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <button className="btn sm" onClick={() => setOpen(null)}>‹ Back to the run</button>
          <b>{open.name}</b>
        </div>
        <MyPay userId={open.id} />
      </>
    );
  }

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(month)}</b>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        <div className="sp" style={{ flex: 1 }} />
        <ExportMenu dataset="payroll" params={{ month }} />
      </div>

      {error && <div className="errbox" style={{ marginBottom: 12 }}>{(error as Error).message}</div>}

      {run && (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <Kpi label="Gross" value={cad(run.totals.gross)} note={`${run.totals.people} people`} accent />
            <Kpi label="Base pay" value={cad(run.totals.base)} note="salary and hourly" />
            <Kpi label="Commission" value={cad(run.totals.commission)} note={`${cad(run.totals.commissionUnpaid)} not yet collected`} />
            <Kpi label="Hours" value={run.totals.hours} note="from Attendance" />
          </div>

          <div className="card">
            <div className="hd">
              <h3>Everyone, {monthLabel(month)}</h3>
              <div className="sp" style={{ flex: 1 }} />
              <span className="sm mut">All figures in CAD</span>
            </div>
            <div className="bd" style={{ padding: 0 }}>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Pay type</th>
                      <th style={{ textAlign: 'right' }}>Hours</th>
                      <th style={{ textAlign: 'right' }}>Base</th>
                      <th style={{ textAlign: 'right' }}>Sales</th>
                      <th style={{ textAlign: 'right' }}>Commission</th>
                      <th style={{ textAlign: 'right' }}>Gross</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {run.rows.map((row) => (
                      <tr key={row.user.id}>
                        <td>
                          <div className="rowflex" style={{ gap: 10 }}>
                            <Avatar name={row.user.name} colour={row.user.colour} src={row.user.avatarUrl} size={28} />
                            <div style={{ minWidth: 0 }}>
                              <div className="b">{row.user.name}</div>
                              <div className="mut sm">{row.user.title ?? ROLE_LABEL[row.user.role]}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`pill ${row.pay.payType === 'COMMISSION_ONLY' ? 'DRAFT' : 'EXPORTED'}`}>
                            {payBasis(row.pay.payType, row.pay.earnsCommission)}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>{row.attendance.hours}</td>
                        <td style={{ textAlign: 'right' }}>{cad(row.pay.base)}</td>
                        <td style={{ textAlign: 'right' }}>{row.sales.count}</td>
                        <td style={{ textAlign: 'right' }}>
                          {cad(row.pay.commission)}
                          {Number(row.pay.commissionUnpaid) > 0 && (
                            <div className="mut sm">{cad(row.pay.commissionUnpaid)} unpaid</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }} className="b">{cad(row.pay.gross)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn sm"
                            onClick={() => setOpen({ id: row.user.id, name: row.user.name })}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                    {run.rows.length === 0 && (
                      <tr><td colSpan={8} className="mut">No active accounts.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="note" style={{ marginTop: 14 }}>
            Nothing here is stored — the month is worked out fresh from the sales, the timesheets and
            the pay setup each time it is opened. Correcting an attendance day or amending a sale is
            reflected immediately, so this is a view of the period rather than an approved run.
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Approvals — the payroll invoice queue
// ---------------------------------------------------------------------------

type InvoiceAction = { kind: 'edit' | 'approve' | 'reject'; invoice: PayrollInvoiceRow };

function Approvals() {
  const qc = useQueryClient();
  const testRow = useTestRow();
  const [action, setAction] = useState<InvoiceAction | null>(null);

  const { data: pending, isLoading } = useQuery({
    queryKey: ['payroll', 'invoices', 'pending'],
    queryFn: () => api.get<PayrollInvoiceRow[]>('/api/payroll/invoices/pending'),
  });

  const refresh = () => {
    setAction(null);
    void qc.invalidateQueries({ queryKey: ['payroll'] });
  };

  return (
    <>
      <div className="card">
        <div className="hd">
          <h3>Payroll awaiting approval</h3>
          <div className="sp" />
          <span className="sm mut">{pending?.length ?? 0} waiting</span>
        </div>

        {isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : !pending || pending.length === 0 ? (
          <div className="empty">
            <h3>Queue is clear</h3>
            <p>Every submitted payroll has been reviewed.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th><th>Month</th>
                  <th style={{ textAlign: 'right' }}>Hours</th>
                  <th style={{ textAlign: 'right' }}>Base</th>
                  <th style={{ textAlign: 'right' }}>Commission</th>
                  <th style={{ textAlign: 'right' }}>Gross</th>
                  <th>Submitted</th><th />
                </tr>
              </thead>
              <tbody>
                {pending.map((inv) => (
                  <tr key={inv.id} className={testRow(inv)}>
                    <td>
                      <div className="rowflex" style={{ gap: 10 }}>
                        <Avatar name={inv.user?.name ?? '?'} colour={inv.user?.colour} src={inv.user?.avatarUrl} size={28} />
                        <div style={{ minWidth: 0 }}>
                          <div className="b">{inv.user?.name}<TestTag on={inv.isTestData} /></div>
                          <div className="mut sm">{inv.user ? ROLE_LABEL[inv.user.role] : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="sm">{monthLabel(inv.month)}</td>
                    <td style={{ textAlign: 'right' }}>{inv.hours}</td>
                    <td style={{ textAlign: 'right' }}>{money(inv.base, 'CAD')}</td>
                    <td style={{ textAlign: 'right' }}>{money(inv.commission, 'CAD')}</td>
                    <td style={{ textAlign: 'right' }} className="b">{money(inv.gross, 'CAD')}</td>
                    <td className="sm mut">{fmtDate(inv.submittedAt)}</td>
                    <td>
                      <div className="rowflex" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setAction({ kind: 'edit', invoice: inv })}>
                          Edit
                        </button>
                        <button className="btn sm primary" onClick={() => setAction({ kind: 'approve', invoice: inv })}>
                          Approve
                        </button>
                        <button className="btn sm dgr" onClick={() => setAction({ kind: 'reject', invoice: inv })}>
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {action && <InvoiceActionModal action={action} onClose={() => setAction(null)} onDone={refresh} />}
    </>
  );
}

function InvoiceActionModal({
  action, onClose, onDone,
}: {
  action: InvoiceAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const { kind, invoice } = action;
  const [base, setBase] = useState(invoice.base);
  const [commission, setCommission] = useState(invoice.commission);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => {
      if (kind === 'edit') {
        return api.patch(`/api/payroll/invoices/${invoice.id}`, { base: Number(base), commission: Number(commission), note });
      }
      if (kind === 'approve') {
        return api.post(`/api/payroll/invoices/${invoice.id}/approve`, {});
      }
      return api.post(`/api/payroll/invoices/${invoice.id}/reject`, { reason: note });
    },
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  const title =
    kind === 'edit' ? `Edit ${invoice.user?.name}'s payroll — ${monthLabel(invoice.month)}`
    : kind === 'approve' ? `Approve ${invoice.user?.name}'s payroll`
    : `Reject ${invoice.user?.name}'s payroll`;

  const ready = kind === 'approve' || note.trim().length > 0;

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
            <div className="r"><span>Month</span><span>{monthLabel(invoice.month)}</span></div>
            <div className="r"><span>Submitted gross</span><span>{money(invoice.gross, 'CAD')}</span></div>
          </div>

          {kind === 'edit' && (
            <>
              <div className="fields">
                <div className="f">
                  <label>Base pay (CAD)</label>
                  <input type="number" step="0.01" value={base} onChange={(e) => setBase(e.target.value)} />
                </div>
                <div className="f">
                  <label>Commission (CAD)</label>
                  <input type="number" step="0.01" value={commission} onChange={(e) => setCommission(e.target.value)} />
                </div>
              </div>
              <div className="f" style={{ marginTop: 10 }}>
                <label>Reason for the change</label>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </>
          )}

          {kind === 'reject' && (
            <div className="f">
              <label>Why is this being rejected?</label>
              <textarea
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Be specific — the person sees this text."
              />
            </div>
          )}

          {kind === 'approve' && (
            <p className="sm mut">This locks the figures above and marks the month paid out.</p>
          )}

          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={'btn ' + (kind === 'reject' ? 'dgr' : 'primary')}
            disabled={run.isPending || !ready}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending ? 'Working…' : title}
          </button>
        </div>
      </div>
    </div>
  );
}
