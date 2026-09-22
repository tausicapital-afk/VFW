/**
 * Shared constants and response shapes for DocuSign's eSignature REST API
 * (v2.1) and its Authorization Code Grant OAuth flow.
 *
 * Modelled on qbo.types.ts: both Intuit and DocuSign are a standard OAuth 2.0
 * authorization-code dance (authorize URL -> redirect back with a code ->
 * exchange for access+refresh tokens -> refresh before expiry), so the shape
 * here deliberately mirrors that file closely.
 *
 * UNVERIFIED AGAINST LIVE DOCUSIGN: this environment has no network access to
 * confirm the exact field names/endpoints against DocuSign's current docs, so
 * everything below is built from training-data knowledge of the eSignature
 * API v2.1 + Authorization Code Grant, applied as precisely as possible. A
 * reviewer connecting a real DocuSign demo account should sanity-check this
 * file first if the OAuth handshake or an envelope call behaves unexpectedly
 * — see the inline notes below for the specific spots most likely to need a
 * correction (token endpoint auth style, the envelope JSON shape, and the
 * combined-document download path).
 */

export type DocuSignEnvironment = 'demo' | 'production';

// Account/authorization host. Distinct from the per-connection API host
// (`baseUri`, returned by userinfo below) — DocuSign accounts are each
// provisioned onto one of several regional API hosts (na1/na2/na3/eu/…),
// which the auth host has no way to know in advance.
function authBase(environment: DocuSignEnvironment): string {
  return environment === 'production' ? 'https://account.docusign.com' : 'https://account-d.docusign.com';
}

export function authorizeUrlBase(environment: DocuSignEnvironment): string {
  return `${authBase(environment)}/oauth/auth`;
}

export function tokenUrl(environment: DocuSignEnvironment): string {
  return `${authBase(environment)}/oauth/token`;
}

export function revokeUrl(environment: DocuSignEnvironment): string {
  return `${authBase(environment)}/oauth/revoke`;
}

export function userInfoUrl(environment: DocuSignEnvironment): string {
  return `${authBase(environment)}/oauth/userinfo`;
}

/**
 * `signature` is the one scope this integration needs (create/send envelopes,
 * read their status and documents). Unlike Google's OAuth in this same
 * codebase (google-sso.service.ts), DocuSign's authorization-code grant
 * returns a refresh token by default — no extra "offline access" scope to
 * request.
 */
export const DOCUSIGN_SCOPE = 'signature';

export interface DocuSignTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number; // seconds — access token lifetime (DocuSign: ~1 hour)
  scope?: string;
}

/**
 * GET {authBase}/oauth/userinfo, called with the fresh access token right
 * after exchanging the code. This is where accountId/baseUri come from —
 * there is no admin-typed equivalent of QBO's realmId here.
 */
export interface DocuSignUserInfoResponse {
  sub: string;
  name?: string;
  email?: string;
  accounts: {
    account_id: string;
    is_default: boolean;
    account_name: string;
    // Host only, e.g. "https://demo.docusign.net" or "https://na3.docusign.net"
    // — API calls go to `${base_uri}/restapi/v2.1/accounts/${account_id}/...`.
    base_uri: string;
  }[];
}

/** Every eSignature REST call is scoped under this base. */
export function apiAccountBase(baseUri: string, accountId: string): string {
  return `${baseUri.replace(/\/+$/, '')}/restapi/v2.1/accounts/${accountId}`;
}

/** The envelope statuses this app tracks — see SignatureRequestStatus in schema.prisma. */
export const TRACKED_ENVELOPE_STATUSES = ['sent', 'delivered', 'completed', 'declined', 'voided'] as const;
export type TrackedEnvelopeStatus = (typeof TRACKED_ENVELOPE_STATUSES)[number];

/** The OAuth/token endpoint's error shape: `{ error, error_description }` — same convention as Intuit's. */
export async function docusignOAuthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    if (body.error) return `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`;
  } catch {
    // Non-JSON body — the status is all we have.
  }
  return `DocuSign returned ${res.status}`;
}

/** DocuSign wants the document's extension named explicitly, separate from its filename. */
export function fileExtensionOf(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : 'pdf';
}

/** The eSignature REST API's error envelope: `{ errorCode, message }`. */
export async function docusignApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errorCode?: string; message?: string };
    if (body.message) return `${body.errorCode ? `${body.errorCode}: ` : ''}${body.message}`;
  } catch {
    // Non-JSON body (e.g. a binary/PDF endpoint failing) — the status is all we have.
  }
  return `DocuSign returned ${res.status}`;
}
