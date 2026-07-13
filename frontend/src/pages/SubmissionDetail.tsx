import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, money, PAY_LABEL } from '../lib/format';
import type { AuditEntry, Submission } from '../lib/types';
import { Page } from '../shell/Shell';
import { StatusPill } from './Submissions';

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

  return (
    <Page crumb="Work / Submissions" title={sub.ref} actions={<StatusPill status={sub.status} />}>
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

          {sub.glCode && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="hd"><h3>Accounting</h3></div>
              <div className="bd">
                <div className="totals">
                  <Row label="GL account" value={sub.glCode} />
                  {sub.costCentre && <Row label="Cost centre" value={sub.costCentre} />}
                  <Row label="Approved" value={fmtDateTime(sub.approvedAt)} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
