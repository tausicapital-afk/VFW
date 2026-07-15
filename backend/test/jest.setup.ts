import 'reflect-metadata';
import { testDatabaseUrl } from './test-db';

// Runs in every worker BEFORE the test file (and its AppModule import) loads, so
// PrismaClient is constructed against the test database, not the dev one.
process.env.DATABASE_URL = testDatabaseUrl();

// The JWT module needs a secret to sign session tokens; supply a throwaway one
// for tests if the environment has not.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-prod';

// No mail from the test suite, ever.
//
// ConfigModule loads the dev .env, which points MAIL_* at a real SMTP server —
// so before this, every spec that signed a user up or issued an addressed
// invitation opened a live connection to it and waited ~20s for the handshake to
// time out. That is a real server receiving traffic from `npm test`, and it put
// those specs within a second or two of the 30s testTimeout, which is exactly
// the kind of flake that gets a suite ignored.
//
// Clearing the credentials makes EmailService.configured false, so send() fails
// fast and locally. The paths that must still work without a transport already
// know how: createInvitation reports `emailed: false` and hands back the code,
// and signup falls back to DEV_ECHO_LINKS, which is what it is for.
for (const key of ['MAIL_HOST', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_FROM_ADDRESS']) {
  delete process.env[key];
}
process.env.DEV_ECHO_LINKS = 'true';
