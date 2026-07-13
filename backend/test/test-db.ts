/**
 * Integration tests must never touch the developer's working database. This
 * derives a sibling `<db>_test` database from DATABASE_URL, so `npm test` is
 * self-contained locally and in CI without a second connection string to keep
 * in sync.
 */
export function testDatabaseUrl(): string {
  const base =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://vfw:vfw@localhost:5434/vfw?schema=public';

  // Already a dedicated test database — leave it alone.
  if (/_test(\b|_)/.test(base)) return base;

  const u = new URL(base);
  // pathname is "/<dbname>"; suffix the db name with _test.
  u.pathname = u.pathname.replace(/\/([^/]+)$/, '/$1_test');
  return u.toString();
}
