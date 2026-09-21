import { RemindersService } from './reminders.service';

/**
 * Both jobs read straight from ReportsService's own queries (mocked here, not
 * re-derived) and both must never re-send inside their cooldown window. The
 * two properties this file exists to pin down:
 *
 *  - A row with nothing due (not overdue / not lapsed relative to its own
 *    pattern / no email on file) never reaches EmailService.send.
 *  - A row that WOULD be reminded is skipped when the Emails log already shows
 *    a matching send inside the cooldown, and goes out when the log is clear
 *    (or the earlier send has aged out of the window).
 */

function make() {
  const prisma = {
    emailMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const reports = {
    receivablesRows: jest.fn().mockResolvedValue([]),
    retentionRows: jest.fn().mockResolvedValue([]),
  };
  const email = {
    paymentReminder: jest.fn().mockReturnValue({ __mail: 'reminder' }),
    renewalNudge: jest.fn().mockReturnValue({ __mail: 'nudge' }),
    send: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new RemindersService(prisma as any, reports as any, email as any);
  return { svc, prisma, reports, email };
}

const overdueRow = {
  submissionId: 'sub-1',
  ref: 'VFW-1001',
  contactId: 'c1',
  brand: 'Maison A',
  contactEmail: 'maison-a@example.com',
  due: new Date('2026-08-01'),
  daysToDue: -10,
  total: 1000,
  paid: 200,
  balance: 800,
  currency: 'CAD',
};

const retentionRow = {
  contactId: 'c1',
  brand: 'Maison A',
  contactEmail: 'maison-a@example.com',
  bookings: 3,
  net: 5000,
  repId: 'rep-1',
  repName: 'Riley Rep',
  repEmail: 'riley@example.com',
  // 200-day average gap (600 days across 3 bookings → 2 gaps of 300... use
  // simple even spread so the math in the test is easy to eyeball).
  firstBooking: new Date(Date.now() - 600 * 86_400_000),
  lastBooking: new Date(Date.now() - 600 * 86_400_000 + 2 * 300 * 86_400_000), // = now
};

describe('RemindersService — overdue payment reminder', () => {
  it('sends nothing for a submission that is not yet past its due date', async () => {
    const { svc, reports, email } = make();
    reports.receivablesRows.mockResolvedValue([{ ...overdueRow, daysToDue: 5 }]);

    await svc.overduePaymentReminders();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the contact has no email on file', async () => {
    const { svc, reports, email } = make();
    reports.receivablesRows.mockResolvedValue([{ ...overdueRow, contactEmail: null }]);

    await svc.overduePaymentReminders();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('reminds an overdue, unremembered submission exactly once', async () => {
    const { svc, prisma, reports, email } = make();
    reports.receivablesRows.mockResolvedValue([overdueRow]);
    prisma.emailMessage.findFirst.mockResolvedValue(null); // no prior reminder

    await svc.overduePaymentReminders();

    expect(email.paymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'maison-a@example.com',
        submissionId: 'sub-1',
        ref: 'VFW-1001',
        daysOverdue: 10,
      }),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    // The de-dupe check is keyed on this submission specifically.
    expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ submissionId: 'sub-1', kind: 'OTHER' }),
      }),
    );
  });

  it('does not re-send when a reminder already went out for this invoice inside the cooldown', async () => {
    const { svc, prisma, reports, email } = make();
    reports.receivablesRows.mockResolvedValue([overdueRow]);
    prisma.emailMessage.findFirst.mockResolvedValue({ id: 'already-sent' });

    await svc.overduePaymentReminders();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('keeps going when one submission fails, so one bad row cannot block the rest', async () => {
    const { svc, prisma, reports, email } = make();
    reports.receivablesRows.mockResolvedValue([
      overdueRow,
      { ...overdueRow, submissionId: 'sub-2', ref: 'VFW-1002' },
    ]);
    prisma.emailMessage.findFirst
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(null);

    await svc.overduePaymentReminders();

    expect(email.send).toHaveBeenCalledTimes(1);
  });
});

describe('RemindersService — renewal nudge', () => {
  it('nudges nobody for a contact with only one booking (no pattern to compare against)', async () => {
    const { svc, reports, email } = make();
    reports.retentionRows.mockResolvedValue([{ ...retentionRow, bookings: 1 }]);

    await svc.renewalNudges();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('nudges nobody for a contact still within their usual booking cadence', async () => {
    const { svc, reports, email } = make();
    // Last booking yesterday — nowhere near "overdue" relative to any cadence.
    reports.retentionRows.mockResolvedValue([
      { ...retentionRow, lastBooking: new Date(Date.now() - 1 * 86_400_000) },
    ]);

    await svc.renewalNudges();

    expect(email.send).not.toHaveBeenCalled();
  });

  it('nudges the rep once for a contact that has gone well past its own cadence', async () => {
    const { svc, reports, email } = make();
    // Average historical gap ~120 days; nothing booked for 400 days since.
    const firstBooking = new Date(Date.now() - 640 * 86_400_000);
    const lastBooking = new Date(Date.now() - 400 * 86_400_000);
    reports.retentionRows.mockResolvedValue([
      { ...retentionRow, bookings: 3, firstBooking, lastBooking },
    ]);

    await svc.renewalNudges();

    expect(email.renewalNudge).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'riley@example.com', brand: 'Maison A', bookings: 3 }),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('does not re-nudge the same rep about the same contact inside the cooldown', async () => {
    const { svc, prisma, reports, email } = make();
    const firstBooking = new Date(Date.now() - 640 * 86_400_000);
    const lastBooking = new Date(Date.now() - 400 * 86_400_000);
    reports.retentionRows.mockResolvedValue([
      { ...retentionRow, bookings: 3, firstBooking, lastBooking },
    ]);
    prisma.emailMessage.findFirst.mockResolvedValue({ id: 'already-nudged' });

    await svc.renewalNudges();

    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ toAddress: 'riley@example.com', kind: 'OTHER' }),
      }),
    );
  });
});
