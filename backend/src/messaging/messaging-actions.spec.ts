import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Edit, delete, reactions, search — the "Deferred" follow-ups from the
 * original messaging build (docs/addon-features.md). Integration-style, like
 * payroll.spec.ts, because the thing that matters most here is a real
 * boundary the mocked unit tests in messaging.service.spec.ts don't exercise:
 * the Postgres unique constraint on a reaction, and — the one this whole
 * batch turns on — that a soft-deleted message's content is actually gone
 * from every read path, not just the one the scoping doc happened to find.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com'; // the sender in most cases
const OTHER = 'diego@vanfashionweek.com'; // a fellow member who is never the sender
const THIRD = 'priya@vanfashionweek.com'; // used only to build a conversation SALES is not in

describe('messaging — edit, delete, reactions, search', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminCookie: string;
  let salesCookie: string;
  let otherCookie: string;
  let thirdCookie: string;
  let adminId: string;
  let salesId: string;
  let otherId: string;
  let thirdId: string;
  let groupId: string;
  const convoLitter: string[] = [];

  const openDm = async (cookie: string, userId: string) => {
    const res = await http(app)
      .post('/api/messaging/conversations')
      .set('Cookie', cookie)
      .send({ kind: 'DM', userIds: [userId] })
      .expect(201);
    convoLitter.push(res.body.conversation.id);
    return res.body.conversation.id as string;
  };

  const send = async (cookie: string, conversationId: string, body: string) => {
    const res = await http(app)
      .post(`/api/messaging/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .send({ body })
      .expect(201);
    return res.body as { id: string; body: string | null };
  };

  const messagesIn = async (cookie: string, conversationId: string) => {
    const res = await http(app)
      .get(`/api/messaging/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body.messages as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    adminCookie = await loginCookie(app, ADMIN);
    salesCookie = await loginCookie(app, SALES);
    otherCookie = await loginCookie(app, OTHER);
    thirdCookie = await loginCookie(app, THIRD);
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } })).id;
    salesId = (await prisma.user.findUniqueOrThrow({ where: { email: SALES } })).id;
    otherId = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER } })).id;
    thirdId = (await prisma.user.findUniqueOrThrow({ where: { email: THIRD } })).id;

    // A group with all three of admin/sales/other so a "member but not sender"
    // check lands on the 403 sender-only rule, not the 404 membership boundary.
    const res = await http(app)
      .post('/api/messaging/conversations')
      .set('Cookie', salesCookie)
      .send({ kind: 'GROUP', userIds: [otherId, adminId], title: 'edit/delete/react spec' })
      .expect(201);
    groupId = res.body.conversation.id;
    convoLitter.push(groupId);
  });

  afterAll(async () => {
    if (convoLitter.length) {
      await prisma.conversation.deleteMany({ where: { id: { in: [...new Set(convoLitter)] } } });
    }
    await app.close();
  });

  // --- Edit ------------------------------------------------------------------

  describe('edit', () => {
    it('the sender can edit their own message within the edit window', async () => {
      const msg = await send(salesCookie, groupId, 'Oops tpyo');
      const res = await http(app)
        .patch(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', salesCookie)
        .send({ body: 'Oops typo, fixed' })
        .expect(200);
      expect(res.body.body).toBe('Oops typo, fixed');
      expect(res.body.editedAt).toBeTruthy();
    });

    it('a fellow member cannot edit someone else\'s message — not even ADMIN', async () => {
      const msg = await send(salesCookie, groupId, 'mine only');
      await http(app)
        .patch(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', otherCookie)
        .send({ body: 'hacked by other' })
        .expect(403);
      await http(app)
        .patch(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', adminCookie)
        .send({ body: 'hacked by admin' })
        .expect(403);

      const stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id);
      expect(stored?.body).toBe('mine only');
      expect(stored?.editedAt).toBeFalsy();
    });

    it('rejects an edit once the edit window has passed', async () => {
      const msg = await send(salesCookie, groupId, 'old message');
      await prisma.message.update({
        where: { id: msg.id },
        data: { createdAt: new Date(Date.now() - 20 * 60_000) }, // 20 minutes ago
      });
      await http(app)
        .patch(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', salesCookie)
        .send({ body: 'too late now' })
        .expect(400);
    });

    it('rejects an edit that would leave the message blank', async () => {
      const msg = await send(salesCookie, groupId, 'has text');
      await http(app)
        .patch(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', salesCookie)
        .send({ body: '   ' })
        .expect(400);
    });
  });

  // --- Delete ------------------------------------------------------------------

  describe('delete', () => {
    it('a fellow member cannot delete someone else\'s message — not even ADMIN', async () => {
      const msg = await send(salesCookie, groupId, 'do not delete me');
      await http(app)
        .delete(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', otherCookie)
        .expect(403);
      await http(app)
        .delete(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', adminCookie)
        .expect(403);

      const stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id);
      expect(stored?.deletedAt).toBeFalsy();
    });

    it('the sender can delete their own message, and it becomes a tombstone — content gone from every read', async () => {
      const marker = `DELMARK${Date.now()}`;
      const msg = await send(salesCookie, groupId, `secret ${marker} text`);

      const delRes = await http(app)
        .delete(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', salesCookie)
        .expect(200);
      expect(delRes.body.deletedAt).toBeTruthy();
      expect(delRes.body.body).toBeNull();

      // 1) The thread-history read path: the row survives (tombstone), but its
      //    content does not.
      const stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id);
      expect(stored).toBeTruthy();
      expect(stored?.deletedAt).toBeTruthy();
      expect(stored?.body).toBeNull();

      // 2) The search read path: the original text no longer matches anything.
      const searchRes = await http(app)
        .get(`/api/messaging/search?q=${encodeURIComponent(marker)}`)
        .set('Cookie', salesCookie)
        .expect(200);
      expect(searchRes.body.find((m: { id: string }) => m.id === msg.id)).toBeUndefined();
    });

    it('a deleted message does not count toward the recipient\'s unread badge', async () => {
      // Fresh DM so no other unread traffic can interfere with the count.
      const dm = await openDm(otherCookie, salesId);
      const msg = await send(otherCookie, dm, 'will be deleted before sales ever reads it');
      await http(app)
        .delete(`/api/messaging/conversations/${dm}/messages/${msg.id}`)
        .set('Cookie', otherCookie)
        .expect(200);

      const convRes = await http(app).get('/api/messaging/conversations').set('Cookie', salesCookie).expect(200);
      const conv = (convRes.body as Array<{ id: string; unreadCount: number }>).find((c) => c.id === dm);
      expect(conv?.unreadCount).toBe(0);
    });

    it('deleting an already-deleted message is idempotent, not an error', async () => {
      const msg = await send(salesCookie, groupId, 'delete me twice');
      const url = `/api/messaging/conversations/${groupId}/messages/${msg.id}`;
      await http(app).delete(url).set('Cookie', salesCookie).expect(200);
      const second = await http(app).delete(url).set('Cookie', salesCookie).expect(200);
      expect(second.body.deletedAt).toBeTruthy();
    });
  });

  // --- Reactions ---------------------------------------------------------------

  describe('reactions', () => {
    it('a member can react, and reacting twice with the same emoji is idempotent', async () => {
      const msg = await send(salesCookie, groupId, 'react to me');
      const url = `/api/messaging/conversations/${groupId}/messages/${msg.id}/reactions`;
      await http(app).post(url).set('Cookie', otherCookie).send({ emoji: '👍' }).expect(201);
      await http(app).post(url).set('Cookie', otherCookie).send({ emoji: '👍' }).expect(201);

      const stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id) as {
        reactions: { userId: string; emoji: string }[];
      };
      const mine = stored.reactions.filter((r) => r.userId === otherId && r.emoji === '👍');
      expect(mine).toHaveLength(1);
    });

    it('different users can each add the same emoji, and removing one leaves the other', async () => {
      const msg = await send(salesCookie, groupId, 'react from two people');
      const url = `/api/messaging/conversations/${groupId}/messages/${msg.id}/reactions`;
      await http(app).post(url).set('Cookie', otherCookie).send({ emoji: '❤️' }).expect(201);
      await http(app).post(url).set('Cookie', adminCookie).send({ emoji: '❤️' }).expect(201);

      let stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id) as {
        reactions: { userId: string; emoji: string }[];
      };
      expect(stored.reactions.filter((r) => r.emoji === '❤️')).toHaveLength(2);

      // Toggle off is a delete of just that (message, user, emoji) row.
      await http(app)
        .delete(`${url}/${encodeURIComponent('❤️')}`)
        .set('Cookie', otherCookie)
        .expect(200);

      stored = (await messagesIn(salesCookie, groupId)).find((m) => m.id === msg.id) as {
        reactions: { userId: string; emoji: string }[];
      };
      const hearts = stored.reactions.filter((r) => r.emoji === '❤️');
      expect(hearts).toHaveLength(1);
      expect(hearts[0].userId).toBe(adminId);
    });

    it('rejects reacting to a deleted message', async () => {
      const msg = await send(salesCookie, groupId, 'to delete then react');
      await http(app)
        .delete(`/api/messaging/conversations/${groupId}/messages/${msg.id}`)
        .set('Cookie', salesCookie)
        .expect(200);
      await http(app)
        .post(`/api/messaging/conversations/${groupId}/messages/${msg.id}/reactions`)
        .set('Cookie', otherCookie)
        .send({ emoji: '🎉' })
        .expect(400);
    });

    it('rejects an emoji outside the fixed reaction set', async () => {
      const msg = await send(salesCookie, groupId, 'react restricted');
      await http(app)
        .post(`/api/messaging/conversations/${groupId}/messages/${msg.id}/reactions`)
        .set('Cookie', otherCookie)
        .send({ emoji: '🤖' })
        .expect(400);
    });

    it('a non-member cannot react (404, the membership boundary — not 403)', async () => {
      const dm = await openDm(otherCookie, thirdId);
      const msg = await send(otherCookie, dm, 'not yours to react to');
      await http(app)
        .post(`/api/messaging/conversations/${dm}/messages/${msg.id}/reactions`)
        .set('Cookie', salesCookie)
        .send({ emoji: '👍' })
        .expect(404);
    });

    it('the database enforces one reaction per (message, user, emoji)', async () => {
      const msg = await send(salesCookie, groupId, 'constraint check');
      await prisma.messageReaction.create({ data: { messageId: msg.id, userId: otherId, emoji: '😂' } });
      await expect(
        prisma.messageReaction.create({ data: { messageId: msg.id, userId: otherId, emoji: '😂' } }),
      ).rejects.toThrow();
    });
  });

  // --- Search --------------------------------------------------------------

  describe('search', () => {
    it('only returns messages from conversations the caller participates in', async () => {
      const marker = `UNIQSEARCH${Date.now()}`;
      const inDm = await openDm(salesCookie, otherId);
      await send(salesCookie, inDm, `hello ${marker} world`);

      // A conversation sales is NOT a member of, containing the same marker.
      const outDm = await openDm(otherCookie, thirdId);
      await send(otherCookie, outDm, `hello ${marker} world`);

      const res = await http(app)
        .get(`/api/messaging/search?q=${encodeURIComponent(marker)}`)
        .set('Cookie', salesCookie)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].conversationId).toBe(inDm);
    });

    it('scopes to one conversation when conversationId is given, and 404s for a conversation the caller is not in', async () => {
      const marker = `SCOPEDSEARCH${Date.now()}`;
      await send(salesCookie, groupId, `scoped ${marker} text`);

      const res = await http(app)
        .get(`/api/messaging/search?q=${encodeURIComponent(marker)}&conversationId=${groupId}`)
        .set('Cookie', salesCookie)
        .expect(200);
      expect(res.body).toHaveLength(1);

      const outDm = await openDm(otherCookie, thirdId);
      await http(app)
        .get(`/api/messaging/search?q=${encodeURIComponent(marker)}&conversationId=${outDm}`)
        .set('Cookie', salesCookie)
        .expect(404);
    });
  });
});
