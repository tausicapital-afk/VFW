import { ActivityService } from './activity.service';

// A hand-rolled Prisma mock — only the delegate methods each test touches, the
// same approach as messaging.service.spec.ts. These tests are about the session
// bookkeeping (duration maths, the race fallback, idempotency, the boot sweep),
// not the SQL, which the e2e check exercises live.
function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    userSession: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(),
    },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    user: { update: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
  return { service: new ActivityService(prisma), prisma };
}

describe('closeSession', () => {
  it('closes a session by id, stamping its duration and a DISCONNECT event', async () => {
    const { service, prisma } = makeService();
    const startedAt = new Date(Date.now() - 90_000); // ~90s ago
    prisma.userSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', startedAt, endedAt: null,
    });

    await service.closeSession('u1', 'Ann', 's1');

    expect(prisma.userSession.update).toHaveBeenCalledTimes(1);
    const arg = prisma.userSession.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 's1' });
    expect(arg.data.endedAt).toBeInstanceOf(Date);
    // Allow a second of scheduling slack around the ~90s span.
    expect(arg.data.durationSec).toBeGreaterThanOrEqual(90);
    expect(arg.data.durationSec).toBeLessThanOrEqual(92);

    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.activityLog.create.mock.calls[0][0].data.action).toBe('DISCONNECT');
  });

  it("falls back to the user's open session when no id was remembered (the race)", async () => {
    const { service, prisma } = makeService();
    prisma.userSession.findFirst.mockResolvedValue({
      id: 's2', userId: 'u1', startedAt: new Date(Date.now() - 10_000), endedAt: null,
    });

    await service.closeSession('u1', 'Ann');

    expect(prisma.userSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.userSession.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    expect(prisma.userSession.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an already-closed session (idempotent)', async () => {
    const { service, prisma } = makeService();
    prisma.userSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', startedAt: new Date(), endedAt: new Date(),
    });

    await service.closeSession('u1', 'Ann', 's1');

    expect(prisma.userSession.update).not.toHaveBeenCalled();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it('ignores a session id that belongs to a different user', async () => {
    const { service, prisma } = makeService();
    prisma.userSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'someoneElse', startedAt: new Date(), endedAt: null,
    });

    await service.closeSession('u1', 'Ann', 's1');

    expect(prisma.userSession.update).not.toHaveBeenCalled();
  });
});

describe('closeOrphanedSessions', () => {
  it('closes every still-open session and returns the count', async () => {
    const { service, prisma } = makeService({
      userSession: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    });

    const n = await service.closeOrphanedSessions();

    expect(n).toBe(3);
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { endedAt: null },
      data: { endedAt: expect.any(Date) },
    });
  });
});
