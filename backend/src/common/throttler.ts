import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Request } from 'express';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Rate limiting.
 *
 * Two buckets, both keyed by client IP, and a request must satisfy every bucket
 * that applies to it:
 *
 *   auth   — 10 writes/min to /api/auth/*, then locked out for 15 minutes.
 *   global — 300 requests/min to everything else. A backstop against scraping,
 *            not something a human clicking around can ever hit.
 *
 * Why a path predicate instead of `@Throttle()` decorators: the limits are
 * declared here, in one table, rather than scattered across controllers where a
 * new endpoint can quietly be born unlimited. It also means auth/ needs no edit.
 *
 * This complements — does not replace — the per-email brute-force lockout in
 * AuthService. That one stops a slow, distributed grind at one account; this one
 * stops a fast burst from one source. An attacker has to beat both.
 */

/** Writes to the auth surface: login. GET /api/auth/me is a read — not this. */
function isAuthWrite(ctx: ExecutionContext): boolean {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.method === 'POST' && req.path.startsWith('/api/auth/');
}

/**
 * Railway probes this every few seconds; throttling it would fail the deploy.
 *
 * Only the machine probe is exempt. The same URL serves an HTML status page to
 * browsers, and that costs a rollup query over the probe history — leaving it
 * unlimited would hand out a cheap way to make the database do real work. The
 * page stays inside the global bucket, which no human clicking refresh can hit.
 */
function isHealthCheck(ctx: ExecutionContext): boolean {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (req.path !== '/api/health') return false;
  return req.accepts(['json', 'html']) !== 'html';
}

export const throttlerOptions: ThrottlerModuleOptions = {
  errorMessage: 'Too many requests. Slow down and try again shortly.',
  throttlers: [
    {
      name: 'auth',
      ttl: MINUTE,
      limit: 10,
      // Once tripped, the door stays shut for 15 minutes rather than reopening
      // at the top of the next minute — otherwise a burst just paces itself.
      blockDuration: 15 * MINUTE,
      skipIf: (ctx) => !isAuthWrite(ctx),
    },
    {
      name: 'global',
      ttl: MINUTE,
      limit: 300,
      skipIf: (ctx) => isHealthCheck(ctx) || isAuthWrite(ctx),
    },
  ],
};

@Injectable()
export class VfwThrottlerGuard extends ThrottlerGuard {
  /**
   * The IP-keyed limiter is about HTTP requests. As a global guard it would also
   * run on WebSocket message handlers, where there is no `req.ip` and its path
   * predicates make no sense — skip those; socket flooding is a separate concern.
   */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    return super.canActivate(ctx);
  }

  /**
   * Key the limit on the caller's IP.
   *
   * `req.ip` is only trustworthy because `trust proxy` is configured in main.ts
   * to a fixed hop count — Express then reads the client address from the right
   * end of X-Forwarded-For, past the hops our own infrastructure appended,
   * rather than believing the left-most value a caller can simply invent.
   *
   * Falls back to the socket address if there is no forwarded chain at all.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
