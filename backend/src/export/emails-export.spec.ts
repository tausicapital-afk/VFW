import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Emails → Sent / Received exports.
 *
 * Both datasets carry no `permission`, the attendance precedent: `load` calls
 * EmailsService.list directly, the exact method GET /api/emails calls, so the
 * file inherits the screen's own row-scoping — a viewAll role (ACCT/MGR/ADMIN)
 * gets the whole log, everyone else gets only mail they triggered. The load-
 * bearing test is the rep-scoping one: if the dataset ever read the table
 * directly instead of going through `list`, a rep would download a colleague's
 * sends and every other test here would still pass.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const OTHER_SALES = 'diego@vanfashionweek.com';

function binaryParser(
  res: SuperagentResponse,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('emails exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;
  let salesId: string;
  let otherId: string;
  const litter: string[] = [];
  const submissionLitter: string[] = [];
  const contactLitter: string[] = [];

  const pull = async (dataset: string, cookie: string, query = '') => {
    const res = await http(app)
      .get(`/api/export/${dataset}?format=csv${query}`)
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

    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
    otherId = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER_SALES } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.emailMessage.deleteMany({ where: { id: { in: litter } } });
    await prisma.submission.deleteMany({ where: { id: { in: submissionLitter } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactLitter } } });
    await app.close();
  });

  describe.each([
    ['emails-sent', 'OUTBOUND'],
    ['emails-received', 'INBOUND'],
  ])('%s', (dataset, direction) => {
    it('renders in all three formats', async () => {
      for (const format of ['csv', 'xlsx', 'pdf'] as const) {
        const res = await http(app)
          .get(`/api/export/${dataset}?format=${format}`)
          .set('Cookie', admin)
          .buffer(true)
          .parse(binaryParser)
          .expect(200);
        expect((res.body as Buffer).length).toBeGreaterThan(0);
      }
    }, 30_000);

    it('is not refused to a sales rep — email.viewOwn is held by every role', async () => {
      await http(app).get(`/api/export/${dataset}?format=csv`).set('Cookie', sales).expect(200);
    });

    it(`honours the tab's own direction (${direction})`, async () => {
      const row = await prisma.emailMessage.create({
        data: {
          direction: direction as 'OUTBOUND' | 'INBOUND',
          status: 'SENT',
          kind: 'OTHER',
          fromAddress: 'system@vanfashionweek.com',
          toAddress: 'someone@example.com',
          subject: `direction probe ${dataset} ${Date.now()}`,
          triggeredById: salesId,
        },
      });
      litter.push(row.id);

      const csv = await pull(dataset, admin);
      expect(csv).toContain(row.subject);

      // The opposite direction never leaks into this tab's file.
      const otherDataset = dataset === 'emails-sent' ? 'emails-received' : 'emails-sent';
      const otherCsv = await pull(otherDataset, admin);
      expect(otherCsv).not.toContain(row.subject);
    }, 30_000);
  });

  it('scopes emails-sent to the rep who triggered it, and not a colleague\'s', async () => {
    const mine = await prisma.emailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        kind: 'OTHER',
        fromAddress: 'system@vanfashionweek.com',
        toAddress: 'mine@example.com',
        subject: `ScopeMine-${Date.now()}`,
        triggeredById: salesId,
      },
    });
    litter.push(mine.id);
    const theirs = await prisma.emailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        kind: 'OTHER',
        fromAddress: 'system@vanfashionweek.com',
        toAddress: 'theirs@example.com',
        subject: `ScopeTheirs-${Date.now()}`,
        triggeredById: otherId,
      },
    });
    litter.push(theirs.id);

    const repFile = await pull('emails-sent', sales);
    expect(repFile).toContain(mine.subject);
    expect(repFile).not.toContain(theirs.subject);

    // A viewAll role (ADMIN) sees both — proving the absence above is the
    // scope, not a missing row.
    const adminFile = await pull('emails-sent', admin);
    expect(adminFile).toContain(mine.subject);
    expect(adminFile).toContain(theirs.subject);
  }, 30_000);

  it('never hands a non-viewAll rep received mail — inbound rows carry no triggeredById', async () => {
    const inbound = await prisma.emailMessage.create({
      data: {
        direction: 'INBOUND',
        status: 'RECEIVED',
        kind: 'INBOUND',
        fromAddress: 'client@example.com',
        toAddress: 'inbox@vanfashionweek.com',
        subject: `InboundOnlyAdmin-${Date.now()}`,
      },
    });
    litter.push(inbound.id);

    const repFile = await pull('emails-received', sales);
    expect(repFile).not.toContain(inbound.subject);

    const adminFile = await pull('emails-received', admin);
    expect(adminFile).toContain(inbound.subject);
  }, 30_000);

  it("honours the kind filter, the same dropdown the screen's Kind select uses", async () => {
    const invoice = await prisma.emailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        kind: 'INVOICE',
        fromAddress: 'system@vanfashionweek.com',
        toAddress: 'invoice-kind@example.com',
        subject: `KindInvoice-${Date.now()}`,
        triggeredById: salesId,
      },
    });
    litter.push(invoice.id);
    const welcome = await prisma.emailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        kind: 'WELCOME',
        fromAddress: 'system@vanfashionweek.com',
        toAddress: 'welcome-kind@example.com',
        subject: `KindWelcome-${Date.now()}`,
        triggeredById: salesId,
      },
    });
    litter.push(welcome.id);

    const filtered = await pull('emails-sent', sales, '&kind=INVOICE');
    expect(filtered).toContain(invoice.subject);
    expect(filtered).not.toContain(welcome.subject);
    expect(filtered).toContain('Invoice'); // KIND_LABEL, spelled as the screen spells it
  }, 30_000);

  it('marks test data and links the related sale, as the reader pane does', async () => {
    const contact = await prisma.contact.create({
      data: { brand: `EmailFxBrand-${Date.now()}`, designer: 'Email Fixture Designer' },
    });
    contactLitter.push(contact.id);
    const event = await prisma.event.findFirstOrThrow();
    const pkg = await prisma.package.findFirstOrThrow();
    const tax = await prisma.taxProfile.findFirstOrThrow();

    const submission = await prisma.submission.create({
      data: {
        ref: `EMAILFX-${Date.now()}`,
        status: 'APPROVED',
        repId: salesId,
        contactId: contact.id,
        eventId: event.id,
        cityId: event.cityId,
        packageId: pkg.id,
        currency: 'CAD',
        packagePrice: '1000', subtotal: '1000', taxable: '1000',
        taxRate: '0', taxAmount: '0', total: '1000', balance: '0',
        taxCode: tax.code,
        commissionPct: '0', commissionAmount: '0',
        invoiceNo: `INV-EMAILFX-${Date.now()}`,
      },
    });
    submissionLitter.push(submission.id);

    const row = await prisma.emailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        kind: 'INVOICE',
        fromAddress: 'system@vanfashionweek.com',
        toAddress: 'rehearsal@example.com',
        subject: `RehearsalInvoice-${Date.now()}`,
        triggeredById: salesId,
        isTestData: true,
        submissionId: submission.id,
      },
    });
    litter.push(row.id);

    const csv = await pull('emails-sent', admin);
    const line = csv.split('\n').find((l) => l.includes(row.subject));
    expect(line).toContain('TEST');
    expect(line).toContain(submission.invoiceNo);
  }, 30_000);
});
