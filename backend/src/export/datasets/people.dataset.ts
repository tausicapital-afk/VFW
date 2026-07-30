import { FeedbackService } from '../../feedback/feedback.controller';
import { InternalService } from '../../internal/internal.controller';
import { ExportDataset } from '../export.types';

type FeedbackRow = Awaited<ReturnType<FeedbackService['list']>>['feedback'][number];
type CommentRow = Awaited<ReturnType<InternalService['list']>>['comments'][number];

/**
 * Designer feedback — the raw responses.
 *
 * Reports has a *feedback trends* table; this is not that. Trends are the
 * rollup, and the conversation someone has with a designer needs what was
 * actually said, by whom, about which brand.
 *
 * Feedback is a COACHING INPUT and reaches no score, no ranking and no
 * commission (see reports/score.ts). Nothing here changes that — but a column of
 * ratings next to rep names in a spreadsheet invites exactly that reading, which
 * is why the rep who made the sale is not a column in this file. The brand and
 * the person who recorded it are.
 */
export function feedbackDataset(feedback: FeedbackService): ExportDataset<FeedbackRow> {
  return {
    key: 'feedback',
    title: 'Designer feedback',
    filename: 'designer-feedback',
    permission: 'feedback.view',
    load: async () => (await feedback.list()).feedback,
    columns: [
      { header: 'When', value: (f) => f.createdAt, width: 13 },
      { header: 'Brand', value: (f) => f.contact.brand, width: 22 },
      { header: 'Designer', value: (f) => f.contact.designer, width: 22 },
      { header: 'Rating', value: (f) => f.rating, width: 8 },
      { header: 'Feedback', value: (f) => f.body, width: 60 },
      { header: 'Recorded by', value: (f) => f.recordedBy?.name ?? '', width: 20 },
    ],
  };
}

/**
 * Internal comments — CONFIDENTIAL.
 *
 * `list` applies `notAboutMe`, and this dataset goes through it rather than
 * around it for exactly one reason: the promise that nobody reads the coaching
 * notes written about their own sale must hold in a file as much as on a screen.
 * A manager who carries their own deals is in `internal.view` and would still
 * have exported the notes about themselves if this had queried the table
 * directly. The permission gate alone would not have caught that — it is about
 * roles, and this rule is not.
 */
export function internalCommentsDataset(internal: InternalService): ExportDataset<CommentRow> {
  return {
    key: 'internal-comments',
    title: 'Internal comments',
    filename: 'internal-comments',
    permission: 'internal.view',
    load: async (user) => (await internal.list(user)).comments,
    columns: [
      { header: 'When', value: (c) => c.createdAt, width: 13 },
      { header: 'Department', value: (c) => c.department, width: 16 },
      { header: 'Record', value: (c) => c.submission?.ref ?? '', width: 12 },
      { header: 'Brand', value: (c) => c.submission?.contact.brand ?? '', width: 20 },
      { header: 'Comment', value: (c) => c.body, width: 60 },
      { header: 'Author', value: (c) => c.author?.name ?? '', width: 20 },
      { header: 'Author role', value: (c) => c.author?.role, width: 10, spreadsheetOnly: true },
    ],
  };
}
