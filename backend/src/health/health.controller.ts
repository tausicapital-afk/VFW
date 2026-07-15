import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { Public } from '../common/auth.guard';
import { PageData, Overall, overallOf, renderStatusPage } from './health.page';
import { COMPONENTS, HealthService, ProbeResult, RETENTION_DAYS } from './health.service';

/** The banner verdict, in the JSON shape the page's poller reads back. */
const OVERALL: Record<Overall, Overall> = {
  operational: 'operational',
  degraded: 'degraded',
  partial_outage: 'partial_outage',
  major_outage: 'major_outage',
  unknown: 'unknown',
};

/**
 * How long a rendered page is reused. The prober only moves the numbers once a
 * minute, so re-running the rollup more often than this could not tell anyone
 * anything new — and the live half of the page is refreshed by its own poller
 * against the cheap JSON branch regardless.
 */
const PAGE_TTL_MS = 60_000;

@Controller('api')
export class HealthController {
  /** Rendered page, reused for PAGE_TTL_MS. See {@link PAGE_TTL_MS}. */
  private cached: { html: string; at: number } | null = null;
  /** In-flight render, so a burst of misses does one rollup rather than N. */
  private rendering: Promise<string> | null = null;

  constructor(
    private readonly health: HealthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Health, for two very different readers.
   *
   * A browser gets the status page. Everything else — Railway's probe, curl,
   * any monitor — gets exactly the JSON this endpoint has always returned, with
   * `checks` added alongside. The old keys are untouched on purpose: something
   * out there parses them, and a redesign is no reason to break it.
   *
   * `ok` still means "this process is up and serving", NOT "every dependency is
   * healthy". That distinction is load-bearing: Railway restarts the container
   * when this fails, so reporting a Postgres blip as a failed healthcheck would
   * turn a brief database wobble into a restart loop that takes the API down
   * too. Per-component state lives in `checks`, where a monitor can read it
   * without holding a restart trigger.
   *
   * Neither response probes anything. This is hit every few seconds; the
   * background prober in HealthService owns the round-trips and this reads its
   * last result. See the class comment there.
   */
  @Public()
  @Get('health')
  async health_(@Req() req: Request, @Res() res: Response): Promise<void> {
    const results = this.health.snapshot();

    // `accepts` picks the caller's preferred type. A browser asks for
    // text/html explicitly; `Accept: */*` and a missing header both land on
    // the first listed type, so probes and curl keep getting JSON.
    if (req.accepts(['json', 'html']) === 'html') {
      res
        .type('html')
        // Always fresh: a cached status page is worse than no status page.
        .setHeader('Cache-Control', 'no-store');
      res.send(await this.page(results));
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'vfw-api',
      time: new Date().toISOString(),
      status: OVERALL[overallOf(results)],
      checks: results.map((r) => ({
        component: r.component,
        label: COMPONENTS.find((c) => c.id === r.component)?.label ?? r.component,
        status: r.status,
        latencyMs: r.latencyMs,
        checkedAt: r.checkedAt.toISOString(),
        // `error` is deliberately not here. This route is public and a probe
        // failure names internal hosts and ports. It is in the HealthProbe
        // table for an operator who can already read the database.
      })),
    });
  }

  /**
   * The page, cached and single-flighted.
   *
   * The rollup behind it reads the whole retention window, and this route is
   * public. Without these two guards, anyone holding down refresh would have
   * the database aggregate ~500k rows per request.
   */
  private async page(results: ProbeResult[]): Promise<string> {
    if (this.cached && Date.now() - this.cached.at < PAGE_TTL_MS) return this.cached.html;
    if (this.rendering) return this.rendering;

    this.rendering = this.render(results)
      .then((html) => {
        this.cached = { html, at: Date.now() };
        return html;
      })
      .finally(() => {
        this.rendering = null;
      });

    return this.rendering;
  }

  private async render(results: ProbeResult[]): Promise<string> {
    const [history, measuringSince] = await Promise.all([
      this.health.history(RETENTION_DAYS),
      this.health.measuringSince(),
    ]);

    const data: PageData = {
      results,
      history,
      measuringSince,
      windowDays: RETENTION_DAYS,
      consoleUrl: (this.config.get('APP_URL') ?? 'http://localhost:5173').replace(/\/$/, ''),
      now: new Date(),
    };
    return renderStatusPage(data);
  }

  /**
   * How this app sees the caller, once the proxy chain has been unwound.
   *
   * The rate limiter keys on `ip`. If that shows the proxy's address rather than
   * the caller's, every user shares one bucket and the limiter is worthless.
   * `TRUST_PROXY_HOPS` tunes it, and this is how you check it: call this through
   * the real front door and confirm `ip` is your own address.
   *
   * Echoes only the caller's own request back to them — no secrets, and nothing
   * they did not already send.
   */
  @Public()
  @Get('health/ip')
  ip(@Req() req: Request) {
    return {
      ip: req.ip,
      ips: req.ips,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      socket: req.socket.remoteAddress,
      trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
    };
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
