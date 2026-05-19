import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the HubSpot SDK at the module boundary. Every adapter call routes
 * through these spies; tests configure return values per-case. The real
 * SDK is never loaded.
 */
const oauthTokensCreate = vi.fn();
const oauthAccessTokensGet = vi.fn();
const listsDoSearch = vi.fn();
const membershipsGetPage = vi.fn();
const contactsBatchRead = vi.fn();

vi.mock('@hubspot/api-client', () => {
  class FakeClient {
    constructor(_opts?: { accessToken?: string }) {}
    crm = {
      contacts: { batchApi: { read: contactsBatchRead } },
      lists: {
        listsApi: { doSearch: listsDoSearch },
        membershipsApi: { getPage: membershipsGetPage },
      },
    };
    oauth = {
      tokensApi: { create: oauthTokensCreate },
      accessTokensApi: { get: oauthAccessTokensGet },
    };
  }
  return { Client: FakeClient };
});

import {
  HUBSPOT_AUTHORIZE_URL,
  HUBSPOT_SCOPES,
  hubspotSourceAdapter,
  type HubspotCredentials,
} from './hubspot.source';
import { RefreshRejectedError } from '../credential-manager';
import type {
  CredentialUpdate,
  DecryptedCredentials,
  NormalizedContact,
} from '@getbeyond/shared';

function apiException(code: number, body: unknown = {}): Error & {
  code: number;
  body: unknown;
} {
  const err = new Error(`HTTP ${code}`) as Error & {
    code: number;
    body: unknown;
  };
  err.code = code;
  err.body = body;
  return err;
}

const VALID_CREDS: HubspotCredentials = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  hubId: 12345,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HUBSPOT_CLIENT_ID = 'client-id-test';
  process.env.HUBSPOT_CLIENT_SECRET = 'client-secret-test';
});

afterEach(() => {
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
});

describe('hubspotSourceAdapter — startOAuth', () => {
  it('builds the consent URL with client_id, redirect_uri, scope, state', () => {
    const { authUrl, state } = hubspotSourceAdapter.startOAuth(
      'https://app.example/cb',
    );
    const parsed = new URL(authUrl);
    expect(parsed.origin + parsed.pathname).toBe(HUBSPOT_AUTHORIZE_URL);
    expect(parsed.searchParams.get('client_id')).toBe('client-id-test');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example/cb',
    );
    expect(parsed.searchParams.get('scope')).toBe(HUBSPOT_SCOPES.join(' '));
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it('throws when HUBSPOT_CLIENT_ID is unset', () => {
    delete process.env.HUBSPOT_CLIENT_ID;
    expect(() =>
      hubspotSourceAdapter.startOAuth('https://app.example/cb'),
    ).toThrow(/HUBSPOT_CLIENT_ID/);
  });

  it('rejects the placeholder client id', () => {
    process.env.HUBSPOT_CLIENT_ID = 'change-me-in-production';
    expect(() =>
      hubspotSourceAdapter.startOAuth('https://app.example/cb'),
    ).toThrow(/HUBSPOT_CLIENT_ID/);
  });

  it('two calls produce different state tokens', () => {
    const a = hubspotSourceAdapter.startOAuth('https://app.example/cb');
    const b = hubspotSourceAdapter.startOAuth('https://app.example/cb');
    expect(a.state).not.toBe(b.state);
  });
});

describe('hubspotSourceAdapter — completeOAuth', () => {
  it('exchanges the auth code for credentials', async () => {
    oauthTokensCreate.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 1800,
    });

    const creds = await hubspotSourceAdapter.completeOAuth(
      'auth-code-123',
      'state-abc',
      'https://app.example/cb',
    );

    expect(oauthTokensCreate).toHaveBeenCalledWith(
      'authorization_code',
      'auth-code-123',
      'https://app.example/cb',
      'client-id-test',
      'client-secret-test',
    );
    expect(creds.accessToken).toBe('new-access');
    expect(creds.refreshToken).toBe('new-refresh');
    expect(creds.hubId).toBeNull();
    expect(creds.expiresAt).toBeTypeOf('string');
  });

  it('propagates SDK errors (caller decides what to surface)', async () => {
    oauthTokensCreate.mockRejectedValueOnce(apiException(400, { error: 'invalid_grant' }));
    await expect(
      hubspotSourceAdapter.completeOAuth(
        'bad-code',
        'state',
        'https://app.example/cb',
      ),
    ).rejects.toThrow('HTTP 400');
  });
});

describe('hubspotSourceAdapter — ping', () => {
  it('returns ok=true with vendor-reported scopes on success', async () => {
    oauthAccessTokensGet.mockResolvedValueOnce({
      scopes: ['oauth', 'crm.objects.contacts.read'],
      hubId: 12345,
    });
    const result = await hubspotSourceAdapter.ping(
      VALID_CREDS as unknown as DecryptedCredentials,
    );
    expect(result).toEqual({
      ok: true,
      scopes: ['oauth', 'crm.objects.contacts.read'],
    });
  });

  it('returns ok=false on 401 (no credentials in error message)', async () => {
    const secret = 'super-secret-do-not-leak';
    oauthAccessTokensGet.mockRejectedValueOnce(apiException(401));
    const result = await hubspotSourceAdapter.ping({
      ...VALID_CREDS,
      accessToken: secret,
    } as unknown as DecryptedCredentials);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(secret);
    expect(result.error).toContain('401');
  });

  it('returns ok=false with status=unknown on a non-HTTP error', async () => {
    oauthAccessTokensGet.mockRejectedValueOnce(new Error('connection refused'));
    const result = await hubspotSourceAdapter.ping(
      VALID_CREDS as unknown as DecryptedCredentials,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown');
  });
});

describe('hubspotSourceAdapter — listSources', () => {
  it('maps HubSpot lists to SourceOption shape', async () => {
    listsDoSearch.mockResolvedValueOnce({
      lists: [
        {
          listId: 42,
          name: 'High-intent leads',
          additionalProperties: { hs_list_size: 247 },
        },
        {
          listId: '99',
          name: 'Newsletter signups',
          additionalProperties: { hs_list_size: '4200' },
        },
        { listId: 7, name: 'No size field', additionalProperties: {} },
      ],
    });

    const sources = await hubspotSourceAdapter.listSources(
      VALID_CREDS as unknown as DecryptedCredentials,
    );

    expect(sources).toEqual([
      {
        id: '42',
        kind: 'list',
        name: 'High-intent leads',
        itemCount: 247,
      },
      {
        id: '99',
        kind: 'list',
        name: 'Newsletter signups',
        itemCount: 4200,
      },
      {
        id: '7',
        kind: 'list',
        name: 'No size field',
        itemCount: undefined,
      },
    ]);
  });

  it('returns an empty array when vendor returns no lists', async () => {
    listsDoSearch.mockResolvedValueOnce({});
    const sources = await hubspotSourceAdapter.listSources(
      VALID_CREDS as unknown as DecryptedCredentials,
    );
    expect(sources).toEqual([]);
  });
});

describe('hubspotSourceAdapter — syncContacts (happy path)', () => {
  it('yields contacts from a single page of list members', async () => {
    membershipsGetPage.mockResolvedValueOnce({
      results: [{ recordId: '101' }, { recordId: '102' }],
      paging: { next: undefined },
    });
    contactsBatchRead.mockResolvedValueOnce({
      results: [
        {
          id: '101',
          properties: {
            email: 'sasha@example.com',
            firstname: 'Sasha',
            lastname: 'Lin',
            jobtitle: 'Founder',
            company: 'Acme',
            hs_linkedinid: 'https://linkedin.com/in/sasha',
          },
        },
        {
          id: '102',
          properties: {
            email: 'marcus@example.com',
            firstname: 'Marcus',
            lastname: null,
          },
        },
      ],
    });

    const collected: NormalizedContact[] = [];
    const onVendorSuccess = vi.fn();
    for await (const contact of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'list-1' },
      onVendorSuccess,
    })) {
      collected.push(contact);
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({
      emailRaw: 'sasha@example.com',
      externalId: '101',
      firstName: 'Sasha',
      company: 'Acme',
      linkedinUrl: 'https://linkedin.com/in/sasha',
    });
    expect(collected[1]).toMatchObject({
      emailRaw: 'marcus@example.com',
      externalId: '102',
      lastName: null,
    });
    expect(onVendorSuccess).toHaveBeenCalled();
  });

  it('skips contacts that have no email property', async () => {
    membershipsGetPage.mockResolvedValueOnce({
      results: [{ recordId: '1' }],
    });
    contactsBatchRead.mockResolvedValueOnce({
      results: [
        { id: '1', properties: { firstname: 'No-email Person' } },
      ],
    });
    const collected: NormalizedContact[] = [];
    for await (const c of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'list-1' },
    })) {
      collected.push(c);
    }
    expect(collected).toEqual([]);
  });

  it('paginates via paging.next.after', async () => {
    // First page: 2 records, cursor='page-2'
    membershipsGetPage
      .mockResolvedValueOnce({
        results: [{ recordId: '1' }, { recordId: '2' }],
        paging: { next: { after: 'page-2' } },
      })
      .mockResolvedValueOnce({
        results: [{ recordId: '3' }],
        paging: undefined,
      });
    contactsBatchRead
      .mockResolvedValueOnce({
        results: [
          { id: '1', properties: { email: 'a@x.com' } },
          { id: '2', properties: { email: 'b@x.com' } },
        ],
      })
      .mockResolvedValueOnce({
        results: [{ id: '3', properties: { email: 'c@x.com' } }],
      });

    const emails: string[] = [];
    for await (const c of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'list-1' },
    })) {
      emails.push(c.emailRaw);
    }
    expect(emails).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(membershipsGetPage).toHaveBeenCalledTimes(2);
    // Second call should pass cursor='page-2' as `after` (second positional arg).
    expect(membershipsGetPage.mock.calls[1]?.[1]).toBe('page-2');
  });

  it('stops paginating when paging.next.after is missing on an empty page', async () => {
    membershipsGetPage.mockResolvedValueOnce({
      results: [],
      paging: { next: undefined },
    });
    const collected: NormalizedContact[] = [];
    for await (const c of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'list-empty' },
    })) {
      collected.push(c);
    }
    expect(collected).toEqual([]);
    expect(contactsBatchRead).not.toHaveBeenCalled();
  });

  it('resumes from the cursor passed by the runtime', async () => {
    membershipsGetPage.mockResolvedValueOnce({
      results: [],
      paging: { next: undefined },
    });
    for await (const _ of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      cursor: 'resume-here',
    })) {
      // not reached
    }
    expect(membershipsGetPage.mock.calls[0]?.[1]).toBe('resume-here');
  });
});

describe('hubspotSourceAdapter — syncContacts (refresh + circuit)', () => {
  it('on 401: invokes onAuthExpired then retries with new creds', async () => {
    // First call: 401. Refresh fires, returns new creds. Retry succeeds.
    membershipsGetPage
      .mockRejectedValueOnce(apiException(401))
      .mockResolvedValueOnce({
        results: [{ recordId: '1' }],
        paging: undefined,
      });
    contactsBatchRead.mockResolvedValueOnce({
      results: [{ id: '1', properties: { email: 'a@x.com' } }],
    });

    const newCreds: HubspotCredentials = {
      ...VALID_CREDS,
      accessToken: 'access-rotated',
    };
    const onAuthExpired = vi.fn(async (_refresher) => {
      return newCreds as unknown as DecryptedCredentials;
    });
    const onVendorSuccess = vi.fn();

    const emails: string[] = [];
    for await (const c of hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      onAuthExpired,
      onVendorSuccess,
    })) {
      emails.push(c.emailRaw);
    }
    expect(emails).toEqual(['a@x.com']);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(onVendorSuccess).toHaveBeenCalled();
  });

  it('on two consecutive 401s: reports auth_invalid + throws', async () => {
    membershipsGetPage
      .mockRejectedValueOnce(apiException(401))
      .mockRejectedValueOnce(apiException(401));

    const onAuthExpired = vi.fn(async (_refresher) => {
      return { ...VALID_CREDS, accessToken: 'still-bad' } as unknown as DecryptedCredentials;
    });
    const onVendorFailure = vi.fn(async () => {});

    const iter = hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      onAuthExpired,
      onVendorFailure,
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('HTTP 401');
    expect(onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('on 5xx: reports server_5xx + propagates', async () => {
    membershipsGetPage.mockRejectedValueOnce(apiException(503));
    const onVendorFailure = vi.fn(async () => {});

    const iter = hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      onVendorFailure,
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('HTTP 503');
    expect(onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });

  it('on 4xx (not 401): propagates without invoking callbacks', async () => {
    membershipsGetPage.mockRejectedValueOnce(apiException(403, { error: 'forbidden' }));
    const onAuthExpired = vi.fn();
    const onVendorFailure = vi.fn();

    const iter = hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      onAuthExpired,
      onVendorFailure,
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('HTTP 403');
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(onVendorFailure).not.toHaveBeenCalled();
  });

  it('without onAuthExpired callback: 401 propagates unchanged (BYO callers)', async () => {
    membershipsGetPage.mockRejectedValueOnce(apiException(401));
    const iter = hubspotSourceAdapter.syncContacts({
      creds: VALID_CREDS as unknown as DecryptedCredentials,
      config: { kind: 'list', listId: 'l' },
      // no onAuthExpired
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('HTTP 401');
  });
});

describe('hubspotSourceAdapter — makeRefresher', () => {
  it('calls /token with grant_type=refresh_token + persisted refresh token', async () => {
    oauthTokensCreate.mockResolvedValueOnce({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresIn: 1800,
    });

    const refresher = hubspotSourceAdapter.makeRefresher();
    const result: CredentialUpdate = await refresher(
      VALID_CREDS as unknown as DecryptedCredentials,
    );

    expect(oauthTokensCreate).toHaveBeenCalledWith(
      'refresh_token',
      undefined,
      undefined,
      'client-id-test',
      'client-secret-test',
      'refresh-1',
    );
    expect(result.next.accessToken).toBe('access-2');
    expect(result.next.refreshToken).toBe('refresh-2');
    expect(result.next.hubId).toBe(VALID_CREDS.hubId);
    expect(result.expiresAt).toBeTypeOf('string');
  });

  it('rotation-lost: 400 from vendor → RefreshRejectedError', async () => {
    oauthTokensCreate.mockRejectedValueOnce(
      apiException(400, { error: 'invalid_grant' }),
    );
    const refresher = hubspotSourceAdapter.makeRefresher();
    await expect(
      refresher(VALID_CREDS as unknown as DecryptedCredentials),
    ).rejects.toBeInstanceOf(RefreshRejectedError);
  });

  it('non-400 vendor errors propagate unchanged (not classified as rotation-lost)', async () => {
    oauthTokensCreate.mockRejectedValueOnce(apiException(503));
    const refresher = hubspotSourceAdapter.makeRefresher();
    await expect(
      refresher(VALID_CREDS as unknown as DecryptedCredentials),
    ).rejects.not.toBeInstanceOf(RefreshRejectedError);
  });

  it('does not include refresh token plaintext in error messages', async () => {
    const refreshSecret = 'unique-refresh-do-not-leak';
    oauthTokensCreate.mockRejectedValueOnce(
      apiException(400, { error: 'invalid_grant' }),
    );
    const refresher = hubspotSourceAdapter.makeRefresher();
    try {
      await refresher({
        ...VALID_CREDS,
        refreshToken: refreshSecret,
      } as unknown as DecryptedCredentials);
    } catch (err) {
      expect((err as Error).message).not.toContain(refreshSecret);
    }
  });
});
