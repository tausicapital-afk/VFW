import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * The status page's data source.
 *
 * A background loop probes each dependency, keeps the newest result in memory,
 * and appends it to HealthProbe. The request path never probes: GET /api/health
 * is hit by Railway every few seconds, and a healthcheck that opens a database
 * connection and an SMTP session per call is a self-inflicted outage. Requests
 * read {@link snapshot}, which is at most one cycle stale.
 *
 * The 90-day bars are why the table exists — see the model comment in
 * schema.prisma. Live checks can only ever say "up right now".
 */

export type ComponentId = 'api' | 'database' | 'storage' | 'email';

/**
 * UNCONFIGURED is not an outage: nothing was set up, so nothing can be down.
 * It is excluded from uptime and from the overall banner, because counting a
 * feature the operator never enabled as downtime would make the number a lie.
 */
export type ProbeStatus = 'OPERATIONAL' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';

export interface ProbeResult {
  component: ComponentId;
  status: ProbeStatus;
  latencyMs: number | null;
  /** Operator-facing only: persisted, never served. Errors name hosts and ports. */
  error: string | null;
  checkedAt: Date;
}

/** One UTC day of probes for one component, as drawn by a single tick. */
export interface DayBucket {
  /** YYYY-MM-DD, UTC. */
  day: string;
  ok: number;
  degraded: number;
  down: number;
}

interface ComponentSpec {
  id: ComponentId;
  /** The name on the page. Written for someone who does not know the stack. */
  label: string;
  /** What a reader loses when this is down. */
  blurb: string;
  /** Slower than this and it is up but not well. */
  degradedAboveMs: number;
  /**
   * Floor between probes. Storage and email cost a network round-trip to a
   * third party, so they are sampled less often than the cycle — a bar built
   * from 96 honest samples beats one that gets the SMTP account rate-limited.
   */
  minIntervalMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const COMPONENTS: readonly ComponentSpec[] = [
  {
    id: 'api',
    label: 'API',
    blurb: 'Signing in, and every request the console makes',
    degradedAboveMs: 250,
    minIntervalMs: 0,
  },
  {
    id: 'database',
    label: 'Database',
    blurb: 'Submissions, contacts, and pricing',
    degradedAboveMs: 250,
    minIntervalMs: 0,
  },
  {
    id: 'storage',
    label: 'Document storage',
    blurb: 'Uploading and downloading files',
    degradedAboveMs: 1500,
    minIntervalMs: 5 * MINUTE,
  },
  {
    id: 'email',
    label: 'Outbound email',
    blurb: 'Sign-in codes, invitations, and password resets',
    degradedAboveMs: 3 * SECOND,
    minIntervalMs: 15 * MINUTE,
  },
];

/** The window the page draws, and so the window worth keeping. */
export const RETENTION_DAYS = 90;

const CYCLE_MS = 60 * SECOND;
/** A hung dependency must not hold the cycle open forever. */
const PROBE_TIMEOUT_MS = 10 * SECOND;
const RETENTION_SWEEP_MS = 60 * MINUTE;

/** Reject rather than hang, so one dead socket cannot stall every other probe. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

@Injectable()
export class HealthService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(HealthService.name);
  private readonly latest = new Map<ComponentId, ProbeResult>();
  private cycleTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  /** Set while a cycle is in flight, so a slow cycle cannot overlap the next. */
  private cycling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    // Probe once at boot so the first caller sees real state rather than
    // "checking…", then settle into the cycle.
    void this.runCycle();

    this.cycleTimer = setInterval(() => void this.runCycle(), CYCLE_MS);
    this.sweepTimer = setInterval(() => void this.sweep(), RETENTION_SWEEP_MS);

    // Timers must not be the reason the process refuses to exit.
    this.cycleTimer.unref();
    this.sweepTimer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.cycleTimer);
    clearInterval(this.sweepTimer);
  }

  /** The newest result per component. Missing until the first cycle lands. */
  snapshot(): ProbeResult[] {
    return COMPONENTS.map((c) => this.latest.get(c.id)).filter((r): r is ProbeResult => Boolean(r));
  }

  async runCycle(): Promise<void> {
    if (this.cycling) return;
    this.cycling = true;
    try {
      const now = Date.now();
      for (const spec of COMPONENTS) {
        const last = this.latest.get(spec.id);
        // Not due yet: the previous result stands, and no row is written. The
        // bar is built from fewer samples, which is honest; inventing a sample
        // we did not take would not be.
        if (last && now - last.checkedAt.getTime() < spec.minIntervalMs) continue;

        const result = await this.probe(spec);
        this.latest.set(spec.id, result);
        await this.record(result);
      }
    } finally {
      this.cycling = false;
    }
  }

  private async probe(spec: ComponentSpec): Promise<ProbeResult> {
    const startedAt = Date.now();
    const done = (status: ProbeStatus, error: string | null, timed = true): ProbeResult => ({
      component: spec.id,
      status,
      latencyMs: timed ? Date.now() - startedAt : null,
      error,
      checkedAt: new Date(),
    });

    // Nothing to reach and nothing to time — this process is answering.
    if (spec.id === 'api') return done('OPERATIONAL', null, false);

    if (spec.id === 'storage' && !this.storage.configured) return done('UNCONFIGURED', null, false);
    if (spec.id === 'email' && !this.email.configured) return done('UNCONFIGURED', null, false);

    try {
      await withTimeout(this.reach(spec.id), PROBE_TIMEOUT_MS);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`Health probe failed for ${spec.id}: ${reason}`);
      return done('DOWN', reason.slice(0, 500));
    }

    const latencyMs = Date.now() - startedAt;
    return done(latencyMs > spec.degradedAboveMs ? 'DEGRADED' : 'OPERATIONAL', null);
  }

  private reach(id: ComponentId): Promise<unknown> {
    switch (id) {
      // Cheapest thing that proves a connection can be taken from the pool and
      // a round-trip completed. Touches no table, so it cannot be slowed by data.
      case 'database':
        return this.prisma.$queryRaw`SELECT 1`;
      // HEAD on the bucket: proves the credentials reach it, moves no bytes.
      case 'storage':
        return this.storage.verify();
      // Connects and authenticates without sending mail.
      case 'email':
        return this.email.verify();
      default:
        return Promise.resolve();
    }
  }

  /**
   * Append the observation. Best-effort by design: when the database is the
   * thing that is down, failing to record that it is down must not also take
   * out the status page that is trying to say so.
   */
  private async record(result: ProbeResult): Promise<void> {
    try {
      await this.prisma.healthProbe.create({
        data: {
          component: result.component,
          status: result.status,
          latencyMs: result.latencyMs,
          error: result.error,
          checkedAt: result.checkedAt,
        },
      });
    } catch (err) {
      this.log.debug(
        `Could not record ${result.component} probe: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * MINUTE);
    try {
      const { count } = await this.prisma.healthProbe.deleteMany({
        where: { checkedAt: { lt: cutoff } },
      });
      if (count > 0) this.log.log(`Aged out ${count} health probes older than ${RETENTION_DAYS}d`);
    } catch (err) {
      this.log.debug(
        `Health probe sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Probes bucketed by UTC day, per component, for the retention window.
   *
   * Aggregated in Postgres rather than in Node: this is ~130k rows per
   * component at full history, and shipping them here to count them would be
   * absurd. UNCONFIGURED rows are dropped — see {@link ProbeStatus}.
   *
   * Days with no probes are simply absent from the result. The page draws those
   * as "no data" rather than assuming either way; before this shipped there was
   * no history, and a green bar for a day nobody watched would be fiction.
   */
  async history(days = RETENTION_DAYS): Promise<Map<ComponentId, Map<string, DayBucket>>> {
    const empty = new Map<ComponentId, Map<string, DayBucket>>(
      COMPONENTS.map((c) => [c.id, new Map<string, DayBucket>()]),
    );

    let rows: Array<{ component: string; day: string; ok: number; degraded: number; down: number }>;
    try {
      rows = await this.prisma.$queryRaw`
        SELECT "component",
               to_char(("checkedAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
               COUNT(*) FILTER (WHERE "status" = 'OPERATIONAL')::int AS ok,
               COUNT(*) FILTER (WHERE "status" = 'DEGRADED')::int    AS degraded,
               COUNT(*) FILTER (WHERE "status" = 'DOWN')::int        AS down
        FROM "HealthProbe"
        WHERE "checkedAt" >= NOW() - make_interval(days => ${days})
          AND "status" <> 'UNCONFIGURED'
        GROUP BY 1, 2
      `;
    } catch (err) {
      // The page still renders: live status is in memory, and the bars degrade
      // to "no data" rather than the whole page 500-ing on a reporting query.
      this.log.warn(
        `Health history unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }

    for (const row of rows) {
      const bucket = empty.get(row.component as ComponentId);
      if (!bucket) continue; // A component that existed under an older build.
      bucket.set(row.day, { day: row.day, ok: row.ok, degraded: row.degraded, down: row.down });
    }
    return empty;
  }

  /** The oldest probe on record — the page says uptime is measured from here. */
  async measuringSince(): Promise<Date | null> {
    try {
      const first = await this.prisma.healthProbe.findFirst({
        orderBy: { checkedAt: 'asc' },
        select: { checkedAt: true },
      });
      return first?.checkedAt ?? null;
    } catch {
      return null;
    }
  }
}
