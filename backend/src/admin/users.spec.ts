import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Users & roles tab.
 *
 * Two properties worth holding here, beyond "the edit saves":
 *
 *   1. Editing a rep's commission changes what the NEXT sale pays, never what a
 *      sale already on the books paid. Submission copies commissionPct onto the
 *      record at creation — catalog.spec.ts holds the same line for prices.
 *   2. An admin cannot use this screen to lock everyone out of this screen.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

describe('users & roles — edit and soft delete', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const litter: string[] = [];

  /** A throwaway account to edit, so the seeded demo logins stay as seeded. */
  const scratchUser = async (over: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        name: 'Scratch Rep',
        email: `scratch.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
        // argon2 hash of 'Vfw@2026!' would be slow to compute per test; these
        // accounts are edited, not signed into, unless a test says otherwise.
        passwordHash: 'x',
        role: 'SALES',
        department: 'Sales',
        status: 'ACTIVE',
        commissionPct: '8',
        target: '100000',
        ...over,
      },
    });
    litter.push(user.id);
    return user;
  };

  const listed = async (id: string) => {
    const res = await http(app).get('/api/users').set('Cookie', admin).expect(200);
    return (res.body.users as { id: string }[]).some((u) => u.id === id);
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
  });

  afterAll(async () => {
    if (litter.length) await prisma.user.deleteMany({ where: { id: { in: litter } } });
    await app?.close();
  });

  describe('editing', () => {
    it('saves the fields the tab shows', async () => {
      const u = await scratchUser();

      const res = await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({
          name: 'Renamed Rep',
          phone: '+1 604 555 0123',
          role: 'MGR',
          department: 'Marketing',
          commissionPct: '12.5',
          target: '250000',
        })
        .expect(200);

      expect(res.body.user).toMatchObject({
        name: 'Renamed Rep',
        phone: '+1 604 555 0123',
        role: 'MGR',
        department: 'Marketing',
        // Decimal serialises via toString (see main.ts), so a trailing zero is
        // not part of the wire format — 12.5 and 12.50 are the same number.
        commissionPct: '12.5',
        target: '250000',
      });

      // What was actually stored, at the scale the column declares.
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.commissionPct.toFixed(2)).toBe('12.50');
      expect(row.target.toFixed(2)).toBe('250000.00');
    });

    it('keeps money exact rather than round-tripping it through a float', async () => {
      const u = await scratchUser();

      const res = await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ commissionPct: '7.33', target: '123456789.99' })
        .expect(200);

      expect(res.body.user.commissionPct).toBe('7.33');
      expect(res.body.user.target).toBe('123456789.99');
    });

    it('rejects a commission that is not a positive number, or is over 100', async () => {
      const u = await scratchUser();
      const bad = (body: object) =>
        http(app).patch(`/api/users/${u.id}`).set('Cookie', admin).send(body).expect(400);

      await bad({ commissionPct: 'lots' });
      await bad({ commissionPct: '-5' });
      await bad({ commissionPct: '101' });
      await bad({ target: '-1' });
    });

    it('records only what changed, and refuses fields that are not editable', async () => {
      const u = await scratchUser({ name: 'Stable Name' });

      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ name: 'Stable Name', role: 'ACCT' }) // name resent unchanged
        .expect(200);

      const entry = await prisma.auditEntry.findFirst({
        where: { action: 'USER_UPDATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.payload).toMatchObject({ before: { role: 'SALES' }, after: { role: 'ACCT' } });
      expect(entry?.payload).not.toHaveProperty('after.name');

      // Email and tokenVersion are not on the DTO; forbidNonWhitelisted 400s.
      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ email: 'new@example.com' })
        .expect(400);
      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ tokenVersion: 0 })
        .expect(400);
    });

    it('will not write PENDING or REJECTED through the edit form', async () => {
      const u = await scratchUser();
      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ status: 'REJECTED' })
        .expect(400);
    });
  });

  describe('a commission change and history', () => {
    it('does not move a sale that has already been made', async () => {
      // The rep sells at 8%.
      const rep = await prisma.user.findUniqueOrThrow({ where: { email: SALES } });
      const sale = await prisma.submission.findFirst({
        where: { repId: rep.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!sale) throw new Error('seed has no submission for the sales rep to test against');

      const before = sale.commissionPct.toFixed(2);
      const amountBefore = sale.commissionAmount.toFixed(2);

      // Their rate changes to something conspicuously different.
      await http(app)
        .patch(`/api/users/${rep.id}`)
        .set('Cookie', admin)
        .send({ commissionPct: '25' })
        .expect(200);

      const after = await prisma.submission.findUniqueOrThrow({ where: { id: sale.id } });
      expect(after.commissionPct.toFixed(2)).toBe(before);
      expect(after.commissionAmount.toFixed(2)).toBe(amountBefore);

      // Put the seeded rep back the way the seed left them.
      await http(app)
        .patch(`/api/users/${rep.id}`)
        .set('Cookie', admin)
        .send({ commissionPct: rep.commissionPct.toFixed(2) })
        .expect(200);
    });
  });

  describe('disabling', () => {
    it('blocks the login and kills the session already held', async () => {
      // A real password, because this one actually signs in.
      const invite = await http(app)
        .post('/api/invitations')
        .set('Cookie', admin)
        .send({ role: 'SALES', department: 'Sales' })
        .expect(201);
      const email = `disable.me.${Date.now()}@example.com`;
      await http(app)
        .post('/api/auth/signup')
        .send({ code: invite.body.code, name: 'Soon Disabled', email, password: 'Vfw@2026!test' })
        .expect(201);
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      litter.push(u.id);
      await http(app).post(`/api/users/${u.id}/approve`).set('Cookie', admin).expect(201);

      const theirs = await loginCookie(app, email, 'Vfw@2026!test');
      await http(app).get('/api/contacts').set('Cookie', theirs).expect(200);

      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ status: 'DISABLED' })
        .expect(200);

      await http(app).get('/api/contacts').set('Cookie', theirs).expect(401);
      await http(app)
        .post('/api/auth/login')
        .send({ email, password: 'Vfw@2026!test' })
        .expect(401);

      // ...and re-enabling lets them back in. Disabled is meant to be reversible;
      // that is the whole reason it is not a delete.
      await http(app)
        .patch(`/api/users/${u.id}`)
        .set('Cookie', admin)
        .send({ status: 'ACTIVE' })
        .expect(200);
      await loginCookie(app, email, 'Vfw@2026!test');
    });
  });

  describe('soft delete', () => {
    it('takes the account off the tab but keeps the row', async () => {
      const u = await scratchUser();
      expect(await listed(u.id)).toBe(true);

      await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(200);

      expect(await listed(u.id)).toBe(false);
      const row = await prisma.user.findUnique({ where: { id: u.id } });
      expect(row?.deletedAt).toBeInstanceOf(Date);
    });

    it('leaves a deleted account uneditable rather than half-alive', async () => {
      const u = await scratchUser();
      await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(200);

      await http(app).patch(`/api/users/${u.id}`).set('Cookie', admin).send({ name: 'Ghost' }).expect(404);
      await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(404);
    });
  });

  describe('locking yourself out', () => {
    it('refuses to change your own role or status', async () => {
      const me = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });

      const role = await http(app)
        .patch(`/api/users/${me.id}`)
        .set('Cookie', admin)
        .send({ role: 'SALES' })
        .expect(400);
      expect(role.body.message).toMatch(/your own role/i);

      const status = await http(app)
        .patch(`/api/users/${me.id}`)
        .set('Cookie', admin)
        .send({ status: 'DISABLED' })
        .expect(400);
      expect(status.body.message).toMatch(/your own status/i);

      const del = await http(app).delete(`/api/users/${me.id}`).set('Cookie', admin).expect(400);
      expect(del.body.message).toMatch(/your own account/i);
    });

    it('still lets you edit your own details', async () => {
      const me = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
      await http(app)
        .patch(`/api/users/${me.id}`)
        .set('Cookie', admin)
        .send({ phone: '+1 604 555 0199', role: me.role, status: me.status })
        .expect(200);
    });

    /**
     * The last-admin guard cannot be reached over HTTP today: only an ADMIN may
     * call these routes, so there is always at least one ACTIVE admin — the
     * caller — and they are blocked from demoting or deleting themselves by the
     * checks above. It is a backstop for the day either of those changes (the
     * ACL widens to MGR, say), so it is tested where it can actually be
     * exercised: at the service, with an actor who is not the admin in question.
     */
    it('backstop: refuses to demote, disable or delete the last administrator', async () => {
      const service = app.get(AdminService);
      const theAdmin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
      const rep = await prisma.user.findUniqueOrThrow({ where: { email: SALES } });
      const actor = { id: rep.id, email: rep.email, name: rep.name, role: rep.role };

      // Sanity: the seed really does have exactly one admin, or this proves nothing.
      const admins = await prisma.user.count({
        where: { role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
      });
      expect(admins).toBe(1);

      await expect(service.updateUser(theAdmin.id, { role: 'SALES' }, actor)).rejects.toThrow(
        /last administrator/i,
      );
      await expect(service.updateUser(theAdmin.id, { status: 'DISABLED' }, actor)).rejects.toThrow(
        /last administrator/i,
      );
      await expect(service.deleteUser(theAdmin.id, actor)).rejects.toThrow(/last administrator/i);

      // ...and allows it once a second admin exists to carry the console.
      const spare = await scratchUser({ role: 'ADMIN', status: 'ACTIVE' });
      await expect(service.updateUser(theAdmin.id, { role: 'SALES' }, actor)).resolves.toBeDefined();

      // Put the seeded admin back.
      await prisma.user.update({ where: { id: theAdmin.id }, data: { role: 'ADMIN' } });
      await prisma.user.delete({ where: { id: spare.id } });
    });
  });

  describe('authorization', () => {
    it('is admin-only — a rep cannot edit or delete an account', async () => {
      const u = await scratchUser();
      const rep = await loginCookie(app, SALES);

      await http(app).patch(`/api/users/${u.id}`).set('Cookie', rep).send({ role: 'ADMIN' }).expect(403);
      await http(app).delete(`/api/users/${u.id}`).set('Cookie', rep).expect(403);
      await http(app).get('/api/users').set('Cookie', rep).expect(403);
    });
  });
});
