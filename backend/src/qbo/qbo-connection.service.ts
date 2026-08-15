import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { decryptSecret, encryptSecret } from '../config/config.crypto';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUTHORIZE_URL,
  apiBase,
  QboEnvironment,
  QboTokenResponse,
  QBO_SCOPE,
  REVOKE_URL,
  TOKEN_URL,
  qboAccountingError,
  qboOAuthError,
} from './qbo.types';

// Refresh a bit before actual expiry so a request in flight never races a
// token that goes stale mid-call.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// How long the CSRF state token is honoured — long enough for someone to sit
// on Intuit's consent screen, short enough that a leaked/logged state is
// useless shortly after.
const STATE_TTL_MS = 10 * 60 * 1000;

export interface QboStatus {
  connected: boolean;
  environment?: QboEnvironment;
  realmId?: string;
  companyName?: string | null;
  connectedAt?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  /** Past this, the connection is dead and can only be fixed by reconnecting. */
  refreshTokenExpired?: boolean;
}

interface PendingState {
  userId: string;
  expiresAt: number;
}

/**
 * The QuickBooks Online OAuth connection: authorizing it, keeping the access
 * token fresh, and tearing it down.
 *
 * One company connected at a time (`QboConnection` is a singleton row, id
 * fixed at 1 — same convention as `Settings`). The CSRF `state` for the
 * handshake lives in an in-memory map rather than a table: it only has to
 * survive the seconds a browser spends on Intuit's consent screen, so this
 * makes the same "fine for one instance" tradeoff messaging's presence map
 * documents (see docs/architecture.md §11.5) rather than adding a table for
 * something this short-lived.
 */
@Injectable()
export class QboConnectionService {
  private readonly log = new Logger(QboConnectionService.name);
  private pending = new Map<string, PendingState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // App credentials (from ConfigService — set once under Administration ->
  // Configuration, distinct from any one company's connection below).
  // ---------------------------------------------------------------------

  private credentials(): { clientId: string; clientSecret: string; environment: QboEnvironment } {
    const clientId = this.config.get('QBO_CLIENT_ID');
    const clientSecret = this.config.get('QBO_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'Set the QuickBooks Client ID and Client secret under Administration → Configuration first.',
      );
    }
    const environment: QboEnvironment =
      this.config.get('QBO_ENVIRONMENT')?.trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
    return { clientId, clientSecret, environment };
  }

  /**
   * Where Intuit sends the browser back to. Computed from the app's own public
   * address rather than a separately-typed setting, so it can never drift from
   * what the frontend proxy actually answers on — see docs/DEPLOYMENT.md for
   * why /api is proxied through the frontend's nginx rather than hit directly.
   */
  redirectUri(): string {
    const appUrl = this.config.get('APP_URL');
    if (!appUrl) {
      throw new BadRequestException(
        'Set the app web address (APP_URL) under Administration → Configuration first — QuickBooks needs it to know where to send you back.',
      );
    }
    return `${appUrl.replace(/\/+$/, '')}/api/admin/qbo/callback`;
  }

  private basicAuth(clientId: string, clientSecret: string): string {
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  // ---------------------------------------------------------------------
  // The handshake
  // ---------------------------------------------------------------------

  authorizeUrl(user: AuthUser): string {
    const { clientId } = this.credentials();
    const state = randomBytes(24).toString('hex');
    for (const [k, v] of this.pending) if (v.expiresAt < Date.now()) this.pending.delete(k);
    this.pending.set(state, { userId: user.id, expiresAt: Date.now() + STATE_TTL_MS });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', QBO_SCOPE);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleCallback(
    query: { code?: string; realmId?: string; state?: string; error?: string },
    user: AuthUser,
  ): Promise<QboStatus> {
    if (query.error) {
      throw new BadRequestException(`QuickBooks declined the connection: ${query.error}`);
    }
    const { code, realmId, state } = query;
    if (!code || !realmId || !state) {
      throw new BadRequestException('QuickBooks did not return the expected authorization details.');
    }
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now() || pending.userId !== user.id) {
      throw new BadRequestException(
        'This QuickBooks authorization link expired or was not started by you — try connecting again.',
      );
    }

    const { clientId, clientSecret, environment } = this.credentials();
    const tokens = await this.exchangeCode(code, clientId, clientSecret);
    const now = Date.now();

    await this.prisma.qboConnection.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        environment,
        realmId,
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        refreshToken: encryptSecret(tokens.refresh_token),
        refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
        connectedById: user.id,
      },
      update: {
        environment,
        realmId,
        companyName: null, // filled in below once the company info call returns
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        refreshToken: encryptSecret(tokens.refresh_token),
        refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
        connectedById: user.id,
        connectedAt: new Date(),
      },
    });

    const companyName = await this.fetchCompanyName(realmId, environment, tokens.access_token).catch((e) => {
      this.log.warn(
        `Connected to QuickBooks but could not read the company name: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    });
    if (companyName) {
      await this.prisma.qboConnection.update({ where: { id: 1 }, data: { companyName } });
    }

    await this.audit.log({
      actorId: user.id,
      action: 'QBO_CONNECTED',
      detail: `Connected to QuickBooks Online (${environment}, company ${companyName ?? realmId})`,
      payload: { environment, realmId, companyName },
    });

    return this.status();
  }

  async disconnect(user: AuthUser): Promise<void> {
    const connection = await this.prisma.qboConnection.findUnique({ where: { id: 1 } });
    if (!connection) return;

    // Best-effort: an already-invalid token still needs the local row gone, so
    // a revoke failure must not block disconnecting here.
    try {
      const { clientId, clientSecret } = this.credentials();
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth(clientId, clientSecret),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: decryptSecret(connection.refreshToken) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.log.warn(`QuickBooks token revoke failed (disconnecting locally anyway): ${e instanceof Error ? e.message : e}`);
    }

    await this.prisma.qboConnection.delete({ where: { id: 1 } });
    await this.audit.log({
      actorId: user.id,
      action: 'QBO_DISCONNECTED',
      detail: `Disconnected from QuickBooks Online (was ${connection.environment}, company ${connection.companyName ?? connection.realmId})`,
      payload: { environment: connection.environment, realmId: connection.realmId },
    });
  }

  // ---------------------------------------------------------------------
  // Token lifecycle
  // ---------------------------------------------------------------------

  private async exchangeCode(code: string, clientId: string, clientSecret: string): Promise<QboTokenResponse> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new BadRequestException(`Could not connect to QuickBooks: ${await qboOAuthError(res)}`);
    return (await res.json()) as QboTokenResponse;
  }

  /**
   * A valid access token for the connected company, refreshing first if it is
   * within {@link REFRESH_SKEW_MS} of expiring. Every QBO API call goes
   * through this rather than reading the stored token directly, so nothing
   * else has to know Intuit's tokens are short-lived.
   */
  async ensureFreshToken(): Promise<{ accessToken: string; realmId: string; environment: QboEnvironment }> {
    const connection = await this.prisma.qboConnection.findUnique({ where: { id: 1 } });
    if (!connection) {
      throw new BadRequestException(
        'QuickBooks is not connected. Connect it under Administration → Configuration first.',
      );
    }
    if (connection.refreshTokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'The QuickBooks connection has expired (unused for over 100 days). Reconnect it under Administration → Configuration.',
      );
    }
    if (connection.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      return {
        accessToken: decryptSecret(connection.accessToken),
        realmId: connection.realmId,
        environment: connection.environment as QboEnvironment,
      };
    }

    const { clientId, clientSecret } = this.credentials();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decryptSecret(connection.refreshToken),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Could not refresh the QuickBooks connection: ${await qboOAuthError(res)}. Reconnect it under Administration → Configuration.`,
      );
    }
    const tokens = (await res.json()) as QboTokenResponse;
    const now = Date.now();
    const updated = await this.prisma.qboConnection.update({
      where: { id: 1 },
      data: {
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        // Intuit rotates the refresh token on every use; the old one becomes
        // invalid immediately, so it must be persisted every time, not just
        // when it is close to its own expiry.
        refreshToken: encryptSecret(tokens.refresh_token),
        refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000),
      },
    });
    return {
      accessToken: tokens.access_token,
      realmId: updated.realmId,
      environment: updated.environment as QboEnvironment,
    };
  }

  private async fetchCompanyName(realmId: string, environment: QboEnvironment, accessToken: string): Promise<string | null> {
    const res = await fetch(`${apiBase(environment)}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await qboAccountingError(res));
    const body = (await res.json()) as { CompanyInfo?: { CompanyName?: string } };
    return body.CompanyInfo?.CompanyName ?? null;
  }

  // ---------------------------------------------------------------------
  // Admin-facing status
  // ---------------------------------------------------------------------

  async status(): Promise<QboStatus> {
    const connection = await this.prisma.qboConnection.findUnique({ where: { id: 1 } });
    if (!connection) return { connected: false };
    return {
      connected: true,
      environment: connection.environment as QboEnvironment,
      realmId: connection.realmId,
      companyName: connection.companyName,
      connectedAt: connection.connectedAt.toISOString(),
      accessTokenExpiresAt: connection.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: connection.refreshTokenExpiresAt.toISOString(),
      refreshTokenExpired: connection.refreshTokenExpiresAt.getTime() < Date.now(),
    };
  }

  async isConnected(): Promise<boolean> {
    const connection = await this.prisma.qboConnection.findUnique({ where: { id: 1 }, select: { id: true } });
    return connection !== null;
  }
}
