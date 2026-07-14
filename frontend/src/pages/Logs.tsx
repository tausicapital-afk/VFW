import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtDuration } from '../lib/format';
import type {
  ActivityPage,
  ActivityUser,
  SessionPage,
} from '../lib/types';
import { Page } from '../shell/Shell';

/**
 * The Logs screen — operational telemetry, admin-only. Three views of the same
 * story: who the users are and when they were last active (Users), the raw
 * event stream (Activity), and online sessions with their durations (Sessions).
 *
 * Read-only. Nothing here writes; the events are recorded server-side as a side
 * effect of signing in, opening a screen, or sending a message.
 */

const TABS = [
  ['users', 'Users'],
  ['activity', 'Activity'],
  ['sessions', 'Sessions'],
] as const;

type TabKey = (typeof TABS)[number][0];

const PAGE = 50;

// Reuse the status pills the rest of the console already styles.
const actionPill = (action: string) => {
  switch (action) {
    case 'LOGIN':
    case 'CONNECT':
      return 'APPROVED';
    case 'LOGOUT':
    case 'DISCONNECT':
      return 'RETURNED';
    case 'MESSAGE_SENT':
      return 'PENDING';
    default:
      return 'DRAFT';
  }
};

function Dot({ colour }: { colour: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colour,
        marginRight: 6,
        verticalAlign: 'middle',
      }}
    />
  );
}

export function Logs() {
  const [tab, setTab] = useState<TabKey>('users');

  return (
    <Page crumb="System" title="Logs">
      <div className="hint" style={{ marginBottom: 14 }}>
        Activity telemetry across the console — sign-ins, screens opened and
        messaging. Read-only and separate from the financial audit trail.
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={'tab' + (tab === key ? ' on' : '')}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'sessions' && <SessionsTab />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Users — who they are, last login (or never), and lifetime activity
// ---------------------------------------------------------------------------

function UsersTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['activity', 'users'],
    queryFn: () => api.get<ActivityUser[]>('/api/activity/users'),
    refetchInterval: 30_000,
  });

  const users = data ?? [];
  const online = users.filter((u) => u.online).length;
  const never = users.filter((u) => u.neverLoggedIn).length;

  return (
    <>
      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="lb">Users</div>
          <div className="vl">{users.length}</div>
          <div className="dt">accounts</div>
        </div>
        <div className="kpi ok">
          <div className="lb">Online now</div>
          <div className="vl">{online}</div>
          <div className="dt">live connections</div>
        </div>
        <div className="kpi amber">
          <div className="lb">Never signed in</div>
          <div className="vl">{never}</div>
          <div className="dt">no login on record</div>
        </div>
      </div>

      <div className="card">
        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : users.length === 0 ? (
            <div className="empty"><h3>No users</h3></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Last login</th>
                  <th>Last activity</th>
                  <th className="num">Sessions</th>
                  <th className="num">Time online</th>
                  <th className="num">Messages</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="b">
                      <Dot colour={u.online ? '#0C7A4D' : (u.colour ?? '#8a8a8a')} />
                      {u.name}
                      {u.online && <span className="pill APPROVED" style={{ marginLeft: 8 }}>Online</span>}
                      <div className="sm mut">{u.email}</div>
                    </td>
                    <td className="sm">{u.role}</td>
                    <td className="sm">
                      {u.neverLoggedIn
                        ? <span className="pill DRAFT">Never</span>
                        : <span className="mono">{fmtDateTime(u.lastLoginAt)}</span>}
                    </td>
                    <td className="sm mut">{fmtAgo(u.lastActivityAt)}</td>
                    <td className="num sm">{u.sessionCount}</td>
                    <td className="num sm">{fmtDuration(u.totalActiveSec)}</td>
                    <td className="num sm">{u.messageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity — the raw event feed
// ---------------------------------------------------------------------------

function ActivityTab() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);

  const { data: actions } = useQuery({
    queryKey: ['activity', 'actions'],
    queryFn: () => api.get<string[]>('/api/activity/actions'),
    staleTime: 60_000,
  });

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q.trim()) params.set('q', q.trim());
  if (action) params.set('action', action);

  const { data, isLoading } = useQuery({
    queryKey: ['activity', 'feed', params.toString()],
    queryFn: () => api.get<ActivityPage>(`/api/activity?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const rows = data?.entries ?? [];
  const total = data?.total ?? 0;
  const to = Math.min(offset + PAGE, total);

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search detail or user…"
          value={q}
          onChange={(e) => reset(() => setQ(e.target.value))}
        />
        <select value={action} onChange={(e) => reset(() => setAction(e.target.value))}>
          <option value="">All actions</option>
          {(actions ?? []).map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
        </select>
        <button className="btn sm" onClick={() => reset(() => { setQ(''); setAction(''); })}>
          Clear
        </button>
        <div style={{ flex: 1 }} />
        <span className="sm mut">{total} events</span>
      </div>

      <div className="card">
        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <h3>No activity</h3>
              <p>Nothing matches this filter yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>User</th>
                  <th>Detail</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="sm mut mono">{fmtDateTime(e.createdAt)}</td>
                    <td>
                      <span className={`pill ${actionPill(e.action)}`}>
                        {e.action.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="sm b">
                      {e.user ? <><Dot colour={e.user.colour} />{e.user.name}</> : 'System'}
                    </td>
                    <td className="sm">{e.detail ?? '—'}</td>
                    <td className="sm mut mono">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {total > PAGE && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            ← Newer
          </button>
          <button className="btn sm" disabled={to >= total} onClick={() => setOffset(offset + PAGE)}>
            Older →
          </button>
          <div style={{ flex: 1 }} />
          <span className="sm mut">{offset + 1}–{to} of {total}</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sessions — online periods with durations
// ---------------------------------------------------------------------------

function SessionsTab() {
  const [state, setState] = useState<'' | 'open' | 'closed'>('');
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (state) params.set('state', state);

  const { data, isLoading } = useQuery({
    queryKey: ['activity', 'sessions', params.toString()],
    queryFn: () => api.get<SessionPage>(`/api/activity/sessions?${params.toString()}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const rows = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const to = Math.min(offset + PAGE, total);

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  // A live session has no endedAt yet — show elapsed-so-far, not a dash.
  const liveDuration = (startedAt: string) =>
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);

  return (
    <>
      <div className="toolbar">
        <select value={state} onChange={(e) => reset(() => setState(e.target.value as typeof state))}>
          <option value="">All sessions</option>
          <option value="open">Online now</option>
          <option value="closed">Ended</option>
        </select>
        <div style={{ flex: 1 }} />
        <span className="sm mut">{total} sessions</span>
      </div>

      <div className="card">
        <div className="tbl-wrap">
          {isLoading ? (
            <div className="empty"><h3>Loading…</h3></div>
          ) : rows.length === 0 ? (
            <div className="empty"><h3>No sessions</h3></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th className="num">Duration</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const open = s.endedAt === null;
                  return (
                    <tr key={s.id}>
                      <td className="b">
                        {s.user ? <><Dot colour={s.user.colour} />{s.user.name}</> : '—'}
                      </td>
                      <td className="sm mut mono">{fmtDateTime(s.startedAt)}</td>
                      <td className="sm mut mono">
                        {open ? <span className="pill APPROVED">Online</span> : fmtDateTime(s.endedAt)}
                      </td>
                      <td className="num sm">
                        {open ? fmtDuration(liveDuration(s.startedAt)) : fmtDuration(s.durationSec)}
                      </td>
                      <td className="sm mut mono">{s.ip ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {total > PAGE && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            ← Newer
          </button>
          <button className="btn sm" disabled={to >= total} onClick={() => setOffset(offset + PAGE)}>
            Older →
          </button>
          <div style={{ flex: 1 }} />
          <span className="sm mut">{offset + 1}–{to} of {total}</span>
        </div>
      )}
    </>
  );
}
