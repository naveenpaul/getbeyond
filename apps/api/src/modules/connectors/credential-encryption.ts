import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for `ConnectorAccount.credentials` (eng-review pass-2
 * D4 + codex T5 + critical silent gap #3 from pass-1).
 *
 * Algorithm: ChaCha20-Poly1305 AEAD via Node's built-in crypto module.
 *   - 32-byte key (from CREDENTIAL_MASTER_KEY env, base64-encoded)
 *   - 12-byte random nonce per encryption
 *   - 16-byte Poly1305 MAC appended
 * Sealed buffer layout: `nonce(12) || ciphertext || tag(16)`.
 *
 * Hard rule: this module is the ONLY place credentials are ever in plaintext
 * outside an adapter's `execute()` boundary. Errors thrown here MUST NOT
 * include plaintext or key material — they land in logs.
 *
 * (We were on libsodium-wrappers earlier; switched to Node crypto when 0.7.16
 * shipped a broken ESM entry point. Same security guarantees, no external dep.)
 */

const ALGO = 'chacha20-poly1305';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialEncryptionError extends Error {
  constructor(
    public readonly reason:
      | 'invalid_key'
      | 'decrypt_failed'
      | 'malformed_ciphertext',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

/**
 * Load + validate the master key from a base64 string. Generate one with
 * `openssl rand -base64 32` or {@link generateMasterKey}.
 */
export function loadMasterKey(base64Key: string): Buffer {
  if (!base64Key) {
    throw new CredentialEncryptionError(
      'invalid_key',
      'CREDENTIAL_MASTER_KEY is empty',
    );
  }
  const key = Buffer.from(base64Key, 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new CredentialEncryptionError(
      'invalid_key',
      `CREDENTIAL_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.byteLength}`,
    );
  }
  return key;
}

/** Generate a fresh random 32-byte master key as base64. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Seal a credentials object. Output is `nonce(12) || ciphertext(>=0) || tag(16)`
 * as a Buffer ready to write to a Prisma Bytes column.
 */
export function encryptCredentials(
  plaintext: Record<string, unknown>,
  masterKey: Buffer,
): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, nonce, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Unseal a credentials buffer. Throws `CredentialEncryptionError` on:
 *   - malformed_ciphertext (buffer shorter than nonce + tag)
 *   - decrypt_failed (MAC verification failure — wrong key or tampered bytes)
 *
 * Error messages NEVER include plaintext or key material.
 */
export function decryptCredentials<T = Record<string, unknown>>(
  sealed: Buffer,
  masterKey: Buffer,
): T {
  if (sealed.byteLength < NONCE_BYTES + TAG_BYTES) {
    throw new CredentialEncryptionError(
      'malformed_ciphertext',
      `sealed buffer too short (need >= ${NONCE_BYTES + TAG_BYTES} bytes)`,
    );
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.byteLength - TAG_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.byteLength - TAG_BYTES);

  const decipher = createDecipheriv(ALGO, masterKey, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    throw new CredentialEncryptionError(
      'decrypt_failed',
      'MAC verification failed (wrong key or tampered ciphertext)',
    );
  }
}
