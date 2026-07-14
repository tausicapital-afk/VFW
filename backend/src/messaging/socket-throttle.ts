/**
 * Rate limiting for the WebSocket surface.
 *
 * The HTTP throttler (common/throttler.ts) cannot help here: it is a Nest guard
 * over an Express request, and a socket event is neither. This is the same
 * *shape* — one table of buckets, each with a limit and a block duration, and an
 * event must satisfy every bucket that applies to it — so there is one style of
 * rate limiting in this codebase, not two.
 *
 * Two differences from the HTTP side, both deliberate:
 *
 * 1. **Keyed by userId, not IP.** A socket is already authenticated (the gateway
 *    verifies the session cookie on the handshake), so the real actor is known.
 *    Keying on IP would put a whole NAT'd office behind one bucket and let one
 *    person's flood throttle their colleagues.
 *
 * 2. **Counters survive a disconnect.** Forgetting a user's window when their
 *    last socket closes would hand every flooder a reset button: disconnect,
 *    reconnect, keep going. Windows expire on time, and only on time; the map is
 *    swept lazily so it does not grow without bound.
 *
 * Pure and side-effect free (the clock is injected), so it is unit-tested like
 * receipts.ts rather than by standing up a socket server.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export interface SocketBucket {
  name: string;
  /** Length of the counting window. */
  ttlMs: number;
  /** Events allowed per user per window. */
  limit: number;
  /** How long the door stays shut once the limit is beaten. */
  blockMs: number;
  appliesTo(event: string): boolean;
}

/**
 * The table. Limits are set so a human cannot reach them and a script cannot
 * miss them:
 *
 *   typing — a client sends at most one start + one stop per burst of typing.
 *            60/min is already an implausibly chatty client.
 *   events — the backstop across everything a socket can send (typing, read,
 *            delivered). A receipt storm on a busy conversation is bursty, so
 *            this is set well above typing rather than tightly.
 *
 * Note what is NOT here: sending a message. Messages are persisted over REST
 * (POST /api/messaging/conversations/:id/messages) and only fanned out over the
 * socket, so the send path is covered by the HTTP throttler's `global` bucket.
 */
export const socketBuckets: SocketBucket[] = [
  {
    name: 'typing',
    ttlMs: MINUTE,
    limit: 60,
    blockMs: MINUTE,
    appliesTo: (event) => event === 'typing',
  },
  {
    name: 'events',
    ttlMs: MINUTE,
    limit: 240,
    blockMs: MINUTE,
    appliesTo: () => true,
  },
];

export type SocketVerdict =
  | { allowed: true }
  | { allowed: false; bucket: string; retryAfterMs: number };

interface Window {
  count: number;
  /** When the counting window rolls over. */
  resetAt: number;
  /** Set on a breach; until then, everything in this bucket is refused. */
  blockedUntil: number;
}

/** Sweep expired windows at most this often, rather than on every single event. */
const SWEEP_EVERY_MS = MINUTE;

export class SocketThrottle {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly buckets: SocketBucket[] = socketBuckets,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Count one inbound event from `userId` and say whether it may proceed.
   *
   * Every applicable bucket is charged, and the first breach wins — so a typing
   * flood trips `typing` (the tighter bucket) rather than grinding all the way
   * up to the `events` backstop.
   */
  check(userId: string, event: string): SocketVerdict {
    const now = this.now();
    this.sweep(now);

    for (const bucket of this.buckets) {
      if (!bucket.appliesTo(event)) continue;

      const key = `${userId}:${bucket.name}`;
      const window = this.windows.get(key);

      if (window && window.blockedUntil > now) {
        return { allowed: false, bucket: bucket.name, retryAfterMs: window.blockedUntil - now };
      }

      // Start a clean window when there is none, when the old one has rolled
      // over, or when a block has just expired — serving out a block resets the
      // count, or the very next event would be over the limit again and the user
      // would never get back in.
      if (!window || window.resetAt <= now || window.blockedUntil > 0) {
        this.windows.set(key, { count: 1, resetAt: now + bucket.ttlMs, blockedUntil: 0 });
        continue;
      }

      window.count += 1;
      if (window.count > bucket.limit) {
        window.blockedUntil = now + bucket.blockMs;
        return { allowed: false, bucket: bucket.name, retryAfterMs: bucket.blockMs };
      }
    }

    return { allowed: true };
  }

  /** Drop windows that have both rolled over and come out of any block. */
  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now && w.blockedUntil <= now) this.windows.delete(key);
    }
  }
}
