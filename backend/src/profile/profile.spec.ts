import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Self-service profile editing.
 *
 * The interesting tests here are all about the boundary of "yourself". A profile
 * form is a write endpoint every signed-in account can reach, so the questions
 * worth holding are: can it be made to write a field it should not (role,
 * status, commission), and can it be made to read an object it should not (an
 * avatar key pointed at somebody's contract).
 */

const SALES = 'marielle@vanfashionweek.com';
const PASSWORD = 'Vfw@2026!';

describe('profile', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let salesId: string;

  /** Put the seeded account back the way the seed left it. */
  const restore = async () =>
    prisma.user.update({
      where: { id: salesId },
      data: {
        name: 'Marielle Fontaine',
        phone: '+1 604 555 0142',
        department: 'Sales',
        title: null,
        colour: '#2F6BFF',
        avatarKey: null,
      },
    });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, SALES);
    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
  });

  afterEach(restore);

  afterAll(async () => {
    await app?.close();
  });

  it('returns the caller their own profile', async () => {
    const res = await http(app).get('/api/profile').set('Cookie', sales).expect(200);
    expect(res.body.email).toBe(SALES);
    expect(res.body.hasAvatar).toBe(false);
    // Never the hash, and never the raw storage key — the client gets a link.
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.avatarKey).toBeUndefined();
  });

  it('saves the fields a person may change about themselves', async () => {
    const res = await http(app)
      .patch('/api/profile')
      .set('Cookie', sales)
      .send({ name: 'Marielle F.', title: 'Senior Sales Representative', colour: '#0C7A4D' })
      .expect(200);

    expect(res.body.name).toBe('Marielle F.');
    expect(res.body.title).toBe('Senior Sales Representative');
    expect(res.body.colour).toBe('#0C7A4D');
  });

  it('treats an empty string as clearing a field, not as storing a blank one', async () => {
    const res = await http(app)
      .patch('/api/profile')
      .set('Cookie', sales)
      .send({ phone: '   ' })
      .expect(200);

    expect(res.body.phone).toBeNull();
  });

  it('refuses to write a field that is not the caller’s to change', async () => {
    // forbidNonWhitelisted on the global pipe: an undeclared property is a 400,
    // so a rep cannot smuggle a role change through the profile form.
    for (const body of [
      { role: 'ADMIN' },
      { status: 'ACTIVE' },
      { commissionPct: '99' },
      { email: 'someone.else@example.com' },
    ]) {
      await http(app).patch('/api/profile').set('Cookie', sales).send(body).expect(400);
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: salesId } });
    expect(after.role).toBe('SALES');
    expect(after.email).toBe(SALES);
    expect(after.commissionPct.toString()).toBe('8');
  });

  it('refuses a colour that is not a colour', async () => {
    // The value is interpolated into a style attribute on every screen that
    // renders this person, so "anything the user typed" is not an option.
    await http(app).patch('/api/profile').set('Cookie', sales)
      .send({ colour: 'red; background:url(x)' }).expect(400);
    await http(app).patch('/api/profile').set('Cookie', sales)
      .send({ colour: '#fff' }).expect(400);
  });

  // --- Avatar --------------------------------------------------------------

  it('refuses an avatar key outside the caller’s own prefix', async () => {
    // The whole point of the prefix check: without it, "set my avatar to that
    // contract" turns this endpoint into a read of another submission's files.
    for (const storageKey of [
      'submissions/abc/contract.pdf',
      'avatars/someone-else/photo.png',
      '../avatars/x/photo.png',
    ]) {
      await http(app).put('/api/profile/avatar').set('Cookie', sales).send({ storageKey }).expect(400);
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: salesId } });
    expect(after.avatarKey).toBeNull();
  });

  it('accepts a key under the caller’s own prefix and can drop it again', async () => {
    // Committing does not need the bytes to exist: the row points at a key, and
    // the link is signed on read. Storage may not even be configured in tests,
    // which is exactly why avatarUrl degrades to null instead of failing.
    const storageKey = `avatars/${salesId}/test-avatar.png`;

    const set = await http(app).put('/api/profile/avatar').set('Cookie', sales)
      .send({ storageKey }).expect(200);
    expect(set.body.hasAvatar).toBe(true);

    const cleared = await http(app).delete('/api/profile/avatar').set('Cookie', sales).expect(200);
    expect(cleared.body.hasAvatar).toBe(false);
    expect(cleared.body.avatarUrl).toBeNull();
  });

  it('only presigns image types', async () => {
    await http(app).post('/api/profile/avatar/presign').set('Cookie', sales)
      // SVG is a document that can carry script, and would be served back inline.
      .send({ filename: 'x.svg', contentType: 'image/svg+xml' }).expect(400);
    await http(app).post('/api/profile/avatar/presign').set('Cookie', sales)
      .send({ filename: 'x.pdf', contentType: 'application/pdf' }).expect(400);
  });

  // --- Password ------------------------------------------------------------

  describe('password change', () => {
    /** A scratch account, so the seeded login every other spec uses is untouched. */
    let cookie: string;
    let userId: string;
    const email = `pw.${Date.now()}@example.com`;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          name: 'Password Tester',
          email,
          passwordHash: await argon2.hash(PASSWORD),
          role: 'SALES',
          status: 'ACTIVE',
          hidden: true,
        },
      });
      userId = user.id;
      cookie = await loginCookie(app, email);
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it('refuses a change without the current password', async () => {
      await http(app).post('/api/profile/password').set('Cookie', cookie)
        .send({ currentPassword: 'wrong-password', newPassword: 'BrandNew#2026' })
        .expect(401);
    });

    it('refuses a new password that is the old one', async () => {
      await http(app).post('/api/profile/password').set('Cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: PASSWORD })
        .expect(400);
    });

    it('refuses a new password that is too short', async () => {
      await http(app).post('/api/profile/password').set('Cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);
    });

    it('changes it, signs the other sessions out, and keeps this one alive', async () => {
      // A second browser, signed in before the change.
      const otherBrowser = await loginCookie(app, email);
      const next = 'BrandNew#2026';

      const res = await http(app).post('/api/profile/password').set('Cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: next })
        .expect(201);

      // The response replaces this browser's cookie — the old one died with the
      // tokenVersion bump, so continuing to send it would sign the user out of
      // the very request that succeeded.
      const refreshed = (res.headers['set-cookie'] as unknown as string[])[0];
      await http(app).get('/api/profile').set('Cookie', refreshed).expect(200);

      // Every other session is gone.
      await http(app).get('/api/profile').set('Cookie', otherBrowser).expect(401);

      // And the new password is the one that works.
      await http(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(401);
      await http(app).post('/api/auth/login').send({ email, password: next }).expect(201);

      cookie = refreshed;
    });
  });
});
