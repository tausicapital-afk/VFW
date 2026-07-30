import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Hand-set invoice numbers, and the edit window either side of approval.
 *
 * The boundary this file exists to hold is the one the numbers move across at
 * approval: before it, an invoice number is data entry and belongs to whoever
 * owns the sale; after it, the number is on a document a client may already be
 * holding, so it belongs to Accounting. Get that backwards in either direction
 * and the failure is silent — a rep quietly renumbering a sent invoice, or
 * Accounting unable to fix one.
 *
 * The second property is uniqueness. It used to be free, because the only way to
 * get a number was a row-locked increment. Now that a person can type one, two
 * sales can claim the same number, and the one that loses is discovered months
 * later by whoever reconciles the books.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';
const OTHER_SALES = 'diego@vanfashionweek.com';

describe('invoice numbers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let acct: string;
  let sales: string;
  let other: string;
  const litter: string[] = [];

  /** A fresh PENDING sale owned by Marielle. */
  const newPending = async () => {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({
        designer: 'Invoice Test',
        brand: `Invoice ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        eventId: 'VFW-FW26',
        packageId: 'VFW-BRONZE',
      })
      .expect(201);
    litter.push(res.body.id);
    return res.body.id as string;
  };

  const approve = (id: string) =>
    http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send().expect(201);

  const setNo = (id: string, cookie: string, invoiceNo: string) =>
    http(app).put(`/api/submissions/${id}/invoice-no`).set('Cookie', cookie).send({ invoiceNo });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    acct = await loginCookie(app, ACCT);
    sales = await loginCookie(app, SALES);
    other = await loginCookie(app, OTHER_SALES);
  });

  afterAll(async () => {
    if (litter.length) {
      await prisma.submission.deleteMany({ where: { id: { in: litter } } });
    }
    await app?.close();
  });

  // --- Before approval -----------------------------------------------------

  it('lets the rep who owns an unapproved sale set its number', async () => {
    const id = await newPending();
    const no = `TEST-${Date.now()}`;

    const res = await setNo(id, sales, no).expect(200);
    expect(res.body.invoiceNo).toBe(no);
  });

  it("refuses another rep's sale the same way a read does — as if it did not exist", async () => {
    const id = await newPending();

    await setNo(id, other, 'HIJACK-1').expect(404);
    const after = await prisma.submission.findUniqueOrThrow({ where: { id } });
    expect(after.invoiceNo).toBeNull();
  });

  it('lets Accounting set it on anyone’s unapproved sale', async () => {
    const id = await newPending();
    await setNo(id, acct, `ACCT-${Date.now()}`).expect(200);
  });

  // --- After approval ------------------------------------------------------

  it('stops the rep once the sale is approved, and lets Accounting through', async () => {
    const id = await newPending();
    await setNo(id, sales, `BEFORE-${Date.now()}`).expect(200);
    await approve(id);

    // Same person, same sale, same request — the only thing that changed is that
    // somebody decided on it.
    await setNo(id, sales, `AFTER-${Date.now()}`).expect(403);

    const fixed = `FIXED-${Date.now()}`;
    const res = await setNo(id, acct, fixed).expect(200);
    expect(res.body.invoiceNo).toBe(fixed);
  });

  it('records a renumbering as its own kind of event', async () => {
    const id = await newPending();
    await setNo(id, sales, `FIRST-${Date.now()}`).expect(200);
    await setNo(id, sales, `SECOND-${Date.now()}`).expect(200);

    const trail = await prisma.auditEntry.findMany({ where: { submissionId: id } });
    const actions = trail.map((e) => e.action);
    // The first set is an INVOICE; changing it afterwards is not the same event.
    expect(actions).toContain('INVOICE');
    expect(actions).toContain('INVOICE_RENUMBERED');
  });

  // --- Uniqueness and the sequence -----------------------------------------

  it('refuses a number another sale already holds, and names it', async () => {
    const first = await newPending();
    const second = await newPending();
    const no = `DUPE-${Date.now()}`;

    await setNo(first, sales, no).expect(200);
    const clash = await setNo(second, sales, no).expect(400);

    const owner = await prisma.submission.findUniqueOrThrow({ where: { id: first } });
    expect(clash.body.message).toContain(owner.ref);
  });

  it('pushes the automatic sequence past a hand-typed number in its range', async () => {
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    // Claim a number well ahead of the counter, the way somebody matching an
    // external ledger would.
    const ahead = settings.nextInvoiceSeq + 25;

    const manual = await newPending();
    await setNo(manual, sales, `${settings.invoicePrefix}${ahead}`).expect(200);

    // The next approval must not be handed the number that was just taken.
    const next = await newPending();
    await approve(next);
    const res = await http(app)
      .post(`/api/submissions/${next}/invoice`)
      .set('Cookie', acct)
      .send()
      .expect(201);

    expect(res.body.invoiceNo).toBe(`${settings.invoicePrefix}${ahead + 1}`);
  });

  it('leaves the sequence alone for a number that is not ours', async () => {
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const id = await newPending();

    // A client's own reference. Nothing to do with our two sequences.
    await setNo(id, sales, `2026/03/${Date.now() % 1000}`).expect(200);

    const after = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(after.nextInvoiceSeq).toBe(before.nextInvoiceSeq);
    expect(after.nextGfcInvoiceSeq).toBe(before.nextGfcInvoiceSeq);
  });

  // --- Shape ---------------------------------------------------------------

  it('refuses a number that could not go on a document', async () => {
    const id = await newPending();

    for (const invoiceNo of ['', '   ', '-leading-dash', 'has<angle>brackets', 'x'.repeat(41)]) {
      await setNo(id, sales, invoiceNo).expect(400);
    }
  });

  it('accepts the shapes a real business actually bills under', async () => {
    for (const invoiceNo of [`VFW-${Date.now()}`, `2026/03/${Date.now() % 10000}`, `INV.${Date.now()}`]) {
      const id = await newPending();
      await setNo(id, sales, invoiceNo).expect(200);
    }
  });

  // --- Dead ends -----------------------------------------------------------

  it('will not number a voided sale', async () => {
    const id = await newPending();
    await http(app).post(`/api/submissions/${id}/void`).set('Cookie', acct).send({}).expect(201);

    await setNo(id, acct, `VOID-${Date.now()}`).expect(400);
  });
});

// ---------------------------------------------------------------------------

/**
 * The edit window itself. Editing used to stop dead at DRAFT and RETURNED, which
 * left a rep who spotted a typo in a queued sale with nothing to do but wait for
 * it to be returned, and left Accounting unable to correct an approved one at all.
 */
describe('the edit window either side of approval', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let acct: string;
  let sales: string;
  const litter: string[] = [];

  const body = (brand: string) => ({
    designer: 'Edit Window',
    brand,
    eventId: 'VFW-FW26',
    packageId: 'VFW-BRONZE',
  });

  const newPending = async () => {
    const brand = `Window ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send(body(brand))
      .expect(201);
    litter.push(res.body.id);
    return { id: res.body.id as string, brand };
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    acct = await loginCookie(app, ACCT);
    sales = await loginCookie(app, SALES);
  });

  afterAll(async () => {
    if (litter.length) {
      await prisma.submission.deleteMany({ where: { id: { in: litter } } });
    }
    await app?.close();
  });

  it('lets a rep correct a sale that is still in the queue, without moving it', async () => {
    const { id, brand } = await newPending();
    const before = await prisma.submission.findUniqueOrThrow({ where: { id } });

    const res = await http(app)
      .put(`/api/submissions/${id}`)
      .set('Cookie', sales)
      .send({ ...body(brand), packageId: 'VFW-SILVER' })
      .expect(200);

    expect(res.body.status).toBe('PENDING');
    // A correction is not a fresh submission jumping the queue: the timestamp
    // the queue is ordered by must not move.
    const after = await prisma.submission.findUniqueOrThrow({ where: { id } });
    expect(after.submittedAt?.toISOString()).toBe(before.submittedAt?.toISOString());
    // And it really did re-price.
    expect(Number(after.total)).not.toBe(Number(before.total));
  });

  it('refuses a rep an approved sale, and lets Accounting amend it', async () => {
    const { id, brand } = await newPending();
    await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send().expect(201);

    await http(app)
      .put(`/api/submissions/${id}`)
      .set('Cookie', sales)
      .send({ ...body(brand), packageId: 'VFW-SILVER' })
      .expect(403);

    const res = await http(app)
      .put(`/api/submissions/${id}`)
      .set('Cookie', acct)
      .send({ ...body(brand), packageId: 'VFW-SILVER' })
      .expect(200);

    // An amendment does not un-approve the sale — that decision still stands.
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedAt).not.toBeNull();
  });

  it('logs an amendment as an amendment, with what the sale was worth before', async () => {
    const { id, brand } = await newPending();
    await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send().expect(201);
    const before = await prisma.submission.findUniqueOrThrow({ where: { id } });

    await http(app)
      .put(`/api/submissions/${id}`)
      .set('Cookie', acct)
      .send({ ...body(brand), packageId: 'VFW-SILVER' })
      .expect(200);

    const entry = await prisma.auditEntry.findFirst({
      where: { submissionId: id, action: 'AMENDED' },
    });
    expect(entry).not.toBeNull();
    expect((entry!.payload as { previousTotal: string }).previousTotal).toBe(before.total.toString());
  });

  it('still refuses a voided sale, which has its own way back', async () => {
    const { id, brand } = await newPending();
    await http(app).post(`/api/submissions/${id}/void`).set('Cookie', acct).send({}).expect(201);

    const res = await http(app)
      .put(`/api/submissions/${id}`)
      .set('Cookie', acct)
      .send(body(brand))
      .expect(400);
    expect(res.body.message).toContain('voided');
  });
});
