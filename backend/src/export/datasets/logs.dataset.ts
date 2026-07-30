import { ActivityService } from '../../activity/activity.service';
import { MessagingGateway } from '../../messaging/messaging.gateway';
import { ExportDataset, MAX_EXPORT_ROWS } from '../export.types';

type FeedRow = Awaited<ReturnType<ActivityService['feedAll']>>[number];
type SessionRow = Awaited<ReturnType<ActivityService['sessionsAll']>>[number];
type OverviewRow = Awaited<ReturnType<ActivityService['usersOverview']>>[number];

/**
 * The Logs screens. All three are user-monitoring, so all three carry
 * 'activity.view' (ADMIN and ACCT) — the same gate as the screen. This is HR- and
 * security-sensitive material: the export exists because those questions get
 * answered off-console, in a spreadsheet, not because the tables were untidy.
 */

/** Seconds as the screen writes them: "2h 14m", not 8040. */
function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Logs → Activity: the raw event feed, filtered as the screen filters it. */
export function activityDataset(activity: ActivityService): ExportDataset<FeedRow> {
  return {
    key: 'activity',
    title: 'Activity log',
    filename: 'activity-log',
    permission: 'activity.view',
    load: (_user, f) => activity.feedAll({ q: f.q, action: f.action }, MAX_EXPORT_ROWS + 1),
    columns: [
      { header: 'When', value: (e) => e.createdAt, width: 13 },
      // The screen prints "MODULE VIEW", not "MODULE_VIEW".
      { header: 'Action', value: (e) => e.action.replace(/_/g, ' '), width: 20 },
      { header: 'Detail', value: (e) => e.detail, width: 44 },
      { header: 'User', value: (e) => e.user?.name ?? 'System', width: 20 },
      { header: 'Role', value: (e) => e.user?.role, width: 10, spreadsheetOnly: true },
    ],
  };
}

/**
 * Logs → Sessions: sign-in periods, filtered by the screen's state dropdown.
 *
 * A live session has no `endedAt` and no `durationSec` yet. The screen shows
 * elapsed-so-far against a ticking clock; a file cannot, so it says "Still
 * open" rather than printing a duration that stopped being true when it saved.
 */
export function sessionsDataset(activity: ActivityService): ExportDataset<SessionRow> {
  return {
    key: 'sessions',
    title: 'Sessions',
    filename: 'sessions',
    permission: 'activity.view',
    load: (_user, f) => activity.sessionsAll({ state: f.state }, MAX_EXPORT_ROWS + 1),
    columns: [
      { header: 'User', value: (s) => s.user?.name ?? '', width: 20 },
      { header: 'Role', value: (s) => s.user?.role, width: 10, spreadsheetOnly: true },
      { header: 'Started', value: (s) => s.startedAt, width: 13 },
      { header: 'Ended', value: (s) => s.endedAt ?? 'Still open', width: 13 },
      { header: 'Duration', value: (s) => (s.endedAt ? duration(s.durationSec) : ''), width: 12 },
      { header: 'From', value: (s) => s.ip, width: 16 },
      { header: 'Device', value: (s) => s.userAgent, width: 40, spreadsheetOnly: true },
    ],
  };
}

/**
 * Logs → Users: per-person console usage and presence.
 *
 * "Online" is live on the screen and a snapshot here — it is true of the moment
 * the file was made and never again, so the column says so in its name. The
 * alternative was dropping it, but who was connected during an incident is
 * usually the reason someone is exporting this at all.
 */
export function logUsersDataset(
  activity: ActivityService,
  gateway: MessagingGateway,
): ExportDataset<OverviewRow> {
  return {
    // Not 'users': that key is the admin staff roster. This is the same people
    // seen as console usage, and two datasets that differ have to differ by name.
    key: 'log-users',
    title: 'User activity',
    filename: 'user-activity',
    permission: 'activity.view',
    load: () => activity.usersOverview(new Set(gateway.onlineUserIds())),
    columns: [
      { header: 'User', value: (u) => u.name, width: 20 },
      { header: 'Email', value: (u) => u.email, width: 28 },
      { header: 'Role', value: (u) => u.role, width: 10 },
      { header: 'Department', value: (u) => u.department, width: 16, spreadsheetOnly: true },
      { header: 'Online at export', value: (u) => (u.online ? 'Yes' : 'No'), width: 10 },
      // The screen prints a "Never" pill rather than an empty cell, because
      // never having signed in is a finding, not missing data.
      { header: 'Last login', value: (u) => u.lastLoginAt ?? 'Never', width: 13 },
      { header: 'Last activity', value: (u) => u.lastActivityAt, width: 13 },
      { header: 'Sessions', value: (u) => u.sessionCount, width: 9 },
      { header: 'Time online', value: (u) => duration(u.totalActiveSec), width: 12 },
      { header: 'Messages', value: (u) => u.messageCount, width: 9 },
      { header: 'Events', value: (u) => u.eventCount, width: 9, spreadsheetOnly: true },
      { header: 'Status', value: (u) => u.status, width: 10, spreadsheetOnly: true },
    ],
  };
}
