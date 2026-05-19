import { describe, expect, it, vi } from 'vitest';

/**
 * Mock the HubSpot adapter + the upsert layer at the module boundary.
 * The service is responsible for orchestration only; the underlying pieces
 * are covered by their own suites.
 *
 * vi.mock factories run BEFORE module-level const declarations (hoisted),
 * so the shared spy fns must use vi.hoisted to land in the same phase.
 */
const { mockSyncContacts, mockUpsertContact } = vi.hoisted(() => ({
  mockSyncContacts: vi.fn(),
  mockUpsertContact: vi.fn(),
}));

vi.mock('./adapters/hubspot.source', () => ({
  hubspotSourceAdapter: {
    kind: 'hubspot',
    authMode: 'oauth',
    syncContacts: mockSyncContacts,
  },
}));

vi.mock('../contacts/contact-upsert', () => ({
  upsertContact: mockUpsertContact,
}));

import { runHubspotSync } from './hubspot-sync.service';
import { CredentialManagerError } from './credential-manager';
import { InvalidEmailError } from '../contacts/identity';
import type { NormalizedContact } from '@getbeyond/shared';

interface FakeSyncRun {
  id: string;
  orgId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt: Date | null;
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: unknown[];
}

interface FakeConnectorAccount {
  id: string;
  lastSyncAt: Date | null;
  lastError: string | null;
}

function makeFakePrisma(seedSyncRun: FakeSyncRun, seedAccount: FakeConnectorAccount) {
  const syncRuns = new Map<string, FakeSyncRun>([[seedSyncRun.id, { ...seedSyncRun }]]);
  const accounts = new Map<string, FakeConnectorAccount>([
    [seedAccount.id, { ...seedAccount }],
  ]);
  return {
    syncRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const existing = syncRuns.get(where.id);
        return existing ? { ...existing } : null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeSyncRun>;
        }) => {
          const existing = syncRuns.get(where.id);
          if (!existing) throw new Error('not found');
          Object.assign(existing, data);
          return { ...existing };
        },
      ),
    },
    connectorAccount: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeConnectorAccount>;
        }) => {
          const existing = accounts.get(where.id);
          if (!existing) throw new Error('not found');
          Object.assign(existing, data);
          return { ...existing };
        },
      ),
    },
    _syncRuns: syncRuns,
    _accounts: accounts,
  };
}

function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function makeCredentialManager(overrides: Partial<{
  load: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  reportVendorFailure: ReturnType<typeof vi.fn>;
  reportVendorSuccess: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    load: overrides.load ?? vi.fn(async () => ({ accessToken: 'tok-1', refreshToken: 'r-1' })),
    refresh: overrides.refresh ?? vi.fn(),
    reportVendorFailure: overrides.reportVendorFailure ?? vi.fn(),
    reportVendorSuccess: overrides.reportVendorSuccess ?? vi.fn(),
  };
}

function freshContact(overrides: Partial<NormalizedContact>): NormalizedContact {
  return {
    emailRaw: 'a@example.com',
    externalId: 'hs-1',
    rawPayload: { _raw: true },
    ...overrides,
  };
}

const BASE_SYNC_RUN: FakeSyncRun = {
  id: 'sync-1',
  orgId: 'org-A',
  status: 'running',
  startedAt: new Date(),
  completedAt: null,
  recordsIn: 0,
  recordsOut: 0,
  errorCount: 0,
  errors: [],
};

const BASE_ACCOUNT: FakeConnectorAccount = {
  id: 'acct-1',
  lastSyncAt: null,
  lastError: null,
};

describe('runHubspotSync — preflight', () => {
  it('throws when the SyncRun does not exist', async () => {
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    await expect(
      runHubspotSync({
        prisma: prisma as never,
        credentialManager: makeCredentialManager() as never,
        syncRunId: 'does-not-exist',
        orgId: 'org-A',
        connectorAccountId: 'acct-1',
        listId: 'list-1',
        triggeredBy: 'user-1',
      }),
    ).rejects.toThrow('SyncRun does-not-exist not found');
  });

  it('throws when the SyncRun belongs to a different org', async () => {
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    await expect(
      runHubspotSync({
        prisma: prisma as never,
        credentialManager: makeCredentialManager() as never,
        syncRunId: 'sync-1',
        orgId: 'wrong-org',
        connectorAccountId: 'acct-1',
        listId: 'list-1',
        triggeredBy: 'user-1',
      }),
    ).rejects.toThrow('belongs to a different org');
  });
});

describe('runHubspotSync — credential failures fail the SyncRun cleanly', () => {
  it('CredentialManager throws expired → SyncRun status=failed, reason=expired', async () => {
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const credentialManager = makeCredentialManager({
      load: vi.fn(async () => {
        throw new CredentialManagerError(
          'expired',
          'ConnectorAccount acct-1 status=expired',
        );
      }),
    });
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: credentialManager as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });
    expect(result.syncRun.status).toBe('failed');
    expect(result.errors[0]?.reason).toBe('expired');
    // Adapter was never invoked.
    expect(mockSyncContacts).not.toHaveBeenCalled();
    // No connectorAccount mutation on credential failure (we never got that far).
    expect(prisma.connectorAccount.update).not.toHaveBeenCalled();
  });

  it('CredentialManager throws circuit_broken → SyncRun status=failed', async () => {
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const credentialManager = makeCredentialManager({
      load: vi.fn(async () => {
        throw new CredentialManagerError(
          'circuit_broken',
          'circuit open; cooldown 120s remaining',
        );
      }),
    });
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: credentialManager as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });
    expect(result.syncRun.status).toBe('failed');
    expect(result.errors[0]?.reason).toBe('circuit_broken');
  });

  it('non-CredentialManagerError from load() → reason=load_failed', async () => {
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const credentialManager = makeCredentialManager({
      load: vi.fn(async () => {
        throw new Error('database unreachable');
      }),
    });
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: credentialManager as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });
    expect(result.syncRun.status).toBe('failed');
    expect(result.errors[0]?.reason).toBe('load_failed');
    expect(result.errors[0]?.message).toContain('database unreachable');
  });
});

describe('runHubspotSync — happy path', () => {
  it('streams contacts → upserts each → marks SyncRun completed', async () => {
    mockUpsertContact.mockReset();
    mockSyncContacts.mockReset();
    mockSyncContacts.mockImplementation(() =>
      asAsyncIterable([
        freshContact({ emailRaw: 'sasha@x.com', externalId: 'hs-1' }),
        freshContact({ emailRaw: 'marcus@x.com', externalId: 'hs-2' }),
      ]),
    );
    mockUpsertContact.mockResolvedValue({
      contact: { id: 'c-1' },
      created: true,
      sourceCreated: true,
    });

    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const credentialManager = makeCredentialManager();

    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: credentialManager as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });

    expect(result.syncRun.status).toBe('completed');
    expect(result.recordsIn).toBe(2);
    expect(result.recordsOut).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(mockUpsertContact).toHaveBeenCalledTimes(2);
    expect(mockUpsertContact.mock.calls[0]?.[1]).toMatchObject({
      orgId: 'org-A',
      sourceAccountId: 'acct-1',
      sourceKind: 'hubspot',
      externalId: 'hs-1',
    });
    // ConnectorAccount.lastSyncAt + lastError=null
    expect(prisma._accounts.get('acct-1')?.lastSyncAt).toBeInstanceOf(Date);
    expect(prisma._accounts.get('acct-1')?.lastError).toBeNull();
  });

  it('wires the three credential callbacks to the CredentialManager', async () => {
    mockUpsertContact.mockReset();
    mockSyncContacts.mockReset();
    let capturedParams: {
      onAuthExpired?: (r: unknown) => Promise<unknown>;
      onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
      onVendorSuccess?: () => void;
    } = {};
    mockSyncContacts.mockImplementation((params) => {
      capturedParams = params;
      return asAsyncIterable([]);
    });

    const credentialManager = makeCredentialManager();
    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    await runHubspotSync({
      prisma: prisma as never,
      credentialManager: credentialManager as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });

    // Verify each callback proxies to the manager with the right accountId.
    const fakeRefresher = vi.fn(async () => ({
      next: { accessToken: 'x' },
      expiresAt: null,
    }));
    await capturedParams.onAuthExpired?.(fakeRefresher);
    expect(credentialManager.refresh).toHaveBeenCalledWith(
      'acct-1',
      fakeRefresher,
    );

    await capturedParams.onVendorFailure?.('server_5xx');
    expect(credentialManager.reportVendorFailure).toHaveBeenCalledWith(
      'acct-1',
      'server_5xx',
    );

    capturedParams.onVendorSuccess?.();
    expect(credentialManager.reportVendorSuccess).toHaveBeenCalledWith('acct-1');
  });
});

describe('runHubspotSync — per-contact errors do not fail the run', () => {
  it('InvalidEmailError is captured into errors[] + sync still completes', async () => {
    mockUpsertContact.mockReset();
    mockSyncContacts.mockReset();
    mockSyncContacts.mockImplementation(() =>
      asAsyncIterable([
        freshContact({ emailRaw: 'good@x.com', externalId: 'hs-good' }),
        freshContact({ emailRaw: 'BAD@@@', externalId: 'hs-bad' }),
        freshContact({ emailRaw: 'fine@x.com', externalId: 'hs-fine' }),
      ]),
    );
    mockUpsertContact.mockImplementation(async (_p: unknown, input: { externalId: string }) => {
      if (input.externalId === 'hs-bad') {
        throw new InvalidEmailError('no_at', 'malformed email');
      }
      return { contact: { id: 'c' }, created: true, sourceCreated: true };
    });

    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: makeCredentialManager() as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });

    expect(result.syncRun.status).toBe('completed');
    expect(result.recordsIn).toBe(3);
    expect(result.recordsOut).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      externalId: 'hs-bad',
      reason: 'invalid_email_no_at',
    });
  });
});

describe('runHubspotSync — adapter-side errors fail the run', () => {
  it('thrown error from the adapter stream → SyncRun status=failed, fatal reason', async () => {
    mockUpsertContact.mockReset();
    mockSyncContacts.mockReset();
    mockSyncContacts.mockImplementation(() => {
      const iter = (async function* () {
        yield freshContact({ emailRaw: 'a@x.com', externalId: 'hs-1' });
        throw new Error('HubSpot 503 Service Unavailable');
      })();
      return iter;
    });
    mockUpsertContact.mockResolvedValue({
      contact: { id: 'c-1' },
      created: true,
      sourceCreated: true,
    });

    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: makeCredentialManager() as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });

    expect(result.syncRun.status).toBe('failed');
    expect(result.recordsIn).toBe(1); // counted the one yielded before the throw
    expect(result.recordsOut).toBe(1);
    expect(result.errors.at(-1)?.reason).toBe('fatal');
    expect(result.errors.at(-1)?.message).toContain('503');
  });

  it('upsert errors that are NOT InvalidEmailError fail the whole run', async () => {
    mockUpsertContact.mockReset();
    mockSyncContacts.mockReset();
    mockSyncContacts.mockImplementation(() =>
      asAsyncIterable([
        freshContact({ emailRaw: 'a@x.com', externalId: 'hs-1' }),
      ]),
    );
    mockUpsertContact.mockRejectedValueOnce(
      new Error('Prisma: deadlock_detected'),
    );

    const prisma = makeFakePrisma(BASE_SYNC_RUN, BASE_ACCOUNT);
    const result = await runHubspotSync({
      prisma: prisma as never,
      credentialManager: makeCredentialManager() as never,
      syncRunId: 'sync-1',
      orgId: 'org-A',
      connectorAccountId: 'acct-1',
      listId: 'list-1',
      triggeredBy: 'user-1',
    });

    expect(result.syncRun.status).toBe('failed');
    expect(result.errors.at(-1)?.message).toContain('deadlock_detected');
  });
});
