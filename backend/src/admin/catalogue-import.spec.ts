import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Bulk CSV import for the catalogue (Shows / Packages / Add-ons).
 *
 * The property under test is the one the feature exists to guarantee: an
 * imported row is created through the exact same path — createPackage,
 * createAddon, createEvent — a single row from the modal would go through. So
 * catalogue-create.spec.ts's rules (duplicate ids rejected, unknown tax/GL/city
 * refused, a package with no price refused) all still apply here, one row at a
 * time, and a bad row does not take good rows in the same file down with it.
 *
 * Own brand, same reasoning as catalogue-create.spec.ts: a crashed run leaves
 * nothing recognisable in the real rate card.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const BRAND = 'ZZCSV';

describe('catalogue — bulk CSV import', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  const sweep = async () => {
    await prisma.packagePrice.deleteMany({ where: { package: { brand: BRAND } } });
    await prisma.package.deleteMany({ where: { brand: BRAND } });
    await prisma.addon.deleteMany({ where: { brand: BRAND } });
    await prisma.event.deleteMany({ where: { brand: BRAND } });
  };

  const upload = (path: string, cookie: string, csv: string) =>
    http(app)
      .post(path)
      .set('Cookie', cookie)
      .attach('file', Buffer.from(csv, 'utf8'), 'import.csv');

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    await sweep();
  });

  afterEach(sweep);

  afterAll(async () => {
    await sweep();
    await app?.close();
  });

  describe('packages', () => {
    const header = 'brand,name,looks,taxCode,glCode,prices';

    it('imports every valid row through the same path a single create would use', async () => {
      const csv = [
        header,
        `${BRAND},Bronze Package,12,GST-5,4010,VAN:USD:7700.00`,
        `${BRAND},Silver Package,20,GST-5,4010,VAN:USD:9900.00;LDN:GBP:6500.00`,
      ].join('\n');

      const res = await upload('/api/admin/packages/import', admin, csv).expect(201);
      expect(res.body).toMatchObject({ succeeded: 2, failed: 0, errors: [] });

      const cat = await http(app).get('/api/admin/catalogue').set('Cookie', admin).expect(200);
      const ids = cat.body.packages
        .filter((p: { brand: string }) => p.brand === BRAND)
        .map((p: { id: string }) => p.id);
      expect(ids.sort()).toEqual([`${BRAND}-BRONZE`, `${BRAND}-SILVER`]);

      const silver = cat.body.packages.find((p: { id: string }) => p.id === `${BRAND}-SILVER`);
      expect(silver.prices).toHaveLength(2);
    });

    it('reports a bad row with its file row number and reason, and still commits the good rows', async () => {
      const csv = [
        header,
        `${BRAND},Bronze Package,12,GST-5,4010,VAN:USD:7700.00`, // row 2 — good
        `${BRAND},Silver Package,20,GST-5,4010,VAN:USD:9900.00`, // row 3 — good
        `${BRAND},Broken Tax Package,10,NO-SUCH-TAX,4010,VAN:USD:100.00`, // row 4 — unknown tax
        `${BRAND},No Price Package,10,GST-5,4010,`, // row 5 — no prices at all
      ].join('\n');

      const res = await upload('/api/admin/packages/import', admin, csv).expect(201);
      expect(res.body.succeeded).toBe(2);
      expect(res.body.failed).toBe(2);

      const rows = res.body.errors as Array<{ row: number; error: string }>;
      expect(rows.map((e) => e.row).sort()).toEqual([4, 5]);
      expect(rows.find((e) => e.row === 4)?.error).toMatch(/tax/i);
      expect(rows.find((e) => e.row === 5)?.error).toMatch(/prices/i);

      // The two good rows are really on the rate card — a failure elsewhere in
      // the file did not roll them back.
      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-BRONZE` } })).not.toBeNull();
      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-SILVER` } })).not.toBeNull();
      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-BROKEN-TAX-PACKAGE` } })).toBeNull();
      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-NO-PRICE-PACKAGE` } })).toBeNull();
    });

    it('refuses a duplicate id the same way a single create would, row by row', async () => {
      const csv = [
        header,
        `${BRAND},Bronze Package,12,GST-5,4010,VAN:USD:7700.00`,
        `${BRAND},Bronze Package,12,GST-5,4010,VAN:USD:8800.00`, // same derived id
      ].join('\n');

      const res = await upload('/api/admin/packages/import', admin, csv).expect(201);
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed).toBe(1);
      expect(res.body.errors[0].error).toMatch(new RegExp(`${BRAND}-BRONZE`));
    });
  });

  describe('add-ons', () => {
    it('imports valid rows, with forBrands read as a ";"-separated list', async () => {
      const csv = [
        'brand,name,price,currency,forBrands,glCode',
        `${BRAND},Backstage Media,600.00,USD,${BRAND};VFW,4200`,
      ].join('\n');

      const res = await upload('/api/admin/addons/import', admin, csv).expect(201);
      expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

      const addon = await prisma.addon.findUnique({ where: { id: `${BRAND}-BACKSTAGE-MEDIA` } });
      expect(addon?.forBrands).toEqual([BRAND, 'VFW']);
    });
  });

  describe('shows', () => {
    it('imports valid rows and refuses an unknown city with a per-row error', async () => {
      const csv = [
        'brand,name,season,cityId,start,end',
        `${BRAND},CSV Show,Fall/Winter 26,VAN,2026-09-10,2026-09-14`,
        `${BRAND},Bad City Show,Fall/Winter 26,ATLANTIS,2026-09-10,2026-09-14`,
      ].join('\n');

      const res = await upload('/api/admin/events/import', admin, csv).expect(201);
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed).toBe(1);
      expect(res.body.errors[0]).toMatchObject({ row: 3 });
      expect(res.body.errors[0].error).toMatch(/city/i);
    });
  });

  describe('authorization', () => {
    it('is admin-only — a rep cannot bulk-import the catalogue', async () => {
      const rep = await loginCookie(app, SALES);
      const csv = ['brand,name,looks,taxCode,glCode,prices', `${BRAND},Sneaky,1,GST-5,4010,VAN:USD:1.00`].join('\n');

      await upload('/api/admin/packages/import', rep, csv).expect(403);
      await upload('/api/admin/addons/import', rep, 'brand,name,price,currency,forBrands,glCode\n').expect(403);
      await upload('/api/admin/events/import', rep, 'brand,name,season,cityId,start,end\n').expect(403);

      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-SNEAKY` } })).toBeNull();
    });
  });
});
