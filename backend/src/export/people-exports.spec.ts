import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The QuickBooks ledger, Designer feedback and Internal comments exports.
 *
 * The load-bearing test here is the last one. Internal comments promise that
 * nobody reads the coaching notes written about their own sale — a promise the
 * permission gate cannot keep, because it is about roles and this rule is not.
 * A manager carrying their own deals is in `internal.view`. If the export
 * reached the table directly instead of going through `list`, it would hand them
 * the notes about themselves and every other test here would still pass.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';
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

describe('people & ledger exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let acct: string;
  let sales: string;
  const comments: string[] = [];
  const feedback: string[] = [];

  const pull = async (dataset: string, cookie: string) => {
    const res = await http(app)
      .get(`/api/export/${dataset}?format=csv`)
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
    acct = await loginCookie(app, ACCT);
    sales = await loginCookie(app, SALES);
  }, 60_000);

  afterAll(async () => {
    await prisma.internalComment.deleteMany({ where: { id: { in: comments } } });
    await prisma.designerFeedback.deleteMany({ where: { id: { in: feedback } } });
    await app.close();
  });

  describe.each([
    ['qbo-ledger', 'quickbooks.export'],
    ['feedback', 'feedback.view'],
    ['internal-comments', 'internal.view'],
  ])('%s', (dataset) => {
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

    it('is refused to a sales rep', async () => {
      await http(app).get(`/api/export/${dataset}?format=csv`).set('Cookie', sales).expect(403);
    });
  });

  it('the ledger holds what was posted, not what is merely approved', async () => {
    const csv = await pull('qbo-ledger', acct);
    expect(csv).toContain('Invoice,Ref,Customer');

    const exported = await prisma.submission.count({ where: { status: 'EXPORTED' } });
    expect(csv.trim().split('\n').length - 1).toBe(exported);

    // An APPROVED-but-unposted ref must not be in the ledger — that is the
    // "Ready to export" card, and conflating them is the reconciliation bug
    // this file exists to avoid.
    const approved = await prisma.submission.findFirst({ where: { status: 'APPROVED' } });
    if (approved) expect(csv).not.toContain(approved.ref);
  }, 30_000);

  it('feedback carries what was said, and not the rep who sold it', async () => {
    const contact = await prisma.contact.findFirstOrThrow();
    const recorder = await prisma.user.findFirstOrThrow({ where: { email: ACCT } });
    const row = await prisma.designerFeedback.create({
      data: {
        contactId: contact.id,
        rating: 5,
        body: 'a memorable feedback phrase',
        recordedById: recorder.id,
      },
    });
    feedback.push(row.id);

    const csv = await pull('feedback', admin);
    expect(csv).toContain('a memorable feedback phrase');
    expect(csv).toContain('Hannah Okafor'); // who recorded it
    // Feedback is a coaching input and reaches no score. A rep column next to a
    // rating column is how a file starts being read as a scoreboard.
    expect(csv).not.toContain('Rep');
  }, 30_000);

  it('never exports the notes written about the exporter\'s own sale', async () => {
    // A comment about Marielle's deal, authored by accounting.
    const marielle = await prisma.user.findFirstOrThrow({ where: { email: SALES } });
    const author = await prisma.user.findFirstOrThrow({ where: { email: ACCT } });
    const hers = await prisma.submission.findFirstOrThrow({ where: { repId: marielle.id } });

    const row = await prisma.internalComment.create({
      data: {
        submissionId: hers.id,
        department: 'Accounting',
        body: 'a confidential note about Marielle',
        authorId: author.id,
      },
    });
    comments.push(row.id);

    // Accounting may read it: not their sale.
    const acctFile = await pull('internal-comments', acct);
    expect(acctFile).toContain('a confidential note about Marielle');

    // Now make Marielle able to reach the endpoint at all, without making the
    // comment hers to read. Promoting her to MGR is the real shape of the risk:
    // a manager who still carries deals passes the permission gate.
    await prisma.user.update({ where: { id: marielle.id }, data: { role: 'MGR' } });
    try {
      const mgr = await loginCookie(app, SALES);
      const herFile = await pull('internal-comments', mgr);
      expect(herFile).not.toContain('a confidential note about Marielle');
      expect(herFile).not.toContain(hers.ref);
    } finally {
      await prisma.user.update({ where: { id: marielle.id }, data: { role: 'SALES' } });
    }
  }, 60_000);
});
