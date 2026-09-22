import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';

/**
 * The DocuSign OAuth connection (connect/callback/disconnect), through the
 * real request path — the same two things QboConnectionService's live
 * exchange with Intuit is not tested here either: what a real DocuSign
 * account hands back once DOCUSIGN_CLIENT_ID/SECRET are set needs a real
 * answer from DocuSign's servers, which this suite has no network access to.
 *
 * What IS ours to test, and does not need one, is everything on this side of
 * that call:
 *  - the graceful "not configured" 400 rather than a 500 (see
 *    test/jest.setup.ts, which blanks DOCUSIGN_CLIENT_ID/SECRET the same way
 *    it blanks GOOGLE_CLIENT_ID/SECRET, so this holds regardless of a
 *    developer's local .env);
 *  - the CSRF `state` handshake: a callback with an unrecognised or
 *    mismatched state must not connect anything, exactly like QBO's.
 */
describe('DocuSign OAuth connection', () => {
  let app: INestApplication;
  let admin: string;
  let acct: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await loginCookie(app, 'it@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('not configured', () => {
    it('GET /api/admin/docusign/status reports disconnected without throwing', async () => {
      const res = await http(app).get('/api/admin/docusign/status').set('Cookie', admin).expect(200);
      expect(res.body).toEqual({ connected: false });
    });

    it('GET /api/admin/docusign/connect fails with a readable 400, not a 500', async () => {
      const res = await http(app).get('/api/admin/docusign/connect').set('Cookie', admin);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/DocuSign/i);
    });

    it('non-admin roles are refused before that (403)', async () => {
      const sales = await loginCookie(app, 'marielle@vanfashionweek.com');
      const res = await http(app).get('/api/admin/docusign/connect').set('Cookie', sales);
      expect(res.status).toBe(403);
    });
  });

  describe('CSRF state handshake, once configured', () => {
    // Set directly on process.env, not through the admin Configuration API —
    // ConfigService resolves DB row -> env -> default, so this is honoured
    // exactly like a developer's real .env would be, without writing a
    // ConfigSetting row other spec files in this suite would then also see.
    const ORIGINALS: Record<string, string | undefined> = {};

    beforeAll(() => {
      for (const key of ['DOCUSIGN_CLIENT_ID', 'DOCUSIGN_CLIENT_SECRET', 'APP_URL']) {
        ORIGINALS[key] = process.env[key];
      }
      process.env.DOCUSIGN_CLIENT_ID = 'test-integration-key';
      process.env.DOCUSIGN_CLIENT_SECRET = 'test-secret-key';
      process.env.APP_URL = 'https://console.test.invalid';
    });

    afterAll(() => {
      for (const [key, value] of Object.entries(ORIGINALS)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('mints a state and redirects to DocuSign\'s consent screen', async () => {
      const res = await http(app).get('/api/admin/docusign/connect').set('Cookie', admin);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.hostname).toBe('account-d.docusign.com');
      expect(location.searchParams.get('client_id')).toBe('test-integration-key');
      expect(location.searchParams.get('redirect_uri')).toBe(
        'https://console.test.invalid/api/admin/docusign/callback',
      );
      expect(location.searchParams.get('state')).toEqual(expect.any(String));
    });

    it('a callback with an unrecognised state redirects with an error, not a 500 or a connection', async () => {
      const res = await http(app)
        .get('/api/admin/docusign/callback')
        .query({ code: 'some-code', state: 'not-a-real-state' })
        .set('Cookie', admin);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.searchParams.get('docusign')).toBe('error');

      const status = await http(app).get('/api/admin/docusign/status').set('Cookie', admin).expect(200);
      expect(status.body.connected).toBe(false);
    });

    it('a callback whose state was minted for a DIFFERENT admin is rejected, not honoured', async () => {
      const connectRes = await http(app).get('/api/admin/docusign/connect').set('Cookie', admin);
      const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

      // it@ minted this state; accounting@ tries to redeem it.
      const res = await http(app)
        .get('/api/admin/docusign/callback')
        .query({ code: 'some-code', state })
        .set('Cookie', acct);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.searchParams.get('docusign')).toBe('error');
    });

    it('a callback carrying DocuSign\'s own error param redirects with it, without attempting an exchange', async () => {
      const res = await http(app)
        .get('/api/admin/docusign/callback')
        .query({ error: 'access_denied' })
        .set('Cookie', admin);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.searchParams.get('docusign')).toBe('error');
      expect(location.searchParams.get('docusignMessage')).toMatch(/access_denied/);
    });
  });
});
