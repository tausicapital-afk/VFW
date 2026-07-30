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
 * An HTTP provider needs no host, port or username — just a key and a sender:
 *
 *   railway run --service backend npm run mail:add -- \
 *     --provider resend --label "Resend" --from noreply@veeb.co.ke --activate
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

const HTTP_PROVIDERS = ['resend'];

async function main() {
  const provider = arg('provider') ?? 'smtp';
  const http = HTTP_PROVIDERS.includes(provider);
  const label = arg('label');
  const host = http ? '' : arg('host');
  const username = http ? '' : arg('user');
  const fromAddress = arg('from') ?? (http ? undefined : username);
  const password = process.env.MAIL_ACCOUNT_PASSWORD?.trim() || arg('password');
  const port = http ? 465 : Number(arg('port') ?? 465);
  const encryption = http ? 'ssl' : (arg('encryption') ?? 'ssl');
  const fromName = arg('from-name');

  // An HTTP provider has no host or username to require — asking for them would
  // be asking for values with no meaning.
  const required: Record<string, string | undefined> = http
    ? { label, from: fromAddress, password }
    : { label, host, user: username, password };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => `--${k}`);
  if (missing.length) {
    console.error(
      `Missing: ${missing.join(', ')}\n` +
        `(the password/API key may come from MAIL_ACCOUNT_PASSWORD instead of --password)`,
    );
    process.exit(1);
  }
  if (host?.includes('@')) {
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
    provider,
    host: host ?? '',
    port,
    encryption,
    username: username ?? '',
    password: encryptSecret(password!),
    fromAddress: fromAddress!,
    fromName: fromName ?? null,
  };

  const account = await prisma.mailAccount.upsert({
    where: {
      provider_host_username_fromAddress: {
        provider,
        host: host ?? '',
        username: username ?? '',
        fromAddress: fromAddress!,
      },
    },
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
  console.log(`Saved "${account.label}" (${account.fromAddress}). Mail accounts now:`);
  for (const a of all) {
    const via = HTTP_PROVIDERS.includes(a.provider)
      ? `${a.provider} (HTTPS)`
      : `${a.host}:${a.port} ${a.encryption}`;
    console.log(`  ${a.isActive ? '●' : '○'} ${a.label} — ${a.fromAddress} via ${via}`);
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
