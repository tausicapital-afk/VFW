import type { INestApplication } from '@nestjs/common';
import { SubmissionStatus } from '@prisma/client';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The submission lifecycle is a state machine, and illegal transitions must
 * fail rather than silently corrupt a financial record. These drive the real
 * endpoints and assert the transition is refused with a 400.
 */
describe('Submission lifecycle — illegal transitions are refused', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: string;
  let acct: string;

  const newPending = async () => {
    const res = await http(app)
      .post('/api/submissions')
      .set('Cookie', sales)
      .send({ designer: 'Lifecycle', brand: `Lifecycle ${Date.now()}-${Math.random()}`, eventId: 'VFW-FW26', packageId: 'VFW-BRONZE' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    return res.body.id as string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
    acct = await loginCookie(app, 'accounting@vanfashionweek.com');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('cannot double-approve', async () => {
    const id = await newPending();

    const first = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('APPROVED');

    const second = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(second.status).toBe(400);
    expect(JSON.stringify(second.body.message)).toMatch(/pending/i);
  });

  it('cannot approve a rejected record', async () => {
    const id = await newPending();

    const rej = await http(app)
      .post(`/api/submissions/${id}/reject`)
      .set('Cookie', acct)
      .send({ reason: 'Pricing does not match approved rate card' });
    expect(rej.status).toBe(201);
    expect(rej.body.status).toBe('REJECTED');

    const approve = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(approve.status).toBe(400);
  });

  it('cannot approve something that was never submitted (a DRAFT)', async () => {
    // The API only ever creates PENDING records, so force one back to DRAFT to
    // model a submission that never reached Accounting.
    const id = await newPending();
    await prisma.submission.update({ where: { id }, data: { status: SubmissionStatus.DRAFT } });

    const approve = await http(app).post(`/api/submissions/${id}/approve`).set('Cookie', acct).send();
    expect(approve.status).toBe(400);
    expect(JSON.stringify(approve.body.message)).toMatch(/pending/i);
  });
});
