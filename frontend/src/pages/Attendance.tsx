import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { can } from '../lib/acl';
import {
  STATUSES, STATUS_LABEL, STATUS_PILL, WEEKDAYS,
  dayKey, hoursBetween, isWeekend, monthGrid, monthKey, monthLabel, shiftMonth, timeNow,
} from '../lib/attendance';
import type {
  AttendanceEntry, AttendanceSheet, AttendanceStatus, AttendanceTeam,
} from '../lib/types';
import { Avatar } from '../shell/Avatar';
import { ExportMenu } from '../shell/ExportMenu';
import { Page, ROLE_LABEL } from '../shell/Shell';

const qk = {
  sheet: (month: string, userId?: string) => ['attendance', month, userId ?? 'me'] as const,
  team: (month: string) => ['attendance', 'team', month] as const,
};

export function Attendance() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const showTeam = can('attendance.viewTeam', user?.role);

  return (
    <Page crumb="People" title="Attendance">
      {showTeam && (
        <div className="tabs">
          <button className={'tab' + (tab === 'mine' ? ' on' : '')} onClick={() => setTab('mine')}>
            My timesheet
          </button>
          <button className={'tab' + (tab === 'team' ? ' on' : '')} onClick={() => setTab('team')}>
            Team
          </button>
        </div>
      )}

      {tab === 'mine' || !showTeam ? <MySheet /> : <TeamSheet />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// One person's month
// ---------------------------------------------------------------------------

function MySheet({ userId }: { userId?: string } = {}) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: sheet } = useQuery({
    queryKey: qk.sheet(month, userId),
    queryFn: () =>
      api.get<AttendanceSheet>(
        `/api/attendance?month=${month}` + (userId ? `&userId=${userId}` : ''),
      ),
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['attendance'] });
  }

  const clock = useMutation({
    mutationFn: (which: 'in' | 'out') =>
      api.post(`/api/attendance/clock-${which}`, {
        date: dayKey(new Date()),
        time: timeNow(),
        ...(userId ? { userId } : {}),
      }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not record that'),
  });

  const today = dayKey(new Date());
  const byDate = new Map((sheet?.entries ?? []).map((e) => [e.date, e]));
  const todayEntry = byDate.get(today);
  // Clocking in only makes sense on today, and only on the month that contains
  // it — the buttons are hidden rather than disabled on other months, because a
  // greyed control invites a click that could never have worked.
  const onCurrentMonth = month === monthKey(new Date());

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(month)}</b>
        <button className="btn sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        <div className="sp" style={{ flex: 1 }} />

        {onCurrentMonth && sheet?.self && (
          <div className="rowflex" style={{ gap: 8 }}>
            <button
              className="btn sm"
              disabled={clock.isPending || !!todayEntry?.checkIn}
              onClick={() => clock.mutate('in')}
            >
              {todayEntry?.checkIn ? `In ${todayEntry.checkIn}` : 'Clock in'}
            </button>
            <button
              className="btn sm primary"
              disabled={clock.isPending || !todayEntry?.checkIn}
              onClick={() => clock.mutate('out')}
            >
              {todayEntry?.checkOut ? `Out ${todayEntry.checkOut}` : 'Clock out'}
            </button>
          </div>
        )}
        <ExportMenu dataset="attendance" params={{ month, ...(userId ? { userId } : {}) }} />
      </div>

      {error && <div className="errbox" style={{ marginBottom: 12 }}>{error}</div>}

      {sheet && (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <Kpi label="Days worked" value={String(sheet.summary.daysWorked)} note={`${sheet.summary.days} recorded`} accent />
            <Kpi label="Hours" value={sheet.summary.hours} note="this month" />
            <Kpi label="Average day" value={`${sheet.summary.avgHours}h`} note="across days worked" />
            <Kpi
              label="Away"
              value={String(
                sheet.summary.byStatus.LEAVE + sheet.summary.byStatus.SICK + sheet.summary.byStatus.HOLIDAY,
              )}
              note="leave, sick or holiday"
            />
          </div>

          <div className="card">
            <div className="hd">
              <h3>{sheet.self ? 'Your month' : `${sheet.user?.name}'s month`}</h3>
              <div className="sp" style={{ flex: 1 }} />
              <span className="sm mut">Pick a day to record it</span>
            </div>
            <div className="bd">
              <div className="cal-head">
                {WEEKDAYS.map((d) => <div key={d}>{d}</div>)}
              </div>
              <div className="cal">
                {monthGrid(month).map((date, i) =>
                  date === null ? (
                    <div key={`b${i}`} className="cal-day empty-cell" />
                  ) : (
                    <DayCell
                      key={date}
                      date={date}
                      entry={byDate.get(date)}
                      today={date === today}
                      onClick={() => setEditing(date)}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {editing && (
        <DayModal
          date={editing}
          entry={byDate.get(editing)}
          userId={userId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
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

function DayCell({
  date, entry, today, onClick,
}: {
  date: string;
  entry?: AttendanceEntry;
  today: boolean;
  onClick: () => void;
}) {
  const dayNumber = Number(date.slice(-2));
  const classes = [
    'cal-day',
    entry ? `on ${entry.status}` : '',
    isWeekend(date) ? 'weekend' : '',
    today ? 'today' : '',
  ].filter(Boolean).join(' ');

  return (
    <button className={classes} onClick={onClick} title={entry ? STATUS_LABEL[entry.status] : 'Not recorded'}>
      <span className="n">{dayNumber}</span>
      {entry && (
        <>
          <span className="h">{Number(entry.hours).toFixed(2).replace(/\.00$/, '')}h</span>
          <span className="s">{STATUS_LABEL[entry.status]}</span>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The day editor
// ---------------------------------------------------------------------------

function DayModal({
  date, entry, userId, onClose, onSaved,
}: {
  date: string;
  entry?: AttendanceEntry;
  userId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<AttendanceStatus>(entry?.status ?? 'PRESENT');
  const [checkIn, setCheckIn] = useState(entry?.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(entry?.checkOut ?? '');
  const [hours, setHours] = useState(entry ? Number(entry.hours).toFixed(2) : '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  // Times win over a typed total, exactly as the server resolves it — showing
  // anything else here would mean the form previewed a number the save discards.
  const derived = checkIn && checkOut ? hoursBetween(checkIn, checkOut) : null;
  const effectiveHours = derived ?? (hours || '0');

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/attendance/${date}`, {
        status,
        hours: effectiveHours,
        checkIn: checkIn || null,
        checkOut: checkOut || null,
        note: note.trim() || null,
        ...(userId ? { userId } : {}),
      }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save that day'),
  });

  const clear = useMutation({
    mutationFn: () =>
      api.del(`/api/attendance/${date}` + (userId ? `?userId=${userId}` : '')),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not clear that day'),
  });

  const [y, m, d] = date.split('-').map(Number);
  const heading = new Date(y, m - 1, d, 12).toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>{heading}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="f" style={{ marginBottom: 14 }}>
            <label>Status</label>
            <div className="status-choices">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={'status-choice' + (status === s ? ' on' : '')}
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                >
                  <span className={`pill ${STATUS_PILL[s]}`}>{STATUS_LABEL[s]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="fields">
            <div className="f">
              <label>Started</label>
              <input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="f">
              <label>Finished</label>
              <input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
            <div className="f">
              <label>Hours</label>
              <input
                type="number"
                step="0.25"
                min="0"
                max="24"
                value={derived ?? hours}
                readOnly={derived !== null}
                onChange={(e) => setHours(e.target.value)}
              />
              <div className="help">
                {derived !== null
                  ? 'Worked out from the times above.'
                  : 'Fill this in directly if you did not track the times.'}
              </div>
            </div>
          </div>

          <div className="f wide" style={{ marginTop: 4 }}>
            <label>Note</label>
            <input
              value={note}
              maxLength={500}
              placeholder="Optional — where you were, what shifted"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {entry?.correctedBy && (
            <div className="note" style={{ marginTop: 12 }}>
              Last changed by {entry.correctedBy.name}.
            </div>
          )}
          {error && <div className="errbox" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          {entry && (
            <button
              className="btn dgr"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Clear day
            </button>
          )}
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save day'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The team roll-up
// ---------------------------------------------------------------------------

function TeamSheet() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  // Opening a person swaps the whole panel for their sheet, rather than nesting
  // a second calendar inside a table row — a month grid needs the width.
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  const { data: team } = useQuery({
    queryKey: qk.team(month),
    queryFn: () => api.get<AttendanceTeam>(`/api/attendance/team?month=${month}`),
  });

  if (open) {
    return (
      <>
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <button className="btn sm" onClick={() => setOpen(null)}>‹ Back to team</button>
          <b>{open.name}</b>
        </div>
        <MySheet userId={open.id} />
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
        <ExportMenu dataset="attendance-team" params={{ month }} />
      </div>

      <div className="card">
        <div className="hd"><h3>Everyone, {monthLabel(month)}</h3></div>
        <div className="bd" style={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Department</th>
                  <th style={{ textAlign: 'right' }}>Days worked</th>
                  <th style={{ textAlign: 'right' }}>Hours</th>
                  <th style={{ textAlign: 'right' }}>Avg/day</th>
                  <th style={{ textAlign: 'right' }}>Away</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(team?.rows ?? []).map(({ user, summary }) => (
                  <tr key={user.id}>
                    <td>
                      <div className="rowflex" style={{ gap: 10 }}>
                        <Avatar name={user.name} colour={user.colour} src={user.avatarUrl} size={28} />
                        <div style={{ minWidth: 0 }}>
                          <div className="b">{user.name}</div>
                          <div className="mut sm">{ROLE_LABEL[user.role]}</div>
                        </div>
                      </div>
                    </td>
                    <td>{user.department ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{summary.daysWorked}</td>
                    <td style={{ textAlign: 'right' }}>{summary.hours}</td>
                    <td style={{ textAlign: 'right' }}>{summary.avgHours}</td>
                    <td style={{ textAlign: 'right' }}>
                      {summary.byStatus.LEAVE + summary.byStatus.SICK + summary.byStatus.HOLIDAY}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => setOpen({ id: user.id, name: user.name })}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
                {team && team.rows.length === 0 && (
                  <tr><td colSpan={7} className="mut">No active accounts.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
