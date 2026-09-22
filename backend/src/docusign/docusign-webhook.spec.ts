import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { createTestApp, http, loginCookie } from '../../test/app';
import { encryptSecret } from '../config/config.crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * The DocuSign Connect webhook — the single most security-sensitive endpoint
 * in this feature, since it is `@Public()` and its whole job is to let an
 * outside caller move a SignatureRequest into COMPLETED and attach a "signed"
 * Document to a submission.
 *
 * What is deliberately NOT exercised here: DocuSign's actual envelope-fetch
 * API (no network access in this suite) — `global.fetch` is stubbed for the
 * one call the completed path makes (fetching the combined PDF), and
 * StorageService.putObject is stubbed so this never needs real R2 credentials
 * either. Both stubs are scoped to individual tests and restored afterwards.
 *
 * What IS exercised, because it is entirely this app's own logic:
 *  - a configured HMAC key rejects a wrong/missing signature (401), and
 *    accepts a correctly-signed one;
 *  - an envelope id this app never issued a SignatureRequest for does
 *    nothing, however the rest of the payload is shaped — because the
 *    payload never names a submission or a document at all, only DocuSign's
 *    envelope id, there is no field for a forged payload to lie about beyond
 *    that id, and an id that matches no row touches no row;
 *  - a `completed` notification only ever affects the ONE SignatureRequest
 *    whose envelope id matches, never a sibling request for a different
 *    submission;
 *  - a `completed` notification creates exactly one signed Document, and
 *    replaying it (DocuSign Connect redelivers on anything but a fast 2xx,
 *    and can redeliver regardless) does not create a second one.
 */
describe('DocuSign Connect webhook', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let repId: string;

  const createdSubmissionIds: string[] = [];
  let originalFetch: typeof global.fetch;

  const fakePdfResponse = () =>
    ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 fake signed pdf').buffer,
    }) as unknown as Response;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    const me = await http(app).get('/api/auth/me').set('Cookie', sales).expect(200);
    repId = me.body.user.id as string;
  });

  afterAll(async () => {
    if (createdSubmissionIds.length) {
      await prisma.submission.deleteMany({ where: { id: { in: createdSubmissionIds } } });
    }
    // Clean up the singleton connection row this spec creates — other spec
    // files (docusign-connection.spec.ts) assert on DocuSign being
    // unconnected by default, and Jest's default sequencer does not
    // guarantee file execution order.
    await prisma.docuSignConnection.deleteMany({ where: { id: 1 } });
    await app?.close();
  });

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  async function createSubmissionWithDocument() {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Webhook Test Designer',
        brand: `Webhook Test ${Date.now()}-${Math.random()}`,
        email: 'designer@example.invalid',
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      })
      .expect(201);
    const submissionId = res.body.id as string;
    createdSubmissionIds.push(submissionId);

    const doc = await prisma.document.create({
      data: {
        submissionId,
        type: 'contract',
        filename: 'contract.pdf',
        storageKey: `submissions/${submissionId}/contract.pdf`,
        contentType: 'application/pdf',
        size: 100,
        uploadedById: repId,
      },
    });
    return { submissionId, documentId: doc.id };
  }

  async function createSignatureRequest(submissionId: string, documentId: string, envelopeId: string) {
    return prisma.signatureRequest.create({
      data: { submissionId, documentId, docusignEnvelopeId: envelopeId, status: 'SENT', sentById: repId },
    });
  }

  /** A DocuSignConnection with an access token that never needs refreshing, so ensureFreshToken() never hits the network. */
  async function ensureFakeConnection() {
    const existing = await prisma.docuSignConnection.findUnique({ where: { id: 1 } });
    if (existing) return;
    await prisma.docuSignConnection.create({
      data: {
        id: 1,
        environment: 'demo',
        accountId: 'test-account',
        baseUri: 'https://demo.docusign.invalid',
        accountName: 'Test Account',
        accessToken: encryptSecret('fake-access-token'),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        refreshToken: encryptSecret('fake-refresh-token'),
        refreshTokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    });
  }

  describe('HMAC signature verification', () => {
    const ORIGINAL_KEY = process.env.DOCUSIGN_HMAC_KEY;
    const KEY = 'webhook-test-hmac-key';

    beforeAll(() => {
      process.env.DOCUSIGN_HMAC_KEY = KEY;
    });
    afterAll(() => {
      process.env.DOCUSIGN_HMAC_KEY = ORIGINAL_KEY;
    });

    it('rejects a missing signature with 401 when a key is configured', async () => {
      const res = await http(app)
        .post('/api/docusign/webhook')
        .send({ event: 'envelope-sent', data: { envelopeId: 'no-such-envelope' } });
      expect(res.status).toBe(401);
    });

    it('rejects a wrong signature with 401', async () => {
      const res = await http(app)
        .post('/api/docusign/webhook')
        .set('X-DocuSign-Signature-1', Buffer.from('not-the-right-hmac').toString('base64'))
        .send({ event: 'envelope-sent', data: { envelopeId: 'no-such-envelope' } });
      expect(res.status).toBe(401);
    });

    it('accepts a correctly-signed payload (HMAC computed over the exact raw JSON bytes sent)', async () => {
      // supertest/superagent JSON.stringify()s a plain object body the same
      // way this computes the expected signature — matching what the server's
      // raw-body capture (main.ts's `rawBody: true`) actually sees on the wire.
      const payload = { event: 'envelope-sent', data: { envelopeId: 'unknown-but-correctly-signed' } };
      const signature = createHmac('sha256', KEY).update(JSON.stringify(payload)).digest('base64');

      const res = await http(app)
        .post('/api/docusign/webhook')
        .set('X-DocuSign-Signature-1', signature)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('scoping: only an envelope this app issued does anything', () => {
    it('an unrecognised envelope id is a safe no-op (200, nothing created)', async () => {
      const res = await http(app)
        .post('/api/docusign/webhook')
        .send({ event: 'envelope-completed', data: { envelopeId: 'totally-made-up-envelope-id' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("a completed notification for envelope X never touches sibling submission Y's request", async () => {
      await ensureFakeConnection();
      global.fetch = jest.fn().mockResolvedValue(fakePdfResponse()) as unknown as typeof fetch;
      jest.spyOn(app.get(StorageService), 'putObject').mockResolvedValue(undefined);

      const x = await createSubmissionWithDocument();
      const y = await createSubmissionWithDocument();
      const envelopeX = `env-x-${Date.now()}`;
      const envelopeY = `env-y-${Date.now()}`;
      await createSignatureRequest(x.submissionId, x.documentId, envelopeX);
      await createSignatureRequest(y.submissionId, y.documentId, envelopeY);

      await http(app)
        .post('/api/docusign/webhook')
        .send({ event: 'envelope-completed', data: { envelopeId: envelopeX } })
        .expect(200);

      const reqX = await prisma.signatureRequest.findUniqueOrThrow({ where: { docusignEnvelopeId: envelopeX } });
      const reqY = await prisma.signatureRequest.findUniqueOrThrow({ where: { docusignEnvelopeId: envelopeY } });
      expect(reqX.status).toBe('COMPLETED');
      expect(reqX.signedDocumentId).not.toBeNull();
      // Y was never named in the payload and must be untouched.
      expect(reqY.status).toBe('SENT');
      expect(reqY.signedDocumentId).toBeNull();

      const docsOnY = await prisma.document.findMany({ where: { submissionId: y.submissionId } });
      expect(docsOnY).toHaveLength(1); // only the original contract, no signed copy
    });
  });

  describe('completed: exactly one signed Document, idempotent against a replay', () => {
    it('creates exactly one Document and does not duplicate it on a replayed notification', async () => {
      await ensureFakeConnection();
      const fetchMock = jest.fn().mockResolvedValue(fakePdfResponse());
      global.fetch = fetchMock as unknown as typeof fetch;
      const putObject = jest.spyOn(app.get(StorageService), 'putObject').mockResolvedValue(undefined);

      const { submissionId, documentId } = await createSubmissionWithDocument();
      const envelopeId = `env-replay-${Date.now()}`;
      await createSignatureRequest(submissionId, documentId, envelopeId);

      const payload = { event: 'envelope-completed', data: { envelopeId } };

      await http(app).post('/api/docusign/webhook').send(payload).expect(200);
      // DocuSign Connect redelivers on anything but a fast 2xx, and can even
      // redeliver after one — replay it twice more.
      await http(app).post('/api/docusign/webhook').send(payload).expect(200);
      await http(app).post('/api/docusign/webhook').send(payload).expect(200);

      const signed = await prisma.document.findMany({
        where: { submissionId, type: 'Signed Contract' },
      });
      expect(signed).toHaveLength(1);

      const request = await prisma.signatureRequest.findUniqueOrThrow({ where: { docusignEnvelopeId: envelopeId } });
      expect(request.status).toBe('COMPLETED');
      expect(request.signedDocumentId).toBe(signed[0].id);

      // The signed Document is attributed to the hidden system user, not a
      // human — nobody uploaded it, the webhook did.
      const uploader = await prisma.user.findUniqueOrThrow({ where: { id: signed[0].uploadedById } });
      expect(uploader.email).toBe('docusign@system.internal');
      expect(uploader.hidden).toBe(true);
      expect(uploader.status).toBe('ACTIVE');

      // Only the first delivery should have reached the network/storage layer
      // — the compare-and-set in handleCompleted stops a replay before either.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(putObject).toHaveBeenCalledTimes(1);
    });
  });
});
