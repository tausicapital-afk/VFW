/**
 * TOTP (RFC 6238) helpers, backed by `otplib` — the smallest well-established
 * library for this, chosen over hand-rolling HMAC-SHA1 time steps because a
 * second factor is exactly the kind of primitive worth not re-deriving.
 *
 * Secrets are generated and verified here; encrypting them at rest for
 * storage is the caller's job via config.crypto's encryptSecret/decryptSecret
 * (already used for SMTP/R2/QBO credentials) — this module never sees a
 * database row.
 */
import { generateSecret, generateURI, verify } from 'otplib';

const ISSUER = 'VFW Console';

/** ±1 time step (30s) of clock drift tolerance — standard authenticator-app practice. */
const EPOCH_TOLERANCE_S = 30;

/** A fresh base32 secret, ready to store (encrypted) or render into a QR/URI. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** The `otpauth://` URI an authenticator app scans or is pasted with. */
export function totpUri(secret: string, accountEmail: string): string {
  return generateURI({ issuer: ISSUER, label: accountEmail, secret });
}

/** Six digits, nothing else — reject anything malformed before it reaches the HMAC compare. */
export function isTotpCodeShape(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  if (!isTotpCodeShape(code)) return false;
  const result = await verify({ secret, token: code, epochTolerance: EPOCH_TOLERANCE_S });
  return result.valid;
}
