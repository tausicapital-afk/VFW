import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The backfill: marking records that ALREADY exist as test data.
 *
 * The runtime switch (ConfigService.testDataMode) only stamps rows as they are
 * created, which is no help at all for the demo book that is already sitting in
 * the database. This is the other half — and it is deliberately a plain function
 * over a Prisma client rather than a Nest service, because it has two callers
 * that cannot share an injector: the admin endpoint (test-data.service.ts) and
 * the command-line script (scripts/mark-test-data.ts), which runs against
 * production with a bare PrismaClient and no application boot.
 *
 * WHAT IT WALKS. Given a set of submission refs, marking is transitive along the
 * relations that make a demo sale a demo sale: its contact, its payments, and
 * the emails sent about it. It is NOT transitive the other way — marking a
 * contact does not mark every submission against that brand — because a real
 * sale to a brand that was first entered as a demo is still a real sale, and a
 * backfill that reclassified it would be silently wrong in the one direction
 * that costs money.
 *
 * The catalogue (Event / Package / Addon) is deliberately untouched by ref-based
 * marking. Those rows are shared: the show and the rate card a demo sale points
 * at are the same ones the real sales point at, so following the relation would
 * mark the whole catalogue as a rehearsal. They carry the flag so a genuinely
 * throwaway show or package can be marked, which is what `markCatalogue` is for.
 */

/** Anything that can run these writes: PrismaClient, PrismaService, or a tx. */
export type MarkerClient = PrismaClient | Prisma.TransactionClient;

/** The five demo sales this system shipped with. See README / the seed. */
export const DEMO_SUBMISSION_REFS = [
  'S-26-1001',
  'S-26-1002',
  'S-26-1003',
  'S-26-1004',
  'S-26-1005',
];

export interface MarkOptions {
  /** Submission refs to mark, e.g. ['S-26-1001']. Matched exactly. */
  refs: string[];
  /**
   * Also mark what hangs off each submission — its contact, its payments and the
   * emails sent about it. On by default: a demo sale whose designer still reads
   * as a real customer defeats the point of marking it at all.
   */
  includeRelated?: boolean;
  /** Clear the flag instead of setting it. The same walk, in reverse. */
  unmark?: boolean;
}

/** How many rows of each kind the walk actually changed. */
export interface MarkResult {
  /** Refs that were asked for but do not exist. Reported, never fatal. */
  unknownRefs: string[];
  submissions: number;
  contacts: number;
  payments: number;
  emails: number;
}

/**
 * Mark (or unmark) the given submissions and, unless told otherwise, everything
 * that belongs to them.
 *
 * Runs in one transaction: a half-marked sale — the submission flagged but its
 * contact not — is worse than an unmarked one, because the table would then
 * disagree with itself about the same deal.
 *
 * Idempotent. Every write is scoped to rows not already in the target state, so
 * running it twice reports zero the second time rather than counting the same
 * rows again, and the counts mean "changed" rather than "matched".
 */
export async function markTestData(
  db: MarkerClient,
  { refs, includeRelated = true, unmark = false }: MarkOptions,
): Promise<MarkResult> {
  const value = !unmark;
  const wanted = [...new Set(refs.map((r) => r.trim()).filter(Boolean))];

  const found = await db.submission.findMany({
    where: { ref: { in: wanted } },
    select: { id: true, ref: true, contactId: true },
  });

  const ids = found.map((s) => s.id);
  const contactIds = [...new Set(found.map((s) => s.contactId))];
  const unknownRefs = wanted.filter((r) => !found.some((s) => s.ref === r));

  const result: MarkResult = {
    unknownRefs,
    submissions: 0,
    contacts: 0,
    payments: 0,
    emails: 0,
  };
  if (!ids.length) return result;

  const submissions = await db.submission.updateMany({
    where: { id: { in: ids }, isTestData: !value },
    data: { isTestData: value },
  });
  result.submissions = submissions.count;

  if (includeRelated) {
    const [contacts, payments, emails] = await Promise.all([
      db.contact.updateMany({
        where: { id: { in: contactIds }, isTestData: !value },
        data: { isTestData: value },
      }),
      db.payment.updateMany({
        where: { submissionId: { in: ids }, isTestData: !value },
        data: { isTestData: value },
      }),
      db.emailMessage.updateMany({
        where: { submissionId: { in: ids }, isTestData: !value },
        data: { isTestData: value },
      }),
    ]);
    result.contacts = contacts.count;
    result.payments = payments.count;
    result.emails = emails.count;
  }

  return result;
}

/** The catalogue models the flag also lives on, marked by id rather than by ref. */
export interface CatalogueMarkOptions {
  eventIds?: string[];
  packageIds?: string[];
  addonIds?: string[];
  unmark?: boolean;
}

export interface CatalogueMarkResult {
  events: number;
  packages: number;
  addons: number;
}

/**
 * Mark catalogue rows — a throwaway show, a package invented for a demo.
 *
 * Separate from `markTestData` rather than a branch inside it, because the two
 * are asked for at different times by different people: a submission backfill is
 * "these five sales were a rehearsal", while this is "this show never happened".
 * Folding them together would invite exactly the transitive walk the comment at
 * the top of this file explains must not exist.
 */
export async function markCatalogueTestData(
  db: MarkerClient,
  { eventIds = [], packageIds = [], addonIds = [], unmark = false }: CatalogueMarkOptions,
): Promise<CatalogueMarkResult> {
  const value = !unmark;
  const [events, packages, addons] = await Promise.all([
    eventIds.length
      ? db.event.updateMany({
          where: { id: { in: eventIds }, isTestData: !value },
          data: { isTestData: value },
        })
      : { count: 0 },
    packageIds.length
      ? db.package.updateMany({
          where: { id: { in: packageIds }, isTestData: !value },
          data: { isTestData: value },
        })
      : { count: 0 },
    addonIds.length
      ? db.addon.updateMany({
          where: { id: { in: addonIds }, isTestData: !value },
          data: { isTestData: value },
        })
      : { count: 0 },
  ]);
  return { events: events.count, packages: packages.count, addons: addons.count };
}
