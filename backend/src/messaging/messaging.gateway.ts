import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ActivityService } from '../activity/activity.service';
import { AuthUser, verifySession } from '../common/auth.guard';
import { SESSION_COOKIE } from '../common/cookie';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

const userRoom = (userId: string) => `user:${userId}`;
const convRoom = (conversationId: string) => `conv:${conversationId}`;

type AuthedSocket = Socket & { data: { user?: AuthUser } };

/**
 * The real-time surface. Mounted at `/api/socket.io` so it rides through the
 * same nginx front door as the REST API (see frontend/nginx.conf.template).
 *
 * Authentication is the SAME session cookie the REST API uses, verified with the
 * shared `verifySession` helper on the handshake — a global HTTP guard cannot
 * reach a WebSocket handshake, so this is where the door is. `cors.credentials`
 * is on so the browser sends the cookie during the upgrade.
 *
 * Presence is in-memory: one process, one map of who is connected. That is
 * correct for a single backend instance; scaling past one needs the socket.io
 * Redis adapter and a shared presence store (a documented follow-up, consistent
 * with the project's "add Redis when it is actually needed" stance).
 */
@Injectable()
@WebSocketGateway({ path: '/api/socket.io', cors: { origin: true, credentials: true } })
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagingGateway.name);

  @WebSocketServer()
  private server: Server;

  // userId -> the set of that user's live socket ids (a user may have several
  // tabs open). Online iff the set is non-empty.
  private readonly presence = new Map<string, Set<string>>();

  // userId -> the id of their currently-open UserSession row. One session spans
  // a whole online period (first connect to last disconnect), not one socket.
  private readonly sessionByUser = new Map<string, string>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly activity: ActivityService,
  ) {}

  // --- Presence helpers exposed to the controller --------------------------

  isOnline(userId: string): boolean {
    return (this.presence.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.presence.keys()].filter((id) => this.isOnline(id));
  }

  // --- Lifecycle -----------------------------------------------------------

  async handleConnection(socket: AuthedSocket) {
    let user: AuthUser;
    try {
      const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      user = await verifySession(this.jwt, this.prisma, token);
    } catch {
      // No valid session — nothing on the other end is entitled to anything.
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;

    const wasOffline = !this.isOnline(user.id);
    const sockets = this.presence.get(user.id) ?? new Set<string>();
    sockets.add(socket.id);
    this.presence.set(user.id, sockets);

    // First socket for this user opens a session for the Logs screen. Handshake
    // headers give us the origin; best-effort, never blocks the connection.
    if (wasOffline) {
      const ctx = {
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
      };
      this.activity
        .openSession(user.id, user.name, ctx)
        .then((id) => this.sessionByUser.set(user.id, id))
        .catch(() => undefined);
    }

    // Join my personal room and every conversation I belong to, so fan-out to a
    // conversation reaches all of a member's tabs.
    await socket.join(userRoom(user.id));
    const convIds = await this.messaging.conversationIdsFor(user.id);
    if (convIds.length) await socket.join(convIds.map(convRoom));

    // Everything already waiting for me is now delivered. Tell the senders.
    const delivered = await this.messaging.markAllDelivered(user.id);
    for (const row of delivered) {
      this.server.to(convRoom(row.conversationId)).emit('receipt', {
        conversationId: row.conversationId,
        userId: user.id,
        lastDeliveredSeq: row.lastDeliveredSeq,
      });
    }

    // Only announce presence on the transition offline -> online.
    if (wasOffline) await this.emitPresence(user.id, true);
  }

  async handleDisconnect(socket: AuthedSocket) {
    const user = socket.data.user;
    if (!user) return;

    const sockets = this.presence.get(user.id);
    sockets?.delete(socket.id);
    if (sockets && sockets.size === 0) {
      this.presence.delete(user.id);
      await this.messaging.setLastSeen(user.id);
      await this.emitPresence(user.id, false);

      // Last socket gone — close the session and stamp its duration.
      const sessionId = this.sessionByUser.get(user.id);
      if (sessionId) {
        this.sessionByUser.delete(user.id);
        await this.activity.closeSession(sessionId, user.id, user.name).catch(() => undefined);
      }
    }
  }

  private async emitPresence(userId: string, online: boolean) {
    const coIds = await this.messaging.coParticipantIds(userId);
    const payload = { userId, online, lastSeenAt: online ? null : new Date().toISOString() };
    for (const uid of coIds) this.server.to(userRoom(uid)).emit('presence', payload);
  }

  // --- Client -> server events ---------------------------------------------

  @SubscribeMessage('typing')
  onTyping(socket: AuthedSocket, data: { conversationId: string; isTyping: boolean }) {
    const user = socket.data.user;
    if (!user || !data?.conversationId) return;
    // to() excludes the sender's own socket — you never see your own indicator.
    socket.to(convRoom(data.conversationId)).emit('typing', {
      conversationId: data.conversationId,
      userId: user.id,
      isTyping: !!data.isTyping,
    });
  }

  @SubscribeMessage('read')
  async onRead(socket: AuthedSocket, data: { conversationId: string; seq?: number }) {
    const user = socket.data.user;
    if (!user || !data?.conversationId) return;
    try {
      const receipt = await this.messaging.markRead(data.conversationId, user.id, data.seq);
      this.server.to(convRoom(data.conversationId)).emit('receipt', receipt);
    } catch (e) {
      this.logger.debug(`read receipt ignored: ${(e as Error).message}`);
    }
  }

  @SubscribeMessage('delivered')
  async onDelivered(socket: AuthedSocket, data: { conversationId: string; seq: number }) {
    const user = socket.data.user;
    if (!user || !data?.conversationId || !data?.seq) return;
    try {
      const receipt = await this.messaging.markDelivered(data.conversationId, user.id, data.seq);
      this.server.to(convRoom(data.conversationId)).emit('receipt', receipt);
    } catch (e) {
      this.logger.debug(`delivered receipt ignored: ${(e as Error).message}`);
    }
  }

  // --- Server -> client fan-out (called by the controller) -----------------

  /** Make every participant's live sockets members of the conversation room. */
  private async joinRooms(participantIds: string[], conversationId: string) {
    await this.server
      .in(participantIds.map(userRoom))
      .socketsJoin(convRoom(conversationId));
  }

  /**
   * A new message was persisted. Push it to the room, then mark it delivered for
   * every recipient who is online right now and echo those receipts back so the
   * sender's ticks turn from ✓ to ✓✓ without a refresh.
   */
  async dispatchMessage(
    conversationId: string,
    message: { seq: number; senderId: string },
    recipientIds: string[],
  ) {
    await this.joinRooms([message.senderId, ...recipientIds], conversationId);
    this.server.to(convRoom(conversationId)).emit('message', { conversationId, message });

    for (const rid of recipientIds) {
      if (!this.isOnline(rid)) continue;
      const receipt = await this.messaging.markDelivered(conversationId, rid, message.seq);
      this.server.to(convRoom(conversationId)).emit('receipt', receipt);
    }
  }

  /** Push a receipt to a room — used by the REST read fallback. */
  broadcastReceipt(
    conversationId: string,
    receipt: { userId: string; lastReadSeq: number; lastDeliveredSeq: number },
  ) {
    this.server.to(convRoom(conversationId)).emit('receipt', { conversationId, ...receipt });
  }

  /** A conversation was created or someone was added — notify participants. */
  async dispatchConversation(conversation: { id: string }, participantIds: string[]) {
    await this.joinRooms(participantIds, conversation.id);
    for (const uid of participantIds) {
      this.server.to(userRoom(uid)).emit('conversation', conversation);
    }
  }
}
