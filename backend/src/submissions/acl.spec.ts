import type { INestApplication } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { createTestApp, http, loginCookie } from '../../test/app';
import { ACL, can, type Permission } from '../common/acl';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The ACL matrix in common/acl.ts is a table, so this test is a table too: one
 * case per role per guarded endpoint. The security boundary is the SERVER — the
 * frontend copy is cosmetic — so these hit the real request path through the
 * global AuthGuard.
 */

// The seeded demo accounts, one per role we can sign in as. (INTERN has no
// seeded account; its rows in the matrix are covered by the unit-level `can()`.)
const ACCOUNTS: Record<string, { email: string; role: Role }> = {
  SALES: { email: 'marielle@vanfashionweek.com', role: 'SALES' },
  ACCT: { email: 'accounting@vanfashionweek.com', role: 'ACCT' },
  MGR: { email: 'sales.director@vanfashionweek.com', role: 'MGR' },
  ADMIN: { email: 'it@vanfashionweek.com', role: 'ADMIN' },
};

// Guarded endpoints, each with the permission the route declares. Using a
// non-existent id (or an empty body) means an *allowed* role falls through the
// guard to a 404/400 while a *denied* role is stopped at 403 — cleanly
// isolating the authorization decision from everything else.
type Ep = { name: string; method: 'get' | 'post' | 'patch'; path: string; permission: Permission; body?: object };
const ENDPOINTS: Ep[] = [
  { name: 'GET  /contacts', method: 'get', path: '/api/contacts', permission: 'contacts.view' },
  { name: 'POST /contacts', method: 'post', path: '/api/contacts', permission: 'contacts.create', body: { brand: '' } },
  { name: 'GET  /queue', method: 'get', path: '/api/submissions/queue', permission: 'submission.queueView' },
  { name: 'POST /approve', method: 'post', path: '/api/submissions/no-such-id/approve', permission: 'submission.approve' },
  { name: 'POST /reject', method: 'post', path: '/api/submissions/no-such-id/reject', permission: 'submission.reject', body: { reason: 'x' } },
  { name: 'POST /return', method: 'post', path: '/api/submissions/no-such-id/return', permission: 'submission.return', body: { note: 'x' } },
  { name: 'POST /payments', method: 'post', path: '/api/submissions/no-such-id/payments', permission: 'accounting.fields', body: { date: '2026-01-01', amount: 1, method: 'Cash' } },
  { name: 'PATCH /:id', method: 'patch', path: '/api/submissions/no-such-id', permission: 'accounting.fields', body: { glAccount: '4010' } },
  { name: 'POST /invoice', method: 'post', path: '/api/submissions/no-such-id/invoice', permission: 'invoice.generate' },
  { name: 'POST /export', method: 'post', path: '/api/submissions/no-such-id/export', permission: 'quickbooks.export' },
];

describe('ACL boundary (server-side authorization)', () => {
  let app: INestApplication;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    for (const [key, acc] of Object.entries(ACCOUNTS)) {
      cookies[key] = await loginCookie(app, acc.email);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sanity-checks the matrix under test against the shipped ACL', () => {
    // Every endpoint's permission must be a real key in the ACL table.
    for (const ep of ENDPOINTS) expect(ACL[ep.permission]).toBeDefined();
  });

  // ---- the table: role x endpoint ----
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    describe(`as ${acc.role}`, () => {
      for (const ep of ENDPOINTS) {
        const allowed = can(ep.permission, acc.role);
        it(`${ep.name} -> ${allowed ? 'passes the guard (not 403)' : '403'}`, async () => {
          const req = http(app)[ep.method](ep.path).set('Cookie', cookies[key]);
          const res = await (ep.body ? req.send(ep.body) : req.send());
          if (allowed) {
            expect(res.status).not.toBe(403);
          } else {
            expect(res.status).toBe(403);
          }
        });
      }
    });
  }

  // ---- the explicit negatives the prompt calls out ----
  describe('named boundary cases that must keep holding', () => {
    it('no session -> 401', async () => {
      const res = await http(app).get('/api/submissions');
      expect(res.status).toBe(401);
    });

    it('SALES -> POST /approve -> 403', async () => {
      const res = await http(app)
        .post('/api/submissions/no-such-id/approve')
        .set('Cookie', cookies.SALES)
        .send();
      expect(res.status).toBe(403);
    });

    it('SALES -> GET /queue -> 200, but only their own rows (reading is not deciding)', async () => {
      const me = await http(app).get('/api/auth/me').set('Cookie', cookies.SALES).expect(200);
      const myId = me.body.user.id as string;

      const res = await http(app).get('/api/submissions/queue').set('Cookie', cookies.SALES);
      expect(res.status).toBe(200);
      const rows = res.body as { repId: string }[];
      // The queue is the one submission read with a second audience. If the
      // scope ever comes off, a rep reads every rep's brand, discount and total.
      expect(rows.every((s) => s.repId === myId)).toBe(true);

      // Accounting sees the same queue unscoped, so this is a real restriction
      // and not just an empty-table pass.
      const acct = await http(app).get('/api/submissions/queue').set('Cookie', cookies.ACCT).expect(200);
      expect((acct.body as unknown[]).length).toBeGreaterThanOrEqual(rows.length);
    });

    it("rep A -> GET rep B's submission -> 404, NOT 403 (no existence probing)", async () => {
      // Rep A (Marielle) creates a submission...
      const created = await http(app)
        .post('/api/submissions')
        .set('Cookie', cookies.SALES)
        .send({ designer: 'Probe Test', brand: `ACL Probe ${Date.now()}`, eventId: 'VFW-FW26', packageId: 'VFW-BRONZE' });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      // ...and rep B (Diego) must get a 404, indistinguishable from "no such record".
      const repB = await loginCookie(app, 'diego@vanfashionweek.com');
      const res = await http(app).get(`/api/submissions/${id}`).set('Cookie', repB);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
    });

    it('client that sends its own "total" -> 400 (the server prices the sale)', async () => {
      const res = await http(app)
        .post('/api/submissions')
        .set('Cookie', cookies.SALES)
        .send({ designer: 'Sneaky', brand: `Sneaky ${Date.now()}`, eventId: 'VFW-FW26', packageId: 'VFW-BRONZE', total: 1 });
      expect(res.status).toBe(400);
      const msg = JSON.stringify(res.body.message);
      expect(msg).toMatch(/total/i);
    });
  });

  // ---- INTERN has no seeded login, so assert its matrix at the unit level ----
  describe('INTERN is a restricted rep, not a synonym for SALES', () => {
    it('drafts sales like a rep', () => {
      expect(can('submission.create', 'INTERN')).toBe(true);
      expect(can('submission.editOwn', 'INTERN')).toBe(true);
      expect(can('leaderboard.view', 'INTERN')).toBe(true);
      expect(can('messaging.use', 'INTERN')).toBe(true);
    });

    it('does NOT get the customer book or feedback', () => {
      expect(can('contacts.view', 'INTERN')).toBe(false);
      expect(can('contacts.create', 'INTERN')).toBe(false);
      expect(can('feedback.record', 'INTERN')).toBe(false);
    });

    it('never gets administration or the logs', () => {
      expect(can('admin.manage', 'INTERN')).toBe(false);
      expect(can('activity.view', 'INTERN')).toBe(false);
    });
  });

  // ---- ACCT is the second keyholder for administration, but not for the logs ----
  describe('Accounting holds administration', () => {
    it('can manage users and roles', () => {
      expect(can('admin.manage', 'ACCT')).toBe(true);
    });

    it('still cannot read the activity log — the one single-role permission', () => {
      expect(can('activity.view', 'ACCT')).toBe(false);
      expect(ACL['activity.view']).toEqual(['ADMIN']);
    });

    it('MGR and the rep roles are unaffected', () => {
      for (const role of ['SALES', 'INTERN', 'MGR'] as const) {
        expect(can('admin.manage', role)).toBe(false);
      }
    });
  });

  // ---- sessions are revocable: the token is a claim, not a standing grant ----
  describe('session revocation', () => {
    let prisma: PrismaService;
    beforeAll(() => {
      prisma = app.get(PrismaService);
    });

    it('disabling an account kills its live session immediately', async () => {
      const cookie = await loginCookie(app, 'priya@vanfashionweek.com');
      expect((await http(app).get('/api/submissions').set('Cookie', cookie)).status).toBe(200);

      await prisma.user.update({
        where: { email: 'priya@vanfashionweek.com' },
        data: { status: 'DISABLED' },
      });
      try {
        const res = await http(app).get('/api/submissions').set('Cookie', cookie);
        expect(res.status).toBe(401);
      } finally {
        await prisma.user.update({
          where: { email: 'priya@vanfashionweek.com' },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('a role change takes effect on the next request, not in 30 days', async () => {
      const cookie = await loginCookie(app, 'aiko@vanfashionweek.com');
      // As SALES, reports are off limits. (Not the approval queue — a rep may
      // now read that one, so it no longer separates the two roles.)
      expect((await http(app).get('/api/reports/types').set('Cookie', cookie)).status).toBe(403);

      await prisma.user.update({ where: { email: 'aiko@vanfashionweek.com' }, data: { role: 'ACCT' } });
      try {
        // Same cookie, minted while they were SALES — the guard re-reads the role.
        const res = await http(app).get('/api/reports/types').set('Cookie', cookie);
        expect(res.status).toBe(200);
      } finally {
        await prisma.user.update({ where: { email: 'aiko@vanfashionweek.com' }, data: { role: 'SALES' } });
      }
    });

    it('bumping tokenVersion (as a password reset does) invalidates the cookie', async () => {
      const cookie = await loginCookie(app, 'diego@vanfashionweek.com');
      expect((await http(app).get('/api/submissions').set('Cookie', cookie)).status).toBe(200);

      await prisma.user.update({
        where: { email: 'diego@vanfashionweek.com' },
        data: { tokenVersion: { increment: 1 } },
      });
      const res = await http(app).get('/api/submissions').set('Cookie', cookie);
      expect(res.status).toBe(401);
    });
  });

  // ---- the contact write path is scoped like the read path ----
  describe('contacts cannot be overwritten across reps', () => {
    it("rep B submitting for rep A's brand does not clobber A's contact details", async () => {
      const brand = `Overwrite Probe ${Date.now()}`;
      const created = await http(app)
        .post('/api/submissions')
        .set('Cookie', cookies.SALES)
        .send({
          designer: 'Real Designer', brand, email: 'real@brand.com', phone: '+1 111',
          eventId: 'VFW-FW26', packageId: 'VFW-BRONZE',
        });
      expect(created.status).toBe(201);

      // Rep B cannot even see this contact, but can guess the brand name.
      const repB = await loginCookie(app, 'diego@vanfashionweek.com');
      const attack = await http(app)
        .post('/api/submissions')
        .set('Cookie', repB)
        .send({
          designer: 'Attacker', brand, email: 'attacker@evil.com', phone: '+1 999',
          eventId: 'VFW-FW26', packageId: 'VFW-BRONZE',
        });
      expect(attack.status).toBe(201);

      // The sale links to the same contact, but the details are untouched.
      const asAcct = await http(app).get('/api/contacts').set('Cookie', cookies.ACCT);
      const contact = (asAcct.body as { brand: string; email: string; designer: string }[])
        .find((c) => c.brand === brand);
      expect(contact).toBeDefined();
      expect(contact!.email).toBe('real@brand.com');
      expect(contact!.designer).toBe('Real Designer');
    });
  });
});
