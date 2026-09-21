import { Injectable } from '@nestjs/common';
import { can } from '../common/acl';
import { AuthUser } from '../common/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { SubmissionsService } from '../submissions/submissions.service';

export type SearchResultType = 'submission' | 'contact';

export interface SearchResult {
  id: string;
  type: SearchResultType;
  label: string;
  sublabel: string | null;
  href: string;
}

/** Top results per entity type. A jump-to tool, not a results page. */
const LIMIT = 5;

/**
 * Cross-entity jump-to search (Cmd/Ctrl-K global search).
 *
 * Every result here is something the caller could already open directly by
 * URL — each half of this reuses the exact scoped service method the
 * corresponding screen itself reads through (SubmissionsService.search /
 * ContactsService.list), so this endpoint cannot leak a row that
 * /api/submissions or /api/contacts would not already hand back to the same
 * caller. There is no second, subtly different definition of "whose rows can
 * I see" here — that would be the whole vulnerability.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly contacts: ContactsService,
  ) {}

  async search(user: AuthUser, q: string): Promise<SearchResult[]> {
    const query = q?.trim();
    if (!query) return [];

    const results: SearchResult[] = [];

    const submissions = await this.submissions.search(user, query, LIMIT);
    for (const s of submissions) {
      results.push({
        id: s.id,
        type: 'submission',
        label: s.ref,
        sublabel: s.invoiceNo ? `${s.contact.brand} · ${s.invoiceNo}` : s.contact.brand,
        href: `/submissions/${s.id}`,
      });
    }

    // The customer book is its own permission — INTERN holds no
    // `contacts.view` at all (see common/acl.ts) — so search must not open a
    // door the Contacts screen itself keeps shut for that role.
    if (can('contacts.view', user.role)) {
      const contacts = await this.contacts.list(user, query);
      for (const c of contacts.slice(0, LIMIT)) {
        results.push({
          id: c.id,
          type: 'contact',
          label: c.brand,
          sublabel: c.designer || c.company || null,
          href: `/contacts/${c.id}`,
        });
      }
    }

    return results;
  }
}
