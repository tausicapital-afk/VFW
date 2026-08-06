/**
 * Mark existing records as test data, from the command line.
 *
 * Why this exists alongside the admin endpoint: the endpoint needs a signed-in
 * administrator and a running app, and the moment you most want this is exactly
 * when neither is true — a fresh environment where the demo book was loaded
 * before anyone thought about flagging it. This runs against a database with
 * nothing but DATABASE_URL, the same way scripts/add-mail-account.ts does.
 *
 * The marking logic itself is NOT duplicated here: both callers go through
 * markTestData() in src/testdata/test-data.marker.ts, so the script and the
 * button can never drift into two slightly different definitions of what
 * "belongs to" a demo sale.
 *
 * Usage — the five demo sales this system shipped with, plus their contacts,
 * payments and emails:
 *
 *   npm run testdata:mark -- --demo
 *
 * Specific sales:
 *
 *   npm run testdata:mark -- --refs S-26-1001,S-26-1002
 *
 * Against production, so it picks up that environment's connection string:
 *
 *   railway run --service backend npm run testdata:mark -- --demo
 *
 * Other flags:
 *   --unmark            clear the flag instead of setting it
 *   --submissions-only  do not touch the contacts / payments / emails
 *   --dry-run           report what would change, then roll back
 *
 * Nothing here writes outside one transaction, and --dry-run aborts it, so a
 * mistaken invocation is recoverable by not typing the last word.
 */
import { PrismaClient } from '@prisma/client';
import { DEMO_SUBMISSION_REFS, markTestData } from '../src/testdata/test-data.marker';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** A sentinel the transaction throws to abort a dry run once counts are known. */
class DryRun extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof markTestData>>) {
    super('dry run');
  }
}

async function main() {
  const demo = flag('demo');
  const refsArg = arg('refs');
  const unmark = flag('unmark');
  const includeRelated = !flag('submissions-only');
  const dryRun = flag('dry-run');

  if (!demo && !refsArg) {
    console.error(
      'Nothing to mark. Pass --demo for the shipped demo sales ' +
        `(${DEMO_SUBMISSION_REFS.join(', ')}) or --refs S-26-1001,S-26-1002.`,
    );
    process.exitCode = 1;
    return;
  }

  // --demo and --refs compose rather than compete: marking the demo book plus
  // one extra sale someone added afterwards is a real thing to want.
  const refs = [
    ...(demo ? DEMO_SUBMISSION_REFS : []),
    ...(refsArg ? refsArg.split(',').map((r) => r.trim()).filter(Boolean) : []),
  ];

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const r = await markTestData(tx, { refs, includeRelated, unmark });
      if (dryRun) throw new DryRun(r);
      return r;
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    result = e.result;
  }

  const verb = unmark ? 'cleared' : 'marked';
  console.log(`${dryRun ? '[dry run] ' : ''}Test data ${verb}:`);
  console.log(`  submissions : ${result.submissions}`);
  if (includeRelated) {
    console.log(`  contacts    : ${result.contacts}`);
    console.log(`  payments    : ${result.payments}`);
    console.log(`  emails      : ${result.emails}`);
  }
  if (result.unknownRefs.length) {
    // A warning, not a failure: refs that do not exist here usually mean the
    // command was aimed at the wrong environment, and saying which ones missed
    // is more use than refusing to do the ones that hit.
    console.warn(`  not found   : ${result.unknownRefs.join(', ')}`);
  }
  if (dryRun) console.log('Nothing was written — rerun without --dry-run to apply.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
