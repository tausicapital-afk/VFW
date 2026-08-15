/**
 * Shared constants and the one error shape every Intuit endpoint this module
 * calls can return, so callers get a readable message instead of a raw HTTP
 * status.
 */

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export type QboEnvironment = 'sandbox' | 'production';

export function apiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
  token_type: string;
}

/** The Accounting API's fault envelope: `{ Fault: { Error: [{ Message, Detail }] } }`. */
export async function qboAccountingError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      Fault?: { Error?: { Message?: string; Detail?: string }[] };
    };
    const first = body.Fault?.Error?.[0];
    if (first?.Message) return `${first.Message}${first.Detail ? ` — ${first.Detail}` : ''}`;
  } catch {
    // Non-JSON body — the status is all we have.
  }
  return `QuickBooks returned ${res.status}`;
}

/** The OAuth/token endpoint's error shape: `{ error, error_description }`. */
export async function qboOAuthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    if (body.error) return `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`;
  } catch {
    // Non-JSON body — the status is all we have.
  }
  return `QuickBooks returned ${res.status}`;
}
