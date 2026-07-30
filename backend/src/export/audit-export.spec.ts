import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Audit trail export, and with it the filter contract the whole export
 * system now rests on.
 *
 * The property that matters: the file agrees with the table. An export that
 * ignored the screen's filter, or that quietly held page one of a trail, would
 * still open cleanly in Excel — which is exactly why it has to be tested rather
 * than eyeballed.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

function binaryParser(
  res: SuperagentResponse,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('audit trail export', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;
  const litter: string[] = [];

  const pull = async (query: string) => {
    const res = await http(app)
      .get(`/api/export/audit?${query}`)
      .set('Cookie', admin)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return (res.body as Buffer).toString('utf8');
  };

  /** A trail entry we control, so the assertions do not ride on seed data. */
  const entry = async (action: string, detail: string) => {
    const row = await prisma.auditEntry.create({ data: { action, detail } });
    litter.push(row.id);
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    sales = await loginCookie(app, SALES);
  }, 60_000);

  afterAll(async () => {
    await prisma.auditEntry.deleteMany({ where: { id: { in: litter } } });
    await app.close();
  });

  it('renders in all three formats', async () => {
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      const res = await http(app)
        .get(`/api/export/audit?format=${format}`)
        .set('Cookie', admin)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect((res.body as Buffer).length).toBeGreaterThan(0);
      expect(res.headers['content-disposition']).toContain(`.${format}`);
    }
  }, 30_000);

  it('is refused to a rep — the company-wide trail is not theirs', async () => {
    await http(app).get('/api/export/audit?format=csv').set('Cookie', sales).expect(403);
  });

  it('honours the action filter the screen is showing', async () => {
    await entry('EXPORT_TEST_ALPHA', 'alpha detail');
    await entry('EXPORT_TEST_BETA', 'beta detail');

    const filtered = await pull('format=csv&action=EXPORT_TEST_ALPHA');
    expect(filtered).toContain('alpha detail');
    expect(filtered).not.toContain('beta detail');

    // Unfiltered, both are there — proving the absence above is the filter
    // working, not the row missing.
    const all = await pull('format=csv');
    expect(all).toContain('alpha detail');
    expect(all).toContain('beta detail');
  }, 30_000);

  it('honours the search box', async () => {
    await entry('EXPORT_TEST_SEARCH', 'a distinctive needle phrase');
    const csv = await pull('format=csv&q=distinctive needle');
    expect(csv).toContain('a distinctive needle phrase');
    expect(csv.trim().split('\n').length).toBe(2); // header + the one hit
  }, 30_000);

  it('exports the whole filtered trail, not the page the screen is on', async () => {
    const action = 'EXPORT_TEST_PAGING';
    for (let i = 0; i < 60; i++) await entry(action, `paged entry ${i}`);

    // The screen pages at 50 and the API caps `limit` at 200; the export must
    // hold all 60 regardless.
    const csv = await pull(`format=csv&action=${action}`);
    expect(csv.trim().split('\n').length).toBe(61);
    expect(csv).toContain('paged entry 0');
    expect(csv).toContain('paged entry 59');
  }, 60_000);

  it('prints "System" where an entry has no actor, as the screen does', async () => {
    await entry('EXPORT_TEST_SYSTEM', 'nobody did this');
    const csv = await pull('format=csv&action=EXPORT_TEST_SYSTEM');
    expect(csv).toContain('System');
  }, 30_000);

  it('spells the action as the screen spells it', async () => {
    await entry('EXPORT_TEST_UNDERSCORE', 'underscore check');
    const csv = await pull('format=csv&action=EXPORT_TEST_UNDERSCORE');
    expect(csv).toContain('EXPORT TEST UNDERSCORE');
  }, 30_000);

  it('rejects a filter value the DTO does not allow', async () => {
    // forbidNonWhitelisted: a param no DTO declares is a 400, not a silent
    // ignore. This is what stops a dataset from reading a filter nobody vetted.
    await http(app)
      .get('/api/export/audit?format=csv&somethingElse=1')
      .set('Cookie', admin)
      .expect(400);
  });

  it('writes a DATA_EXPORT line naming the filter that was pulled', async () => {
    await pull('format=csv&action=EXPORT_TEST_ALPHA');
    // The activity write is fire-and-forget, so give it a beat to land.
    await new Promise((r) => setTimeout(r, 300));
    const log = await prisma.activityLog.findFirst({
      where: { action: 'DATA_EXPORT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).toBeTruthy();
    expect(log?.meta).toMatchObject({
      dataset: 'audit',
      format: 'csv',
      filters: { action: 'EXPORT_TEST_ALPHA' },
    });
  }, 30_000);
});
