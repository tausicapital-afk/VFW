import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityQueryDto, SessionsQueryDto } from './dto';

/** Where a request came from, threaded through so the log line can name it. */
export interface ActivityContext {
  ip?: string;
  userAgent?: string;
}

/**
 * Operational telemetry: logins, module views, message activity and online
 * sessions, for the admin-only Logs screen. Deliberately separate from
 * AuditService — that trail is submission-scoped financial evidence and must
 * not be polluted with routine sign-in noise. Nothing here ever updates or
 * deletes a log line; sessions are the one exception (opened, then closed once).
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Writers -------------------------------------------------------------

  /** Append a single event. Best-effort by callers: telemetry must never be
   * the reason a login or a message fails, so callers swallow errors. */
  async log(
    entry: {
      userId?: string | null;
      action: string;
      detail?: string;
      meta?: Prisma.InputJsonValue;
      ctx?: ActivityContext;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.activityLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        detail: entry.detail,
        meta: entry.meta,
        ip: entry.ctx?.ip,
        userAgent: entry.ctx?.userAgent,
      },
    });
  }

  /** A successful authentication: stamp lastLoginAt and record the event. */
  async recordLogin(userId: string, name: string, ctx?: ActivityContext) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
    await this.log({ userId, action: 'LOGIN', detail: `${name} signed in`, ctx });
  }

  async recordLogout(userId: string, name: string, ctx?: ActivityContext) {
    await this.log({ userId, action: 'LOGOUT', detail: `${name} signed out`, ctx });
  }

  /**
   * A user's first socket connected — open a session and record it. Returns the
   * session id so the gateway can close it when the last socket drops.
   */
  async openSession(userId: string, name: string, ctx?: ActivityContext): Promise<string> {
    const session = await this.prisma.userSession.create({
      data: { userId, ip: ctx?.ip, userAgent: ctx?.userAgent },
    });
    await this.log({ userId, action: 'CONNECT', detail: `${name} came online`, ctx });
    return session.id;
  }

  /**
   * The last socket dropped — close the session and stamp its duration. Prefer
   * the exact session id the gateway remembered; if that was lost (a disconnect
   * that raced the open, before the id was recorded), fall back to the user's
   * most recent still-open session. Either way a session can never be orphaned
   * open by an in-memory timing gap.
   */
  async closeSession(userId: string, name: string, sessionId?: string) {
    const session = sessionId
      ? await this.prisma.userSession.findUnique({ where: { id: sessionId } })
      : await this.prisma.userSession.findFirst({
          where: { userId, endedAt: null },
          orderBy: { startedAt: 'desc' },
        });
    if (!session || session.endedAt || session.userId !== userId) return;

    const endedAt = new Date();
    const durationSec = Math.max(
      0,
      Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000),
    );
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { endedAt, durationSec },
    });
    await this.log({
      userId,
      action: 'DISCONNECT',
      detail: `${name} went offline`,
      meta: { durationSec },
    });
  }

  /**
   * Close any session left open by a previous process. Presence is in-memory and
   * single-instance, so on a clean boot there are no live sockets yet — every
   * still-open session is therefore a leftover from a crash or restart. We know
   * it started but not when it ended, so we stamp `endedAt` without a duration
   * (null = unknown) rather than invent one, and it stops showing as "online".
   * Returns how many were closed, for a boot log line.
   */
  async closeOrphanedSessions(): Promise<number> {
    const res = await this.prisma.userSession.updateMany({
      where: { endedAt: null },
      data: { endedAt: new Date() },
    });
    return res.count;
  }

  /** A self-reported module view from the client (the only forgeable action,
   * and it is harmless — it records that the caller opened one of their own
   * screens). */
  async trackModuleView(userId: string, module: string, label: string, ctx?: ActivityContext) {
    await this.log({
      userId,
      action: 'MODULE_VIEW',
      detail: `Opened ${label}`,
      meta: { module },
      ctx,
    });
  }

  /** A message was sent — metadata only, never the body. */
  async recordMessageSent(
    senderId: string,
    target: { conversationId: string; label: string; recipientIds: string[] },
  ) {
    await this.log({
      userId: senderId,
      action: 'MESSAGE_SENT',
      detail: `Messaged ${target.label}`,
      meta: { conversationId: target.conversationId, recipientIds: target.recipientIds },
    });
  }

  // --- Readers -------------------------------------------------------------

  /**
   * One row per user for the overview tab: their identity and status alongside
   * derived activity — last login (null = never), last seen, event and message
   * counts, and total time online. `onlineIds` is the authoritative live set
   * from the gateway.
   */
  async usersOverview(onlineIds: Set<string>) {
    const users = await this.prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, email: true, role: true, status: true, colour: true,
        department: true, createdAt: true, lastLoginAt: true, lastSeenAt: true,
      },
    });

    // Per-user aggregates in four grouped queries rather than N round-trips.
    // groupBy needs an orderBy for its result types to resolve cleanly.
    const [events, messages, lastEvents, sessions] = await this.prisma.$transaction([
      this.prisma.activityLog.groupBy({
        by: ['userId'], _count: true, orderBy: { userId: 'asc' },
      }),
      this.prisma.activityLog.groupBy({
        by: ['userId'], where: { action: 'MESSAGE_SENT' }, _count: true, orderBy: { userId: 'asc' },
      }),
      this.prisma.activityLog.groupBy({
        by: ['userId'], _max: { createdAt: true }, orderBy: { userId: 'asc' },
      }),
      this.prisma.userSession.groupBy({
        by: ['userId'], _sum: { durationSec: true }, _count: true, orderBy: { userId: 'asc' },
      }),
    ]);

    // groupBy({ _count: true }) always yields a number, but Prisma types it as
    // `number | true | {…}` because the same field can be a per-column object.
    // Narrow it here rather than at each use: this shape is the API response,
    // and every reader of it would otherwise inherit the ambiguity.
    const count = (n: unknown): number => (typeof n === 'number' ? n : 0);

    const eventCount = new Map(events.map((r) => [r.userId, count(r._count)]));
    const messageCount = new Map(messages.map((r) => [r.userId, count(r._count)]));
    const lastActivity = new Map(lastEvents.map((r) => [r.userId, r._max?.createdAt ?? null]));
    const sessionAgg = new Map(sessions.map((r) => [r.userId, r]));

    return users.map((u) => {
      const s = sessionAgg.get(u.id);
      return {
        ...u,
        online: onlineIds.has(u.id),
        neverLoggedIn: u.lastLoginAt === null,
        eventCount: eventCount.get(u.id) ?? 0,
        messageCount: messageCount.get(u.id) ?? 0,
        lastActivityAt: lastActivity.get(u.id) ?? null,
        sessionCount: count(s?._count),
        totalActiveSec: s?._sum?.durationSec ?? 0,
      };
    });
  }

  /**
   * The feed's filter, built once, so the export reads the feed through the same
   * predicate the screen does rather than through a second copy of it.
   */
  private feedWhere(filter: ActivityQueryDto): Prisma.ActivityLogWhereInput {
    const where: Prisma.ActivityLogWhereInput = {};
    if (filter.action) where.action = filter.action;
    if (filter.userId) where.userId = filter.userId;
    const q = filter.q?.trim();
    if (q) {
      where.OR = [
        { detail: { contains: q, mode: 'insensitive' } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  /** The same feed as feed(), unpaged, for an export. See searchAll in AuditService. */
  async feedAll(filter: ActivityQueryDto, limit: number) {
    return this.prisma.activityLog.findMany({
      where: this.feedWhere(filter),
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { id: true, name: true, role: true, colour: true } } },
    });
  }

  /** The chronological activity feed, newest first, filtered and paged. */
  async feed(filter: ActivityQueryDto) {
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const where = this.feedWhere(filter);

    const [total, entries] = await this.prisma.$transaction([
      this.prisma.activityLog.count({ where }),
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { user: { select: { id: true, name: true, role: true, colour: true } } },
      }),
    ]);

    return { total, limit, offset, entries };
  }

  /** Distinct actions on record, for the feed's filter dropdown. */
  async actions(): Promise<string[]> {
    const rows = await this.prisma.activityLog.groupBy({
      by: ['action'],
      orderBy: { action: 'asc' },
    });
    return rows.map((r) => r.action);
  }

  private sessionsWhere(filter: SessionsQueryDto): Prisma.UserSessionWhereInput {
    const where: Prisma.UserSessionWhereInput = {};
    if (filter.userId) where.userId = filter.userId;
    if (filter.state === 'open') where.endedAt = null;
    if (filter.state === 'closed') where.endedAt = { not: null };
    return where;
  }

  /** The same sessions as sessions(), unpaged, for an export. */
  async sessionsAll(filter: SessionsQueryDto, limit: number) {
    return this.prisma.userSession.findMany({
      where: this.sessionsWhere(filter),
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { user: { select: { id: true, name: true, role: true, colour: true } } },
    });
  }

  /** Online sessions with their durations, newest first. */
  async sessions(filter: SessionsQueryDto) {
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const where = this.sessionsWhere(filter);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.userSession.count({ where }),
      this.prisma.userSession.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: offset,
        take: limit,
        include: { user: { select: { id: true, name: true, role: true, colour: true } } },
      }),
    ]);

    return { total, limit, offset, sessions: rows };
  }
}
