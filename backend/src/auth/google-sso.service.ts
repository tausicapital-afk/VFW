import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '../config/config.service';
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_SCOPE,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GoogleTokenResponse,
  GoogleUserInfo,
  googleOAuthError,
} from './google-sso.types';

// How long the CSRF `state` is honoured — long enough to sit on Google's
// consent screen, short enough that a leaked/logged value is useless shortly
// after. Same tradeoff and same value as QboConnectionService.STATE_TTL_MS.
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The Google Workspace OAuth handshake: sending the browser to Google and
 * exchanging what comes back for the signed-in Google account's email.
 *
 * This is OAuth *mechanics only* — it never touches the User table or decides
 * who may sign in. AuthService.loginWithGoogle owns that decision (existing
 * user only, see its docstring); this service just answers "which Google
 * account, if any, completed the handshake that started at authorizeUrl()".
 *
 * Modelled directly on QboConnectionService: hand-rolled fetch calls, no
 * passport/SDK dependency, credentials read from ConfigService with a loud
 * error when unset, and an in-memory CSRF-state map (fine for one instance,
 * same tradeoff documented on QboConnectionService — the state only has to
 * survive the seconds a browser spends on Google's consent screen).
 */
@Injectable()
export class GoogleSsoService {
  private readonly log = new Logger(GoogleSsoService.name);
  private pending = new Map<string, number>(); // state -> expiresAt

  constructor(private readonly config: ConfigService) {}

  private credentials(): { clientId: string; clientSecret: string } {
    const clientId = this.config.get('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.',
      );
    }
    return { clientId, clientSecret };
  }

  /**
   * Where Google sends the browser back to — the backend callback, reached
   * through the frontend's /api proxy exactly like the QBO callback. Computed
   * from APP_URL rather than a separately-typed setting so it can never drift
   * from what the proxy actually answers on.
   */
  private redirectUri(): string {
    const appUrl = this.config.get('APP_URL');
    if (!appUrl) {
      throw new BadRequestException('Set the app web address (APP_URL) before enabling Google sign-in.');
    }
    return `${appUrl.replace(/\/+$/, '')}/api/auth/google/callback`;
  }

  /** Where the frontend itself lives, so the callback can send the browser home. */
  frontendUrl(): string {
    const appUrl = this.config.get('APP_URL');
    if (!appUrl) {
      throw new BadRequestException('Set the app web address (APP_URL) before enabling Google sign-in.');
    }
    return appUrl.replace(/\/+$/, '');
  }

  authorizeUrl(): string {
    const { clientId } = this.credentials();
    const state = randomBytes(24).toString('hex');
    for (const [k, expiresAt] of this.pending) if (expiresAt < Date.now()) this.pending.delete(k);
    this.pending.set(state, Date.now() + STATE_TTL_MS);

    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPE);
    url.searchParams.set('state', state);
    // Google re-shows the consent screen only the first time by default; this
    // just keeps the prompt to an account picker rather than forcing "allow"
    // every single sign-in.
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  /**
   * Exchange the callback's code for the Google account's email. Throws a
   * BadRequestException (readable, safe to redirect the browser with) on any
   * failure — expired/replayed state, a code Google rejects, or an
   * unverified email address, which this app will not treat as a proven
   * identity.
   */
  async resolveCallback(query: { code?: string; state?: string; error?: string }): Promise<GoogleUserInfo> {
    if (query.error) {
      throw new BadRequestException(`Google declined the sign-in: ${query.error}`);
    }
    const { code, state } = query;
    if (!code || !state) {
      throw new BadRequestException('Google did not return the expected authorization details.');
    }
    const expiresAt = this.pending.get(state);
    this.pending.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      throw new BadRequestException('This sign-in link expired — try again.');
    }

    const { clientId, clientSecret } = this.credentials();
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.redirectUri(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!tokenRes.ok) {
      throw new BadRequestException(`Could not complete Google sign-in: ${await googleOAuthError(tokenRes)}`);
    }
    const tokens = (await tokenRes.json()) as GoogleTokenResponse;

    // The userinfo endpoint, not a locally-decoded ID token: the point of
    // calling it with the access_token we just received is that Google's own
    // TLS-authenticated response IS the proof, with no JWT signature/JWKS
    // verification to hand-roll here — the same "call the provider, trust the
    // authenticated response" shape QboConnectionService uses for
    // fetchCompanyName.
    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!infoRes.ok) {
      throw new BadRequestException(`Could not read the Google account: ${await googleOAuthError(infoRes)}`);
    }
    const info = (await infoRes.json()) as GoogleUserInfo;
    if (!info.sub) {
      throw new BadRequestException('Google did not return an account identifier.');
    }
    if (!info.email || info.email_verified === false) {
      throw new BadRequestException('That Google account does not have a verified email address.');
    }
    return info;
  }
}
