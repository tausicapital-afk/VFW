import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Encryption for secret config values (SMTP password, R2 secret key) held in the
 * database.
 *
 * Why encrypt at all? Moving these secrets out of env and into the DB — so a
 * non-technical admin can set them — means a database dump now contains live
 * third-party credentials. Encrypting at rest keeps a dump from being a
 * ready-to-use set of keys: the ciphertext is worthless without the root key,
 * which stays in the environment and is never written to a table.
 *
 * The root key is CONFIG_ENC_KEY if set, otherwise JWT_SECRET — the app already
 * has one bootstrap secret in env and treats it as "rotate deliberately, rarely"
 * (see docs/architecture.md §10.3). A dedicated CONFIG_ENC_KEY is preferred in
 * production precisely so rotating the session key does not also make every
 * stored secret undecryptable; the fallback exists so the feature works out of
 * the box without adding a second mandatory env var.
 *
 * Cipher is AES-256-GCM (authenticated: a tampered ciphertext fails to decrypt
 * rather than returning garbage). Stored form is a self-describing string:
 *
 *     enc:v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
 */

const PREFIX = 'enc:v1:';
// A fixed salt is fine here: the salt exists to domain-separate this key from any
// other use of the same root secret, not to be per-record. The per-record
// randomness that matters is the IV, which is fresh on every encrypt.
const KEY_SALT = 'vfw-config-encryption-v1';

export class ConfigEncryptionUnavailableError extends Error {
  constructor() {
    super(
      'No encryption key is available for storing secret configuration. ' +
        'Set CONFIG_ENC_KEY (or JWT_SECRET) in the environment.',
    );
  }
}

function rootKey(): Buffer {
  const secret = process.env.CONFIG_ENC_KEY?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) throw new ConfigEncryptionUnavailableError();
  // Derive a 32-byte AES key so the AES key is never the literal root secret.
  return scryptSync(secret, KEY_SALT, 32);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', rootKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

/**
 * Reverse of {@link encryptSecret}. Throws if the value is not in the expected
 * form or the root key has changed since it was written — a caller that cannot
 * decrypt a stored secret must fail loudly, not serve a corrupt credential.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    throw new Error('Value is not an encrypted config secret');
  }
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted config secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', rootKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
