import type { INestApplication } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { createTestApp, http, loginCookie } from '../../test/app';
import { ACL, can, type Permission } from '../common/acl';

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
  { name: 'GET  /queue', method: 'get', path: '/api/submissions/queue', permission: 'submission.approve' },
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

    it('SALES -> GET /queue -> 403', async () => {
      const res = await http(app).get('/api/submissions/queue').set('Cookie', cookies.SALES);
      expect(res.status).toBe(403);
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
});
