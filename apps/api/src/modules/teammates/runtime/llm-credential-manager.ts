import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CredentialEncryptionError,
  decryptCredentials,
  encryptCredentials,
  loadMasterKey,
} from '../../connectors/credential-encryption';
import { LlmAuthError } from './llm-types';

/**
 * LlmCredentialManager (LLM provider abstraction, P3).
 *
 * Owns the lifecycle of `OrgLlmCredential.apiKey` — the org's bring-your-own
 * LLM key. Deliberately MUCH thinner than the connector `CredentialManager`:
 *
 *   - Seal on save, unseal on load — reuses `credential-encryption.ts`
 *     primitives directly (no reimplemented crypto).
 *   - No OAuth, no refresh, no circuit breaker, no singleflight. A raw API key
 *     does not rotate behind our back the way an OAuth token does.
 *   - EVERY query is scoped to `orgId`. An org's key must never resolve for a
 *     different org (BYO-key isolation — a REGRESSION-IF-BROKEN path; a leak
 *     here would be silent and cross-tenant).
 *   - A wrong/rotated master key (decrypt failure) surfaces as the neutral
 *     `LlmAuthError` — the same class the provider adapters raise for a bad
 *     vendor key — so the runtime treats "can't decrypt our copy of your key"
 *     and "vendor rejected your key" identically: re-enter your key.
 *
 * Hard rule (inherited from credential-encryption.ts): errors thrown here
 * NEVER include plaintext key material — they land in logs.
 *
 * Pre-conditions:
 *   - `CREDENTIAL_MASTER_KEY` env var is a base64-encoded 32-byte key. Loaded
 *     once at instantiation; rotation requires a process restart.
 */

/** Plaintext shape of the sealed `OrgLlmCredential.apiKey` payload. */
interface SealedApiKey {
  apiKey: string;
}

export class LlmCredentialManagerError extends Error {
  constructor(
    public readonly code: 'master_key_missing',
    message: string,
  ) {
    super(message);
    this.name = 'LlmCredentialManagerError';
  }
}

@Injectable()
export class LlmCredentialManager {
  // Explicit field + @Inject + manual assignment (NOT param-property shorthand):
  // vitest/esbuild drops design:paramtypes metadata, so the shorthand injects
  // undefined under test. See getbeyond CLAUDE.md "NestJS DI — pitfall".
  private readonly prisma: PrismaService;
  private readonly masterKey: Buffer;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    const base64Key = process.env.CREDENTIAL_MASTER_KEY ?? '';
    if (!base64Key || base64Key === 'change-me-in-production') {
      throw new LlmCredentialManagerError(
        'master_key_missing',
        'CREDENTIAL_MASTER_KEY is not set or still at the placeholder value',
      );
    }
    this.masterKey = loadMasterKey(base64Key);
  }

  /**
   * Persist (or rotate) an org's BYO key for a provider. Seals the key at this
   * boundary so callers never touch the master key. Upserts on
   * (orgId, provider) — re-saving rotates the key and bumps `keyVersion`.
   */
  async save(orgId: string, provider: Provider, apiKey: string): Promise<void> {
    const sealed = encryptCredentials({ apiKey } satisfies SealedApiKey, this.masterKey);
    await this.prisma.orgLlmCredential.upsert({
      where: { orgId_provider: { orgId, provider } },
      create: {
        orgId,
        provider,
        apiKey: sealed,
        keyVersion: 1,
      },
      update: {
        apiKey: sealed,
        keyVersion: { increment: 1 },
      },
    });
  }

  /**
   * Load + decrypt an org's BYO key for a provider.
   *
   * Returns `null` when the org has no credential row for that provider (the
   * caller — the resolver in P4 — decides whether to fall back to env or block
   * the run). Throws `LlmAuthError` when a row exists but cannot be decrypted
   * (wrong/rotated master key, or tampered bytes).
   *
   * The query is scoped to `(orgId, provider)`: org A's key is structurally
   * unreachable from org B's `orgId`.
   */
  async load(orgId: string, provider: Provider): Promise<string | null> {
    const row = await this.prisma.orgLlmCredential.findUnique({
      where: { orgId_provider: { orgId, provider } },
    });
    if (!row) {
      return null;
    }
    try {
      const { apiKey } = decryptCredentials<SealedApiKey>(
        row.apiKey as Buffer,
        this.masterKey,
      );
      return apiKey;
    } catch (err) {
      if (err instanceof CredentialEncryptionError) {
        // Normalize to the neutral auth error. The encryption module already
        // strips key material from the message, so wrapping is safe.
        throw new LlmAuthError(provider, err);
      }
      throw err;
    }
  }
}
