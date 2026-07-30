import { ContactsService } from '../../contacts/contacts.service';
import { ExportDataset } from '../export.types';

type ContactRow = Awaited<ReturnType<ContactsService['list']>>[number];

/**
 * The customer book, scoped and searched exactly as the screen is.
 *
 * This dataset is governed at both levels the contacts layer is governed at, and
 * it needs both:
 *
 * - `permission` answers "may this ROLE touch contacts at all". An INTERN may
 *   not — they are a supervised trainee who drafts sales without holding
 *   designer PII — and `load` alone would never have said so, because it scopes
 *   rows rather than refusing the caller.
 * - `list` answers "WHICH contacts", reusing the screen's own row-level scope: a
 *   rep exports brands they sold to or entered, and nobody else's.
 *
 * Neither implies the other. See contacts.controller.ts, which says the same
 * thing about the endpoint this mirrors.
 */
export function contactsDataset(contacts: ContactsService): ExportDataset<ContactRow> {
  return {
    key: 'contacts',
    title: 'Contacts',
    filename: 'contacts',
    permission: 'contacts.view',
    load: (user, f) => contacts.list(user, f.q),
    columns: [
      { header: 'Brand', value: (c) => c.brand, width: 22 },
      { header: 'Designer', value: (c) => c.designer, width: 22 },
      { header: 'Company', value: (c) => c.company, width: 24 },
      { header: 'Type', value: (c) => c.type, width: 12 },
      { header: 'Email', value: (c) => c.email, width: 28 },
      { header: 'Phone', value: (c) => c.phone, width: 18 },
      { header: 'Country', value: (c) => c.country, width: 14 },
      { header: 'Added', value: (c) => c.createdAt, width: 13, spreadsheetOnly: true },
    ],
  };
}
