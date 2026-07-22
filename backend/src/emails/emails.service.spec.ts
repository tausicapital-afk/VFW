import { NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/auth.guard';
import { EmailsService } from './emails.service';

/**
 * The two properties that matter here, both silent when broken:
 *
 *  - Row scoping. A rep must see only mail they triggered; a viewAll role sees
 *    the whole log. The scope lives in the WHERE, so a leak would just quietly
 *    widen someone's list — nothing errors.
 *  - Invoice send reuses the ONE PDF (SubmissionsService.invoicePdf), attaches
 *    it, tags the send INVOICE + attributes it, and audits it.
 */

const acct: AuthUser = { id: 'u-acct', email: 'a@x.com', name: 'A', role: 'ACCT' };
const rep: AuthUser = { id: 'u-rep', email: 'r@x.com', name: 'R', role: 'SALES' };

function make() {
  const prisma = {
    emailMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const email = {
    invoiceEmail: jest.fn().mockReturnValue({ __mail: true }),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const submissions = {
    invoicePdf: jest.fn().mockResolvedValue({ buffer: Buffer.from('%PDF'), filename: 'VFW-1042.pdf' }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new EmailsService(prisma as any, email as any, submissions as any, audit as any);
  return { svc, prisma, email, submissions, audit };
}

describe('EmailsService', () => {
  it('scopes a non-viewAll role to their own triggered mail', async () => {
    const { svc, prisma } = make();
    await svc.list(rep, {});
    const arg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(arg.where.triggeredById).toBe('u-rep');
  });

  it('lets a viewAll role see the whole log, honouring filters', async () => {
    const { svc, prisma } = make();
    await svc.list(acct, { direction: 'OUTBOUND', kind: 'INVOICE' });
    const arg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(arg.where.triggeredById).toBeUndefined();
    expect(arg.where.direction).toBe('OUTBOUND');
    expect(arg.where.kind).toBe('INVOICE');
  });

  it('404s (not 403s) an email outside the caller scope', async () => {
    const { svc, prisma } = make();
    await expect(svc.get('e1', rep)).rejects.toBeInstanceOf(NotFoundException);
    const arg = prisma.emailMessage.findFirst.mock.calls[0][0];
    expect(arg.where).toMatchObject({ id: 'e1', triggeredById: 'u-rep' });
  });

  it('sends the invoice PDF as an INVOICE attachment and audits it', async () => {
    const { svc, email, submissions, audit } = make();
    const res = await svc.sendInvoice(
      { submissionId: 's1', to: 'maison@example.com', subject: 'Invoice VFW-1042', message: 'Hi there' },
      acct,
    );

    // The PDF comes from the submission service under the caller's own scope.
    expect(submissions.invoicePdf).toHaveBeenCalledWith('s1', acct);
    expect(email.invoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'maison@example.com',
        invoiceNo: 'VFW-1042',
        submissionId: 's1',
        triggeredById: 'u-acct',
        pdf: expect.any(Buffer),
      }),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INVOICE_EMAILED', submissionId: 's1' }),
    );
    expect(res).toEqual({ ok: true, invoiceNo: 'VFW-1042', to: 'maison@example.com' });
  });
});
