import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { InternalComment } from '../lib/types';
import { Page } from '../shell/Shell';

export const COMMENT_DEPARTMENTS = ['Accounting', 'Production', 'Marketing', 'Event Management'];

/**
 * The company-wide internal-comment log. Guarded twice over: `internal.view` on
 * the route (ACCT/MGR/ADMIN), and the server additionally excludes any comment
 * written about a submission the caller carries — nobody reads the coaching
 * notes about their own deal, whatever their role.
 */
export function Internal() {
  const { data } = useQuery({
    queryKey: ['internal-comments'],
    queryFn: () => api.get<{ comments: InternalComment[] }>('/api/internal-comments'),
  });

  const comments = data?.comments ?? [];

  const byDept = comments.reduce<Record<string, number>>((acc, c) => {
    acc[c.department] = (acc[c.department] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Page crumb="People" title="Internal notes">
      <div className="note lock" style={{ marginBottom: 16 }}>
        <b>Confidential.</b> Accounting, Production, Marketing and Event Management use this space
        to record how a deal actually ran. It is coaching material for managers. It does not reach
        the sales representative, and it is structurally excluded from the performance score,
        ranking, commission, bonuses and the leaderboard.
      </div>

      <div className="kpis" style={{ marginBottom: 16 }}>
        {Object.keys(byDept).length === 0 ? (
          <div className="kpi">
            <div className="lb">Comments</div>
            <div className="vl">0</div>
            <div className="dt">Nothing logged yet</div>
          </div>
        ) : (
          Object.entries(byDept).map(([dept, n]) => (
            <div className="kpi" key={dept}>
              <div className="lb">{dept}</div>
              <div className="vl">{n}</div>
              <div className="dt">observation{n > 1 ? 's' : ''}</div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="hd">
          <h3>All internal comments</h3>
          <div className="sp" />
          <span className="pill RETURNED">Confidential</span>
        </div>
        {!comments.length ? (
          <div className="bd">
            <div className="empty">
              <h3>Nothing logged</h3>
              <p>Open a submission and use the Internal notes card to record an observation.</p>
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Department</th><th>Deal / rep</th><th>Observation</th><th>Logged by</th>
                </tr>
              </thead>
              <tbody>
                {comments.map((c) => (
                  <tr key={c.id}>
                    <td className="sm b">{c.department}</td>
                    <td className="sm">
                      <Link to={`/submissions/${c.submission.id}`}>
                        {c.submission.contact.brand}
                      </Link>
                      <div className="mut">{c.submission.rep.name} · {c.submission.ref}</div>
                    </td>
                    <td>{c.body}</td>
                    <td className="sm mut">
                      {c.author.name}
                      <div>{fmtDateTime(c.createdAt)}</div>
                    </td>
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

/**
 * The per-submission card, rendered on the submission detail page for
 * ACCT/MGR/ADMIN only. It fetches from a separate guarded endpoint rather than
 * reading a field off the submission — the submission payload contains no
 * comments at all, for anybody, so there is nothing here to leak.
 *
 * The server 403s if the viewer is the rep on this record, even when their role
 * carries `internal.view`. That is not an error state worth shouting about — the
 * card simply does not render.
 */
export function InternalCard({ submissionId, canComment }: {
  submissionId: string;
  canComment: boolean;
}) {
  const qc = useQueryClient();
  const [department, setDepartment] = useState(COMMENT_DEPARTMENTS[0]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError } = useQuery({
    queryKey: ['submission', submissionId, 'comments'],
    queryFn: () =>
      api.get<{ comments: InternalComment[] }>(`/api/submissions/${submissionId}/comments`),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/submissions/${submissionId}/comments`, { department, body: body.trim() }),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['submission', submissionId, 'comments'] });
      void qc.invalidateQueries({ queryKey: ['internal-comments'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  // Own record: the server refuses, and rightly so. Show nothing.
  if (loadError) return null;

  const comments = data?.comments ?? [];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="hd">
        <h3>Internal notes</h3>
        <div className="sp" />
        <span className="pill RETURNED">Confidential</span>
      </div>
      <div className="bd">
        <div className="note lock" style={{ marginBottom: 14 }}>
          Not shown to the sales representative, and excluded by design from the score, ranking,
          commission and the leaderboard.
        </div>

        {!comments.length ? (
          <div className="empty">
            <h3>No comments</h3>
            <p>Departments can log observations about documentation, coordination or communication.</p>
          </div>
        ) : (
          <div className="log">
            {comments.map((c) => (
              <div className="e" key={c.id}>
                <div className="t"><b>{c.department}</b> — {c.body}</div>
                <div className="m">{c.author.name} · {fmtDateTime(c.createdAt)}</div>
              </div>
            ))}
          </div>
        )}

        {canComment && (
          <div style={{ marginTop: 14 }}>
            <div className="fields">
              <div className="f">
                <label>Department</label>
                <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                  {COMMENT_DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div className="f" style={{ marginTop: 10 }}>
              <label>Observation</label>
              <textarea
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What happened, and what should change next time?"
              />
            </div>
            {error && <div className="note bad" style={{ marginTop: 10 }}>{error}</div>}
            <button
              className="btn primary"
              style={{ marginTop: 10 }}
              disabled={!body.trim() || save.isPending}
              onClick={() => { setError(null); save.mutate(); }}
            >
              {save.isPending ? 'Saving…' : 'Save comment'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
