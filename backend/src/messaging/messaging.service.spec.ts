import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagingService } from './messaging.service';

// A hand-rolled Prisma mock — only the delegate methods each test touches. This
// keeps the tests on the branching logic (membership, DM dedupe, group admin),
// not on the raw SQL, which is exercised live in the e2e check.
function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    conversationParticipant: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    conversation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
  const storage: any = { presignUpload: jest.fn(), presignDownload: jest.fn() };
  return { service: new MessagingService(prisma, storage), prisma };
}

const me = { id: 'me', email: 'me@x', name: 'Me', role: 'SALES' as const };

describe('membership boundary', () => {
  it('returns 404 (not 403) when a non-member opens a conversation', async () => {
    const { service, prisma } = makeService();
    prisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(service.getConversation('c1', me)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a non-member cannot send a message', async () => {
    const { service, prisma } = makeService();
    prisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(service.sendMessage('c1', me, { body: 'hi' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('createConversation — DM dedupe', () => {
  it('reuses the existing thread for the same pair instead of forking a duplicate', async () => {
    const existing = { id: 'dm1', kind: 'DM', participants: [] };
    const { service, prisma } = makeService();
    prisma.user.findMany.mockResolvedValue([{ id: 'other' }]); // recipient is active
    prisma.conversation.findUnique.mockResolvedValue(existing); // found by dmKey

    const res = await service.createConversation(me, { kind: 'DM', userIds: ['other'] });

    expect(res.created).toBe(false);
    expect(res.conversation).toBe(existing);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('rejects a DM to an inactive or unknown user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findMany.mockResolvedValue([]); // no active match
    await expect(
      service.createConversation(me, { kind: 'DM', userIds: ['ghost'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a DM naming more than one other person', async () => {
    const { service, prisma } = makeService();
    prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(
      service.createConversation(me, { kind: 'DM', userIds: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('markDeliveredForRecipients — batched fan-out', () => {
  it('no-ops for an empty recipient set, touching no database', async () => {
    const { service, prisma } = makeService({ $executeRaw: jest.fn() });
    const res = await service.markDeliveredForRecipients('c1', [], 5);
    expect(res).toEqual([]);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('advances every recipient in one statement and returns their receipts', async () => {
    const { service, prisma } = makeService({ $executeRaw: jest.fn().mockResolvedValue(1) });
    prisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'a', lastReadSeq: 0, lastDeliveredSeq: 5 },
      { userId: 'b', lastReadSeq: 2, lastDeliveredSeq: 5 },
    ]);

    const res = await service.markDeliveredForRecipients('c1', ['a', 'b'], 5);

    // One write for the whole set, not one per recipient.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(res).toEqual([
      { conversationId: 'c1', userId: 'a', lastReadSeq: 0, lastDeliveredSeq: 5 },
      { conversationId: 'c1', userId: 'b', lastReadSeq: 2, lastDeliveredSeq: 5 },
    ]);
  });
});

describe('group administration', () => {
  it('a non-admin cannot rename a group', async () => {
    const { service, prisma } = makeService();
    prisma.conversationParticipant.findUnique.mockResolvedValue({ isAdmin: false });
    prisma.conversation.findUnique.mockResolvedValue({ kind: 'GROUP' });
    await expect(service.rename('g1', me, 'New name')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a non-admin cannot remove someone else, but can remove themselves (leave)', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findUnique.mockResolvedValue({ kind: 'GROUP' });
    prisma.conversationParticipant.findUnique.mockResolvedValue({ isAdmin: false });

    await expect(service.removeParticipant('g1', me, 'someoneElse')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // Leaving is allowed and deletes the caller's own membership row.
    await expect(service.removeParticipant('g1', me, me.id)).resolves.toEqual({
      conversationId: 'g1',
      removedUserId: me.id,
    });
    expect(prisma.conversationParticipant.deleteMany).toHaveBeenCalled();
  });

  it('a DM cannot be left', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findUnique.mockResolvedValue({ kind: 'DM' });
    await expect(service.removeParticipant('dm1', me, me.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
