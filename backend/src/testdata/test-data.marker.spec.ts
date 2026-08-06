import { DEMO_SUBMISSION_REFS, MarkerClient, markTestData } from './test-data.marker';

/**
 * The backfill's walk, in isolation.
 *
 * No database: what is worth proving here is WHICH rows the walk decides to
 * touch and with what predicate, and a real Postgres would only make that
 * slower to assert and easier to get wrong. The stub records every updateMany it
 * is handed, so each test can read the exact `where` the marker built — which is
 * the thing that would silently reclassify somebody's real sale if it drifted.
 *
 * The two rules that matter, and that the tests below are shaped around:
 *
 *  - The walk is transitive DOWN from a submission (its contact, its payments,
 *    its emails) and never up. Marking a contact must not sweep every sale
 *    against that brand — a real sale to a brand first entered for a demo is
 *    still a real sale.
 *  - Every write is scoped to rows not already in the target state, so the
 *    counts mean "changed" and running it twice is a no-op rather than a
 *    second round of the same numbers.
 */

interface Call {
  model: string;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

/** A minimal stand-in for the Prisma client, recording what it was asked to do. */
function stubClient(
  submissions: { id: string; ref: string; contactId: string }[],
  counts: Record<string, number> = {},
) {
  const calls: Call[] = [];
  const updateMany = (model: string) => (args: { where: never; data: never }) => {
    calls.push({ model, where: args.where, data: args.data });
    return Promise.resolve({ count: counts[model] ?? 0 });
  };
  const db = {
    submission: {
      findMany: () => Promise.resolve(submissions),
      updateMany: updateMany('submission'),
    },
    contact: { updateMany: updateMany('contact') },
    payment: { updateMany: updateMany('payment') },
    emailMessage: { updateMany: updateMany('emailMessage') },
  } as unknown as MarkerClient;
  return { db, calls };
}

const ROWS = [
  { id: 's1', ref: 'S-26-1001', contactId: 'c1' },
  { id: 's2', ref: 'S-26-1002', contactId: 'c1' },
  { id: 's3', ref: 'S-26-1003', contactId: 'c2' },
];

const byModel = (calls: Call[], model: string) => calls.find((c) => c.model === model)!;

describe('markTestData', () => {
  it('marks the submissions and everything hanging off them', async () => {
    const { db, calls } = stubClient(ROWS, {
      submission: 3, contact: 2, payment: 4, emailMessage: 1,
    });

    const result = await markTestData(db, { refs: ROWS.map((r) => r.ref) });

    expect(result).toEqual({
      unknownRefs: [], submissions: 3, contacts: 2, payments: 4, emails: 1,
    });
    expect(calls.map((c) => c.model).sort()).toEqual([
      'contact', 'emailMessage', 'payment', 'submission',
    ]);
    for (const call of calls) expect(call.data).toEqual({ isTestData: true });
  });

  it('reaches the related rows through the submission, never the other way', async () => {
    const { db, calls } = stubClient(ROWS);
    await markTestData(db, { refs: ROWS.map((r) => r.ref) });

    // Payments and emails are found BY submission id — so a payment against a
    // real sale for the same customer is untouched.
    expect(byModel(calls, 'payment').where).toMatchObject({
      submissionId: { in: ['s1', 's2', 's3'] },
    });
    expect(byModel(calls, 'emailMessage').where).toMatchObject({
      submissionId: { in: ['s1', 's2', 's3'] },
    });

    // Contacts are the deduplicated set the marked sales point at — two sales
    // sharing a brand mark that brand once, not twice.
    expect(byModel(calls, 'contact').where).toMatchObject({ id: { in: ['c1', 'c2'] } });
  });

  it('only touches rows not already in the target state, so a second run is a no-op', async () => {
    const { db, calls } = stubClient(ROWS);
    await markTestData(db, { refs: ['S-26-1001'] });
    for (const call of calls) expect(call.where).toMatchObject({ isTestData: false });
  });

  it('reverses the same walk when unmarking', async () => {
    const { db, calls } = stubClient(ROWS, { submission: 1 });
    const result = await markTestData(db, { refs: ['S-26-1001'], unmark: true });

    expect(result.submissions).toBe(1);
    for (const call of calls) {
      expect(call.data).toEqual({ isTestData: false });
      // The mirror of the test above: unmarking looks only at rows that are
      // currently marked.
      expect(call.where).toMatchObject({ isTestData: true });
    }
  });

  it('leaves the related rows alone when asked to', async () => {
    const { db, calls } = stubClient(ROWS, { submission: 3 });
    const result = await markTestData(db, {
      refs: ROWS.map((r) => r.ref),
      includeRelated: false,
    });

    expect(calls.map((c) => c.model)).toEqual(['submission']);
    expect(result).toEqual({
      unknownRefs: [], submissions: 3, contacts: 0, payments: 0, emails: 0,
    });
  });

  it('reports references that do not exist rather than failing on them', async () => {
    // Aimed at the wrong environment is the common cause, and doing the four
    // that hit is more use than refusing all five.
    const { db } = stubClient([ROWS[0]], { submission: 1 });
    const result = await markTestData(db, { refs: ['S-26-1001', 'S-26-9999'] });

    expect(result.submissions).toBe(1);
    expect(result.unknownRefs).toEqual(['S-26-9999']);
  });

  it('writes nothing at all when no ref matches', async () => {
    const { db, calls } = stubClient([]);
    const result = await markTestData(db, { refs: ['S-26-9999'] });

    expect(calls).toEqual([]);
    expect(result.unknownRefs).toEqual(['S-26-9999']);
  });

  it('deduplicates and trims the refs it was handed', async () => {
    const { db } = stubClient(ROWS);
    const result = await markTestData(db, {
      refs: [' S-26-1001 ', 'S-26-1001', '', '  '],
    });
    // One ref asked for, one found, and no phantom entry for the blanks.
    expect(result.unknownRefs).toEqual([]);
  });

  it('ships the five demo refs the console was seeded with', () => {
    // The admin button and `npm run testdata:mark -- --demo` both default to
    // this list, so it is part of the contract rather than a convenience.
    expect(DEMO_SUBMISSION_REFS).toEqual([
      'S-26-1001', 'S-26-1002', 'S-26-1003', 'S-26-1004', 'S-26-1005',
    ]);
  });
});
