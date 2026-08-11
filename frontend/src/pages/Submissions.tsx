import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate, money, STATUS_LABEL } from '../lib/format';
import { effectivePackage } from '../lib/pricing';
import { TestTag, useTestRow } from '../lib/testData';
import type { Submission } from '../lib/types';
import { ExportMenu } from '../shell/ExportMenu';
import { Page } from '../shell/Shell';

export function StatusPill({ status }: { status: Submission['status'] }) {
  return <span className={'pill ' + status}>{STATUS_LABEL[status]}</span>;
}

function Row({ label, value, cls }: { label: string; value: ReactNode; cls?: string }) {
  return (
    <div className={'r' + (cls ? ' ' + cls : '')}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function SubmissionsTable({ rows }: { rows: Submission[] }) {
  // This one table is the Submissions list, the voided list AND both Dashboard
  // cards, so marking it here is most of the feature's reach in one place.
  const testRow = useTestRow();
  // Held by id rather than by row: the list refetches under the modal, and a
  // captured object would go on showing figures the server has already moved on
  // from. A row that leaves the list (voided from another tab, say) closes it.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((s) => s.id === openId) ?? null;

  if (!rows.length) {
    return (
      <div className="empty">
        <h3>Nothing here yet</h3>
        <p>Submissions will appear as they are created.</p>
      </div>
    );
  }
  return (
    <>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Brand</th>
              <th>Show</th>
              <th>Package</th>
              <th>Rep</th>
              <th className="num">Total</th>
              <th>Status</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              // The whole row opens the quick look, so the ref is plain text: a
              // link inside a clickable row is two different destinations under
              // one pointer. Full record is a click away from inside the modal.
              <tr
                key={s.id}
                className={testRow(s, 'clickable')}
                title="Open a quick look"
                tabIndex={0}
                onClick={() => setOpenId(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(s.id);
                  }
                }}
              >
                <td className="mono">
                  {s.ref}
                  <TestTag on={s.isTestData} />
                </td>
                <td>
                  <b>{s.contact.brand}</b>
                  <div className="sm mut">{s.contact.designer}</div>
                </td>
                <td>
                  <span className={'tag ' + s.event.brand}>{s.event.brand}</span>{' '}
                  <span className="sm">{s.event.city.name}</span>
                </td>
                <td className="sm">{s.package.name}</td>
                <td className="sm">{s.rep.name}</td>
                <td className="num">{money(s.total, s.currency)}</td>
                <td><StatusPill status={s.status} /></td>
                <td className="sm mut">{fmtDate(s.submittedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <SubmissionQuickLook sub={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

/**
 * The quick look — what a row would say if it had room to.
 *
 * Read-only on purpose: everything that changes a sale lives on the detail page,
 * and this exists so that checking a balance or a show date does not cost a
 * navigation and a way back. The list payload is the full record already (the
 * API serves /api/submissions with the same include as /api/submissions/:id), so
 * nothing here needs a second request.
 */
function SubmissionQuickLook({ sub, onClose }: { sub: Submission; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A row is opened from the keyboard as readily as from the mouse, and the
  // modal renders after the table — without this, Tab out of the row walks on
  // down the list behind the backdrop instead of into what just opened.
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" ref={boxRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3 className="mono" style={{ marginRight: 8 }}>{sub.ref}</h3>
          <StatusPill status={sub.status} />
          <TestTag on={sub.isTestData} />
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="totals">
            <Row label="Customer" value={sub.contact.brand} />
            <Row label="Designer" value={sub.contact.designer} />
            <Row
              label="Show"
              value={
                <>
                  <span className={'tag ' + sub.event.brand}>{sub.event.brand}</span>{' '}
                  {sub.event.name} · {sub.event.city.name}
                </>
              }
            />
            <Row label="Package" value={effectivePackage(sub).name} />
            <Row label="Rep" value={sub.rep.name} />
            <Row label="Show date" value={fmtDate(sub.showDate)} />
            <Row label="Submitted" value={fmtDate(sub.submittedAt)} />
            <Row label="Approved" value={fmtDate(sub.approvedAt)} />
          </div>

          <div className="totals" style={{ marginTop: 12 }}>
            <Row label="Package" value={money(sub.packagePrice, sub.currency)} />
            <Row label="Add-ons" value={money(sub.addonTotal, sub.currency)} />
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
            {/* Shown to exactly who the detail page shows it to — whoever can
                see the sale at all. The list is rep-scoped by the server, so a
                rep only ever reads their own rate here. */}
            <Row label={`Commission (${sub.commissionPct}%)`} value={money(sub.commissionAmount, sub.currency)} />
          </div>

          {sub.notes && (
            <>
              <div className="sm mut" style={{ margin: '14px 0 6px' }}>Sales notes</div>
              <p className="sm">{sub.notes}</p>
            </>
          )}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Close</button>
          <Link className="btn primary" to={`/submissions/${sub.id}`}>Open full record</Link>
        </div>
      </div>
    </div>
  );
}

export function Submissions() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const created = params.get('created');

  const { data, isLoading } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => api.get<Submission[]>('/api/submissions'),
  });

  // Voided sales are hidden from the main list; the roles that can restore them
  // get a toggle to review them and open one to restore.
  const canVoid = can('submission.void', user?.role);
  const [showVoided, setShowVoided] = useState(false);
  const { data: voided, isLoading: voidedLoading } = useQuery({
    queryKey: ['submissions', 'voided'],
    queryFn: () => api.get<Submission[]>('/api/submissions/voided'),
    enabled: canVoid && showVoided,
  });

  const scope = can('submission.viewAll', user?.role)
    ? 'Every submission across all shows.'
    : 'Your own customers only.';

  return (
    <Page crumb="Work" title="Submissions">
      {created && (
        <div className="note good" style={{ marginBottom: 16 }}>
          <b className="mono">{created}</b> was sent to Accounting for approval.
        </div>
      )}
      <div className="card">
        <div className="hd">
          <h3>{showVoided ? 'Voided submissions' : 'Submissions'}</h3>
          <div className="sp" />
          {canVoid && (
            <button className="btn sm" onClick={() => setShowVoided((v) => !v)}>
              {showVoided ? 'Back to active' : 'Show voided'}
            </button>
          )}
          {/* Exports what this table shows — the server re-applies the same
              scope, so a rep's file holds only their own customers. */}
          {!showVoided && (
            <ExportMenu dataset="submissions" disabled={isLoading || !data?.length} />
          )}
          <span className="sm mut">{showVoided ? 'Soft-deleted — open one to restore.' : scope}</span>
        </div>
        {showVoided ? (
          voidedLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : voided?.length ? (
            <SubmissionsTable rows={voided} />
          ) : (
            <div className="empty"><h3>Nothing voided</h3><p>No submissions have been voided.</p></div>
          )
        ) : isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : (
          <SubmissionsTable rows={data ?? []} />
        )}
      </div>
    </Page>
  );
}
