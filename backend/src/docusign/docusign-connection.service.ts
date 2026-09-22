import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { decryptSecret, encryptSecret } from '../config/config.crypto';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOCUSIGN_SCOPE,
  DocuSignEnvironment,
  DocuSignTokenResponse,
  DocuSignUserInfoResponse,
  authorizeUrlBase,
  docusignOAuthError,
  revokeUrl,
  tokenUrl,
  userInfoUrl,
} from './docusign.types';

// Refresh a bit before actual expiry, same reasoning as QboConnectionService.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// How long the CSRF state token is honoured — same window as QBO's.
const STATE_TTL_MS = 10 * 60 * 1000;

export interface DocuSignStatus {
  connected: boolean;
  environment?: DocuSignEnvironment;
  accountId?: string;
  accountName?: string | null;
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
 * The DocuSign OAuth connection: authorizing it, keeping the access token
 * fresh, and tearing it down. Structured identically to
 * QboConnectionService — see that file for the fuller reasoning behind each
 * piece; this is the same shape applied to a different OAuth provider.
 *
 * One DocuSign account connected at a time (`DocuSignConnection` is a
 * singleton row, id fixed at 1). The CSRF `state` for the handshake lives in
 * an in-memory map, same tradeoff as QBO's — it only has to survive the
 * seconds a browser spends on DocuSign's consent screen.
 */
@Injectable()
export class DocuSignConnectionService {
  private readonly log = new Logger(DocuSignConnectionService.name);
  private pending = new Map<string, PendingState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // App credentials
  // ---------------------------------------------------------------------

  private credentials(): { clientId: string; clientSecret: string; environment: DocuSignEnvironment } {
    const clientId = this.config.get('DOCUSIGN_CLIENT_ID');
    const clientSecret = this.config.get('DOCUSIGN_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'Set the DocuSign integration key and secret key under Administration → Configuration first.',
      );
    }
    const environment: DocuSignEnvironment =
      this.config.get('DOCUSIGN_ENVIRONMENT')?.trim().toLowerCase() === 'production' ? 'production' : 'demo';
    return { clientId, clientSecret, environment };
  }

  /** Same derivation as QboConnectionService.redirectUri — see that file for why. */
  redirectUri(): string {
    const appUrl = this.config.get('APP_URL');
    if (!appUrl) {
      throw new BadRequestException(
        'Set the app web address (APP_URL) under Administration → Configuration first — DocuSign needs it to know where to send you back.',
      );
    }
    return `${appUrl.replace(/\/+$/, '')}/api/admin/docusign/callback`;
  }

  private basicAuth(clientId: string, clientSecret: string): string {
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  // ---------------------------------------------------------------------
  // The handshake
  // ---------------------------------------------------------------------

  authorizeUrl(user: AuthUser): string {
    const { clientId, environment } = this.credentials();
    const state = randomBytes(24).toString('hex');
    for (const [k, v] of this.pending) if (v.expiresAt < Date.now()) this.pending.delete(k);
    this.pending.set(state, { userId: user.id, expiresAt: Date.now() + STATE_TTL_MS });

    const url = new URL(authorizeUrlBase(environment));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', DOCUSIGN_SCOPE);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleCallback(
    query: { code?: string; state?: string; error?: string },
    user: AuthUser,
  ): Promise<DocuSignStatus> {
    if (query.error) {
      throw new BadRequestException(`DocuSign declined the connection: ${query.error}`);
    }
    const { code, state } = query;
    if (!code || !state) {
      throw new BadRequestException('DocuSign did not return the expected authorization details.');
    }
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now() || pending.userId !== user.id) {
      throw new BadRequestException(
        'This DocuSign authorization link expired or was not started by you — try connecting again.',
      );
    }

    const { clientId, clientSecret, environment } = this.credentials();
    const tokens = await this.exchangeCode(code, clientId, clientSecret, environment);
    const info = await this.fetchUserInfo(environment, tokens.access_token);
    const account = info.accounts.find((a) => a.is_default) ?? info.accounts[0];
    if (!account) {
      throw new BadRequestException('DocuSign did not return an account to connect — try again.');
    }

    const now = Date.now();
    await this.prisma.docuSignConnection.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        environment,
        accountId: account.account_id,
        baseUri: account.base_uri,
        accountName: account.account_name,
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        refreshToken: encryptSecret(tokens.refresh_token),
        // DocuSign does not hand back a refresh-token lifetime the way Intuit
        // does (x_refresh_token_expires_in) — its refresh tokens are valid for
        // as long as the authorization is not revoked, with no fixed TTL to
        // track. Recorded here at a conservative 30 days purely so
        // ensureFreshToken's "reconnect if this has clearly gone stale" check
        // has something to compare against; unlike QBO's 100-day inactivity
        // window this is not a value DocuSign documents, so treat it as a
        // soft, renewable-on-use marker rather than a hard fact from DocuSign
        // — see ensureFreshToken below, which pushes it forward on every
        // successful refresh.
        refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        connectedById: user.id,
      },
      update: {
        environment,
        accountId: account.account_id,
        baseUri: account.base_uri,
        accountName: account.account_name,
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        refreshToken: encryptSecret(tokens.refresh_token),
        refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        connectedById: user.id,
        connectedAt: new Date(),
      },
    });

    await this.audit.log({
      actorId: user.id,
      action: 'DOCUSIGN_CONNECTED',
      detail: `Connected to DocuSign (${environment}, account ${account.account_name || account.account_id})`,
      payload: { environment, accountId: account.account_id, accountName: account.account_name },
    });

    return this.status();
  }

  async disconnect(user: AuthUser): Promise<void> {
    const connection = await this.prisma.docuSignConnection.findUnique({ where: { id: 1 } });
    if (!connection) return;

    // Best-effort, same reasoning as QboConnectionService.disconnect: an
    // already-invalid token still needs the local row gone.
    try {
      const { clientId, clientSecret } = this.credentials();
      await fetch(revokeUrl(connection.environment as DocuSignEnvironment), {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          token: decryptSecret(connection.refreshToken),
          token_type_hint: 'refresh_token',
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.log.warn(`DocuSign token revoke failed (disconnecting locally anyway): ${e instanceof Error ? e.message : e}`);
    }

    await this.prisma.docuSignConnection.delete({ where: { id: 1 } });
    await this.audit.log({
      actorId: user.id,
      action: 'DOCUSIGN_DISCONNECTED',
      detail: `Disconnected from DocuSign (was ${connection.environment}, account ${connection.accountName ?? connection.accountId})`,
      payload: { environment: connection.environment, accountId: connection.accountId },
    });
  }

  // ---------------------------------------------------------------------
  // Token lifecycle
  // ---------------------------------------------------------------------

  private async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    environment: DocuSignEnvironment,
  ): Promise<DocuSignTokenResponse> {
    const res = await fetch(tokenUrl(environment), {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      // DocuSign's token endpoint does not require redirect_uri on the code
      // exchange the way some providers do (it was already validated against
      // the app's registered redirect URIs at the authorize step) — omitted
      // on purpose, not an oversight.
      body: new URLSearchParams({ grant_type: 'authorization_code', code }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new BadRequestException(`Could not connect to DocuSign: ${await docusignOAuthError(res)}`);
    return (await res.json()) as DocuSignTokenResponse;
  }

  private async fetchUserInfo(environment: DocuSignEnvironment, accessToken: string): Promise<DocuSignUserInfoResponse> {
    const res = await fetch(userInfoUrl(environment), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BadRequestException(`Could not read the DocuSign account: ${await docusignOAuthError(res)}`);
    return (await res.json()) as DocuSignUserInfoResponse;
  }

  /**
   * A valid access token for the connected account, refreshing first if it
   * is within {@link REFRESH_SKEW_MS} of expiring. Every DocuSign API call
   * goes through this — mirrors QboConnectionService.ensureFreshToken.
   */
  async ensureFreshToken(): Promise<{ accessToken: string; accountId: string; baseUri: string; environment: DocuSignEnvironment }> {
    const connection = await this.prisma.docuSignConnection.findUnique({ where: { id: 1 } });
    if (!connection) {
      throw new BadRequestException('DocuSign is not connected. Connect it under Administration → Configuration first.');
    }
    if (connection.refreshTokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'The DocuSign connection has gone stale. Reconnect it under Administration → Configuration.',
      );
    }
    if (connection.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      return {
        accessToken: decryptSecret(connection.accessToken),
        accountId: connection.accountId,
        baseUri: connection.baseUri,
        environment: connection.environment as DocuSignEnvironment,
      };
    }

    const { clientId, clientSecret, environment } = this.credentials();
    const res = await fetch(tokenUrl(environment), {
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
        `Could not refresh the DocuSign connection: ${await docusignOAuthError(res)}. Reconnect it under Administration → Configuration.`,
      );
    }
    const tokens = (await res.json()) as DocuSignTokenResponse;
    const now = Date.now();
    const updated = await this.prisma.docuSignConnection.update({
      where: { id: 1 },
      data: {
        accessToken: encryptSecret(tokens.access_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        // DocuSign issues a new refresh token on every use, same as Intuit —
        // must be persisted every time, not just near its own expiry.
        refreshToken: encryptSecret(tokens.refresh_token),
        refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return {
      accessToken: tokens.access_token,
      accountId: updated.accountId,
      baseUri: updated.baseUri,
      environment: updated.environment as DocuSignEnvironment,
    };
  }

  // ---------------------------------------------------------------------
  // Admin-facing status
  // ---------------------------------------------------------------------

  async status(): Promise<DocuSignStatus> {
    const connection = await this.prisma.docuSignConnection.findUnique({ where: { id: 1 } });
    if (!connection) return { connected: false };
    return {
      connected: true,
      environment: connection.environment as DocuSignEnvironment,
      accountId: connection.accountId,
      accountName: connection.accountName,
      connectedAt: connection.connectedAt.toISOString(),
      accessTokenExpiresAt: connection.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: connection.refreshTokenExpiresAt.toISOString(),
      refreshTokenExpired: connection.refreshTokenExpiresAt.getTime() < Date.now(),
    };
  }

  async isConnected(): Promise<boolean> {
    const connection = await this.prisma.docuSignConnection.findUnique({ where: { id: 1 }, select: { id: true } });
    return connection !== null;
  }
}
