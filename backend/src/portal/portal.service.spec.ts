import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/auth.guard';
import { EmailNotConfiguredError } from '../common/email';
import { PortalService } from './portal.service';

/**
 * Unit-level coverage for the parts of PortalService that do not need a real
 * database or mail transport — same style as EmailsService's own spec
 * (mocked Prisma/Email/Audit, constructed directly). The token-lifecycle and
 * cross-contact leak behaviour that DOES need a real database lives in
 * portal.spec.ts, driven through the real HTTP surface.
 */

const acct: AuthUser = { id: 'u-acct', email: 'a@x.com', name: 'A', role: 'ACCT' };

function make() {
  const prisma = {
    contact: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    contactPortalToken: {
      create: jest.fn().mockResolvedValue(undefined),
      findFirst: jest.fn(),
    },
    submission: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  const email = {
    configured: true,
    portalLink: jest.fn().mockReturnValue({ __mail: true }),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const submissions = { invoicePdfForPortal: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PortalService(prisma as any, email as any, audit as any, submissions as any);
  return { svc, prisma, email, audit, submissions };
}

describe('PortalService.sendLink', () => {
  it('mints a token, emails it to the contact, and audits the send', async () => {
    const { svc, prisma, email, audit } = make();
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      brand: 'Maison X',
      designer: 'Jamie Lee',
      email: 'jamie@maisonx.example',
    });

    const res = await svc.sendLink('c1', acct);

    expect(res).toEqual({ ok: true, to: 'jamie@maisonx.example' });
    expect(prisma.contactPortalToken.create).toHaveBeenCalledTimes(1);
    const created = prisma.contactPortalToken.create.mock.calls[0][0].data;
    expect(created.contactId).toBe('c1');
    // A cryptographically sized bearer token, matching PasswordReset's
    // randomBytes(32).toString('hex') — 32 bytes is 64 hex characters.
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(email.portalLink).toHaveBeenCalledWith(
      'jamie@maisonx.example',
      'Jamie Lee',
      created.token,
      expect.any(Number),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PORTAL_LINK_SENT', actorId: 'u-acct' }),
      expect.anything(),
    );
  });

  it('404s a contact that does not exist', async () => {
    const { svc, prisma } = make();
    prisma.contact.findUnique.mockResolvedValue(null);
    await expect(svc.sendLink('no-such', acct)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a contact with no email on file, before touching the mail transport', async () => {
    const { svc, prisma, email } = make();
    prisma.contact.findUnique.mockResolvedValue({ id: 'c2', brand: 'B', designer: 'D', email: null });
    await expect(svc.sendLink('c2', acct)).rejects.toBeInstanceOf(BadRequestException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('fails loudly when no mail transport is configured, like every other outbound send', async () => {
    const { svc, prisma, email } = make();
    email.configured = false;
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c3', brand: 'B', designer: 'D', email: 'd@example.com',
    });
    await expect(svc.sendLink('c3', acct)).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });
});

describe('PortalService.getPortalData', () => {
  it('returns the exact allowlisted fields for each submission — nothing more', async () => {
    const { svc, prisma } = make();
    prisma.contactPortalToken.findFirst.mockResolvedValue({ contactId: 'c1' });
    prisma.contact.findUniqueOrThrow.mockResolvedValue({
      brand: 'Maison X', designer: 'Jamie Lee', company: 'Maison X Ltd',
    });
    prisma.submission.findMany.mockResolvedValue([
      {
        id: 's1', ref: 'VFW-0001', status: 'APPROVED', currency: 'USD',
        total: { toFixed: () => '1000.00' },
        paidAmount: { toFixed: () => '500.00' },
        balance: { toFixed: () => '500.00' },
        payStatus: 'PARTIAL', invoiceNo: 'VFW-2041',
        showDate: null, createdAt: new Date('2026-01-01'),
        event: { name: 'Vancouver Fashion Week' },
        package: { name: 'Bronze Package' },
        packageNameOverride: null,
      },
    ]);

    const data = await svc.getPortalData('tok');

    // The row scope passed to Prisma: this contact only, voided sales excluded.
    const where = prisma.submission.findMany.mock.calls[0][0].where;
    expect(where.contactId).toBe('c1');
    expect(where.status).toEqual({ not: 'VOIDED' });

    expect(data.contact).toEqual({ brand: 'Maison X', designer: 'Jamie Lee', company: 'Maison X Ltd' });
    expect(data.submissions).toHaveLength(1);
    expect(Object.keys(data.submissions[0]).sort()).toEqual(
      [
        'id', 'ref', 'status', 'currency', 'total', 'paidAmount', 'balance',
        'payStatus', 'invoiceNo', 'event', 'package', 'showDate', 'createdAt',
      ].sort(),
    );
    expect(data.submissions[0]).toMatchObject({
      id: 's1', ref: 'VFW-0001', total: '1000.00', paidAmount: '500.00', balance: '500.00',
      event: 'Vancouver Fashion Week', package: 'Bronze Package',
    });
  });

  it('gives the exact same "invalid or expired" error for a token that never existed', async () => {
    const { svc, prisma } = make();
    prisma.contactPortalToken.findFirst.mockResolvedValue(null);
    await expect(svc.getPortalData('does-not-exist')).rejects.toThrow(
      'This link is invalid or has expired.',
    );
  });
});
