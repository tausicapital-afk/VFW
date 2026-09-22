import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The contact portal's real security boundary: a token in the URL, checked
 * against a real database, with no session behind it at all. Everything here
 * runs through the actual HTTP surface (createTestApp), same as acl.spec.ts —
 * the guarantee that matters is what the server actually returns, not what a
 * mocked layer believes.
 */
describe('Contact portal (unauthenticated, token-gated)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A fresh, approved, invoiced sale against a brand-new contact with an email. */
  async function newInvoicedSubmission(email: string) {
    const created = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Portal Test',
        brand: `Portal ${Date.now()}-${Math.random()}`,
        email,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const contactId = created.body.contact.id as string;

    const approved = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(approved.status).toBe(201);

    const invoiced = await http(app).post(`/api/submissions/${id}/invoice`).set('Cookie', acct).send();
    expect(invoiced.status).toBe(201);

    return { submissionId: id, contactId, invoiceNo: invoiced.body.invoiceNo as string };
  }

  /** Insert a token directly — the send path needs a real mail transport, which the test suite never has. */
  async function mintToken(contactId: string, opts: { expired?: boolean } = {}) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = opts.expired
      ? new Date(Date.now() - 60_000)
      : new Date(Date.now() + 60 * 24 * 60 * 60_000);
    await prisma.contactPortalToken.create({ data: { token, contactId, expiresAt } });
    return token;
  }

  it('a valid token returns only that contact\'s data, with an exact field allowlist', async () => {
    const a = await newInvoicedSubmission('designer-a@example.com');
    const b = await newInvoicedSubmission('designer-b@example.com');
    const token = await mintToken(a.contactId);

    const res = await http(app).get(`/api/portal/${token}`);
    expect(res.status).toBe(200);

    // Only A's contact fields — the exact allowlist, nothing else (no id, no
    // email/phone/country, no createdBy).
    expect(Object.keys(res.body.contact).sort()).toEqual(['brand', 'company', 'designer'].sort());

    // Only A's submission(s) — B's id never appears anywhere in the payload.
    const ids = (res.body.submissions as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(a.submissionId);
    expect(ids).not.toContain(b.submissionId);
    expect(JSON.stringify(res.body)).not.toContain(b.submissionId);

    const row = (res.body.submissions as Record<string, unknown>[]).find((s) => s.id === a.submissionId)!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'id', 'ref', 'status', 'currency', 'total', 'paidAmount', 'balance',
        'payStatus', 'invoiceNo', 'event', 'package', 'showDate', 'createdAt',
      ].sort(),
    );
    expect(row.invoiceNo).toBe(a.invoiceNo);
    // Nothing money-adjacent-but-internal ever rides along.
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('costCentre');
    expect(row).not.toHaveProperty('glCode');
    expect(row).not.toHaveProperty('department');
    expect(row).not.toHaveProperty('rep');
    expect(row).not.toHaveProperty('commissionAmount');
  });

  it('an expired token is refused with a generic error', async () => {
    const a = await newInvoicedSubmission('expired-case@example.com');
    const token = await mintToken(a.contactId, { expired: true });

    const res = await http(app).get(`/api/portal/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('This link is invalid or has expired.');
  });

  it('a token that never existed fails exactly the same way as an expired one', async () => {
    const a = await newInvoicedSubmission('never-existed-case@example.com');
    const expiredToken = await mintToken(a.contactId, { expired: true });
    const bogusToken = randomBytes(32).toString('hex');

    const [expired, bogus] = await Promise.all([
      http(app).get(`/api/portal/${expiredToken}`),
      http(app).get(`/api/portal/${bogusToken}`),
    ]);

    expect(bogus.status).toBe(404);
    // Identical status AND identical message — a caller cannot tell "expired"
    // from "never issued" from the response.
    expect(bogus.body.message).toBe(expired.body.message);
  });

  it('never leaks another contact\'s submission, even through the PDF route with a guessed id', async () => {
    const a = await newInvoicedSubmission('pdf-owner@example.com');
    const b = await newInvoicedSubmission('pdf-victim@example.com');
    const token = await mintToken(a.contactId);

    // A's own invoice downloads fine.
    const own = await http(app).get(`/api/portal/${token}/submissions/${a.submissionId}/invoice.pdf`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');

    // A's token against B's submission id — same 404 as a submission that does
    // not exist at all, not a 403 that would confirm B's id is real.
    const crossContact = await http(app).get(
      `/api/portal/${token}/submissions/${b.submissionId}/invoice.pdf`,
    );
    expect(crossContact.status).toBe(404);

    // A malformed/nonsense submission id must not 500 — Prisma's id lookup
    // simply misses, same 404.
    const malformed = await http(app).get(
      `/api/portal/${token}/submissions/${encodeURIComponent("'; DROP TABLE \"Submission\"; --")}/invoice.pdf`,
    );
    expect(malformed.status).toBe(404);

    // The submissions table is still there and A's row is unaffected.
    const stillThere = await prisma.submission.findUnique({ where: { id: a.submissionId } });
    expect(stillThere).not.toBeNull();
  });

  it('excludes a voided sale from the portal', async () => {
    const a = await newInvoicedSubmission('voided-case@example.com');
    const voided = await http(app)
      .post(`/api/submissions/${a.submissionId}/void`)
      .set('Cookie', acct)
      .send({ reason: 'Test cleanup' });
    expect(voided.status).toBe(201);

    const token = await mintToken(a.contactId);
    const res = await http(app).get(`/api/portal/${token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.submissions as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain(a.submissionId);
  });
});
