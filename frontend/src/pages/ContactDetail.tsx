import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import type { ContactDetail as ContactDetailData } from '../lib/types';
import { Page } from '../shell/Shell';
import { StatusPill } from './Submissions';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="r">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<ContactDetailData>(`/api/contacts/${id}`),
  });

  if (isLoading) {
    return <Page crumb="Work / Contacts" title="Contact"><div className="empty"><h3>Loading…</h3></div></Page>;
  }

  // A rep asking for a brand they cannot see gets the same 404 as a brand that
  // does not exist — the server refuses to confirm the other rep's customer.
  if (error || !data) {
    return (
      <Page crumb="Work / Contacts" title="Not found">
        <div className="empty">
          <h3>Contact not found</h3>
          <p>It may have been opened from a stale link, or it belongs to another representative.</p>
        </div>
      </Page>
    );
  }

  const { contact, lifetimeValue, submissions } = data;
  const currencies = Object.keys(lifetimeValue);

  return (
    <Page crumb="Work / Contacts" title={contact.brand}>
      <div className="split">
        <div className="card">
          <div className="hd"><h3>{contact.type ?? 'Designer'}</h3></div>
          <div className="bd">
            <div className="totals">
              <Row label="Designer" value={contact.designer || '—'} />
              <Row label="Company" value={contact.company || '—'} />
              <Row label="Email" value={contact.email || '—'} />
              <Row label="Phone" value={contact.phone || '—'} />
              <Row label="Country" value={contact.country || '—'} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Lifetime value</h3></div>
          <div className="bd">
            {currencies.length === 0 ? (
              <p className="sm mut">No approved deals yet.</p>
            ) : (
              <div className="totals">
                {currencies.map((cur) => (
                  <Row key={cur} label={cur} value={money(lifetimeValue[cur], cur as never)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>Submission history</h3>
          <div className="sp" />
          <span className="sm mut">{submissions.length} submission{submissions.length === 1 ? '' : 's'}</span>
        </div>
        {submissions.length === 0 ? (
          <div className="empty"><h3>No submissions yet</h3><p>Deals for this brand will appear here.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Event</th>
                  <th>Package</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <Link to={`/submissions/${s.id}`}>{s.ref}</Link>
                    </td>
                    <td className="sm">
                      <span className={'tag ' + s.brand}>{s.brand}</span> {s.event}
                    </td>
                    <td className="sm">{s.package}</td>
                    <td className="num">{money(s.total, s.currency)}</td>
                    <td><StatusPill status={s.status} /></td>
                    <td className="sm mut">{fmtDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}
