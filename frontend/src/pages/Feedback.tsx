import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { Contact, DesignerFeedback } from '../lib/types';
import { ExportMenu } from '../shell/ExportMenu';
import { Page } from '../shell/Shell';

export function Stars({ n }: { n: number }) {
  return (
    <span className="stars">
      {'★'.repeat(n)}
      <span className="mut">{'☆'.repeat(5 - n)}</span>
    </span>
  );
}

export function Feedback() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['feedback'],
    queryFn: () => api.get<{ feedback: DesignerFeedback[] }>('/api/feedback'),
  });

  const rows = data?.feedback ?? [];
  const canRecord = can('feedback.record', user?.role);

  // Averaged for display only. It does not reach the leaderboard: the score has
  // no field for it (see backend/src/reports/score.ts).
  const avg = rows.length
    ? Math.round((rows.reduce((t, f) => t + f.rating, 0) / rows.length) * 10) / 10
    : 0;
  const promoters = rows.filter((f) => f.rating >= 4).length;
  const pct = rows.length ? Math.round((promoters / rows.length) * 100) : 0;

  const actions = canRecord ? (
    <button className="btn primary" onClick={() => setOpen(true)}>Record feedback</button>
  ) : undefined;

  return (
    <Page crumb="People" title="Designer feedback" actions={actions}>
      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi accent">
          <div className="lb">Responses</div>
          <div className="vl">{rows.length}</div>
          <div className="dt">Recorded after a show has run</div>
        </div>
        <div className="kpi ok">
          <div className="lb">Average satisfaction</div>
          <div className="vl">{avg} / 5</div>
          <div className="dt"><Stars n={Math.round(avg)} /></div>
        </div>
        <div className="kpi">
          <div className="lb">4★ and above</div>
          <div className="vl">{pct}%</div>
          <div className="dt">{promoters} of {rows.length}</div>
        </div>
      </div>

      <div className="note lock" style={{ marginBottom: 16 }}>
        <b>Coaching material.</b> Designer feedback is not part of the performance score, the
        ranking, commission or any bonus — the score has no field for it, by design.
      </div>

      <div className="card">
        <div className="hd">
          <h3>All responses</h3>
          <div className="sp" />
          {/* The responses themselves. Reports has the trends rollup; this is
              what was actually said. */}
          <ExportMenu dataset="feedback" disabled={!rows.length} />
        </div>
        {!rows.length ? (
          <div className="bd">
            <div className="empty">
              <h3>No responses yet</h3>
              <p>Record how a designer felt about their show, once it has run.</p>
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Brand</th><th>Designer</th><th>Rating</th>
                  <th>Notes</th><th>Recorded by</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id}>
                    <td className="b">{f.contact.brand}</td>
                    <td className="sm">{f.contact.designer || '—'}</td>
                    <td><Stars n={f.rating} /></td>
                    <td className="sm">{f.body || '—'}</td>
                    <td className="sm mut">{f.recordedBy.name}</td>
                    <td className="sm mut">{fmtDate(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <FeedbackModal
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void qc.invalidateQueries({ queryKey: ['feedback'] });
          }}
        />
      )}
    </Page>
  );
}

export function FeedbackModal({
  contactId: fixedContact, onClose, onDone,
}: {
  contactId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [contactId, setContactId] = useState(fixedContact ?? '');
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: contacts } = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<Contact[]>('/api/contacts'),
    enabled: !fixedContact,
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/feedback', { contactId, rating, body: body.trim() || undefined }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Designer feedback</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="fields">
            {!fixedContact && (
              <div className="f wide">
                <label>Designer / brand</label>
                <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                  <option value="">— select —</option>
                  {contacts?.map((c) => (
                    <option key={c.id} value={c.id}>{c.brand} · {c.designer}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="f">
              <label>Overall satisfaction</label>
              <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>
                ))}
              </select>
            </div>
          </div>
          <div className="f" style={{ marginTop: 12 }}>
            <label>Compliments, concerns, suggestions</label>
            <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="note lock" style={{ marginTop: 12 }}>
            This is coaching material. It does not affect the rep's score, ranking or commission.
          </div>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!contactId || save.isPending}
            onClick={() => { setError(null); save.mutate(); }}
          >
            {save.isPending ? 'Saving…' : 'Save feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}
