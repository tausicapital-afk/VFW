import { execSync } from 'node:child_process';
import { testDatabaseUrl } from './test-db';

/**
 * Once, before the whole suite: sync the schema onto a throwaway test database
 * and seed the catalogue + demo users the integration tests sign in as. `db
 * push` creates the database if it does not exist, so there is nothing to
 * provision by hand — locally or in CI.
 */
export default async function globalSetup() {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url };

  // eslint-disable-next-line no-console
  console.log(`\n[test] preparing ${url.replace(/:[^:@/]+@/, ':****@')}`);

  execSync('npx prisma db push --skip-generate --accept-data-loss', { env, stdio: 'inherit' });
  // tsconfig already targets CommonJS, so ts-node needs no CLI compiler flag
  // (passing one through execSync mangles its JSON in the shell). Set it via env
  // as a belt-and-suspenders and run the seed directly.
  execSync('npx ts-node prisma/seed.ts', {
    env: { ...env, TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' },
    stdio: 'inherit',
  });
}
