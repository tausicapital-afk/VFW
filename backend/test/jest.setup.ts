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
// Blanking the credentials makes EmailService.configured false, so send() fails
// fast and locally. The paths that must still work without a transport already
// know how: createInvitation reports `emailed: false` and hands back the code,
// and signup falls back to DEV_ECHO_LINKS, which is what it is for.
//
// SET TO EMPTY, NOT DELETED, and that is the whole trick. AppModule calls
// ConfigModule.forRoot(), which loads the dev .env when the test file imports it
// — after this runs. Nest only assigns keys that are not already `in
// process.env`, and a key set to '' IS in process.env, so an empty string stays
// empty while a deleted key is quietly refilled from .env. Deleting them looked
// like it worked for years: most specs never send, and the ones that do just
// took ~23s each to time out against a real server rather than failing.
// ConfigService treats empty as unset at every level, so '' reads as "no value".
//
// THIS ONLY HOLDS WHILE THE MailAccount TABLE IS EMPTY. EmailService resolves an
// active mail account BEFORE these variables, so a single row in the seeded test
// database would put every spec back on a live connection to whatever SMTP
// server that row names — with no env var left to unset. That is why
// prisma/seed.ts adds no mail accounts and why scripts/add-mail-account.ts is a
// separate, manual script. A spec that needs an account must point it at an
// unroutable host (see src/config/mail-accounts.spec.ts).
for (const key of ['MAIL_HOST', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_FROM_ADDRESS']) {
  process.env[key] = '';
}
process.env.DEV_ECHO_LINKS = 'true';
