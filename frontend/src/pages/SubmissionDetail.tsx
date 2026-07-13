import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, money, PAY_LABEL } from '../lib/format';
import type { AuditEntry, Submission } from '../lib/types';
import { Page } from '../shell/Shell';
import { StatusPill } from './Submissions';

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: sub, isLoading, error } = useQuery({
    queryKey: ['submission', id],
    queryFn: () => api.get<Submission>(`/api/submissions/${id}`),
  });

  const { data: audit } = useQuery({
    queryKey: ['submission', id, 'audit'],
    queryFn: () => api.get<AuditEntry[]>(`/api/submissions/${id}/audit`),
    enabled: !!sub,
  });

  if (isLoading) {
    return <Page crumb="Work" title="Submission"><div className="empty"><h3>Loading…</h3></div></Page>;
  }

  // A rep asking for someone else's record gets the same 404 as a record that
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

  return (
    <Page
      crumb="Work / Submissions"
      title={sub.ref}
      actions={<StatusPill status={sub.status} />}
    >
      {sub.returnNote && sub.status === 'RETURNED' && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <b>Returned by Accounting:</b> {sub.returnNote}
        </div>
      )}
      {sub.rejectReason && sub.status === 'REJECTED' && (
        <div className="note bad" style={{ marginBottom: 16 }}>
          <b>Rejected:</b> {sub.rejectReason}
        </div>
      )}

      <div className="cols">
        <div>
          <div className="card">
            <div className="hd"><h3>Customer</h3></div>
            <div className="bd">
              <div className="totals">
                <div><span>Brand</span><b>{sub.contact.brand}</b></div>
                <div><span>Designer</span><b>{sub.contact.designer}</b></div>
                {sub.contact.company && <div><span>Company</span><b>{sub.contact.company}</b></div>}
                {sub.contact.email && <div><span>Email</span><b>{sub.contact.email}</b></div>}
                {sub.contact.country && <div><span>Country</span><b>{sub.contact.country}</b></div>}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd">
              <h3>Event &amp; package</h3>
              <div className="sp" style={{ flex: 1 }} />
              <span className={'tag ' + sub.event.brand}>{sub.event.brand}</span>
            </div>
            <div className="bd">
              <div className="totals">
                <div><span>Show</span><b>{sub.event.name}</b></div>
                <div><span>City</span><b>{sub.event.city.name}, {sub.event.city.country}</b></div>
                <div><span>Runs</span><b>{fmtDate(sub.event.start)} – {fmtDate(sub.event.end)}</b></div>
                <div><span>Package</span><b>{sub.package.name} · {sub.package.looks} looks</b></div>
                {sub.addons.length > 0 && (
                  <div>
                    <span>Add-ons</span>
                    <b>{sub.addons.map((a) => a.addon.name).join(', ')}</b>
                  </div>
                )}
              </div>
            </div>
          </div>

          {sub.notes && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="hd"><h3>Sales notes</h3></div>
              <div className="bd"><p>{sub.notes}</p></div>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd">
              <h3>Audit trail</h3>
              <div className="sp" style={{ flex: 1 }} />
              <span className="sm mut">Append-only. Nothing on this record is ever deleted.</span>
            </div>
            <div className="bd">
              {!audit?.length ? (
                <p className="hint">No entries yet.</p>
              ) : (
                <div className="timeline">
                  {audit.map((a) => (
                    <div className="ev" key={a.id}>
                      <div className="dot" />
                      <div>
                        <b>{a.action}</b>
                        {a.detail && <div className="sm">{a.detail}</div>}
                        <div className="sm mut">
                          {a.actor?.name ?? 'System'} · {fmtDateTime(a.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside>
          <div className="card">
            <div className="hd">
              <h3>Money</h3>
              <div className="sp" style={{ flex: 1 }} />
              <span className={'pill ' + sub.payStatus}>{PAY_LABEL[sub.payStatus]}</span>
            </div>
            <div className="bd">
              <div className="totals">
                <div><span>Package</span><b className="mono">{money(sub.packagePrice, sub.currency)}</b></div>
                <div><span>Add-ons</span><b className="mono">{money(sub.addonTotal, sub.currency)}</b></div>
                <div><span>Subtotal</span><b className="mono">{money(sub.subtotal, sub.currency)}</b></div>
                {Number(sub.discountAmount) > 0 && (
                  <div><span>Discount</span><b className="mono">− {money(sub.discountAmount, sub.currency)}</b></div>
                )}
                <div><span>Net revenue</span><b className="mono">{money(sub.taxable, sub.currency)}</b></div>
                <div><span>Tax ({sub.taxRate}%)</span><b className="mono">{money(sub.taxAmount, sub.currency)}</b></div>
                <div className="big"><span>Total</span><b className="mono">{money(sub.total, sub.currency)}</b></div>
                <div><span>Paid</span><b className="mono">{money(sub.paidAmount, sub.currency)}</b></div>
                <div><span>Balance</span><b className="mono">{money(sub.balance, sub.currency)}</b></div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd"><h3>Commission</h3></div>
            <div className="bd">
              <div className="totals">
                <div><span>Rate</span><b className="mono">{sub.commissionPct}%</b></div>
                <div><span>On net revenue</span><b className="mono">{money(sub.commissionAmount, sub.currency)}</b></div>
              </div>
              <div className="note lock" style={{ marginTop: 12 }}>
                Commission is struck on net revenue, never on tax.
              </div>
            </div>
          </div>

          {sub.glCode && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="hd"><h3>Accounting</h3></div>
              <div className="bd">
                <div className="totals">
                  <div><span>GL account</span><b className="mono">{sub.glCode}</b></div>
                  {sub.costCentre && <div><span>Cost centre</span><b>{sub.costCentre}</b></div>}
                  <div><span>Approved</span><b>{fmtDateTime(sub.approvedAt)}</b></div>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </Page>
  );
}
