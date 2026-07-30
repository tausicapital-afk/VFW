import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { EmailDetail, EmailDirection, EmailKind, EmailRow } from '../lib/types';
import { Page } from '../shell/Shell';

const KIND_LABEL: Record<EmailKind, string> = {
  OTP: 'Verification',
  WELCOME: 'Welcome',
  PASSWORD_RESET: 'Password reset',
  PASSWORD_CHANGED: 'Password changed',
  INVITATION: 'Invitation',
  INVOICE: 'Invoice',
  TEST: 'Test',
  INBOUND: 'Received',
  OTHER: 'Other',
};

// The status pill reuses the submission pill palette (see console.css): SENT and
// RECEIVED read as "good" (APPROVED green), FAILED as "bad" (REJECTED red).
const STATUS_CLS: Record<EmailRow['status'], string> = {
  SENT: 'APPROVED',
  RECEIVED: 'APPROVED',
  FAILED: 'REJECTED',
};

function StatusPill({ status }: { status: EmailRow['status'] }) {
  return <span className={'pill ' + STATUS_CLS[status]}>{status[0] + status.slice(1).toLowerCase()}</span>;
}

/** The reading pane. Bodies are shown as text only — never injected as HTML, so
    an inbound message can't script the console. Redacted kinds have no body. */
function EmailReader({ id }: { id: string }) {
  const { data: email, isLoading } = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.get<EmailDetail>(`/api/emails/${id}`),
  });

  if (isLoading) return <div className="empty"><h3>Loading…</h3></div>;
  if (!email) return <div className="empty"><h3>Not found</h3></div>;

  const body = email.bodyText;
  return (
    <div className="email-reader">
      <div className="hd">
        <h3 style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{email.subject}</h3>
        <div className="sp" />
        <StatusPill status={email.status} />
      </div>
      <div className="email-meta">
        <div><span className="mut">From</span> <b>{email.fromName || email.fromAddress}</b> <span className="sm mut">{email.fromAddress}</span></div>
        <div><span className="mut">To</span> <b className="mono">{email.toAddress}</b></div>
        <div><span className="mut">When</span> {fmtDateTime(email.receivedAt ?? email.sentAt ?? email.createdAt)}</div>
        <div>
          <span className="mut">Kind</span> <span className="tag">{KIND_LABEL[email.kind]}</span>
          {email.submission && (
            <>
              {' · '}
              <Link to={`/submissions/${email.submission.id}`} className="mono">
                {email.submission.invoiceNo ?? email.submission.ref}
              </Link>
            </>
          )}
        </div>
      </div>
      {email.error && <div className="note bad" style={{ margin: '12px 0' }}>{email.error}</div>}
      {body ? (
        <pre className="email-body">{body}</pre>
      ) : (
        <div className="empty" style={{ padding: '28px 12px' }}>
          <p className="mut">{email.preview || 'This message has no stored body.'}</p>
        </div>
      )}
    </div>
  );
}

export function Emails() {
  const { user } = useAuth();
  const [direction, setDirection] = useState<EmailDirection>('OUTBOUND');
  const [kind, setKind] = useState<EmailKind | ''>('');
  const [selected, setSelected] = useState<string | null>(null);

  const qs = new URLSearchParams({ direction });
  if (kind) qs.set('kind', kind);

  const { data, isLoading } = useQuery({
    queryKey: ['emails', direction, kind],
    queryFn: () => api.get<EmailRow[]>(`/api/emails?${qs.toString()}`),
  });

  const scope = can('email.viewAll', user?.role)
    ? 'Every message the system has sent and received.'
    : 'Emails you have sent.';

  const tab = (d: EmailDirection, label: string) => (
    <button
      className={'btn sm' + (direction === d ? ' on' : '')}
      onClick={() => { setDirection(d); setSelected(null); }}
    >
      {label}
    </button>
  );

  return (
    <Page crumb="Work" title="Emails">
      <div className="email-split">
        <div className="card">
          <div className="hd">
            {tab('OUTBOUND', 'Sent')}
            {tab('INBOUND', 'Received')}
            <div className="sp" />
            <select
              className="email-select"
              value={kind}
              onChange={(e) => setKind(e.target.value as EmailKind | '')}
              aria-label="Filter by kind"
            >
              <option value="">All kinds</option>
              {(Object.keys(KIND_LABEL) as EmailKind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>

          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : !data?.length ? (
            <div className="empty">
              <h3>Nothing here yet</h3>
              <p>{direction === 'OUTBOUND'
                ? 'Emails the system sends will appear here.'
                : 'Received mail appears here once an inbox is connected.'}</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{direction === 'OUTBOUND' ? 'To' : 'From'}</th>
                    <th>Subject</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((e) => (
                    <tr
                      key={e.id}
                      className={'email-row' + (selected === e.id ? ' on' : '')}
                      onClick={() => setSelected(e.id)}
                    >
                      <td className="sm">
                        {direction === 'OUTBOUND'
                          ? <span className="mono">{e.toAddress}</span>
                          : <><b>{e.fromName || e.fromAddress}</b></>}
                      </td>
                      <td>
                        <b style={{ overflowWrap: 'anywhere' }}>{e.subject}</b>
                        {e.preview && <div className="sm mut email-preview">{e.preview}</div>}
                      </td>
                      <td><span className="tag">{KIND_LABEL[e.kind]}</span></td>
                      <td><StatusPill status={e.status} /></td>
                      <td className="sm mut">{fmtDateTime(e.sentAt ?? e.receivedAt ?? e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="hd" style={{ borderTop: '1px solid var(--line)', borderBottom: 'none' }}>
            <span className="sm mut">{scope}</span>
          </div>
        </div>

        {selected && (
          <div className="card email-detail">
            <EmailReader id={selected} />
          </div>
        )}
      </div>
    </Page>
  );
}
