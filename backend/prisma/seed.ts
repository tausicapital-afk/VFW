/**
 * Catalog seed — transcribed from the sales decks via vfw-console.html
 * (TAX_SEED / CITIES / EVENTS / PACKAGES / ADDONS / GL_ACCOUNTS, lines 376-463).
 *
 * Idempotent: every write is an upsert, so this is safe to re-run against a
 * database that already holds submissions.
 */
import { PrismaClient, Role, Currency, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const TAXES = [
  { code: 'GST-5', label: 'GST 5% (Canada)', rate: 5, gst: 5, pst: 0, hst: 0, note: 'VFW / VKFW standard' },
  { code: 'GST-PST-12', label: 'GST 5% + PST 7% (BC)', rate: 12, gst: 5, pst: 7, hst: 0, note: 'BC goods where applicable' },
  { code: 'JCT-10', label: 'Japan Consumption 10%', rate: 10, gst: 0, pst: 0, hst: 0, note: 'Statutory JCT' },
  { code: 'GFC-8', label: 'GFC quoted 8%', rate: 8, gst: 0, pst: 0, hst: 0, note: 'As quoted in GFC deck (Tokyo/NY/London/Milan)' },
  { code: 'VAT-20', label: 'VAT 20% (France)', rate: 20, gst: 0, pst: 0, hst: 0, note: 'Paris — confirm per invoice' },
  { code: 'ZERO', label: 'Zero-rated / Exempt', rate: 0, gst: 0, pst: 0, hst: 0, note: 'Sponsored & exempt entities' },
];

const CITIES = [
  { id: 'VAN', name: 'Vancouver', country: 'Canada', currency: Currency.CAD, taxCode: 'GST-5' },
  { id: 'TYO', name: 'Tokyo', country: 'Japan', currency: Currency.USD, taxCode: 'GFC-8' },
  { id: 'NYC', name: 'New York', country: 'United States', currency: Currency.USD, taxCode: 'GFC-8' },
  { id: 'LDN', name: 'London', country: 'United Kingdom', currency: Currency.GBP, taxCode: 'GFC-8' },
  { id: 'MIL', name: 'Milan', country: 'Italy', currency: Currency.EUR, taxCode: 'GFC-8' },
  { id: 'PAR', name: 'Paris', country: 'France', currency: Currency.EUR, taxCode: 'VAT-20' },
];

const GL_ACCOUNTS = [
  { code: '4010', name: 'Designer Package Revenue — VFW' },
  { code: '4020', name: 'Emerging Designer Revenue' },
  { code: '4030', name: 'Designer Package Revenue — VKFW' },
  { code: '4050', name: 'Designer Package Revenue — GFC' },
  { code: '4090', name: 'Sponsored Participation Fees' },
  { code: '4200', name: 'Media & Content Rights Revenue' },
  { code: '4210', name: 'Production Add-on Revenue' },
  { code: '2310', name: 'Deferred Revenue — Future Season' },
];

const EVENTS = [
  { id: 'VFW-FW26', brand: 'VFW', name: 'Vancouver Fashion Week', season: 'Fall/Winter 26', cityId: 'VAN', venue: 'Chinese Cultural Centre', start: '2026-03-16', end: '2026-03-22' },
  { id: 'VKFW-FW26', brand: 'VKFW', name: 'Vancouver Kids Fashion Week', season: 'Fall/Winter 26', cityId: 'VAN', venue: 'Chinese Cultural Centre', start: '2026-03-14', end: '2026-03-15' },
  { id: 'GFC-TYO-FW26', brand: 'GFC', name: 'Global Fashion Collective — Tokyo', season: 'Fall/Winter 26', cityId: 'TYO', venue: 'Rakuten Fashion Week Tokyo', start: '2026-03-16', end: '2026-03-20' },
  { id: 'GFC-NYC-FW26', brand: 'GFC', name: 'Global Fashion Collective — New York', season: 'Fall/Winter 26', cityId: 'NYC', venue: 'NYFW Venue TBC', start: '2026-02-11', end: '2026-02-14' },
  { id: 'GFC-LDN-FW26', brand: 'GFC', name: 'Global Fashion Collective — London', season: 'Fall/Winter 26', cityId: 'LDN', venue: 'LFW Venue TBC', start: '2026-02-20', end: '2026-02-24' },
  { id: 'GFC-MIL-FW26', brand: 'GFC', name: 'Global Fashion Collective — Milan', season: 'Fall/Winter 26', cityId: 'MIL', venue: 'MFW Venue TBC', start: '2026-02-24', end: '2026-03-02' },
  { id: 'GFC-PAR-FW26', brand: 'GFC', name: 'Global Fashion Collective — Paris', season: 'Fall/Winter 26', cityId: 'PAR', venue: 'PFW Venue TBC', start: '2026-03-02', end: '2026-03-10' },
];

type PkgSeed = {
  id: string; brand: string; name: string; looks: number; taxCode: string; glCode: string;
  blurb: string; cap?: number; listValue?: number;
  prices: Record<string, { currency: Currency; price: number }>;
};

const PACKAGES: PkgSeed[] = [
  // Vancouver Fashion Week — FW26
  { id: 'VFW-BRONZE', brand: 'VFW', name: 'Bronze Package', looks: 12, taxCode: 'GST-5', glCode: '4010', prices: { VAN: { currency: Currency.USD, price: 7700 } }, blurb: '12 looks · 12 models · 2 dressers · 5 FW tickets' },
  { id: 'VFW-SILVER', brand: 'VFW', name: 'Silver Package', looks: 16, taxCode: 'GST-5', glCode: '4010', prices: { VAN: { currency: Currency.USD, price: 10300 } }, blurb: '16 looks · personalized hair & makeup · 1 reel' },
  { id: 'VFW-GOLD', brand: 'VFW', name: 'Gold Package', looks: 24, taxCode: 'GST-5', glCode: '4010', prices: { VAN: { currency: Currency.USD, price: 22000 } }, blurb: '24 looks · hotel 5d/4n (3★) · airport car service' },
  { id: 'VFW-PLATINUM', brand: 'VFW', name: 'Platinum Package', looks: 36, taxCode: 'GST-5', glCode: '4010', prices: { VAN: { currency: Currency.USD, price: 34100 } }, blurb: '36 looks · 4★ hotel · celebrity styling collab' },
  { id: 'VFW-DIAMOND', brand: 'VFW', name: 'Diamond Package', looks: 42, taxCode: 'GST-5', glCode: '4010', prices: { VAN: { currency: Currency.USD, price: 47300 } }, blurb: '42 looks · media dinner · 6 press collaborations' },
  { id: 'VFW-EMERGING', brand: 'VFW', name: 'Emerging Designer Package', looks: 8, taxCode: 'GST-5', glCode: '4020', prices: { VAN: { currency: Currency.CAD, price: 5105 } }, blurb: '8 looks · CAD price requires verified Canadian residency' },
  { id: 'VFW-SPONSORED', brand: 'VFW', name: 'International Sponsored Package', looks: 12, taxCode: 'GST-5', glCode: '4090', prices: { VAN: { currency: Currency.USD, price: 600 } }, listValue: 7700, blurb: 'Sponsored — designer pays the $600 mandatory photo & video fee only' },

  // Vancouver Kids Fashion Week — FW26
  { id: 'VKFW-VIP', brand: 'VKFW', name: 'VIP Package', looks: 34, taxCode: 'GST-5', glCode: '4030', prices: { VAN: { currency: Currency.USD, price: 11550 } }, cap: 2, blurb: '34 looks · opening or closing slot · only 2 available' },
  { id: 'VKFW-A', brand: 'VKFW', name: 'Package A', looks: 24, taxCode: 'GST-5', glCode: '4030', prices: { VAN: { currency: Currency.USD, price: 5980 } }, blurb: '24 looks · 2-page VKFW magazine spread' },
  { id: 'VKFW-B', brand: 'VKFW', name: 'Package B', looks: 12, taxCode: 'GST-5', glCode: '4030', prices: { VAN: { currency: Currency.USD, price: 3250 } }, blurb: '12 looks · 1-page VKFW magazine spread' },

  // Global Fashion Collective — FW26, priced per city
  {
    id: 'GFC-STANDALONE', brand: 'GFC', name: 'Stand Alone Package', looks: 60, taxCode: 'GFC-8', glCode: '4050',
    prices: {
      TYO: { currency: Currency.USD, price: 104000 }, NYC: { currency: Currency.USD, price: 113000 },
      LDN: { currency: Currency.GBP, price: 102000 }, MIL: { currency: Currency.EUR, price: 104000 },
      PAR: { currency: Currency.EUR, price: 113000 },
    },
    blurb: '60 looks · 3 international PR agencies · private editor dinner',
  },
  {
    id: 'GFC-PLATINUM', brand: 'GFC', name: 'Platinum Package', looks: 36, taxCode: 'GFC-8', glCode: '4050',
    prices: {
      TYO: { currency: Currency.USD, price: 42100 }, NYC: { currency: Currency.USD, price: 47300 },
      LDN: { currency: Currency.GBP, price: 42000 }, MIL: { currency: Currency.EUR, price: 44200 },
      PAR: { currency: Currency.EUR, price: 47300 },
    },
    blurb: '36 looks · 2 international PR agencies · 15 show tickets',
  },
  {
    id: 'GFC-GOLD', brand: 'GFC', name: 'Gold Package', looks: 18, taxCode: 'GFC-8', glCode: '4050',
    prices: {
      TYO: { currency: Currency.USD, price: 29500 }, NYC: { currency: Currency.USD, price: 33100 },
      LDN: { currency: Currency.GBP, price: 29400 }, MIL: { currency: Currency.EUR, price: 30600 },
      PAR: { currency: Currency.EUR, price: 33100 },
    },
    blurb: '18 looks · 2 PR agencies · 12 show tickets',
  },
  {
    id: 'GFC-SILVER', brand: 'GFC', name: 'Silver Package', looks: 12, taxCode: 'GFC-8', glCode: '4050',
    prices: {
      TYO: { currency: Currency.USD, price: 20000 }, NYC: { currency: Currency.USD, price: 22500 },
      LDN: { currency: Currency.GBP, price: 20000 }, MIL: { currency: Currency.EUR, price: 21000 },
      PAR: { currency: Currency.EUR, price: 22500 },
    },
    blurb: '12 looks · GFC-selected models · fixed neutral hair & makeup',
  },
];

const ADDONS = [
  { id: 'VFW-PHOTO', brand: 'VFW', name: 'Runway Photo & Video Rights', price: 600, currency: Currency.USD, glCode: '4200', forBrands: ['VFW'], note: 'Mandatory for sponsored designers' },
  { id: 'VFW-BACKSTAGE', brand: 'VFW', name: 'Backstage Media Content', price: 600, currency: Currency.USD, glCode: '4200', forBrands: ['VFW'], note: null },
  { id: 'VFW-PHOTO-CAD', brand: 'VFW', name: 'Runway Photo & Video (CAD)', price: 600, currency: Currency.CAD, glCode: '4200', forBrands: ['VFW'], note: 'Emerging Designer, Canadian residency' },
  { id: 'VFW-BACK-CAD', brand: 'VFW', name: 'Backstage Media Content (CAD)', price: 575, currency: Currency.CAD, glCode: '4200', forBrands: ['VFW'], note: '20 edited photos' },
  { id: 'VKFW-PHOTO', brand: 'VKFW', name: 'Runway Photo & Video', price: 600, currency: Currency.USD, glCode: '4200', forBrands: ['VKFW'], note: null },
  { id: 'VKFW-MUSIC', brand: 'VKFW', name: 'Runway Music (royalty-free)', price: 150, currency: Currency.USD, glCode: '4210', forBrands: ['VKFW'], note: null },
  { id: 'VKFW-HMU', brand: 'VKFW', name: 'Hair & Makeup Consultation', price: 500, currency: Currency.USD, glCode: '4210', forBrands: ['VKFW'], note: 'Package B' },
  { id: 'VKFW-MODELS', brand: 'VKFW', name: 'Model Preselection', price: 500, currency: Currency.USD, glCode: '4210', forBrands: ['VKFW'], note: 'Package B' },
  { id: 'GFC-RIGHTS-USD', brand: 'GFC', name: 'Runway Photo & Video Rights', price: 760, currency: Currency.USD, glCode: '4200', forBrands: ['GFC'], note: 'Tokyo / New York' },
  { id: 'GFC-RIGHTS-GBP', brand: 'GFC', name: 'Runway Photo & Video Rights', price: 760, currency: Currency.GBP, glCode: '4200', forBrands: ['GFC'], note: 'London' },
  { id: 'GFC-RIGHTS-EUR', brand: 'GFC', name: 'Runway Photo & Video Rights', price: 760, currency: Currency.EUR, glCode: '4200', forBrands: ['GFC'], note: 'Milan / Paris' },
];

// Demo staff, matching DB.users in the mockup. The shared password exists so the
// team can click through the app; it is dev-only and every account is seeded
// ACTIVE. Real accounts arrive via invitation + admin approval.
const DEMO_PASSWORD = 'Vfw@2026!';
const USERS = [
  { employeeId: 'VFW-1001', name: 'Marielle Fontaine', email: 'marielle@vanfashionweek.com', phone: '+1 604 555 0142', role: Role.SALES, department: 'Sales', commissionPct: 8, target: 160000, colour: '#2F6BFF' },
  { employeeId: 'VFW-1002', name: 'Diego Salazar', email: 'diego@vanfashionweek.com', phone: '+1 604 555 0177', role: Role.SALES, department: 'Sales', commissionPct: 8, target: 38000, colour: '#0C7A4D' },
  { employeeId: 'VFW-1003', name: 'Aiko Tanaka', email: 'aiko@vanfashionweek.com', phone: '+81 3 5555 0198', role: Role.SALES, department: 'International', commissionPct: 10, target: 30000, colour: '#6B4BC4' },
  { employeeId: 'VFW-1004', name: 'Priya Raman', email: 'priya@vanfashionweek.com', phone: '+1 604 555 0110', role: Role.SALES, department: 'Sales', commissionPct: 8, target: 25000, colour: '#A96C05' },
  { employeeId: 'VFW-2001', name: 'Hannah Okafor', email: 'accounting@vanfashionweek.com', phone: '+1 604 555 0100', role: Role.ACCT, department: 'Accounting', commissionPct: 0, target: 0, colour: '#0E0E11' },
  { employeeId: 'VFW-3001', name: 'Marcus Bell', email: 'sales.director@vanfashionweek.com', phone: '+1 604 555 0101', role: Role.MGR, department: 'Sales', commissionPct: 0, target: 0, colour: '#B3332A' },
  { employeeId: 'VFW-9001', name: 'System Administrator', email: 'it@vanfashionweek.com', phone: '+1 604 555 0199', role: Role.ADMIN, department: 'Administration', commissionPct: 0, target: 0, colour: '#B0A288' },
];

async function main() {
  // Order matters: taxes and GL accounts are referenced by cities/packages/addons.
  for (const t of TAXES) {
    await prisma.taxProfile.upsert({ where: { code: t.code }, update: t, create: t });
  }
  for (const g of GL_ACCOUNTS) {
    await prisma.glAccount.upsert({ where: { code: g.code }, update: g, create: g });
  }
  for (const c of CITIES) {
    await prisma.city.upsert({ where: { id: c.id }, update: c, create: c });
  }
  for (const e of EVENTS) {
    const row = { ...e, start: new Date(e.start), end: new Date(e.end) };
    await prisma.event.upsert({ where: { id: e.id }, update: row, create: row });
  }

  for (const p of PACKAGES) {
    const { prices, ...pkg } = p;
    await prisma.package.upsert({ where: { id: pkg.id }, update: pkg, create: pkg });
    for (const [cityId, { currency, price }] of Object.entries(prices)) {
      await prisma.packagePrice.upsert({
        where: { packageId_cityId: { packageId: pkg.id, cityId } },
        update: { currency, price },
        create: { packageId: pkg.id, cityId, currency, price },
      });
    }
  }

  for (const a of ADDONS) {
    await prisma.addon.upsert({ where: { id: a.id }, update: a, create: a });
  }

  const passwordHash = await argon2.hash(DEMO_PASSWORD);
  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { ...u, status: UserStatus.ACTIVE },
      create: { ...u, status: UserStatus.ACTIVE, passwordHash },
    });
  }

  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  // Submission refs come from Settings.nextSubmissionSeq, so that counter has to
  // start above any ref that already exists or the next create reissues a taken
  // one and trips `ref @unique`. The migration backfills this, but a database
  // stood up with `prisma db push` (the test harness, a scratch dev box) never
  // runs migrations — and `db push` does not clear data, so submissions from an
  // earlier run are still sitting there. Re-derive the high-water mark here so
  // the seed is correct however the schema arrived.
  // Max of the NUMERIC tail, not of the string: ordering refs as text would put
  // S-26-9999 above S-26-10000 and hand the counter back a number already used.
  const [{ max }] = await prisma.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(split_part("ref", '-', 3) AS INTEGER)) AS max
    FROM "Submission"
    WHERE "ref" ~ '^S-[0-9]+-[0-9]+$'
  `;
  if (max !== null) {
    await prisma.settings.update({
      where: { id: 1 },
      data: { nextSubmissionSeq: { set: max + 1 } },
    });
  }

  const counts = {
    taxes: await prisma.taxProfile.count(),
    cities: await prisma.city.count(),
    events: await prisma.event.count(),
    packages: await prisma.package.count(),
    prices: await prisma.packagePrice.count(),
    addons: await prisma.addon.count(),
    glAccounts: await prisma.glAccount.count(),
    users: await prisma.user.count(),
  };
  console.log('Seed complete:', counts);
  console.log(`Demo password for all seeded accounts: ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
