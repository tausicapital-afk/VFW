/**
 * Shared constants for the Google Workspace OAuth handshake — same shape as
 * qbo.types.ts, mirrored deliberately: this codebase hand-rolls OAuth 2.0
 * authorization-code flows with plain fetch rather than a passport/SDK
 * dependency, and Google's flow follows the same three calls (authorize,
 * exchange, read the identity) as Intuit's.
 */

export const GOOGLE_SCOPE = 'openid email profile';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleTokenResponse {
  access_token: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/** The subset of the OIDC userinfo response this app actually reads. */
export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Google's token/userinfo error shape is typically `{ error, error_description }`. */
export async function googleOAuthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    if (body.error) return `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`;
  } catch {
    // Non-JSON body — the status is all we have.
  }
  return `Google returned ${res.status}`;
}
