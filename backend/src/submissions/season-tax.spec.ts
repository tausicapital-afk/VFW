import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { seasonKey } from '../common/season';
import { PrismaService } from '../prisma/prisma.service';

describe('seasonKey', () => {
  it('treats different spellings of one season alike', () => {
    expect(seasonKey('Fall/Winter 27')).toBe('fw27');
    expect(seasonKey('fall-Winter 27')).toBe('fw27');
    expect(seasonKey('Fall Winter 2027')).toBe('fw27');
    expect(seasonKey('FW27')).toBe('fw27');
    expect(seasonKey('Fall/Winter')).toBeNull();
  });
});

/**
 * New submission: the season is typed (and added to the Seasons list when it
 * is new), and the tax is picked from the tax profiles, at creation only.
 */
describe('submission season and tax', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;
  const EXISTING = 'Fall/Winter 41';

  const submit = (extra: Record<string, unknown>) =>
    http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Season Probe',
        brand: `Season ${Date.now()}-${Math.random()}`,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
        ...extra,
      });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
    await prisma.season.upsert({ where: { label: EXISTING }, update: {}, create: { label: EXISTING } });
  });

  afterAll(async () => {
    await prisma.season.deleteMany({ where: { label: { in: [EXISTING, 'fall-winter 2041', 'Spring/Summer 42'] } } });
    await app?.close();
  });

  it('stores an existing season under its own spelling, whatever the case', async () => {
    const res = await submit({ season: 'fall/winter 41' });
    expect(res.status).toBe(201);
    expect(res.body.season).toBe(EXISTING);
  });

  it('refuses a different spelling of an existing season, naming it', async () => {
    const res = await submit({ season: 'fall-winter 2041' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain(EXISTING);
  });

  it('adds the spelling anyway when the rep insists', async () => {
    const res = await submit({ season: 'fall-winter 2041', seasonIsNew: true });
    expect(res.status).toBe(201);
    expect(await prisma.season.findUnique({ where: { label: 'fall-winter 2041' } })).not.toBeNull();
  });

  it('adds a new season to the Seasons list', async () => {
    const res = await submit({ season: 'Spring/Summer 42' });
    expect(res.status).toBe(201);
    expect(res.body.season).toBe('Spring/Summer 42');
    expect(await prisma.season.findUnique({ where: { label: 'Spring/Summer 42' } })).not.toBeNull();
  });

  it('uses the tax profile the rep picked', async () => {
    const tax = await prisma.taxProfile.findFirstOrThrow({ orderBy: { rate: 'desc' } });
    const res = await submit({ season: EXISTING, taxCode: tax.code });
    expect(res.status).toBe(201);
    expect(res.body.taxCode).toBe(tax.code);
    expect(Number(res.body.taxRate)).toBe(Number(tax.rate));
  });

  it('refuses an unknown tax profile', async () => {
    const res = await submit({ season: EXISTING, taxCode: 'NO-SUCH-TAX' });
    expect(res.status).toBe(400);
  });

  it('no longer lets Accounting change the tax afterwards', async () => {
    const created = await submit({ season: EXISTING });
    const res = await http(app)
      .patch(`/api/submissions/${created.body.id}`)
      .set('Cookie', acct)
      .send({ taxCode: 'GST-5' });
    expect(res.status).toBe(400);
  });
});
