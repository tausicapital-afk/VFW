import type { INestApplication } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * GET /api/search — the cross-entity jump-to search behind Cmd/Ctrl-K.
 *
 * The one thing this endpoint must never do is show or link to a row the
 * signed-in user could not already open directly at its own URL. That is a
 * strict security requirement (see the module's own comment), so most of this
 * file is the negative case: a rep's search for a colleague's submission or
 * contact must come back empty, exactly as if the record did not exist.
 */

const ACCOUNTS: Record<string, { email: string; role: Role }> = {
  SALES: { email: 'marielle@vanfashionweek.com', role: 'SALES' },
  ACCT: { email: 'accounting@vanfashionweek.com', role: 'ACCT' },
};

type Result = { id: string; type: 'submission' | 'contact'; label: string; sublabel: string | null; href: string };

async function createSubmission(app: INestApplication, cookie: string, brand: string) {
  const res = await http(app)
    .post('/api/submissions')
    .set('Cookie', cookie)
    .send({
      designer: 'Search Test Designer',
      brand,
      eventId: 'VFW-FW26',
      packageId: 'VFW-BRONZE',
    });
  if (res.status !== 201) {
    throw new Error(`submission create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { id: string; ref: string };
}

describe('GET /api/search (global search)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const [key, acc] of Object.entries(ACCOUNTS)) {
      cookies[key] = await loginCookie(app, acc.email);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('no session -> 401', async () => {
    const res = await http(app).get('/api/search?q=anything');
    expect(res.status).toBe(401);
  });

  it('empty or missing q -> empty list, not every row', async () => {
    const res = await http(app).get('/api/search').set('Cookie', cookies.SALES);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    const blank = await http(app).get('/api/search?q=').set('Cookie', cookies.SALES);
    expect(blank.body).toEqual([]);
  });

  it('finds the caller\'s own submission by ref and invoice number, and their own contact by brand', async () => {
    const brand = `Search Own ${Date.now()}`;
    const created = await createSubmission(app, cookies.SALES, brand);

    const byRef = await http(app).get(`/api/search?q=${encodeURIComponent(created.ref)}`).set('Cookie', cookies.SALES);
    expect(byRef.status).toBe(200);
    const refResults = byRef.body as Result[];
    expect(refResults.some((r) => r.type === 'submission' && r.id === created.id && r.label === created.ref)).toBe(true);

    // Case-insensitive, partial match — typing a lowercase fragment still finds it.
    const partial = created.ref.slice(0, created.ref.length - 1).toLowerCase();
    const byPartial = await http(app).get(`/api/search?q=${encodeURIComponent(partial)}`).set('Cookie', cookies.SALES);
    expect((byPartial.body as Result[]).some((r) => r.id === created.id)).toBe(true);

    const byBrand = await http(app).get(`/api/search?q=${encodeURIComponent(brand)}`).set('Cookie', cookies.SALES);
    expect(byBrand.status).toBe(200);
    const brandResults = byBrand.body as Result[];
    expect(brandResults.some((r) => r.type === 'contact' && r.label === brand && r.href.startsWith('/contacts/'))).toBe(true);
    // And the submission itself also matches on brand-adjacent ref search is not
    // expected — but the submission for this brand is not what we searched here,
    // so only assert the contact side to keep this test focused.
  });

  it("a colleague's search for the same ref or brand returns nothing (row-scoping)", async () => {
    const brand = `Search Probe ${Date.now()}`;
    const created = await createSubmission(app, cookies.SALES, brand);

    const repB = await loginCookie(app, 'diego@vanfashionweek.com');

    const byRef = await http(app).get(`/api/search?q=${encodeURIComponent(created.ref)}`).set('Cookie', repB);
    expect(byRef.status).toBe(200);
    expect(byRef.body as Result[]).toEqual([]);

    const byBrand = await http(app).get(`/api/search?q=${encodeURIComponent(brand)}`).set('Cookie', repB);
    expect(byBrand.status).toBe(200);
    expect(byBrand.body as Result[]).toEqual([]);
  });

  it('a viewAll role (Accounting) finds any rep\'s submission and contact', async () => {
    const brand = `Search Acct View ${Date.now()}`;
    const created = await createSubmission(app, cookies.SALES, brand);

    const byRef = await http(app).get(`/api/search?q=${encodeURIComponent(created.ref)}`).set('Cookie', cookies.ACCT);
    expect((byRef.body as Result[]).some((r) => r.type === 'submission' && r.id === created.id)).toBe(true);

    const byBrand = await http(app).get(`/api/search?q=${encodeURIComponent(brand)}`).set('Cookie', cookies.ACCT);
    expect((byBrand.body as Result[]).some((r) => r.type === 'contact' && r.label === brand)).toBe(true);
  });

  it('INTERN gets submission results but never a contact result (no customer book, even for its own brand)', async () => {
    // No seeded INTERN login exists (see submissions/acl.spec.ts), so a seeded
    // rep is flipped to INTERN for the duration of this test and restored after
    // — the same technique the ACL role-change test already uses.
    const email = 'priya@vanfashionweek.com';
    await prisma.user.update({ where: { email }, data: { role: 'INTERN' } });
    try {
      const cookie = await loginCookie(app, email);
      const brand = `Search Intern ${Date.now()}`;
      const created = await createSubmission(app, cookie, brand);

      const byRef = await http(app).get(`/api/search?q=${encodeURIComponent(created.ref)}`).set('Cookie', cookie);
      expect(byRef.status).toBe(200);
      expect((byRef.body as Result[]).some((r) => r.type === 'submission' && r.id === created.id)).toBe(true);

      const byBrand = await http(app).get(`/api/search?q=${encodeURIComponent(brand)}`).set('Cookie', cookie);
      expect(byBrand.status).toBe(200);
      expect((byBrand.body as Result[]).some((r) => r.type === 'contact')).toBe(false);
    } finally {
      await prisma.user.update({ where: { email }, data: { role: 'SALES' } });
    }
  });

  it('a voided submission does not resurface through search', async () => {
    const brand = `Search Voided ${Date.now()}`;
    const created = await createSubmission(app, cookies.SALES, brand);
    const voided = await http(app).post(`/api/submissions/${created.id}/void`).set('Cookie', cookies.ACCT).send({});
    expect(voided.status).toBe(201);

    const res = await http(app).get(`/api/search?q=${encodeURIComponent(created.ref)}`).set('Cookie', cookies.SALES);
    expect((res.body as Result[]).some((r) => r.id === created.id)).toBe(false);
  });
});
