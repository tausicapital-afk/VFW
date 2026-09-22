import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "Send for signature": the permission gate, and that it only ever acts on a
 * Document that really is attached to the submission named in the URL — the
 * same existence-hiding, cross-submission scoping every other submission
 * sub-resource in this app gets (see DocumentsService.assertAccess and
 * acl.spec.ts's rep-A/rep-B probes).
 *
 * The actual DocuSign envelope call is not exercised here — no network
 * access, and no DocuSignConnection exists in this suite's database — so the
 * boundary these tests prove is everything on this side of that call: a
 * request that has no business touching a document is refused before ANY of
 * that would run, and one that does get through the scoping/permission
 * checks fails cleanly with "DocuSign is not connected" rather than a 500.
 */
describe('DocuSign: send for signature', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;
  let repBOther: string;

  const createdSubmissionIds: string[] = [];
  const createdDocumentIds: string[] = [];

  async function createSubmission(cookie: string, brandSuffix: string) {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', cookie)
      .send({
        designer: 'Signature Test Designer',
        brand: `Signature Test ${brandSuffix} ${Date.now()}`,
        email: 'designer@example.invalid',
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      })
      .expect(201);
    const id = res.body.id as string;
    createdSubmissionIds.push(id);
    return id;
  }

  async function attachDocument(submissionId: string) {
    const doc = await prisma.document.create({
      data: {
        submissionId,
        type: 'contract',
        filename: 'test-contract.pdf',
        storageKey: `submissions/${submissionId}/test-contract.pdf`,
        contentType: 'application/pdf',
        size: 1234,
        uploadedById: (await prisma.user.findFirstOrThrow({ where: { email: 'marielle@vanfashionweek.com' } })).id,
      },
    });
    createdDocumentIds.push(doc.id);
    return doc.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
    repBOther = await loginCookie(app, 'diego@vanfashionweek.com');
  });

  afterAll(async () => {
    if (createdSubmissionIds.length) {
      // SignatureRequest/Document cascade or restrict-delete with the
      // submission; deleting the submission is enough to clean up everything
      // this spec created under it.
      await prisma.submission.deleteMany({ where: { id: { in: createdSubmissionIds } } });
    }
    await app?.close();
  });

  it('SALES cannot send for signature (email.send is ACCT/ADMIN only)', async () => {
    const submissionId = await createSubmission(sales, 'perm');
    const docId = await attachDocument(submissionId);

    const res = await http(app)
      .post(`/api/submissions/${submissionId}/documents/${docId}/send-for-signature`)
      .set('Cookie', sales);
    expect(res.status).toBe(403);
  });

  it('ACCT passes the permission gate and reaches the connection check (not connected -> 400, not 403/500)', async () => {
    const submissionId = await createSubmission(sales, 'ok');
    const docId = await attachDocument(submissionId);

    const res = await http(app)
      .post(`/api/submissions/${submissionId}/documents/${docId}/send-for-signature`)
      .set('Cookie', acct);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/DocuSign is not connected/i);
  });

  it('404s on a document id that does not exist, for ACCT (permission granted, resource missing)', async () => {
    const submissionId = await createSubmission(sales, 'missing-doc');
    const res = await http(app)
      .post(`/api/submissions/${submissionId}/documents/no-such-document/send-for-signature`)
      .set('Cookie', acct);
    expect(res.status).toBe(404);
  });

  it("404s when the document belongs to a DIFFERENT submission — cannot be used to send someone else's upload", async () => {
    const submissionA = await createSubmission(sales, 'doc-owner');
    const submissionB = await createSubmission(sales, 'wrong-target');
    const docOnA = await attachDocument(submissionA);

    const res = await http(app)
      .post(`/api/submissions/${submissionB}/documents/${docOnA}/send-for-signature`)
      .set('Cookie', acct);
    expect(res.status).toBe(404);
  });

  it("rep B cannot even probe whether rep A's submission has signature requests (404, not 403)", async () => {
    const submissionId = await createSubmission(sales, 'scope');
    const res = await http(app).get(`/api/submissions/${submissionId}/signature-requests`).set('Cookie', repBOther);
    expect(res.status).toBe(404);
  });

  it('the owning rep can read their own (empty) list without the email.send permission', async () => {
    const submissionId = await createSubmission(sales, 'read-own');
    const res = await http(app).get(`/api/submissions/${submissionId}/signature-requests`).set('Cookie', sales).expect(200);
    expect(res.body).toEqual([]);
  });
});
