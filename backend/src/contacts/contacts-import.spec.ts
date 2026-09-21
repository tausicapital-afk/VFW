import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Bulk CSV import for the customer book — migrating an existing contact list.
 *
 * Same property as catalogue-import.spec.ts: every row goes through
 * ContactsService.create(), the exact path POST /api/contacts uses, so the
 * "brand is unique" rule enforced there (see docs/roadmap.md §2.1) is enforced
 * here too, one row at a time, with no second copy of it.
 */

const ADMIN = 'it@vanfashionweek.com';
// contacts.create is SALES / ACCT / ADMIN — MGR holds neither it nor
// admin.manage, which makes it the plain "someone signed in but not entitled"
// case, distinct from admin's own admin-only routes.
const MGR = 'sales.director@vanfashionweek.com';
const BRAND_PREFIX = `ZZCSV-${Date.now()}`;

describe('contacts — bulk CSV import', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  const sweep = () => prisma.contact.deleteMany({ where: { brand: { startsWith: BRAND_PREFIX } } });

  const upload = (cookie: string, csv: string) =>
    http(app)
      .post('/api/contacts/import')
      .set('Cookie', cookie)
      .attach('file', Buffer.from(csv, 'utf8'), 'contacts.csv');

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
  });

  afterEach(sweep);

  afterAll(async () => {
    await sweep();
    await app?.close();
  });

  it('imports every valid row through the same create() path a single add would use', async () => {
    const csv = [
      'brand,designer,company,email,country',
      `${BRAND_PREFIX}-A,Ada Designer,Ada Co,ada@example.com,Canada`,
      `${BRAND_PREFIX}-B,Bea Designer,Bea Co,bea@example.com,Canada`,
    ].join('\n');

    const res = await upload(admin, csv).expect(201);
    expect(res.body).toMatchObject({ succeeded: 2, failed: 0, errors: [] });

    const rows = await prisma.contact.findMany({ where: { brand: { startsWith: BRAND_PREFIX } } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.brand === `${BRAND_PREFIX}-A`)?.designer).toBe('Ada Designer');
  });

  it('reports each bad row with its file row number and reason, without dropping the good rows', async () => {
    // Seed one contact outside the file, then re-offer its brand in the file —
    // the same duplicate-brand rejection create() applies to a single POST.
    await prisma.contact.create({ data: { brand: `${BRAND_PREFIX}-DUP`, designer: '' } });

    const csv = [
      'brand,designer,company,email,country',
      `${BRAND_PREFIX}-C,Cee Designer,Cee Co,cee@example.com,Canada`, // row 2 — good
      `,No Brand,,,`, // row 3 — brand is required
      `${BRAND_PREFIX}-DUP,Dupe Designer,,,`, // row 4 — brand already exists
    ].join('\n');

    const res = await upload(admin, csv).expect(201);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(2);

    const rows = res.body.errors as Array<{ row: number; error: string }>;
    expect(rows.map((e) => e.row).sort()).toEqual([3, 4]);
    expect(rows.find((e) => e.row === 4)?.error).toMatch(/already exists/i);

    expect(await prisma.contact.findUnique({ where: { brand: `${BRAND_PREFIX}-C` } })).not.toBeNull();
  });

  it('is gated the same as a single add — a role without contacts.create cannot import', async () => {
    const mgr = await loginCookie(app, MGR);
    const csv = ['brand,designer', `${BRAND_PREFIX}-Sneaky,Nope`].join('\n');

    await upload(mgr, csv).expect(403);
    expect(await prisma.contact.findUnique({ where: { brand: `${BRAND_PREFIX}-Sneaky` } })).toBeNull();
  });
});
