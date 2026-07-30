import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from './config.crypto';

/**
 * Mail accounts, through the real request path.
 *
 * The properties worth locking down here are the ones whose failure is silent:
 *
 *  - Exactly one account is ever active. Two active rows means the sender is
 *    decided by row order — mail goes out from a mailbox nobody chose.
 *  - The password is stored encrypted and never leaves the server. It is the
 *    only thing in this table that cannot be recovered from anywhere else.
 *  - Deleting the account that is currently sending is refused. Allowing it
 *    turns off every sign-up code and password reset with one click, and the
 *    admin would have no reason to expect that.
 *
 * Every host below is deliberately unroutable (.invalid, reserved by RFC 2606):
 * a real hostname here would have the suite opening SMTP connections to someone
 * else's server, which is exactly what test/jest.setup.ts exists to prevent.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

describe('mail accounts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  const account = (over: object = {}) => ({
    label: 'cPanel',
    host: 'mail.example.invalid',
    port: 465,
    encryption: 'ssl',
    username: 'vfw@example.invalid',
    password: 'secret-one',
    fromAddress: 'vfw@example.invalid',
    ...over,
  });

  const add = async (over: object = {}, expected = 201) => {
    const res = await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', admin)
      .send(account(over))
      .expect(expected);
    return res.body as { accounts: { id: string; label: string; isActive: boolean }[] };
  };

  const list = async () => {
    const res = await http(app).get('/api/admin/mail-accounts').set('Cookie', admin).expect(200);
    return res.body as {
      accounts: { id: string; label: string; isActive: boolean; username: string }[];
      status: { source: string };
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
  });

  // The table is global state that EmailService reads: a row left behind would
  // make every later spec in this file — and the suite — think mail is live.
  afterEach(async () => {
    await prisma.mailAccount.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('is admin-only — a rep cannot read or add a mailbox', async () => {
    const sales = await loginCookie(app, SALES);
    await http(app).get('/api/admin/mail-accounts').set('Cookie', sales).expect(403);
    await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', sales)
      .send(account())
      .expect(403);
  });

  it('makes the first account active, so one mailbox is enough to send', async () => {
    const { accounts } = await add();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].isActive).toBe(true);
    expect((await list()).status.source).toBe('account');
  });

  it('does not activate a second account behind the admin’s back', async () => {
    await add();
    const { accounts } = await add({ label: 'Gmail', username: 'x@gmail.invalid', host: 'smtp.gmail.invalid' });
    expect(accounts.filter((a) => a.isActive).map((a) => a.label)).toEqual(['cPanel']);
  });

  it('activating one mailbox deactivates the other — never two, never none', async () => {
    await add();
    const { accounts } = await add({ label: 'Gmail', username: 'x@gmail.invalid', host: 'smtp.gmail.invalid' });
    const gmail = accounts.find((a) => a.label === 'Gmail')!;

    const res = await http(app)
      .post(`/api/admin/mail-accounts/${gmail.id}/activate`)
      .set('Cookie', admin)
      .expect(201);

    const active = (res.body.accounts as { label: string; isActive: boolean }[]).filter((a) => a.isActive);
    expect(active.map((a) => a.label)).toEqual(['Gmail']);
  });

  it('stores the password encrypted and never returns it', async () => {
    const { accounts } = await add();
    const row = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accounts[0].id } });

    expect(row.password).not.toContain('secret-one');
    expect(row.password.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(row.password)).toBe('secret-one');
    expect(JSON.stringify(accounts)).not.toContain('secret-one');
  });

  it('keeps the stored password when the field is left blank on an edit', async () => {
    const { accounts } = await add();
    const id = accounts[0].id;

    await http(app)
      .patch(`/api/admin/mail-accounts/${id}`)
      .set('Cookie', admin)
      .send({ label: 'cPanel (renamed)', password: '' })
      .expect(200);

    const row = await prisma.mailAccount.findUniqueOrThrow({ where: { id } });
    expect(row.label).toBe('cPanel (renamed)');
    expect(decryptSecret(row.password)).toBe('secret-one');
  });

  it('refuses an email address where the hostname goes', async () => {
    const res = await add({ host: 'vfw@veeb.co.ke' }, 400);
    expect(JSON.stringify(res)).toMatch(/hostname/i);
  });

  // Resend needs an API key and a from-address; demanding an SMTP host for it
  // would be asking for a value that has no meaning.
  it('takes an HTTP provider with no host or username', async () => {
    const res = await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', admin)
      .send({
        label: 'Resend',
        provider: 'resend',
        password: 're_test_key',
        fromAddress: 'noreply@example.invalid',
      })
      .expect(201);

    const created = (res.body.accounts as { provider: string; host: string; username: string }[])[0];
    expect(created.provider).toBe('resend');
    expect(created.host).toBe('');
    expect(created.username).toBe('');
  });

  it('will not carry an SMTP password over as an API key', async () => {
    const { accounts } = await add();
    const res = await http(app)
      .patch(`/api/admin/mail-accounts/${accounts[0].id}`)
      .set('Cookie', admin)
      .send({ provider: 'resend' }) // no new secret
      .expect(400);

    expect(JSON.stringify(res.body)).toMatch(/API key/i);
  });

  it('clears the SMTP fields when an account moves to an HTTP provider', async () => {
    const { accounts } = await add();
    const res = await http(app)
      .patch(`/api/admin/mail-accounts/${accounts[0].id}`)
      .set('Cookie', admin)
      .send({ provider: 'resend', password: 're_new_key' })
      .expect(200);

    const row = (res.body.accounts as { provider: string; host: string; username: string }[])[0];
    expect(row.provider).toBe('resend');
    expect(row.host).toBe('');
    expect(row.username).toBe('');
  });

  it('rejects a provider it does not know', async () => {
    await add({ provider: 'carrier-pigeon' }, 400);
  });

  // The relay keeps a host (its URL) but needs no port/encryption/username.
  it('takes a relay with a URL and a token', async () => {
    const res = await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', admin)
      .send({
        label: 'cPanel relay',
        provider: 'relay',
        host: 'https://veeb.example.invalid/vfw-relay/',
        password: 'relay-token',
        fromAddress: 'vfw@veeb.example.invalid',
      })
      .expect(201);

    const row = (res.body.accounts as { provider: string; host: string; username: string }[])[0];
    expect(row.provider).toBe('relay');
    expect(row.host).toBe('https://veeb.example.invalid/vfw-relay/');
    expect(row.username).toBe('');
  });

  // The token rides in a header on every send, and it is the relay's whole
  // perimeter — over http:// it is readable by anyone on the path.
  it('refuses a relay URL that is not https', async () => {
    const res = await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', admin)
      .send({
        label: 'insecure relay',
        provider: 'relay',
        host: 'http://veeb.example.invalid/vfw-relay/',
        password: 'relay-token',
        fromAddress: 'vfw@veeb.example.invalid',
      })
      .expect(400);

    expect(JSON.stringify(res.body)).toMatch(/https/i);
  });

  it('refuses a relay URL that is not a URL at all', async () => {
    await http(app)
      .post('/api/admin/mail-accounts')
      .set('Cookie', admin)
      .send({
        label: 'bad relay',
        provider: 'relay',
        host: 'mail.veeb.co.ke',
        password: 'relay-token',
        fromAddress: 'vfw@veeb.example.invalid',
      })
      .expect(400);
  });

  // `host` means a hostname for smtp and a URL for relay: carrying the old value
  // across the switch would leave a configured-looking, broken account.
  it('will not reuse an SMTP hostname as a relay URL', async () => {
    const { accounts } = await add();
    const res = await http(app)
      .patch(`/api/admin/mail-accounts/${accounts[0].id}`)
      .set('Cookie', admin)
      .send({ provider: 'relay', password: 'relay-token' }) // no new host
      .expect(400);

    expect(JSON.stringify(res.body)).toMatch(/relay URL/i);
  });

  it('will not delete the mailbox that is currently sending', async () => {
    await add();
    const { accounts } = await add({ label: 'Gmail', username: 'x@gmail.invalid', host: 'smtp.gmail.invalid' });
    const active = accounts.find((a) => a.isActive)!;

    await http(app)
      .delete(`/api/admin/mail-accounts/${active.id}`)
      .set('Cookie', admin)
      .expect(400);

    expect((await list()).accounts).toHaveLength(2);
  });

  it('lets the last mailbox go, handing sending back to the environment', async () => {
    const { accounts } = await add();
    await http(app)
      .delete(`/api/admin/mail-accounts/${accounts[0].id}`)
      .set('Cookie', admin)
      .expect(200);

    const after = await list();
    expect(after.accounts).toHaveLength(0);
    // jest.setup clears MAIL_*, so with no rows left nothing can send — and the
    // status says so rather than pretending.
    expect(after.status.source).toBe('none');
  });

  it('an active account is what EmailService sends from, ahead of MAIL_*', async () => {
    const email = app.get(EmailService);
    expect(email.configured).toBe(false);

    await add();
    expect(email.configured).toBe(true);
  });
});
