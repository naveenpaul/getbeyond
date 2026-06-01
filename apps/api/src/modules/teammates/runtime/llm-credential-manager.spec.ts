import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptCredentials,
  generateMasterKey,
  loadMasterKey,
} from '../../connectors/credential-encryption';
import { LlmAuthError } from './llm-types';
import {
  LlmCredentialManager,
  LlmCredentialManagerError,
} from './llm-credential-manager';

/**
 * REGRESSION-IF-BROKEN — BYO-key isolation class (100% coverage required).
 *
 * Covers the three paths from the plan's test map:
 *   - seal/unseal round-trip (REAL credential-encryption, real master key)
 *   - wrong key → decrypt_failed → LlmAuthError
 *   - load scoped to orgId (cross-org isolation: org A's key never resolves
 *     for org B; assert the Prisma query is filtered by orgId)
 *
 * Prisma is mocked (an in-memory fake keyed on (orgId, provider)); explicit
 * vitest imports because the project runs with `globals: false`.
 */

type Provider = 'anthropic' | 'openai';

interface FakeRow {
  orgId: string;
  provider: Provider;
  apiKey: Buffer;
  keyVersion: number;
}

interface CompositeWhere {
  where: { orgId_provider: { orgId: string; provider: Provider } };
}

/**
 * In-memory fake of `prisma.orgLlmCredential` keyed on the composite unique
 * (orgId, provider) — exactly what the real `@@unique([orgId, provider])`
 * enforces. Modeling it this way means a cross-org lookup structurally misses,
 * which is the property under test.
 */
function makeFakePrisma(seed: FakeRow[] = []) {
  const key = (orgId: string, provider: Provider) => `${orgId}::${provider}`;
  const rows = new Map(seed.map((r) => [key(r.orgId, r.provider), { ...r }]));

  const findUnique = vi.fn(async ({ where }: CompositeWhere) => {
    const { orgId, provider } = where.orgId_provider;
    const found = rows.get(key(orgId, provider));
    return found ? { ...found } : null;
  });

  const upsert = vi.fn(
    async ({
      where,
      create,
      update,
    }: CompositeWhere & {
      create: FakeRow;
      update: { apiKey: Buffer; keyVersion: { increment: number } };
    }) => {
      const { orgId, provider } = where.orgId_provider;
      const k = key(orgId, provider);
      const existing = rows.get(k);
      if (existing) {
        existing.apiKey = update.apiKey;
        existing.keyVersion += update.keyVersion.increment;
        return { ...existing };
      }
      const row: FakeRow = { ...create };
      rows.set(k, row);
      return { ...row };
    },
  );

  return {
    prisma: { orgLlmCredential: { findUnique, upsert } },
    findUnique,
    upsert,
    rows,
  };
}

const TEST_MASTER_KEY = generateMasterKey();

describe('LlmCredentialManager', () => {
  const originalKey = process.env.CREDENTIAL_MASTER_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_MASTER_KEY = TEST_MASTER_KEY;
  });

  afterEach(() => {
    process.env.CREDENTIAL_MASTER_KEY = originalKey;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws master_key_missing when CREDENTIAL_MASTER_KEY is unset', () => {
      delete process.env.CREDENTIAL_MASTER_KEY;
      const { prisma } = makeFakePrisma();
      expect(() => new LlmCredentialManager(prisma as never)).toThrow(
        LlmCredentialManagerError,
      );
      try {
        new LlmCredentialManager(prisma as never);
      } catch (err) {
        expect((err as LlmCredentialManagerError).code).toBe('master_key_missing');
      }
    });

    it('throws master_key_missing when key is the placeholder value', () => {
      process.env.CREDENTIAL_MASTER_KEY = 'change-me-in-production';
      const { prisma } = makeFakePrisma();
      expect(() => new LlmCredentialManager(prisma as never)).toThrow(
        /placeholder/,
      );
    });
  });

  describe('save + load round-trip', () => {
    it('seals on save and unseals the same plaintext on load', async () => {
      const { prisma, upsert, rows } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      await mgr.save('org-1', 'anthropic', 'sk-ant-secret');

      // Stored as sealed bytes — never plaintext.
      const stored = rows.get('org-1::anthropic');
      expect(stored).toBeDefined();
      expect(Buffer.isBuffer(stored!.apiKey)).toBe(true);
      expect(stored!.apiKey.toString('utf8')).not.toContain('sk-ant-secret');
      expect(upsert).toHaveBeenCalledTimes(1);

      const loaded = await mgr.load('org-1', 'anthropic');
      expect(loaded).toBe('sk-ant-secret');
    });

    it('rotates the key and bumps keyVersion on re-save', async () => {
      const { prisma, rows } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      await mgr.save('org-1', 'openai', 'sk-old');
      expect(rows.get('org-1::openai')!.keyVersion).toBe(1);

      await mgr.save('org-1', 'openai', 'sk-new');
      expect(rows.get('org-1::openai')!.keyVersion).toBe(2);
      expect(await mgr.load('org-1', 'openai')).toBe('sk-new');
    });

    it('returns null when the org has no credential for the provider', async () => {
      const { prisma } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      expect(await mgr.load('org-1', 'anthropic')).toBeNull();
    });
  });

  describe('wrong key → decrypt_failed → LlmAuthError', () => {
    it('throws LlmAuthError when the master key cannot decrypt the row', async () => {
      // Seed a row sealed with a DIFFERENT master key — simulates a rotated /
      // wrong CREDENTIAL_MASTER_KEY.
      const otherKey = loadMasterKey(generateMasterKey());
      const sealedWithOtherKey = encryptCredentials(
        { apiKey: 'sk-unreachable' },
        otherKey,
      );
      const { prisma } = makeFakePrisma([
        {
          orgId: 'org-1',
          provider: 'anthropic',
          apiKey: sealedWithOtherKey,
          keyVersion: 1,
        },
      ]);
      const mgr = new LlmCredentialManager(prisma as never);

      await expect(mgr.load('org-1', 'anthropic')).rejects.toBeInstanceOf(
        LlmAuthError,
      );
    });

    it('LlmAuthError carries the provider and retains the encryption error as cause', async () => {
      const otherKey = loadMasterKey(generateMasterKey());
      const sealed = encryptCredentials({ apiKey: 'x' }, otherKey);
      const { prisma } = makeFakePrisma([
        { orgId: 'org-1', provider: 'openai', apiKey: sealed, keyVersion: 1 },
      ]);
      const mgr = new LlmCredentialManager(prisma as never);

      try {
        await mgr.load('org-1', 'openai');
        expect.unreachable('load should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmAuthError);
        const authErr = err as LlmAuthError;
        expect(authErr.provider).toBe('openai');
        expect(authErr.cause).toBeDefined();
        // Never leaks the plaintext key.
        expect(authErr.message).not.toContain('x');
      }
    });

    it('re-throws non-encryption errors unchanged (does not mask them as auth)', async () => {
      const { prisma, findUnique } = makeFakePrisma();
      const boom = new Error('db exploded');
      findUnique.mockRejectedValueOnce(boom);
      const mgr = new LlmCredentialManager(prisma as never);

      await expect(mgr.load('org-1', 'anthropic')).rejects.toBe(boom);
    });
  });

  describe('cross-org isolation (CRITICAL — load scoped to orgId)', () => {
    it("never resolves org A's key for org B", async () => {
      const { prisma, findUnique } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      // Org A saves a key.
      await mgr.save('org-A', 'anthropic', 'sk-A-only');

      // Org B has no key for the same provider → must get null, NOT org A's.
      const bResult = await mgr.load('org-B', 'anthropic');
      expect(bResult).toBeNull();

      // Org A still resolves its own.
      expect(await mgr.load('org-A', 'anthropic')).toBe('sk-A-only');

      // Assert the query was filtered by orgId on every load.
      const orgIdsQueried = findUnique.mock.calls.map(
        ([arg]) => (arg as CompositeWhere).where.orgId_provider.orgId,
      );
      expect(orgIdsQueried).toEqual(['org-B', 'org-A']);
      // No load was ever issued without an orgId in the composite filter.
      for (const [arg] of findUnique.mock.calls) {
        expect(
          (arg as CompositeWhere).where.orgId_provider.orgId,
        ).toBeTruthy();
      }
    });

    it('isolates two orgs that each hold a key for the same provider', async () => {
      const { prisma } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      await mgr.save('org-A', 'anthropic', 'sk-A');
      await mgr.save('org-B', 'anthropic', 'sk-B');

      expect(await mgr.load('org-A', 'anthropic')).toBe('sk-A');
      expect(await mgr.load('org-B', 'anthropic')).toBe('sk-B');
    });

    it('scopes the upsert write by (orgId, provider) too', async () => {
      const { prisma, upsert } = makeFakePrisma();
      const mgr = new LlmCredentialManager(prisma as never);

      await mgr.save('org-A', 'openai', 'sk-A');

      const [arg] = upsert.mock.calls[0] as [CompositeWhere];
      expect(arg.where.orgId_provider).toEqual({
        orgId: 'org-A',
        provider: 'openai',
      });
    });
  });
});
