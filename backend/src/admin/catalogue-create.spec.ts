import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Adding to the catalogue, through the real request path.
 *
 * Two properties matter here. The first is the one the whole tab is built
 * around and that catalog.spec.ts states structurally: a catalogue write is
 * additive and must not move a sale that has already been priced. Creating is
 * the newest way to write to the catalogue, so it is held to it too.
 *
 * The second is that a half-made package must not exist. A row with no price
 * would be offered on the new-submission form and then fail to price, so
 * everything that would leave one behind is refused before it is written.
 *
 * These tests use a brand of their own rather than VFW, so a crashed run leaves
 * nothing recognisable in the real rate card and nothing can collide with a
 * seeded id.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const BRAND = 'ZZTEST';

/** Codes this file invents, swept the same way BRAND is. */
const TAX_CODE = 'ZZTEST-9';

describe('catalogue — creating packages, add-ons and tax profiles', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  const newPackage = (body: object = {}) =>
    http(app)
      .post('/api/admin/packages')
      .set('Cookie', admin)
      .send({
        brand: BRAND,
        name: 'Bronze Package',
        looks: 12,
        taxCode: 'GST-5',
        glCode: '4010',
        prices: [{ cityId: 'VAN', currency: 'USD', price: '7700.00' }],
        ...body,
      });

  const newAddon = (body: object = {}) =>
    http(app)
      .post('/api/admin/addons')
      .set('Cookie', admin)
      .send({
        brand: BRAND,
        name: 'Backstage Media',
        price: '600.00',
        currency: 'USD',
        forBrands: [BRAND],
        glCode: '4200',
        ...body,
      });

  const newTax = (body: object = {}) =>
    http(app)
      .post('/api/admin/tax')
      .set('Cookie', admin)
      .send({ code: TAX_CODE, label: 'Test rate 9%', rate: '9', ...body });

  /** Anything this file made, by construction — it is the only user of BRAND. */
  const sweep = async () => {
    await prisma.packagePrice.deleteMany({ where: { package: { brand: BRAND } } });
    await prisma.package.deleteMany({ where: { brand: BRAND } });
    await prisma.addon.deleteMany({ where: { brand: BRAND } });
    await prisma.taxProfile.deleteMany({ where: { code: TAX_CODE } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    // Also before: a run that died before afterAll would otherwise leave rows
    // that turn the "refuses a duplicate" test into a false pass.
    await sweep();
  });

  afterEach(sweep);

  afterAll(async () => {
    await sweep();
    await app?.close();
  });

  describe('packages', () => {
    it('derives the id from brand and name, the way the seed spells them', async () => {
      const res = await newPackage().expect(201);
      // "Package" is dropped — VFW-BRONZE, not VFW-BRONZE-PACKAGE.
      expect(res.body.id).toBe(`${BRAND}-BRONZE`);
      expect(res.body).toMatchObject({ brand: BRAND, name: 'Bronze Package', looks: 12 });
    });

    it('lands on the rate card with its prices attached', async () => {
      await newPackage({
        prices: [
          { cityId: 'VAN', currency: 'USD', price: '7700.00' },
          { cityId: 'LDN', currency: 'GBP', price: '6100.50' },
        ],
      }).expect(201);

      const res = await http(app).get('/api/admin/catalogue').set('Cookie', admin).expect(200);
      const pkg = res.body.packages.find((p: { id: string }) => p.id === `${BRAND}-BRONZE`);

      expect(pkg).toBeDefined();
      expect(pkg.prices).toHaveLength(2);
      // The price is the string that was typed, to the cent — not a float that
      // has been through a round trip.
      expect(pkg.prices.find((p: { cityId: string }) => p.cityId === 'LDN')).toMatchObject({
        currency: 'GBP',
        price: '6100.5',
      });
    });

    it('takes a currency that is not the city\'s — VFW prices Vancouver in USD', async () => {
      const res = await newPackage().expect(201);
      const van = await prisma.city.findUniqueOrThrow({ where: { id: 'VAN' } });

      expect(van.currency).toBe('CAD');
      expect(res.body.prices[0].currency).toBe('USD');
    });

    it('refuses a second package with the same name in the same brand', async () => {
      await newPackage().expect(201);
      const res = await newPackage().expect(400);
      expect(res.body.message).toMatch(new RegExp(`${BRAND}-BRONZE`));
    });

    it('refuses a package with no price — it would fail on the submission form', async () => {
      await newPackage({ prices: [] }).expect(400);
      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-BRONZE` } })).toBeNull();
    });

    it('refuses two prices for one city rather than hitting the unique constraint', async () => {
      const res = await newPackage({
        prices: [
          { cityId: 'VAN', currency: 'USD', price: '7700.00' },
          { cityId: 'VAN', currency: 'CAD', price: '9900.00' },
        ],
      }).expect(400);
      expect(res.body.message).toMatch(/one price per city/i);
    });

    it('refuses an unknown city, tax profile or GL account, and writes nothing', async () => {
      await newPackage({ prices: [{ cityId: 'ATLANTIS', currency: 'USD', price: '1.00' }] })
        .expect(400);
      await newPackage({ taxCode: 'NO-SUCH-TAX' }).expect(400);
      await newPackage({ glCode: '9999' }).expect(400);

      expect(await prisma.package.findUnique({ where: { id: `${BRAND}-BRONZE` } })).toBeNull();
    });

    it('refuses a price that is not a positive number', async () => {
      await newPackage({ prices: [{ cityId: 'VAN', currency: 'USD', price: '-5.00' }] }).expect(400);
      await newPackage({ prices: [{ cityId: 'VAN', currency: 'USD', price: 'free' }] }).expect(400);
    });

    it('leaves an audit entry naming the package', async () => {
      await newPackage().expect(201);

      const entry = await prisma.auditEntry.findFirst({
        where: { action: 'CATALOG_PACKAGE_CREATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.detail).toContain('Bronze Package');
      expect(entry?.payload).toMatchObject({ packageId: `${BRAND}-BRONZE`, brand: BRAND });
    });

    it('does not touch a package that already exists', async () => {
      const before = await prisma.packagePrice.findMany({
        where: { packageId: 'VFW-BRONZE' },
        orderBy: { cityId: 'asc' },
      });
      expect(before.length).toBeGreaterThan(0);

      await newPackage().expect(201);

      const after = await prisma.packagePrice.findMany({
        where: { packageId: 'VFW-BRONZE' },
        orderBy: { cityId: 'asc' },
      });
      expect(after.map((p) => p.price.toFixed(2))).toEqual(before.map((p) => p.price.toFixed(2)));
    });
  });

  describe('add-ons', () => {
    it('creates one with a derived id and the brands allowed to buy it', async () => {
      const res = await newAddon({ forBrands: [BRAND, 'VFW'] }).expect(201);

      expect(res.body).toMatchObject({
        id: `${BRAND}-BACKSTAGE-MEDIA`,
        price: '600',
        currency: 'USD',
        forBrands: [BRAND, 'VFW'],
      });
    });

    it('refuses a duplicate name in the same brand', async () => {
      await newAddon().expect(201);
      await newAddon().expect(400);
    });

    it('refuses an unknown GL account', async () => {
      await newAddon({ glCode: '9999' }).expect(400);
    });
  });

  describe('tax profiles', () => {
    it('creates one and offers it to price against', async () => {
      const res = await newTax({ note: 'Statutory' }).expect(201);
      expect(res.body).toMatchObject({ code: TAX_CODE, label: 'Test rate 9%', rate: '9' });

      const cat = await http(app).get('/api/admin/catalogue').set('Cookie', admin).expect(200);
      expect(cat.body.taxes.map((t: { code: string }) => t.code)).toContain(TAX_CODE);
    });

    it('uppercases the code — GST-5 and gst-5 are not two profiles', async () => {
      const res = await newTax({ code: TAX_CODE.toLowerCase() }).expect(201);
      expect(res.body.code).toBe(TAX_CODE);
    });

    it('defaults the breakdown to zero when it is a quoted rate, like GFC-8', async () => {
      const res = await newTax().expect(201);
      expect(res.body).toMatchObject({ gst: '0', pst: '0', hst: '0' });
    });

    it('keeps a breakdown that does not sum to the rate — GFC-8 is quoted, not statutory', async () => {
      // The rule the seed actually holds is that there is no rule. A quoted rate
      // with an unrelated breakdown is legal; the modal warns, the server allows.
      const res = await newTax({ rate: '9', gst: '5', pst: '7' }).expect(201);
      expect(res.body).toMatchObject({ rate: '9', gst: '5', pst: '7' });
    });

    it('refuses a code that already exists', async () => {
      await newTax().expect(201);
      const res = await newTax({ label: 'Different label' }).expect(400);
      expect(res.body.message).toMatch(new RegExp(TAX_CODE));
    });

    it('refuses a code with spaces or punctuation — it is a key, not prose', async () => {
      await newTax({ code: 'ZZ TEST' }).expect(400);
      await newTax({ code: 'ZZ/TEST' }).expect(400);
    });

    it('refuses a rate over 100% or below zero', async () => {
      await newTax({ rate: '120' }).expect(400);
      await newTax({ rate: '-1' }).expect(400);
      await newTax({ rate: '9', pst: '101' }).expect(400);
      expect(await prisma.taxProfile.findUnique({ where: { code: TAX_CODE } })).toBeNull();
    });

    it('leaves an audit entry naming the profile', async () => {
      await newTax().expect(201);

      const entry = await prisma.auditEntry.findFirst({
        where: { action: 'CATALOG_TAX_CREATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.detail).toContain(TAX_CODE);
      expect(entry?.payload).toMatchObject({ taxCode: TAX_CODE, rate: '9.000' });
    });

    it('does not move an existing profile', async () => {
      const before = await prisma.taxProfile.findUniqueOrThrow({ where: { code: 'GST-5' } });
      await newTax().expect(201);
      const after = await prisma.taxProfile.findUniqueOrThrow({ where: { code: 'GST-5' } });

      expect(after.rate.toFixed(3)).toBe(before.rate.toFixed(3));
    });
  });

  describe('authorization', () => {
    it('is admin-only — a rep cannot add to the catalogue', async () => {
      const rep = await loginCookie(app, SALES);

      await http(app)
        .post('/api/admin/packages')
        .set('Cookie', rep)
        .send({ brand: BRAND, name: 'Sneaky', looks: 1, taxCode: 'GST-5', glCode: '4010', prices: [] })
        .expect(403);
      await http(app)
        .post('/api/admin/addons')
        .set('Cookie', rep)
        .send({ brand: BRAND, name: 'Sneaky', price: '1', currency: 'USD', forBrands: [BRAND], glCode: '4200' })
        .expect(403);
      await http(app)
        .post('/api/admin/tax')
        .set('Cookie', rep)
        .send({ code: TAX_CODE, label: 'Sneaky', rate: '0' })
        .expect(403);
    });
  });
});
