import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';
import { REPORTS, REPORT_KEYS } from '../reports/reports.service';

/**
 * The report exports, which replaced a client-side CSV/JSON builder.
 *
 * Two things that builder could not do, and which are the reason this exists:
 * it never reached the server, so a consolidated revenue file left no
 * DATA_EXPORT line behind; and it hand-rolled its CSV, skipping the BOM and the
 * formula guard every other export gets. Both are tested here.
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

describe('report exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;

  const pull = async (dataset: string, query = '') => {
    const res = await http(app)
      .get(`/api/export/${dataset}?format=csv${query}`)
      .set('Cookie', admin)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return res.body as Buffer;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    sales = await loginCookie(app, SALES);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  // Every report, by name — a new key in the REPORTS map is covered the moment
  // it is added, rather than the day someone remembers to add a test.
  describe.each(REPORT_KEYS.map((k) => [k, REPORTS[k]] as const))('report-%s (%s)', (key) => {
    it('renders in all three formats', async () => {
      for (const format of ['csv', 'xlsx', 'pdf'] as const) {
        const res = await http(app)
          .get(`/api/export/report-${key}?format=${format}`)
          .set('Cookie', admin)
          .buffer(true)
          .parse(binaryParser)
          .expect(200);
        expect((res.body as Buffer).length).toBeGreaterThan(0);
        // The file is named for the report, not just the day — a folder of
        // identically named files is not something anyone can reconcile.
        expect(res.headers['content-disposition']).toContain(`report-${key}-`);
      }
    }, 60_000);

    it('is refused to a rep — reports are financial', async () => {
      await http(app)
        .get(`/api/export/report-${key}?format=csv`)
        .set('Cookie', sales)
        .expect(403);
    });

    it('carries the table\'s own headers', async () => {
      const summary = await http(app)
        .get(`/api/reports/summary?type=${key}`)
        .set('Cookie', admin)
        .expect(200);
      const cols = (summary.body.cols as { label: string }[]).map((c) => c.label);

      const csv = (await pull(`report-${key}`)).toString('utf8');
      const header = csv.split('\r\n')[0].replace('﻿', '');
      // The header is the report's own columns, in its own order — the export
      // does not get to invent a shape for a table it did not build.
      for (const label of cols) expect(header).toContain(label);
    }, 60_000);
  });

  it('gives each report its own shape, not one shared guess', async () => {
    // The reason report datasets are dynamic: these two do not share a first
    // column label, and neither is knowable before the table is built.
    const byEvent = (await pull('report-event')).toString('utf8').split('\r\n')[0];
    const byCity = (await pull('report-city')).toString('utf8').split('\r\n')[0];
    expect(byEvent).toContain('Event');
    expect(byCity).toContain('City');
    expect(byEvent).not.toBe(byCity);
  }, 30_000);

  it('honours the period the screen is showing', async () => {
    const wide = (await pull('report-revenue')).toString('utf8');
    // A window that closed before this data existed must come back empty of
    // rows but still shaped like the report.
    const empty = (await pull('report-revenue', '&from=1990-01-01&to=1990-01-02')).toString('utf8');

    expect(wide.trim().split('\r\n').length).toBeGreaterThan(1);
    expect(empty.trim().split('\r\n').length).toBe(1);
    // Headers survive an empty period: the columns come from the table, not
    // from whatever happened to be in the first row.
    expect(empty).toContain('Event');
  }, 30_000);

  it('writes the DATA_EXPORT line the old client-side download never could', async () => {
    await pull('report-revenue', '&from=2026-01-01&to=2026-12-31');
    await new Promise((r) => setTimeout(r, 300));

    const log = await prisma.activityLog.findFirst({
      where: { action: 'DATA_EXPORT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.detail).toContain('Revenue analysis');
    expect(log?.meta).toMatchObject({
      dataset: 'report-revenue',
      format: 'csv',
      filters: { from: '2026-01-01', to: '2026-12-31' },
    });
  }, 30_000);

  it('gets the hardened CSV writer, which the hand-rolled one was not', async () => {
    const file = await pull('report-revenue');
    // The BOM, without which Excel mangles é / £ / ¥.
    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(file.toString('utf8')).toContain('\r\n'); // RFC 4180 line endings
  }, 30_000);

  it('404s a report key that does not exist', async () => {
    await http(app)
      .get('/api/export/report-nonsense?format=csv')
      .set('Cookie', admin)
      .expect(404);
  });
});
