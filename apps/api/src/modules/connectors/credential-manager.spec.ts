import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptCredentials,
  generateMasterKey,
  loadMasterKey,
} from './credential-encryption';
import {
  CredentialManager,
  CredentialManagerError,
  RefreshRejectedError,
} from './credential-manager';
import { CIRCUIT_OPEN_THRESHOLD } from './circuit-breaker';

/**
 * Unit tests against an in-memory fake Prisma client. Real DB coverage
 * (concurrent refresh, CAS race) lives in `credential-manager.integration.spec.ts`.
 */

interface FakeAccount {
  id: string;
  status: 'active' | 'expired' | 'revoked' | 'circuit_broken' | 'error';
  credentials: Buffer;
  credentialsVersion: number;
  circuitOpenedAt: Date | null;
  lastError: string | null;
}

function makeFakePrisma(seed: FakeAccount[]) {
  const accounts = new Map(seed.map((a) => [a.id, { ...a }]));
  return {
    connectorAccount: {
      // Clone on read — real Prisma always returns fresh objects, so the
      // service's `account` snapshot doesn't track mid-flight DB mutations.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const existing = accounts.get(where.id);
        return existing ? { ...existing } : null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeAccount>;
        }) => {
          const existing = accounts.get(where.id);
          if (!existing) throw new Error('not found');
          Object.assign(existing, data);
          return existing;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; credentialsVersion?: number };
          data: Partial<FakeAccount>;
        }) => {
          const existing = accounts.get(where.id);
          if (!existing) return { count: 0 };
          if (
            where.credentialsVersion !== undefined &&
            existing.credentialsVersion !== where.credentialsVersion
          ) {
            return { count: 0 };
          }
          Object.assign(existing, data);
          return { count: 1 };
        },
      ),
    },
    _accounts: accounts,
  };
}

const ORIGINAL_MASTER_KEY = process.env.CREDENTIAL_MASTER_KEY;
const BASE64_KEY = generateMasterKey();

beforeEach(() => {
  process.env.CREDENTIAL_MASTER_KEY = BASE64_KEY;
});

function instantiate(seed: FakeAccount[]): {
  manager: CredentialManager;
  prisma: ReturnType<typeof makeFakePrisma>;
} {
  const prisma = makeFakePrisma(seed);
  // Cast: the manager only touches the connectorAccount model.
  const manager = new CredentialManager(prisma as never);
  return { manager, prisma };
}

function sealedCreds(plaintext: Record<string, unknown>): Buffer {
  return encryptCredentials(plaintext, loadMasterKey(BASE64_KEY));
}

afterEachCleanup();

function afterEachCleanup() {
  // Restore env after suite for hygiene with other suites in the same process.
  // (vitest runs each file in its own worker, but this is cheap insurance.)
  process.on('exit', () => {
    if (ORIGINAL_MASTER_KEY === undefined) {
      delete process.env.CREDENTIAL_MASTER_KEY;
    } else {
      process.env.CREDENTIAL_MASTER_KEY = ORIGINAL_MASTER_KEY;
    }
  });
}

describe('CredentialManager — construction', () => {
  it('throws master_key_missing when env var is absent', () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    expect(() => instantiate([])).toThrow(CredentialManagerError);
  });

  it('throws master_key_missing on the placeholder value', () => {
    process.env.CREDENTIAL_MASTER_KEY = 'change-me-in-production';
    try {
      instantiate([]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialManagerError);
      expect((err as CredentialManagerError).code).toBe('master_key_missing');
    }
  });

  it('throws when the env value is not a 32-byte base64 key', () => {
    process.env.CREDENTIAL_MASTER_KEY = Buffer.from('short').toString('base64');
    expect(() => instantiate([])).toThrow();
  });
});

describe('CredentialManager.load', () => {
  it('decrypts credentials for an active account', async () => {
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'tok-1' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const creds = await manager.load('acct-1');
    expect(creds).toEqual({ accessToken: 'tok-1' });
  });

  it('throws not_found when the account does not exist', async () => {
    const { manager } = instantiate([]);
    try {
      await manager.load('nope');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialManagerError).code).toBe('not_found');
    }
  });

  it('throws expired when status=expired', async () => {
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'expired',
        credentials: sealedCreds({ accessToken: 'tok-1' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: 'refresh token rejected',
      },
    ]);
    try {
      await manager.load('acct-1');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialManagerError).code).toBe('expired');
    }
  });

  it('throws expired when status=revoked', async () => {
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'revoked',
        credentials: sealedCreds({ accessToken: 'tok-1' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);
    try {
      await manager.load('acct-1');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialManagerError).code).toBe('expired');
    }
  });

  it('throws circuit_broken inside the cooldown window', async () => {
    const openedAt = new Date(Date.now() - 60_000); // 1 min ago — well inside 5 min
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'circuit_broken',
        credentials: sealedCreds({ accessToken: 'tok-1' }),
        credentialsVersion: 1,
        circuitOpenedAt: openedAt,
        lastError: '5xx storm: circuit opened',
      },
    ]);
    try {
      await manager.load('acct-1');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialManagerError).code).toBe('circuit_broken');
    }
  });

  it('half-open transition: clears state + returns creds after cooldown elapses', async () => {
    const openedAt = new Date(Date.now() - 10 * 60_000); // 10 min ago — past 5 min cooldown
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'circuit_broken',
        credentials: sealedCreds({ accessToken: 'tok-1' }),
        credentialsVersion: 1,
        circuitOpenedAt: openedAt,
        lastError: '5xx storm: circuit opened',
      },
    ]);

    const creds = await manager.load('acct-1');
    expect(creds).toEqual({ accessToken: 'tok-1' });

    const after = prisma._accounts.get('acct-1');
    expect(after?.status).toBe('active');
    expect(after?.circuitOpenedAt).toBeNull();
    expect(after?.lastError).toBeNull();
  });
});

describe('CredentialManager.refresh', () => {
  it('persists new credentials and bumps credentialsVersion on success', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old', refreshToken: 'r1' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const refresher = vi.fn(async () => ({
      next: { accessToken: 'new', refreshToken: 'r2' },
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    }));

    const result = await manager.refresh('acct-1', refresher);
    expect(result).toEqual({ accessToken: 'new', refreshToken: 'r2' });
    expect(refresher).toHaveBeenCalledTimes(1);

    const after = prisma._accounts.get('acct-1');
    expect(after?.credentialsVersion).toBe(2);
    expect(after?.lastError).toBeNull();
  });

  it('singleflight: parallel refresh calls invoke the refresher exactly once', async () => {
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const refresher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { next: { accessToken: 'new' }, expiresAt: null };
    });

    const [a, b, c] = await Promise.all([
      manager.refresh('acct-1', refresher),
      manager.refresh('acct-1', refresher),
      manager.refresh('acct-1', refresher),
    ]);

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ accessToken: 'new' });
    expect(b).toEqual({ accessToken: 'new' });
    expect(c).toEqual({ accessToken: 'new' });
  });

  it('rotation-lost: RefreshRejectedError → status=expired, throws refresh_rejected', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const refresher = vi.fn(async () => {
      throw new RefreshRejectedError('400 invalid_grant');
    });

    try {
      await manager.refresh('acct-1', refresher);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialManagerError).code).toBe('refresh_rejected');
    }

    const after = prisma._accounts.get('acct-1');
    expect(after?.status).toBe('expired');
    expect(after?.credentialsVersion).toBe(1); // never advances on rejection
  });

  it('CAS-lost: when version no longer matches, returns the winner credentials', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const refresher = vi.fn(async () => {
      // Simulate a parallel process winning the CAS race — bump the version
      // and swap the credentials before our updateMany runs.
      const acct = prisma._accounts.get('acct-1')!;
      acct.credentialsVersion = 99;
      acct.credentials = sealedCreds({ accessToken: 'winner-tok' });
      return { next: { accessToken: 'our-tok' }, expiresAt: null };
    });

    const result = await manager.refresh('acct-1', refresher);
    expect(result).toEqual({ accessToken: 'winner-tok' });
  });

  it('does not catch non-RefreshRejectedError thrown by the refresher', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    const refresher = vi.fn(async () => {
      throw new Error('network timeout');
    });

    await expect(manager.refresh('acct-1', refresher)).rejects.toThrow(
      'network timeout',
    );
    // Status stays active — only RefreshRejectedError flips to expired.
    expect(prisma._accounts.get('acct-1')?.status).toBe('active');
  });
});

describe('CredentialManager.reportVendorFailure', () => {
  it('auth_invalid: marks status=expired immediately, regardless of breaker', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    await manager.reportVendorFailure('acct-1', 'auth_invalid');
    expect(prisma._accounts.get('acct-1')?.status).toBe('expired');
  });

  it('server_5xx under threshold: does not open circuit', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD - 1; i++) {
      await manager.reportVendorFailure('acct-1', 'server_5xx');
    }
    expect(prisma._accounts.get('acct-1')?.status).toBe('active');
    expect(prisma._accounts.get('acct-1')?.circuitOpenedAt).toBeNull();
  });

  it('server_5xx at threshold: opens circuit + persists circuitOpenedAt', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      await manager.reportVendorFailure('acct-1', 'server_5xx');
    }
    const after = prisma._accounts.get('acct-1');
    expect(after?.status).toBe('circuit_broken');
    expect(after?.circuitOpenedAt).toBeInstanceOf(Date);
    expect(after?.lastError).toContain('circuit opened');
  });

  it('reportVendorSuccess clears the in-memory breaker', async () => {
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    // Record 9 failures (one below threshold)
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD - 1; i++) {
      await manager.reportVendorFailure('acct-1', 'server_5xx');
    }
    // Successful call resets the breaker
    manager.reportVendorSuccess('acct-1');
    // One more 5xx now should NOT open the circuit
    await manager.reportVendorFailure('acct-1', 'server_5xx');
    expect(prisma._accounts.get('acct-1')?.status).toBe('active');
  });
});

describe('CredentialManager — credential leak hygiene', () => {
  it('errors thrown by load() never include credential plaintext', async () => {
    const secret = 'super-secret-token-do-not-leak';
    const { manager } = instantiate([
      {
        id: 'acct-1',
        status: 'expired',
        credentials: sealedCreds({ accessToken: secret }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);
    try {
      await manager.load('acct-1');
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('errors from CAS-lost path do not include the new credential plaintext', async () => {
    const newSecret = 'about-to-be-overwritten-by-race-winner';
    const { manager, prisma } = instantiate([
      {
        id: 'acct-1',
        status: 'active',
        credentials: sealedCreds({ accessToken: 'old' }),
        credentialsVersion: 1,
        circuitOpenedAt: null,
        lastError: null,
      },
    ]);

    // Race winner deletes the account entirely between refresher resolve + CAS lookup.
    const refresher = vi.fn(async () => {
      prisma._accounts.delete('acct-1');
      return { next: { accessToken: newSecret }, expiresAt: null };
    });

    try {
      await manager.refresh('acct-1', refresher);
    } catch (err) {
      expect((err as Error).message).not.toContain(newSecret);
    }
  });
});
