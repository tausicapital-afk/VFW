import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Contacts export.
 *
 * This is the first dataset where both gates carry weight at once, so both are
 * tested: an INTERN is refused outright (the customer book is designer PII and
 * a trainee does not hold it), while a SALES rep is allowed the endpoint but
 * gets only their own brands. A dataset that leaned on either gate alone would
 * pass one of these tests and fail the other.
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

describe('contacts export', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;
  let intern: string;
  let internId: string;
  const litter: string[] = [];

  const pull = async (cookie: string, query = '') => {
    const res = await http(app)
      .get(`/api/export/contacts?format=csv${query}`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return (res.body as Buffer).toString('utf8');
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    sales = await loginCookie(app, SALES);

    // An INTERN to prove the role gate. Seeded accounts share one password.
    const marielle = await prisma.user.findFirstOrThrow({ where: { email: SALES } });
    const created = await prisma.user.create({
      data: {
        name: 'Trainee Tester',
        email: `intern-export-${Date.now()}@vanfashionweek.com`,
        passwordHash: marielle.passwordHash,
        role: 'INTERN',
        status: 'ACTIVE',
      },
    });
    internId = created.id;
    intern = await loginCookie(app, created.email);
  }, 60_000);

  afterAll(async () => {
    await prisma.contact.deleteMany({ where: { id: { in: litter } } });
    await prisma.user.delete({ where: { id: internId } }).catch(() => undefined);
    await app.close();
  });

  it('renders in all three formats', async () => {
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      const res = await http(app)
        .get(`/api/export/contacts?format=${format}`)
        .set('Cookie', admin)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect((res.body as Buffer).length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('refuses an intern — the role gate, which row-scoping would never have applied', async () => {
    await http(app).get('/api/export/contacts?format=csv').set('Cookie', intern).expect(403);
  });

  it('gives a rep their own customers and not another rep\'s', async () => {
    const marielle = await prisma.user.findFirstOrThrow({ where: { email: SALES } });
    const other = await prisma.user.findFirstOrThrow({
      where: { email: 'diego@vanfashionweek.com' },
    });

    const mine = await prisma.contact.create({
      data: { brand: `ScopeMine-${Date.now()}`, designer: 'Mine Designer', createdById: marielle.id },
    });
    litter.push(mine.id);
    const theirs = await prisma.contact.create({
      data: { brand: `ScopeTheirs-${Date.now()}`, designer: 'Theirs Designer', createdById: other.id },
    });
    litter.push(theirs.id);

    const repFile = await pull(sales);
    expect(repFile).toContain(mine.brand);
    expect(repFile).not.toContain(theirs.brand);

    // An admin sees both — proving the absence above is the scope, not the row.
    const adminFile = await pull(admin);
    expect(adminFile).toContain(mine.brand);
    expect(adminFile).toContain(theirs.brand);
  }, 30_000);

  it('honours the search box', async () => {
    const hit = await prisma.contact.create({
      data: { brand: `Findable-${Date.now()}`, designer: 'Searchable Designer' },
    });
    litter.push(hit.id);
    const miss = await prisma.contact.create({
      data: { brand: `Unfindable-${Date.now()}`, designer: 'Other Designer' },
    });
    litter.push(miss.id);

    const csv = await pull(admin, '&q=Searchable');
    expect(csv).toContain(hit.brand);
    expect(csv).not.toContain(miss.brand);
  }, 30_000);

  it('carries the contact detail the screen holds', async () => {
    const c = await prisma.contact.create({
      data: {
        brand: `Detailed-${Date.now()}`,
        designer: 'Full Designer',
        company: 'Full Co',
        email: 'full@example.com',
        phone: '+1 604 555 0000',
        country: 'Canada',
      },
    });
    litter.push(c.id);

    const csv = await pull(admin, `&q=${encodeURIComponent(c.brand)}`);
    expect(csv).toContain('Brand,Designer,Company,Type,Email,Phone,Country');
    expect(csv).toContain('full@example.com');
    expect(csv).toContain('Full Co');
    expect(csv).toContain('Canada');
  }, 30_000);
});
