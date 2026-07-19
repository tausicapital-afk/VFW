import { Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

type Rates = Record<string, number>;

/** The currencies the app deals in. CAD is the reporting currency, pinned at 1. */
const SUPPORTED = ['CAD', 'USD', 'GBP', 'EUR', 'JPY'] as const;

/** How long a fetched set of rates is trusted before we ask the provider again. */
const TTL_MS = 60 * 60 * 1000; // 1 hour
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Live foreign-exchange rates to CAD.
 *
 * Rates are stored the way the rest of the system reads them: `rates[X]` is the
 * value of ONE unit of X in CAD (so USD 1.37 means 1 USD = 1.37 CAD). The public
 * provider quotes the inverse (units of X per 1 CAD), so we invert on the way in.
 *
 * Outbound HTTPS works on Railway even though SMTP is black-holed (measured — see
 * the mail-provider migration), so the fetch is reliable in production. Still,
 * every failure path falls back to Settings.fxRates — the admin-maintained table
 * — so a provider outage degrades to the last good numbers rather than breaking
 * every consolidated figure on the screen.
 */
@Injectable()
export class FxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private cache: { rates: Rates; at: number } | null = null;

  /**
   * The rates to show. Live when we can reach the provider (cached for an hour);
   * otherwise the admin-maintained fallback in Settings, flagged as such so the
   * UI can say the figures are not live right now.
   */
  async getLive(): Promise<{ rates: Rates; source: 'live' | 'manual'; asOf: string }> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) {
      return { rates: this.cache.rates, source: 'live', asOf: new Date(this.cache.at).toISOString() };
    }
    try {
      const rates = await this.fetchLive();
      this.cache = { rates, at: Date.now() };
      return { rates, source: 'live', asOf: new Date(this.cache.at).toISOString() };
    } catch {
      const s = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
      return { rates: this.normalize(s.fxRates), source: 'manual', asOf: s.updatedAt.toISOString() };
    }
  }

  /**
   * Fetch live rates and write them into Settings.fxRates, so Reports (which sum
   * in CAD using that table) also move to the live figures. An explicit admin
   * action rather than a write-on-read, so nobody's manual rates are silently
   * overwritten by a page load.
   */
  async refreshIntoSettings(actor: AuthUser) {
    const rates = await this.fetchLive(); // throws on failure — the caller surfaces it
    this.cache = { rates, at: Date.now() };
    const s = await this.prisma.settings.update({
      where: { id: 1 },
      data: { fxRates: { ...rates, CAD: 1 } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'FX_REFRESH',
      detail: 'Live FX rates fetched and saved to Settings',
      payload: { rates },
    });
    return { rates: this.normalize(s.fxRates), source: 'live' as const, asOf: new Date().toISOString() };
  }

  private async fetchLive(): Promise<Rates> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      // Free, no API key, no rate-limit at our volume. Base CAD.
      const res = await fetch('https://open.er-api.com/v6/latest/CAD', { signal: ctrl.signal });
      if (!res.ok) throw new Error(`FX provider returned ${res.status}`);
      const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
      if (data.result !== 'success' || !data.rates) throw new Error('FX provider payload malformed');

      const out: Rates = { CAD: 1 };
      for (const c of SUPPORTED) {
        if (c === 'CAD') continue;
        const perCad = data.rates[c]; // units of c per 1 CAD
        if (typeof perCad === 'number' && perCad > 0) out[c] = round4(1 / perCad);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Coerce the untyped Settings.fxRates JSON into a clean, CAD-pinned table. */
  private normalize(raw: unknown): Rates {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
    const out: Rates = { CAD: 1 };
    for (const c of SUPPORTED) {
      if (c !== 'CAD' && typeof obj[c] === 'number' && obj[c] > 0) out[c] = obj[c];
    }
    return out;
  }
}

@Controller('api/fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  // Any signed-in user: the dashboard converts its own figures to CAD with these.
  @Get()
  rates() {
    return this.fx.getLive();
  }

  // Admin pushes the live rates into Settings so Reports pick them up too.
  @Post('refresh')
  @Can('admin.manage')
  refresh(@CurrentUser() user: AuthUser) {
    return this.fx.refreshIntoSettings(user);
  }
}

@Module({
  providers: [FxService],
  controllers: [FxController],
  exports: [FxService],
})
export class FxModule {}
