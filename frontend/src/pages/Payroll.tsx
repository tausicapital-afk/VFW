import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { can } from '../lib/acl';
import { monthKey, monthLabel, shiftMonth } from '../lib/attendance';
import { fmtDate, money } from '../lib/format';
import type { PayrollRun, PayrollSheet, PayrollStatement, PayType } from '../lib/types';
import { Avatar } from '../shell/Avatar';
import { ExportMenu } from '../shell/ExportMenu';
import { Page, ROLE_LABEL } from '../shell/Shell';

const PAY_TYPE_LABEL: Record<PayType, string> = {
  SALARY: 'Salary',
  HOURLY: 'Hourly',
  COMMISSION_ONLY: 'Commission only',
};

/** Everything on this screen is consolidated to the reporting currency. */
const cad = (v: string) => money(v, 'CAD');

export function Payroll() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'mine' | 'run'>('mine');
  const showRun = can('payroll.viewAll', user?.role);

  return (
    <Page crumb="People" title="Payroll">
      {showRun && (
        <div className="tabs">
          <button className={'tab' + (tab === 'mine' ? ' on' : '')} onClick={() => setTab('mine')}>
            My pay
          </button>
          <button className={'tab' + (tab === 'run' ? ' on' : '')} onClick={() => setTab('run')}>
            Payroll run
          </button>
        </div>
      )}

      {tab === 'mine' || !showRun ? <MyPay /> : <Run />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// One person's statement
// ---------------------------------------------------------------------------

function MyPay({ userId }: { userId?: string } = {}) {
  const [month, setMonth] = useState(() => monthKey(new Date()));

  const { data: sheet, error } = useQuery({
    queryKey: ['payroll', month, userId ?? 'me'],
    queryFn: () =>
      api.get<PayrollSheet>(`/api/payroll?month=${month}` + (userId ? `&userId=${userId}` : '')),
  });

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(month)}</b>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
      </div>

      {error && <div className="errbox" style={{ marginBottom: 12 }}>{(error as Error).message}</div>}

      {sheet && (
        <div className="split">
          <Statement statement={sheet} month={month} />
          <ProfileCard statement={sheet} />
        </div>
      )}
    </>
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
          {PAY_TYPE_LABEL[pay.payType]}
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
                {' '}· {sales.count} sale{sales.count === 1 ? '' : 's'} approved,{' '}
                {cad(sales.revenue)} net at {Number(statement.user.commissionPct).toFixed(2)}%
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
          <Field label="Pay type" value={PAY_TYPE_LABEL[statement.pay.payType]} />
          <Field
            label="Base rate"
            value={
              statement.pay.payType === 'COMMISSION_ONLY'
                ? '—'
                : cad(u.baseRate) + (statement.pay.payType === 'HOURLY' ? ' / hour' : ' / month')
            }
          />
          <Field label="Commission" value={`${Number(u.commissionPct).toFixed(2)}%`} />
          <Field label="Sales target" value={cad(u.target)} />
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
                            {PAY_TYPE_LABEL[row.pay.payType]}
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
