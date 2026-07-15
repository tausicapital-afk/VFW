/**
 * Add (or update) a mail account from the command line.
 *
 * Why this exists rather than a few lines in prisma/seed.ts: `npm test` runs the
 * seed against the throwaway test database, and any mail account in that table
 * makes EmailService.configured true for every spec — which is how the suite
 * ends up opening live SMTP connections to a real server and waiting ~20s for
 * each handshake to time out (see test/jest.setup.ts). The seed must stay
 * mailbox-free. This script is separate, explicit, and never runs in tests.
 *
 * Why not plain SQL: `password` is AES-256-GCM ciphertext keyed on
 * CONFIG_ENC_KEY (or JWT_SECRET), so a row has to be written through
 * encryptSecret() to be readable by the app. An INSERT with a plaintext password
 * produces an account that fails to decrypt at send time.
 *
 * Usage — against production, so it picks up that environment's encryption key:
 *
 *   railway run --service backend npm run mail:add -- \
 *     --label "VFW (cPanel)" --host mail.veeb.co.ke --port 465 --encryption ssl \
 *     --user vfw@veeb.co.ke --from vfw@veeb.co.ke --from-name "VFW Console" --activate
 *
 * The password is read from MAIL_ACCOUNT_PASSWORD if set, so it need not go into
 * your shell history; --password is accepted as a fallback. Re-running with the
 * same --host and --user updates that account rather than failing on the unique
 * constraint, so this is safe to run twice.
 *
 * Everything here is also doable from Administration → Configuration, which is
 * the normal path. This is for bootstrapping an environment without clicking.
 */
import { PrismaClient } from '@prisma/client';
import { encryptSecret } from '../src/config/config.crypto';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const label = arg('label');
  const host = arg('host');
  const username = arg('user');
  const fromAddress = arg('from') ?? username;
  const password = process.env.MAIL_ACCOUNT_PASSWORD?.trim() || arg('password');
  const port = Number(arg('port') ?? 465);
  const encryption = arg('encryption') ?? 'ssl';
  const fromName = arg('from-name');

  const missing = Object.entries({ label, host, user: username, password })
    .filter(([, v]) => !v)
    .map(([k]) => `--${k}`);
  if (missing.length) {
    console.error(
      `Missing: ${missing.join(', ')}\n` +
        `(the password may come from MAIL_ACCOUNT_PASSWORD instead of --password)`,
    );
    process.exit(1);
  }
  if (host!.includes('@')) {
    console.error(`--host must be a hostname like mail.veeb.co.ke, not an email address`);
    process.exit(1);
  }
  if (!process.env.CONFIG_ENC_KEY?.trim() && !process.env.JWT_SECRET?.trim()) {
    console.error(
      'No encryption key in this environment: set CONFIG_ENC_KEY or JWT_SECRET.\n' +
        'Run this through `railway run` so it uses the same key the server will decrypt with.',
    );
    process.exit(1);
  }

  const data = {
    label: label!,
    host: host!,
    port,
    encryption,
    username: username!,
    password: encryptSecret(password!),
    fromAddress: fromAddress!,
    fromName: fromName ?? null,
  };

  const account = await prisma.mailAccount.upsert({
    where: { host_username: { host: host!, username: username! } },
    create: data,
    update: data,
  });

  // Activation is a separate transaction for the same reason the service does
  // it that way: exactly one row may be active, so the others must be cleared in
  // the same breath as this one is set.
  if (flag('activate')) {
    await prisma.$transaction([
      prisma.mailAccount.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      prisma.mailAccount.update({ where: { id: account.id }, data: { isActive: true } }),
    ]);
  }

  const all = await prisma.mailAccount.findMany({ orderBy: { createdAt: 'asc' } });
  console.log(`Saved "${account.label}" (${account.username}). Mail accounts now:`);
  for (const a of all) {
    console.log(`  ${a.isActive ? '●' : '○'} ${a.label} — ${a.fromAddress} via ${a.host}:${a.port} ${a.encryption}`);
  }
  if (!all.some((a) => a.isActive)) {
    console.log('\nNothing is active yet — no email will send. Re-run with --activate.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
