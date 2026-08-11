import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { dayKey } from '../lib/attendance';
import { money } from '../lib/format';
import { currentMonthPeriod, periodLabel, shiftMonthPeriod } from '../lib/period';
import type { UserSales } from '../lib/types';
import { ExportMenu } from '../shell/ExportMenu';

const cad = (v: string) => money(v, 'CAD');

/** Inclusive `YYYY-MM-DD` bounds — see lib/period.ts. */
type Period = { from: string; to: string };

/**
 * What one person sold in a period, and to whom.
 *
 * Rendered in two places on purpose, from one endpoint: under a payroll
 * statement, where it is the detail behind the commission line, and under a
 * user's details in Administration, where it is the money a commission rate has
 * actually produced. Anyone who opened both for the same period and found two
 * different answers would be right to trust neither, so there is one component
 * and one query rather than a panel per screen.
 *
 * Pass `period` to pin it to whatever the surrounding screen already steps
 * through — Payroll owns a period selector for the whole statement, and a
 * second one inside it would be two controls disagreeing about what is on the
 * page. Leave it out and the card steps calendar months itself, which is what
 * the Administration modal needs: it has no period of its own.
 *
 * Any period back is reachable either way. Nothing here is stored — the
 * figures are derived from sales already on the books — so history is just an
 * older range, and the export button hands over whichever period is on screen.
 */
export function UserSalesCard({ userId, period: pinned }: { userId: string; period?: Period }) {
  const [own, setOwn] = useState<Period>(() => currentMonthPeriod());
  const period = pinned ?? own;
  const steps = pinned === undefined;
  // A sale is dated by its approval, which cannot happen in a period that has
  // not arrived — so stepping forward from here is always an empty screen, and
  // the button that leads there is disabled rather than left to disappoint.
  const atLatest = period.to >= dayKey(new Date());

  const { data, isLoading, error } = useQuery({
    queryKey: ['payroll', 'sales', userId, period.from, period.to],
    queryFn: () =>
      api.get<UserSales>(`/api/payroll/sales?userId=${userId}&from=${period.from}&to=${period.to}`),
  });

  const target = Number(data?.target ?? 0);
  // Progress is against net revenue, which is what a target is set in and what
  // commission is struck on — invoiced would flatter it by the tax on top.
  const pct = data && target > 0 ? Math.round((Number(data.revenue) / target) * 100) : 0;
  const unpaid = Number(data?.commissionUnpaid ?? 0);

  return (
    <>
      <div className="sect">
        <div className="hd" style={{ alignItems: 'center' }}>
          <h3>Sales</h3>
          {steps ? (
            <>
              <button
                className="btn sm"
                title="Previous month"
                onClick={() => setOwn((p) => shiftMonthPeriod(p, -1))}
              >
                ‹
              </button>
              <span className="n" style={{ minWidth: 118, textAlign: 'center' }}>
                {periodLabel(period.from, period.to)}
              </span>
              <button
                className="btn sm"
                title={atLatest ? 'No months after this one yet' : 'Next month'}
                disabled={atLatest}
                onClick={() => setOwn((p) => shiftMonthPeriod(p, 1))}
              >
                ›
              </button>
            </>
          ) : (
            <span className="n">{periodLabel(period.from, period.to)}</span>
          )}
          <div className="sp" style={{ flex: 1 }} />
          <ExportMenu
            dataset="user-sales"
            params={{ userId, from: period.from, to: period.to }}
            disabled={!data?.clients.length}
          />
        </div>
      </div>

      {error ? (
        <div className="note bad">{(error as Error).message}</div>
      ) : isLoading || !data ? (
        <div className="note">Loading…</div>
      ) : data.count === 0 ? (
        <div className="note">
          Nothing approved in {periodLabel(period.from, period.to)}. A sale counts here in the
          period Accounting approved it, not the period it was submitted — so a deal still in the
          queue will appear once it is decided.
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="lb">Sales closed</div>
              <div className="vl">{data.count}</div>
              <div className="dt">{cad(data.invoiced)} invoiced</div>
            </div>
            <div className="kpi accent">
              <div className="lb">Net revenue</div>
              <div className="vl">{cad(data.revenue)}</div>
              <div className="dt">commission is struck on this</div>
            </div>
            <div className="kpi ok">
              <div className="lb">Commission</div>
              <div className="vl">{cad(data.commission)}</div>
              <div className="dt">at {Number(data.commissionPct).toFixed(2)}%</div>
            </div>
          </div>

          {target > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="rowflex" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                <span className="mut">Against a {cad(data.target)} target</span>
                <span className="b">{pct}%</span>
              </div>
              <div className="bar" style={{ marginTop: 6 }}>
                <i style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
            </div>
          )}

          <div className="totals" style={{ marginTop: 14 }}>
            <div className="r"><span>Collected</span><span>{cad(data.collected)}</span></div>
            <div className="r due"><span>Outstanding</span><span>{cad(data.outstanding)}</span></div>
          </div>

          {unpaid > 0 && (
            <div className="note warn" style={{ marginTop: 14 }}>
              <b>{cad(data.commissionUnpaid)}</b> of that commission is on invoices the client has
              not settled. It is earned all the same — commission follows approval, not payment —
              but it is money the company has not collected yet.
            </div>
          )}

          <div className="sect" style={{ marginTop: 22, marginBottom: 0 }}>
            <div className="hd">
              <h3>Who it came from</h3>
              <span className="n">{data.clients.length}</span>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">Deals</th>
                  <th className="num">Net</th>
                  <th className="num">Collected</th>
                  <th className="num">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.brand}>
                    <td>
                      <b>{c.brand}</b>
                      <div className="sm mut">{c.designer}</div>
                    </td>
                    <td className="num">{c.deals}</td>
                    <td className="num">{cad(c.revenue)}</td>
                    <td className="num">{cad(c.collected)}</td>
                    <td className="num">{cad(c.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
