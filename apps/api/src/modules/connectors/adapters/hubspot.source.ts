import { randomBytes } from 'node:crypto';
import { Client } from '@hubspot/api-client';
import type {
  AuthMode,
  ConnectorKind,
  CredentialUpdate,
  DecryptedCredentials,
  NormalizedContact,
  OAuthStart,
  PingResult,
  SourceAdapter,
  SourceOption,
  SyncContactsParams,
} from '@getbeyond/shared';
import { RefreshRejectedError } from '../credential-manager';

/**
 * HubSpot source adapter (eng-review T3c.3).
 *
 * Pulls contacts from a HubSpot portal via OAuth. v1 supports the
 * `kind: 'list'` config — sync the membership of a chosen static list.
 * Future variants (search criteria, full portfolio) plug in as new union
 * members on HubspotSourceConfig without touching the contract.
 *
 * OAuth scopes (intentionally minimal):
 *   - `oauth` — required by HubSpot for any OAuth app
 *   - `crm.objects.contacts.read` — read contact properties + membership
 *   - `crm.lists.read` — discover + iterate static lists
 *
 * Adding scopes later (e.g. `crm.objects.deals.read` for deal enrichment)
 * doesn't change this file's API surface — just the HUBSPOT_SCOPES array
 * and a corresponding incremental-authorization prompt. Existing connected
 * accounts continue to work with their already-granted scopes.
 *
 * Refresh flow:
 *   - HubSpot access tokens expire in 30 min. The adapter handles 401 by
 *     invoking `params.onAuthExpired(refresher)`. The runtime's
 *     `CredentialManager` wraps `refresher` with singleflight + CAS and
 *     returns the new credentials; the adapter retries the failed request
 *     once. Two 401s in a row → `onVendorFailure('auth_invalid')`.
 *   - 5xx → `onVendorFailure('server_5xx')` feeds the circuit breaker.
 *   - Each successful call resets the in-memory breaker via `onVendorSuccess`.
 *
 * SDK quarantine: this is the only file in the repo that may import
 * `@hubspot/api-client`. Enforced by dependency-cruiser.
 */

export const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
export const HUBSPOT_SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.lists.read',
] as const;

const PAGE_SIZE = 100;
const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'jobtitle',
  'company',
  'hs_linkedinid',
] as const;

/**
 * The shape we persist inside `ConnectorAccount.credentials`. Vendor-specific
 * cast happens at the adapter boundary via `decodeCreds`.
 */
export interface HubspotCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
  /**
   * HubSpot hub (portal) ID. Optional because `completeOAuth` doesn't return
   * it directly — populated by `ping()` on first successful connection check.
   */
  hubId: number | null;
}

export type HubspotSourceConfig = { kind: 'list'; listId: string };

/**
 * Duck-type the HubSpot SDK's ApiException ({ code: number; body: T }) without
 * importing it from a deep codegen path. Keeps the adapter tolerant of minor
 * SDK reshuffles.
 */
function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === 'change-me-in-production') {
    throw new Error(`Required env var ${name} is not set`);
  }
  return v;
}

function decodeCreds(creds: DecryptedCredentials): HubspotCredentials {
  return {
    accessToken: String(creds.accessToken ?? ''),
    refreshToken: String(creds.refreshToken ?? ''),
    expiresAt: creds.expiresAt == null ? null : String(creds.expiresAt),
    hubId: typeof creds.hubId === 'number' ? creds.hubId : null,
  };
}

function parseInteger(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

class HubspotSourceAdapter implements SourceAdapter<HubspotSourceConfig> {
  readonly kind: ConnectorKind = 'hubspot';
  readonly authMode: AuthMode = 'oauth';

  startOAuth(redirectUri: string): OAuthStart {
    const clientId = mustGetEnv('HUBSPOT_CLIENT_ID');
    const state = randomBytes(32).toString('base64url');
    const url = new URL(HUBSPOT_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', HUBSPOT_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return { authUrl: url.toString(), state };
  }

  async completeOAuth(
    code: string,
    _state: string,
    redirectUri: string,
  ): Promise<DecryptedCredentials> {
    const clientId = mustGetEnv('HUBSPOT_CLIENT_ID');
    const clientSecret = mustGetEnv('HUBSPOT_CLIENT_SECRET');
    const client = new Client();
    const resp = (await client.oauth.tokensApi.create(
      'authorization_code',
      code,
      redirectUri,
      clientId,
      clientSecret,
    )) as { accessToken: string; refreshToken: string; expiresIn: number };
    const envelope: HubspotCredentials = {
      accessToken: resp.accessToken,
      refreshToken: resp.refreshToken,
      expiresAt: new Date(Date.now() + resp.expiresIn * 1000).toISOString(),
      // Populated on the first ping(). Storing null here keeps completeOAuth
      // a single round-trip; consumers that need hubId can call ping() before
      // using the account.
      hubId: null,
    };
    return envelope as unknown as DecryptedCredentials;
  }

  async ping(creds: DecryptedCredentials): Promise<PingResult> {
    const c = decodeCreds(creds);
    const client = new Client({ accessToken: c.accessToken });
    try {
      const meta = (await client.oauth.accessTokensApi.get(c.accessToken)) as {
        scopes?: string[];
      };
      return { ok: true, scopes: meta.scopes ?? [] };
    } catch (err) {
      return {
        ok: false,
        scopes: [],
        error: `HubSpot ping failed (status=${httpStatus(err) ?? 'unknown'})`,
      };
    }
  }

  async listSources(creds: DecryptedCredentials): Promise<SourceOption[]> {
    const c = decodeCreds(creds);
    const client = new Client({ accessToken: c.accessToken });
    const resp = (await client.crm.lists.listsApi.doSearch({
      count: 100,
      offset: 0,
      // Static lists only — dynamic lists change membership over time and
      // require streaming sync semantics we don't ship in v1.
      processingTypes: ['MANUAL_LIST', 'SNAPSHOT'],
      additionalProperties: ['hs_list_size'],
    } as unknown as never)) as {
      lists?: Array<{
        listId: string | number;
        name?: string;
        additionalProperties?: Record<string, unknown>;
      }>;
    };
    const lists = resp.lists ?? [];
    return lists.map((l) => ({
      id: String(l.listId),
      kind: 'list' as const,
      name: l.name ?? `List ${l.listId}`,
      itemCount: parseInteger(l.additionalProperties?.hs_list_size),
    }));
  }

  async *syncContacts(
    params: SyncContactsParams<HubspotSourceConfig>,
  ): AsyncIterable<NormalizedContact> {
    let creds = decodeCreds(params.creds);
    let cursor = params.cursor;
    const listId = params.config.listId;
    const refresher = this.makeRefresher();

    // On 401, refresh once via the runtime callback + retry. A second 401
    // signals 'auth_invalid'. 5xx feeds the circuit breaker. Every other
    // error bubbles out unchanged.
    const callApi = async <T>(
      fn: (c: HubspotCredentials) => Promise<T>,
    ): Promise<T> => {
      const attempt = async (
        current: HubspotCredentials,
        isRetry: boolean,
      ): Promise<T> => {
        try {
          const result = await fn(current);
          params.onVendorSuccess?.();
          return result;
        } catch (err) {
          const status = httpStatus(err);
          if (status === 401 && !isRetry && params.onAuthExpired) {
            const refreshed = await params.onAuthExpired(refresher);
            creds = decodeCreds(refreshed);
            return attempt(creds, true);
          }
          if (status === 401 && isRetry && params.onVendorFailure) {
            await params.onVendorFailure('auth_invalid');
          }
          if (
            status !== undefined &&
            status >= 500 &&
            params.onVendorFailure
          ) {
            await params.onVendorFailure('server_5xx');
          }
          throw err;
        }
      };
      return attempt(creds, false);
    };

    while (true) {
      const membersPage = (await callApi(async (c) => {
        const client = new Client({ accessToken: c.accessToken });
        return client.crm.lists.membershipsApi.getPage(
          listId,
          cursor, // after cursor (paging)
          undefined, // before — not used; we only paginate forward
          PAGE_SIZE,
        );
      })) as {
        results?: Array<{ recordId: string | number }>;
        paging?: { next?: { after?: string } };
      };

      const ids = (membersPage.results ?? []).map((r) => String(r.recordId));

      if (ids.length > 0) {
        const detailsPage = (await callApi(async (c) => {
          const client = new Client({ accessToken: c.accessToken });
          return client.crm.contacts.batchApi.read({
            inputs: ids.map((id) => ({ id })),
            properties: [...CONTACT_PROPERTIES],
            propertiesWithHistory: [],
          } as unknown as never);
        })) as {
          results?: Array<{
            id: string;
            properties?: Record<string, string | null>;
          }>;
        };

        for (const contact of detailsPage.results ?? []) {
          const props = contact.properties ?? {};
          const email = props.email;
          if (!email) continue;
          const hubIdSegment = creds.hubId ?? 0;
          yield {
            emailRaw: email,
            externalId: contact.id,
            externalUrl: `https://app.hubspot.com/contacts/${hubIdSegment}/contact/${contact.id}`,
            firstName: props.firstname ?? null,
            lastName: props.lastname ?? null,
            title: props.jobtitle ?? null,
            company: props.company ?? null,
            linkedinUrl: props.hs_linkedinid ?? null,
            rawPayload: contact,
          };
        }
      }

      const nextCursor = membersPage.paging?.next?.after;
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  }

  /**
   * Builds the refresher closure handed to `CredentialManager.refresh()`.
   * Public so tests can drive it directly without spinning up a full sync.
   */
  makeRefresher(): (current: DecryptedCredentials) => Promise<CredentialUpdate> {
    return async (current) => {
      const c = decodeCreds(current);
      const clientId = mustGetEnv('HUBSPOT_CLIENT_ID');
      const clientSecret = mustGetEnv('HUBSPOT_CLIENT_SECRET');
      const client = new Client();
      let resp: { accessToken: string; refreshToken: string; expiresIn: number };
      try {
        resp = (await client.oauth.tokensApi.create(
          'refresh_token',
          undefined,
          undefined,
          clientId,
          clientSecret,
          c.refreshToken,
        )) as typeof resp;
      } catch (err) {
        // HubSpot returns 400 on invalid_grant / revoked refresh token.
        if (httpStatus(err) === 400) {
          throw new RefreshRejectedError('HubSpot rejected refresh token');
        }
        throw err;
      }
      const expiresAt = new Date(Date.now() + resp.expiresIn * 1000).toISOString();
      const next: HubspotCredentials = {
        accessToken: resp.accessToken,
        refreshToken: resp.refreshToken,
        expiresAt,
        hubId: c.hubId,
      };
      return {
        next: next as unknown as DecryptedCredentials,
        expiresAt,
      };
    };
  }
}

export const hubspotSourceAdapter = new HubspotSourceAdapter();
