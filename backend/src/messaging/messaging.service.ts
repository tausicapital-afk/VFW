import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  AddParticipantsDto,
  AttachmentInputDto,
  CreateConversationDto,
  PresignAttachmentDto,
  SendMessageDto,
} from './dto';

/**
 * How long after sending a message its sender may still edit it.
 *
 * No existing numeric-window convention to follow: the closest analogue,
 * Payroll invoice editing (`payroll.service.ts` `editInvoice`/`approveInvoice`),
 * gates on *state* (unapproved vs. approved) rather than a clock. Chat has no
 * equivalent state machine — a message is just sent — so this picks a generous,
 * chat-appropriate window instead: long enough to fix a typo you notice a few
 * messages later, short enough that editing does not become a way to quietly
 * rewrite something other participants already read and reacted to.
 */
export const EDIT_WINDOW_MINUTES = 15;

// What the client needs about each participant to render a header and ticks.
const participantSelect = {
  id: true,
  userId: true,
  isAdmin: true,
  lastReadSeq: true,
  lastDeliveredSeq: true,
  user: {
    select: { id: true, name: true, role: true, colour: true, department: true, lastSeenAt: true },
  },
} satisfies Prisma.ConversationParticipantSelect;

const messageInclude = {
  sender: { select: { id: true, name: true, colour: true } },
  attachments: true,
  reactions: { select: { emoji: true, userId: true } },
} satisfies Prisma.MessageInclude;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // --- Membership: the security boundary -----------------------------------

  /**
   * A conversation you are not in is a conversation that, as far as you are
   * concerned, does not exist. Returns 404 (never 403) for a non-member, the
   * same answer the rest of the system gives for another rep's record — so this
   * endpoint cannot be used to probe for the existence of a chat.
   */
  private async assertMember(conversationId: string, userId: string) {
    const member = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) throw new NotFoundException('Conversation not found');
    return member;
  }

  private keyPrefix(conversationId: string) {
    return `messages/${conversationId}/`;
  }

  // --- Directory -----------------------------------------------------------

  /** Everyone you can start a chat with: active users other than yourself. */
  async listUsers(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { status: 'ACTIVE', id: { not: user.id } },
      select: { id: true, name: true, role: true, colour: true, department: true, lastSeenAt: true },
      orderBy: { name: 'asc' },
    });
  }

  // --- Conversations -------------------------------------------------------

  async listConversations(user: AuthUser) {
    const mine = await this.prisma.conversationParticipant.findMany({
      where: { userId: user.id },
      select: { conversationId: true },
    });
    const ids = mine.map((m) => m.conversationId);
    if (ids.length === 0) return [];

    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: ids } },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        participants: { select: participantSelect },
        messages: {
          orderBy: { seq: 'desc' },
          take: 1,
          include: messageInclude,
        },
      },
    });

    // Unread per conversation in one query rather than N counts: for each of my
    // participant rows, count messages past my read cursor that I did not send.
    const unreadRows = await this.prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT p."conversationId", COUNT(m.*)::int AS unread
      FROM "ConversationParticipant" p
      JOIN "Message" m
        ON m."conversationId" = p."conversationId"
       AND m.seq > p."lastReadSeq"
       AND m."senderId" <> p."userId"
       AND m."deletedAt" IS NULL
      WHERE p."userId" = ${user.id}
      GROUP BY p."conversationId"
    `;
    const unread = new Map(unreadRows.map((r) => [r.conversationId, r.unread]));

    return conversations.map((c) => ({
      ...c,
      lastMessage: c.messages[0] ?? null,
      messages: undefined,
      unreadCount: unread.get(c.id) ?? 0,
    }));
  }

  async getConversation(conversationId: string, user: AuthUser) {
    await this.assertMember(conversationId, user.id);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { select: participantSelect } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /**
   * Open or create a conversation. A DM is idempotent: the two userIds are
   * sorted into a `dmKey`, so a second attempt to open the same DM returns the
   * existing thread instead of forking a duplicate.
   */
  async createConversation(user: AuthUser, dto: CreateConversationDto) {
    const otherIds = [...new Set(dto.userIds)].filter((id) => id !== user.id);
    if (otherIds.length === 0) {
      throw new BadRequestException('A conversation needs at least one other person');
    }

    // Every named user must exist and be active — you cannot open a chat with a
    // disabled account or a fabricated id.
    const others = await this.prisma.user.findMany({
      where: { id: { in: otherIds }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (others.length !== otherIds.length) {
      throw new BadRequestException('One or more recipients are not valid, active users');
    }

    if (dto.kind === 'DM') {
      if (otherIds.length !== 1) {
        throw new BadRequestException('A DM is between exactly two people');
      }
      const dmKey = [user.id, otherIds[0]].sort().join(':');

      const existing = await this.prisma.conversation.findUnique({
        where: { dmKey },
        include: { participants: { select: participantSelect } },
      });
      if (existing) return { conversation: existing, created: false };

      try {
        const conversation = await this.prisma.conversation.create({
          data: {
            kind: 'DM',
            dmKey,
            createdById: user.id,
            participants: {
              create: [{ userId: user.id }, { userId: otherIds[0] }],
            },
          },
          include: { participants: { select: participantSelect } },
        });
        return { conversation, created: true };
      } catch (e) {
        // Lost a race to create the same DM — the unique dmKey caught it. Return
        // the thread the other request just made.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const conversation = await this.prisma.conversation.findUnique({
            where: { dmKey },
            include: { participants: { select: participantSelect } },
          });
          if (conversation) return { conversation, created: false };
        }
        throw e;
      }
    }

    // Group. The creator is the first admin; the named others join as members.
    const conversation = await this.prisma.conversation.create({
      data: {
        kind: 'GROUP',
        title: dto.title?.trim() || 'New group',
        createdById: user.id,
        participants: {
          create: [
            { userId: user.id, isAdmin: true },
            ...otherIds.map((id) => ({ userId: id })),
          ],
        },
      },
      include: { participants: { select: participantSelect } },
    });
    return { conversation, created: true };
  }

  // --- Messages ------------------------------------------------------------

  async listMessages(
    conversationId: string,
    user: AuthUser,
    opts: { before?: number; limit?: number },
  ) {
    await this.assertMember(conversationId, user.id);
    const limit = Math.min(opts.limit ?? 30, 100);

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(opts.before ? { seq: { lt: opts.before } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit,
      include: messageInclude,
    });

    // Fetched newest-first for the cursor; hand back oldest-first for rendering.
    return { messages: messages.reverse(), hasMore: messages.length === limit };
  }

  private validateAttachments(conversationId: string, attachments?: AttachmentInputDto[]) {
    for (const a of attachments ?? []) {
      if (!a.storageKey.startsWith(this.keyPrefix(conversationId))) {
        throw new BadRequestException('An attachment key does not belong to this conversation');
      }
    }
  }

  /**
   * Persist a message and advance the sender's own cursors (you have, by
   * definition, read what you just sent). Returns the message plus the ids of
   * everyone else, so the caller can fan it out and mark it delivered.
   */
  async sendMessage(conversationId: string, user: AuthUser, dto: SendMessageDto) {
    await this.assertMember(conversationId, user.id);

    const body = dto.body?.trim() || null;
    const attachments = dto.attachments ?? [];
    if (!body && attachments.length === 0) {
      throw new BadRequestException('A message must have text or an attachment');
    }
    this.validateAttachments(conversationId, dto.attachments);

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: user.id,
          body,
          attachments: attachments.length
            ? {
                create: attachments.map((a) => ({
                  storageKey: a.storageKey,
                  filename: a.filename,
                  contentType: a.contentType,
                  size: a.size,
                  width: a.width,
                  height: a.height,
                })),
              }
            : undefined,
        },
        include: messageInclude,
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      // The sender has read and been delivered their own message.
      await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: user.id },
        data: { lastReadSeq: created.seq, lastDeliveredSeq: created.seq },
      });

      return created;
    });

    const recipients = await this.prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: user.id } },
      select: { userId: true },
    });

    return { message, recipientIds: recipients.map((r) => r.userId) };
  }

  /** Load a message and confirm it belongs to the conversation the caller named. */
  private async findMessageIn(conversationId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) {
      throw new NotFoundException('Message not found');
    }
    return message;
  }

  /**
   * Edit your own message's text. Sender-only, no exceptions — not even an
   * admin may edit someone else's message, because this is chat, not a
   * moderated record; see EDIT_WINDOW_MINUTES for the time-limit rationale.
   */
  async editMessage(conversationId: string, messageId: string, user: AuthUser, body: string) {
    await this.assertMember(conversationId, user.id);
    const message = await this.findMessageIn(conversationId, messageId);

    if (message.senderId !== user.id) {
      throw new ForbiddenException('You can only edit your own message');
    }
    if (message.deletedAt) {
      throw new BadRequestException('A deleted message cannot be edited');
    }

    const ageMs = Date.now() - message.createdAt.getTime();
    if (ageMs > EDIT_WINDOW_MINUTES * 60_000) {
      throw new BadRequestException(
        `A message can only be edited within ${EDIT_WINDOW_MINUTES} minutes of sending`,
      );
    }

    const trimmed = body.trim();
    if (!trimmed) throw new BadRequestException('An edited message needs text');

    return this.prisma.message.update({
      where: { id: messageId },
      data: { body: trimmed, editedAt: new Date() },
      include: messageInclude,
    });
  }

  /**
   * Soft-delete your own message. Sender-only, same rule as edit. The row
   * stays (so the thread keeps its tombstone — "This message was deleted" — in
   * place rather than leaving a gap in `seq`), but the body and any
   * attachments/reactions are scrubbed so the content itself does not linger
   * in the database or go back over the wire to other participants.
   */
  async deleteMessage(conversationId: string, messageId: string, user: AuthUser) {
    await this.assertMember(conversationId, user.id);
    const message = await this.findMessageIn(conversationId, messageId);

    if (message.senderId !== user.id) {
      throw new ForbiddenException('You can only delete your own message');
    }
    if (message.deletedAt) {
      // Idempotent: deleting an already-deleted message just returns it.
      return this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.messageAttachment.deleteMany({ where: { messageId } });
      await tx.messageReaction.deleteMany({ where: { messageId } });
      return tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), body: null },
        include: messageInclude,
      });
    });
  }

  // --- Reactions -------------------------------------------------------------

  /**
   * Add (or, if it already exists, no-op) one of your reactions to a message.
   * `upsert` on the (messageId, userId, emoji) unique constraint makes a
   * double-click idempotent rather than a 500 from a duplicate-key error.
   */
  async addReaction(conversationId: string, messageId: string, user: AuthUser, emoji: string) {
    await this.assertMember(conversationId, user.id);
    const message = await this.findMessageIn(conversationId, messageId);
    if (message.deletedAt) throw new BadRequestException('Cannot react to a deleted message');

    await this.prisma.messageReaction.upsert({
      where: { messageId_userId_emoji: { messageId, userId: user.id, emoji } },
      update: {},
      create: { messageId, userId: user.id, emoji },
    });
    return this.reactionsFor(messageId);
  }

  /** Remove your own reaction — "toggling off" is just deleting this row. */
  async removeReaction(conversationId: string, messageId: string, user: AuthUser, emoji: string) {
    await this.assertMember(conversationId, user.id);
    await this.findMessageIn(conversationId, messageId);

    await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId: user.id, emoji },
    });
    return this.reactionsFor(messageId);
  }

  private async reactionsFor(messageId: string) {
    return this.prisma.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
    });
  }

  // --- Search ------------------------------------------------------------

  /**
   * Search message bodies. Scoped to the caller's own conversations only — the
   * `in: myConvIds` clause is drawn either from an explicit, membership-checked
   * `conversationId` or from `conversationIdsFor(user.id)`, so a search can
   * never surface a message from a conversation the caller isn't in. Plain
   * `contains`/`insensitive` (Prisma's ILIKE), matching the convention already
   * used by contacts search (`contacts.service.ts`); message volume in an
   * internal chat tool does not justify a search index (tsvector/etc. — not
   * used anywhere else in this codebase either).
   */
  async searchMessages(user: AuthUser, q: string, conversationId?: string) {
    const term = q.trim();
    if (!term) return [];

    let convIds: string[];
    if (conversationId) {
      await this.assertMember(conversationId, user.id);
      convIds = [conversationId];
    } else {
      convIds = await this.conversationIdsFor(user.id);
    }
    if (convIds.length === 0) return [];

    return this.prisma.message.findMany({
      where: {
        conversationId: { in: convIds },
        deletedAt: null,
        body: { contains: term, mode: 'insensitive' },
      },
      orderBy: { seq: 'desc' },
      take: 50,
      include: messageInclude,
    });
  }

  // --- Receipts ------------------------------------------------------------

  /** Raise a participant's read cursor (and delivered, since read implies it). */
  async markRead(conversationId: string, userId: string, seq?: number) {
    await this.assertMember(conversationId, userId);
    const target =
      seq ??
      (await this.prisma.message.aggregate({
        where: { conversationId },
        _max: { seq: true },
      }))._max.seq ??
      0;

    // GREATEST so a stale/out-of-order client cannot move a cursor backwards.
    await this.prisma.$executeRaw`
      UPDATE "ConversationParticipant"
      SET "lastReadSeq" = GREATEST("lastReadSeq", ${target}),
          "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${target})
      WHERE "conversationId" = ${conversationId} AND "userId" = ${userId}
    `;
    return this.cursor(conversationId, userId);
  }

  /** Raise a participant's delivered cursor. */
  async markDelivered(conversationId: string, userId: string, seq: number) {
    await this.prisma.$executeRaw`
      UPDATE "ConversationParticipant"
      SET "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${seq})
      WHERE "conversationId" = ${conversationId} AND "userId" = ${userId}
    `;
    return this.cursor(conversationId, userId);
  }

  /**
   * Raise the delivered cursor for many participants of one conversation in a
   * single statement, then return each one's receipt. Used when a message is
   * fanned out: every online recipient is marked delivered at once instead of
   * one round-trip apiece. GREATEST keeps a cursor from ever moving backwards.
   */
  async markDeliveredForRecipients(conversationId: string, userIds: string[], seq: number) {
    if (userIds.length === 0) return [];
    await this.prisma.$executeRaw`
      UPDATE "ConversationParticipant"
      SET "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${seq})
      WHERE "conversationId" = ${conversationId}
        AND "userId" IN (${Prisma.join(userIds)})
    `;
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { in: userIds } },
      select: { userId: true, lastReadSeq: true, lastDeliveredSeq: true },
    });
    return rows.map((r) => ({
      conversationId,
      userId: r.userId,
      lastReadSeq: r.lastReadSeq,
      lastDeliveredSeq: r.lastDeliveredSeq,
    }));
  }

  /**
   * When a user comes online, everything already waiting for them is now
   * "delivered". Bumps their delivered cursor to the latest message in every
   * conversation and returns the ones that actually moved, so the caller can
   * emit receipts to the senders.
   */
  async markAllDelivered(userId: string) {
    return this.prisma.$queryRaw<
      { conversationId: string; lastDeliveredSeq: number }[]
    >`
      UPDATE "ConversationParticipant" p
      SET "lastDeliveredSeq" = sub.maxseq
      FROM (
        SELECT "conversationId", MAX(seq) AS maxseq FROM "Message" GROUP BY "conversationId"
      ) sub
      WHERE p."conversationId" = sub."conversationId"
        AND p."userId" = ${userId}
        AND p."lastDeliveredSeq" < sub.maxseq
      RETURNING p."conversationId" AS "conversationId", p."lastDeliveredSeq" AS "lastDeliveredSeq"
    `;
  }

  private async cursor(conversationId: string, userId: string) {
    const p = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { lastReadSeq: true, lastDeliveredSeq: true },
    });
    return {
      conversationId,
      userId,
      lastReadSeq: p?.lastReadSeq ?? 0,
      lastDeliveredSeq: p?.lastDeliveredSeq ?? 0,
    };
  }

  /** The userIds of everyone in a conversation — used to target WS rooms. */
  async participantIds(conversationId: string) {
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Every conversation a user belongs to — used to join their WS rooms. */
  async conversationIdsFor(userId: string) {
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    return rows.map((r) => r.conversationId);
  }

  /** Distinct co-participants — who should hear about this user's presence. */
  async coParticipantIds(userId: string) {
    const rows = await this.prisma.$queryRaw<{ userId: string }[]>`
      SELECT DISTINCT other."userId"
      FROM "ConversationParticipant" mine
      JOIN "ConversationParticipant" other
        ON other."conversationId" = mine."conversationId" AND other."userId" <> mine."userId"
      WHERE mine."userId" = ${userId}
    `;
    return rows.map((r) => r.userId);
  }

  async setLastSeen(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  }

  /**
   * A short human label for a conversation from one user's point of view — the
   * other person's name for a DM, the title for a group. Used only to write the
   * activity-log line ("Messaged Jane Doe"); no message content is involved.
   */
  async conversationLabel(conversationId: string, forUserId: string): Promise<string> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        kind: true,
        title: true,
        participants: { select: { userId: true, user: { select: { name: true } } } },
      },
    });
    if (!conv) return 'a conversation';
    if (conv.kind === 'GROUP') return conv.title ?? 'a group';
    const other = conv.participants.find((p) => p.userId !== forUserId);
    return other?.user.name ?? 'someone';
  }

  // --- Media ---------------------------------------------------------------

  async presignAttachment(conversationId: string, user: AuthUser, dto: PresignAttachmentDto) {
    await this.assertMember(conversationId, user.id);
    const safeName = dto.filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
    const storageKey = `${this.keyPrefix(conversationId)}${randomUUID()}-${safeName}`;
    const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType);
    return { uploadUrl, storageKey, method: 'PUT' as const, headers: { 'Content-Type': dto.contentType } };
  }

  async attachmentUrl(attachmentId: string, user: AuthUser) {
    const attachment = await this.prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
      include: { message: { select: { conversationId: true } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    await this.assertMember(attachment.message.conversationId, user.id);

    const inline = IMAGE_TYPES.has(attachment.contentType) || attachment.contentType === 'application/pdf';
    const url = await this.storage.presignDownload(attachment.storageKey, attachment.filename, inline);
    return { url, filename: attachment.filename, contentType: attachment.contentType };
  }

  // --- Group management ----------------------------------------------------

  private async assertGroupAdmin(conversationId: string, user: AuthUser) {
    const member = await this.assertMember(conversationId, user.id);
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { kind: true },
    });
    if (conv?.kind !== 'GROUP') throw new BadRequestException('Not a group conversation');
    if (!member.isAdmin) throw new ForbiddenException('Only a group admin can do that');
    return member;
  }

  async rename(conversationId: string, user: AuthUser, title: string) {
    await this.assertGroupAdmin(conversationId, user);
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { title: title.trim() },
      include: { participants: { select: participantSelect } },
    });
  }

  async addParticipants(conversationId: string, user: AuthUser, dto: AddParticipantsDto) {
    await this.assertGroupAdmin(conversationId, user);
    const existing = await this.participantIds(conversationId);
    const toAdd = [...new Set(dto.userIds)].filter((id) => !existing.includes(id));

    if (toAdd.length) {
      const valid = await this.prisma.user.findMany({
        where: { id: { in: toAdd }, status: 'ACTIVE' },
        select: { id: true },
      });
      if (valid.length !== toAdd.length) {
        throw new BadRequestException('One or more users are not valid, active accounts');
      }
      await this.prisma.conversationParticipant.createMany({
        data: toAdd.map((id) => ({ conversationId, userId: id })),
        skipDuplicates: true,
      });
    }

    return {
      conversation: await this.getConversation(conversationId, user),
      addedIds: toAdd,
    };
  }

  /**
   * Remove someone from a group. An admin can remove anyone; anyone can remove
   * themselves (leave). A DM cannot be left — there is nothing to administer.
   */
  async removeParticipant(conversationId: string, user: AuthUser, targetUserId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { kind: true },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.kind !== 'GROUP') throw new BadRequestException('A DM cannot be left');

    const me = await this.assertMember(conversationId, user.id);
    const leaving = targetUserId === user.id;
    if (!leaving && !me.isAdmin) {
      throw new ForbiddenException('Only a group admin can remove someone');
    }

    await this.prisma.conversationParticipant.deleteMany({
      where: { conversationId, userId: targetUserId },
    });
    return { conversationId, removedUserId: targetUserId };
  }
}
