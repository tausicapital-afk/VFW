import { EmailKind, EmailStatus } from '@prisma/client';
import { EmailsService } from '../../emails/emails.service';
import { ExportColumn, ExportDataset } from '../export.types';

/** The wording Emails.tsx's KIND_LABEL map uses, so the file never disagrees with the screen. */
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

/** The wording the screen's StatusPill uses (SENT → "Sent", not "SENT"). */
const STATUS_LABEL: Record<EmailStatus, string> = {
  SENT: 'Sent',
  RECEIVED: 'Received',
  FAILED: 'Failed',
};

type EmailRow = Awaited<ReturnType<EmailsService['list']>>[number];

/**
 * Columns shared by both tabs. Neither carries the message body or the preview
 * snippet: `LIST_SELECT` on EmailsService keeps the list a summary, never the
 * full body, and this export is that same summary, not a bigger one.
 */
const emailColumns: ExportColumn<EmailRow>[] = [
  // The screen falls back the same way: sentAt for outbound, receivedAt for
  // inbound, createdAt for anything with neither yet.
  { header: 'When', value: (e) => e.sentAt ?? e.receivedAt ?? e.createdAt, width: 13 },
  { header: 'Test data', value: (e) => (e.isTestData ? 'TEST' : ''), width: 10 },
  { header: 'Kind', value: (e) => KIND_LABEL[e.kind], width: 14 },
  { header: 'Status', value: (e) => STATUS_LABEL[e.status], width: 10 },
  { header: 'From', value: (e) => e.fromName || e.fromAddress, width: 24 },
  { header: 'To', value: (e) => e.toAddress, width: 24 },
  { header: 'Subject', value: (e) => e.subject, width: 34 },
  {
    header: 'Related sale',
    value: (e) => e.submission?.invoiceNo ?? e.submission?.ref ?? null,
    width: 14,
  },
];

/**
 * Emails → Sent. `load` calls EmailsService.list directly — the exact method
 * the screen's GET /api/emails calls — so the file inherits the screen's own
 * row-scoping unchanged: a viewAll role (ACCT/MGR/ADMIN) gets the whole log,
 * everyone else gets only mail they triggered. That is also why there is no
 * `permission` here, the same reasoning as attendance.dataset.ts's `attendance`
 * dataset: the scope is per-row and already enforced one layer down, and every
 * role holds `email.viewOwn` (the route-level gate on GET /api/emails) anyway,
 * so a second, coarser gate here would answer a question that already has one.
 */
export function emailsSentDataset(emails: EmailsService): ExportDataset<EmailRow> {
  return {
    key: 'emails-sent',
    title: 'Sent mail',
    filename: 'emails-sent',
    load: (user, f) => emails.list(user, { direction: 'OUTBOUND', kind: (f.kind as EmailKind) || undefined }),
    columns: emailColumns,
  };
}

/** Emails → Received. See emailsSentDataset for the row-scoping and the no-`permission` call. */
export function emailsReceivedDataset(emails: EmailsService): ExportDataset<EmailRow> {
  return {
    key: 'emails-received',
    title: 'Received mail',
    filename: 'emails-received',
    load: (user, f) => emails.list(user, { direction: 'INBOUND', kind: (f.kind as EmailKind) || undefined }),
    columns: emailColumns,
  };
}
