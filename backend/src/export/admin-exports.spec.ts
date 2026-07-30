import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';

/**
 * An export is bytes, and superagent will not hand those over without being told
 * to: left to itself it tries to parse text/csv, gets nowhere, and leaves an
 * empty object behind. Collect the response instead, so the assertions below run
 * against the file a browser would actually save.
 */
function binaryParser(
  res: SuperagentResponse,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  // At parse time this is still the raw response stream, whatever the types say.
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

/**
 * The Administration tab exports, through the real request path.
 *
 * The property that matters here: these datasets are the first ones whose `load`
 * does NOT scope rows to the caller. Submissions could rely on a rep's own list
 * being all a rep can pull; the staff list cannot. So every test below is some
 * form of "the file holds what the tab holds, and only an admin can pull it".
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

/** Each dataset with the tab it sits on, so a failure names the screen that broke. */
const DATASETS = [
  ['user-approvals', 'Invitations & approvals — Pending approval'],
  ['invitations', 'Invitations & approvals — Invitations'],
  ['users', 'Users & roles'],
  ['packages', 'Packages & pricing — Package rate card'],
  ['addons', 'Packages & pricing — Add-on catalogue'],
  ['taxes', 'Tax rates'],
] as const;

describe('administration tab exports', () => {
  let app: INestApplication;
  let admin: string;
  let sales: string;

  /** Pull an export as an admin and hand back the file itself. */
  const pull = async (dataset: string, format: 'csv' | 'xlsx' | 'pdf' = 'csv') => {
    const res = await http(app)
      .get(`/api/export/${dataset}?format=${format}`)
      .set('Cookie', admin)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return res.body as Buffer;
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await loginCookie(app, ADMIN);
    sales = await loginCookie(app, SALES);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  describe.each(DATASETS)('%s (%s)', (dataset) => {
    it('renders in all three formats', async () => {
      for (const format of ['csv', 'xlsx', 'pdf'] as const) {
        const res = await http(app)
          .get(`/api/export/${dataset}?format=${format}`)
          .set('Cookie', admin)
          .buffer(true)
          .parse(binaryParser)
          .expect(200);
        const file = res.body as Buffer;
        expect(file.length).toBeGreaterThan(0);
        expect(res.headers['content-disposition']).toContain(`.${format}`);
      }
    }, 30_000);

    it('is admin-only — a rep cannot pull it', async () => {
      await http(app)
        .get(`/api/export/${dataset}?format=csv`)
        .set('Cookie', sales)
        .expect(403);
    });
  });

  it('exports the staff list the Users tab shows, and only it', async () => {
    const csv = (await pull('users')).toString('utf8');

    expect(csv).toContain('Name,Email,Role,Department');
    // The role reads as the label the tab prints, not the enum behind it.
    expect(csv).toContain('Administrator');
    expect(csv).not.toMatch(/^ADMIN,/m);

    // listUsers drops hidden and deleted accounts, so the file must not carry
    // them either — this is the export agreeing with the tab, row for row.
    const listed = await http(app).get('/api/users').set('Cookie', admin).expect(200);
    const users = listed.body.users as { email: string }[];
    const dataRows = csv.trim().split('\n').length - 1;
    expect(dataRows).toBe(users.length);
    for (const u of users) expect(csv).toContain(u.email);
  }, 30_000);

  it('prints "Open code" for an invitation with no address, as the tab does', async () => {
    const created = await http(app)
      .post('/api/invitations')
      .set('Cookie', admin)
      .send({ role: 'SALES', department: 'Sales' })
      .expect(201);

    try {
      const csv = (await pull('invitations')).toString('utf8');
      expect(csv).toContain(created.body.code as string);
      expect(csv).toContain('Open code');
    } finally {
      await http(app)
        .delete(`/api/invitations/${created.body.id as string}`)
        .set('Cookie', admin);
    }
  }, 30_000);

  it("keeps a package's per-city prices together in one cell", async () => {
    const csv = (await pull('packages')).toString('utf8');

    expect(csv).toContain('City pricing');
    // A multi-city, multi-currency cell — never a bare number a sheet would sum.
    expect(csv).toMatch(/Vancouver [A-Z]{3} \d/);
  }, 30_000);

  it('404s an unknown dataset rather than crashing', async () => {
    await http(app)
      .get('/api/export/not-a-thing?format=csv')
      .set('Cookie', admin)
      .expect(404);
  });
});
