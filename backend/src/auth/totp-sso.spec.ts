import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { generateSync } from 'otplib';
import { createTestApp, http, loginCookie } from '../../test/app';
import { decryptSecret } from '../config/config.crypto';
import { SESSION_COOKIE } from '../common/cookie';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TOTP two-factor authentication (enrollment, login, disable) and Google SSO's
 * "not configured" path.
 *
 * What Google's own handshake actually does once GOOGLE_CLIENT_ID/SECRET are
 * set is not tested here, the same way QboConnectionService's live exchange
 * with Intuit is not: it needs a real answer from Google's servers. What *is*
 * ours to test, and does not need one, is everything on this side of that
 * call — the graceful-degradation redirect, and the TOTP gate that a Google
 * login funnels through exactly like a password login (AuthService.
 * completeFirstFactor is the single shared tail for both).
 */

const PASSWORD = 'Vfw@2026!';

describe('two-factor authentication (TOTP) + Google SSO', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  async function createUser(email: string) {
    const user = await prisma.user.create({
      data: {
        name: 'TOTP Tester',
        email,
        passwordHash: await argon2.hash(PASSWORD),
        role: 'SALES',
        status: 'ACTIVE',
        // Keeps a scratch account off the leaderboard/dashboard, same as the
        // scratch users profile.spec.ts's password-change block creates.
        hidden: true,
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  describe('enrollment', () => {
    let cookie: string;
    let userId: string;
    const email = `totp.enroll.${Date.now()}@example.com`;

    beforeAll(async () => {
      const user = await createUser(email);
      userId = user.id;
      cookie = await loginCookie(app, email);
    });

    it('mints a secret and stores it encrypted, without enabling 2FA yet', async () => {
      const res = await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(201);
      expect(res.body.secret).toEqual(expect.any(String));
      expect(res.body.otpauthUrl).toContain('otpauth://totp/');

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecret).toEqual(expect.any(String));
      // Encrypted at rest, per config.crypto's "enc:v1:" scheme (same helper
      // already used for SMTP/R2/QBO) — never the plaintext secret on the row.
      expect(row.totpSecret).not.toBe(res.body.secret);
      expect(decryptSecret(row.totpSecret!)).toBe(res.body.secret);
    });

    it('does not enable 2FA on a wrong code', async () => {
      await http(app).post('/api/profile/totp/confirm').set('Cookie', cookie).send({ code: '000000' }).expect(400);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpEnabled).toBe(false);
    });

    it('re-enrolling overwrites the never-activated secret', async () => {
      const first = await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(201);
      const second = await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(201);
      expect(second.body.secret).not.toBe(first.body.secret);

      // The first secret no longer validates a code — only the newest one does.
      const staleCode = generateSync({ secret: first.body.secret });
      await http(app).post('/api/profile/totp/confirm').set('Cookie', cookie).send({ code: staleCode }).expect(400);
    });

    it('enables 2FA on a correct code, and refuses to re-enroll once enabled', async () => {
      const enroll = await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(201);
      const code = generateSync({ secret: enroll.body.secret });
      await http(app).post('/api/profile/totp/confirm').set('Cookie', cookie).send({ code }).expect(201);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpEnabled).toBe(true);

      await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(400);
    });

    it('requires the current password to disable, then clears the secret', async () => {
      await http(app).post('/api/profile/totp/disable').set('Cookie', cookie).send({ password: 'wrong-password' }).expect(401);

      let row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpEnabled).toBe(true);

      await http(app).post('/api/profile/totp/disable').set('Cookie', cookie).send({ password: PASSWORD }).expect(201);

      row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecret).toBeNull();
    });
  });

  describe('login with 2FA enabled', () => {
    let userId: string;
    let secret: string;
    const email = `totp.login.${Date.now()}@example.com`;

    beforeAll(async () => {
      const user = await createUser(email);
      userId = user.id;
      const cookie = await loginCookie(app, email);
      const enroll = await http(app).post('/api/profile/totp/enroll').set('Cookie', cookie).expect(201);
      secret = enroll.body.secret;
      const code = generateSync({ secret });
      await http(app).post('/api/profile/totp/confirm').set('Cookie', cookie).send({ code }).expect(201);
    });

    it('a correct password does not complete the login — it returns a challenge, and sets no cookie', async () => {
      const res = await http(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);
      expect(res.body.totpRequired).toBe(true);
      expect(res.body.challenge).toEqual(expect.any(String));
      expect(res.body.user).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('completes the login with a correct code', async () => {
      const first = await http(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);
      const code = generateSync({ secret });
      const res = await http(app)
        .post('/api/auth/login/totp')
        .send({ challenge: first.body.challenge, code })
        .expect(201);

      expect(res.body.user.email).toBe(email);
      expect(res.headers['set-cookie']).toBeDefined();

      // And the session that came back actually works.
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0];
      await http(app).get('/api/profile').set('Cookie', sessionCookie).expect(200);
    });

    it('refuses a wrong code', async () => {
      const first = await http(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);
      await http(app)
        .post('/api/auth/login/totp')
        .send({ challenge: first.body.challenge, code: '000000' })
        .expect(401);
    });

    it('refuses a well-formed but wholly invalid challenge', async () => {
      const code = generateSync({ secret });
      await http(app)
        .post('/api/auth/login/totp')
        .send({ challenge: 'not-a-real-jwt', code })
        .expect(401);
    });

    it('the challenge cannot be replayed as a session cookie', async () => {
      const first = await http(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);

      // The challenge is a JWT signed by the same key as a real session, but it
      // carries `typ: 'totp-challenge'` and no `id`/`tv` — AuthGuard.
      // verifySession checks the claim shape before trusting it, so pasting the
      // challenge in as the session cookie must land on the same plain
      // "not signed in" 401 every other bad token gets, not a 500 from
      // `prisma.user.findUnique({ where: { id: undefined } })`.
      await http(app)
        .get('/api/profile')
        .set('Cookie', `${SESSION_COOKIE}=${first.body.challenge}`)
        .expect(401);
    });
  });

  describe('Google sign-in, not configured', () => {
    it('GET /api/auth/google redirects to the login screen with a readable error, not a 500', async () => {
      const res = await http(app).get('/api/auth/google');
      expect(res.status).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain('ssoError=');
      expect(location).not.toContain('accounts.google.com');
    });

    it('GET /api/auth/google/callback redirects with a readable error rather than throwing', async () => {
      const res = await http(app).get('/api/auth/google/callback').query({ code: 'x', state: 'y' });
      expect(res.status).toBe(302);
      expect(res.headers.location as string).toContain('ssoError=');
    });
  });
});
