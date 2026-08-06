import { AttendanceService } from '../../attendance/attendance.service';
import { AttendanceStatus } from '@prisma/client';
import { ExportColumn, ExportDataset } from '../export.types';

/** The wording the calendar uses, so the file never disagrees with the screen. */
const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  REMOTE: 'Remote',
  LEAVE: 'Leave',
  SICK: 'Sick',
  HOLIDAY: 'Holiday',
  ABSENT: 'Absent',
};

type DayRow = Awaited<ReturnType<AttendanceService['list']>>['entries'][number] & {
  person: string;
};

const dayColumns: ExportColumn<DayRow>[] = [
  { header: 'Date', value: (r) => r.date, width: 12 },
  { header: 'Person', value: (r) => r.person, width: 22 },
  // A timesheet is what hours get paid from, so a rehearsal day inside one has
  // to be visible in the file and not only on the calendar.
  { header: 'Test data', value: (r) => (r.isTestData ? 'TEST' : ''), width: 10 },
  { header: 'Status', value: (r) => STATUS_LABEL[r.status], width: 12 },
  { header: 'In', value: (r) => r.checkIn, width: 8 },
  { header: 'Out', value: (r) => r.checkOut, width: 8 },
  // Not `money`, but the same reason applies: keep it a real number so the
  // spreadsheet this lands in can total a month without being retyped.
  { header: 'Hours', value: (r) => Number(r.hours), width: 9 },
  { header: 'Note', value: (r) => r.note, width: 34, spreadsheetOnly: true },
  {
    header: 'Corrected by',
    value: (r) => r.correctedBy?.name ?? null,
    width: 18,
    spreadsheetOnly: true,
  },
];

/**
 * One person's month, exactly as their timesheet shows it.
 *
 * `load` goes through AttendanceService rather than the database, so the file
 * inherits the screen's scoping unchanged: with no `userId` it is your own
 * sheet, and with one it is somebody else's only if you could have opened it.
 * That is why there is no `permission` here — the rule is per-row and already
 * enforced one layer down, and a route-level grant would be a second, coarser
 * answer to a question that already has one.
 */
export function attendanceDataset(attendance: AttendanceService): ExportDataset<DayRow> {
  return {
    key: 'attendance',
    title: 'Attendance',
    filename: 'attendance',
    load: async (user, filters) => {
      const sheet = await attendance.list(
        { month: filters.month, userId: filters.userId },
        user,
      );
      const person = sheet.user?.name ?? user.name;
      return sheet.entries.map((entry) => ({ ...entry, person }));
    },
    columns: dayColumns,
  };
}

type TeamRow = Awaited<ReturnType<AttendanceService['team']>>['rows'][number];

const teamColumns: ExportColumn<TeamRow>[] = [
  { header: 'Person', value: (r) => r.user.name, width: 24 },
  { header: 'Department', value: (r) => r.user.department, width: 16 },
  { header: 'Days recorded', value: (r) => r.summary.days, width: 13 },
  { header: 'Days worked', value: (r) => r.summary.daysWorked, width: 13 },
  { header: 'Hours', value: (r) => Number(r.summary.hours), width: 10 },
  { header: 'Avg hours/day', value: (r) => Number(r.summary.avgHours), width: 13 },
  { header: 'Leave', value: (r) => r.summary.byStatus.LEAVE, width: 8, spreadsheetOnly: true },
  { header: 'Sick', value: (r) => r.summary.byStatus.SICK, width: 8, spreadsheetOnly: true },
  { header: 'Absent', value: (r) => r.summary.byStatus.ABSENT, width: 8, spreadsheetOnly: true },
];

/**
 * The month rolled up per person — the payroll-facing shape.
 *
 * A separate dataset rather than a filter on the one above, for the same reason
 * pending approvals are separate from users: this answers "how did the team do
 * this month", and a file that quietly contained every individual day instead
 * would be the wrong document under the right name.
 */
export function attendanceTeamDataset(attendance: AttendanceService): ExportDataset<TeamRow> {
  return {
    key: 'attendance-team',
    title: 'Team attendance',
    filename: 'team-attendance',
    permission: 'attendance.viewTeam',
    load: async (user, filters) => (await attendance.team({ month: filters.month }, user)).rows,
    columns: teamColumns,
  };
}
