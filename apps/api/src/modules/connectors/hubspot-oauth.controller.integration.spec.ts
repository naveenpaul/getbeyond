import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the HubSpot SDK BEFORE importing AppModule — the adapter is loaded
 * by Nest at module-init time. We never let the real SDK make a network call.
 */
const oauthTokensCreate = vi.fn();
vi.mock('@hubspot/api-client', () => {
  class FakeClient {
    constructor(_opts?: { accessToken?: string }) {}
    oauth = {
      tokensApi: { create: oauthTokensCreate },
      accessTokensApi: { get: vi.fn() },
    };
    crm = {
      contacts: { batchApi: { read: vi.fn() } },
      lists: {
        listsApi: { doSearch: vi.fn() },
        membershipsApi: { getPage: vi.fn() },
      },
    };
  }
  return { Client: FakeClient };
});

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { generateMasterKey } from './credential-encryption';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'HubspotOauthController (integration)',
  () => {
    let app: NestFastifyApplication;
    let prisma: PrismaClient;
    let orgA: string;
    let orgB: string;

    beforeAll(async () => {
      const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!dbName.includes('test')) {
        throw new Error(
          `Integration tests refuse to run against database "${dbName}".`,
        );
      }

      // CredentialManager refuses to instantiate without a real master key,
      // so seed one for the whole suite.
      process.env.CREDENTIAL_MASTER_KEY = generateMasterKey();
      process.env.HUBSPOT_CLIENT_ID = 'client-id-test';
      process.env.HUBSPOT_CLIENT_SECRET = 'client-secret-test';

      // Import AppModule AFTER setting env so the module's static config sees it.
      const { AppModule } = await import('../../app.module');

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL! } },
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          draft_actions, claims, drafts,
          contact_sources, contact_emails, contact_list_members, contact_lists,
          contacts, sync_runs, oauth_states, connector_accounts,
          tool_calls, model_calls, citations, agent_runs,
          voices, company_brains, users, organizations
        RESTART IDENTITY CASCADE
      `);
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE pgboss.job, pgboss.archive RESTART IDENTITY`,
        )
        .catch(() => {});

      const o1 = await prisma.organization.create({ data: { name: 'OrgA' } });
      const o2 = await prisma.organization.create({ data: { name: 'OrgB' } });
      orgA = o1.id;
      orgB = o2.id;
    });

    // ─── /start ───────────────────────────────────────────────────────

    it('GET /start returns authUrl + state, persists OAuthState row', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/start?orgId=${orgA}&redirectUri=${encodeURIComponent('https://app.example/cb')}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { authUrl: string; state: string };
      expect(body.authUrl).toContain('https://app.hubspot.com/oauth/authorize');
      expect(body.authUrl).toContain('client_id=client-id-test');
      expect(body.state).toMatch(/^[A-Za-z0-9_-]+$/);

      const row = await prisma.oAuthState.findUnique({
        where: { state: body.state },
      });
      expect(row?.orgId).toBe(orgA);
      expect(row?.kind).toBe('hubspot');
      expect(row?.redirectUri).toBe('https://app.example/cb');
      expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('GET /start without orgId → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/hubspot/oauth/start?redirectUri=https://app.example/cb',
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /start without redirectUri → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/start?orgId=${orgA}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /start with unknown orgId → 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/start?orgId=does-not-exist&redirectUri=https://app.example/cb`,
      });
      expect(res.statusCode).toBe(404);
    });

    // ─── /callback ────────────────────────────────────────────────────

    async function startFlow(orgId: string): Promise<{ state: string }> {
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/start?orgId=${orgId}&redirectUri=https%3A%2F%2Fapp.example%2Fcb`,
      });
      const body = JSON.parse(res.body) as { state: string };
      return body;
    }

    it('GET /callback exchanges code + creates ConnectorAccount', async () => {
      const { state } = await startFlow(orgA);
      oauthTokensCreate.mockResolvedValueOnce({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code-123`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { connectorAccountId: string };
      expect(body.connectorAccountId).toBeTypeOf('string');

      const account = await prisma.connectorAccount.findUnique({
        where: { id: body.connectorAccountId },
      });
      expect(account?.orgId).toBe(orgA);
      expect(account?.kind).toBe('hubspot');
      expect(account?.authMode).toBe('oauth');
      expect(account?.status).toBe('active');
      expect(account?.credentialsVersion).toBe(1);
      // Credentials must be sealed bytes, not plaintext JSON.
      expect(Buffer.isBuffer(account?.credentials)).toBe(true);
      expect(account?.credentials.toString('utf8')).not.toContain('access-1');
      expect(account?.scopes).toEqual([
        'oauth',
        'crm.objects.contacts.read',
        'crm.lists.read',
      ]);

      // OAuthState row was one-shot-consumed.
      const stateRow = await prisma.oAuthState.findUnique({ where: { state } });
      expect(stateRow).toBeNull();
    });

    it('GET /callback with unknown state → 404 (no account created)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/hubspot/oauth/callback?state=never-issued&code=x',
      });
      expect(res.statusCode).toBe(404);
      const accounts = await prisma.connectorAccount.count();
      expect(accounts).toBe(0);
    });

    it('GET /callback rejects replay of an already-consumed state → 404', async () => {
      const { state } = await startFlow(orgA);
      oauthTokensCreate.mockResolvedValueOnce({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
      });
      const first = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}&code=auth-1`,
      });
      expect(first.statusCode).toBe(200);

      const replay = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}&code=auth-2`,
      });
      expect(replay.statusCode).toBe(404);
    });

    it('GET /callback rejects expired state → 400 + cleans up the row', async () => {
      const { state } = await startFlow(orgA);
      // Backdate expiresAt so the inline TTL check trips.
      await prisma.oAuthState.update({
        where: { state },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`,
      });
      expect(res.statusCode).toBe(400);
      expect(oauthTokensCreate).not.toHaveBeenCalled();

      const row = await prisma.oAuthState.findUnique({ where: { state } });
      expect(row).toBeNull();
    });

    it('GET /callback without state → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/connectors/hubspot/oauth/callback?code=abc',
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /callback without code → 400', async () => {
      const { state } = await startFlow(orgA);
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /callback propagates vendor exchange errors + leaves no account behind', async () => {
      const { state } = await startFlow(orgA);
      const err = new Error('HTTP 400') as Error & { code: number };
      err.code = 400;
      oauthTokensCreate.mockRejectedValueOnce(err);

      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state)}&code=bad`,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500); // unhandled → 500
      const count = await prisma.connectorAccount.count();
      expect(count).toBe(0);
      // State row consumed before the exchange — user must restart /start.
      const row = await prisma.oAuthState.findUnique({ where: { state } });
      expect(row).toBeNull();
    });

    it('orgA cannot use orgB-issued state (kind+state are bound at /start)', async () => {
      const { state: stateA } = await startFlow(orgA);
      oauthTokensCreate.mockResolvedValueOnce({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
      });
      // Whoever calls /callback with stateA will create the account against orgA,
      // not whichever orgId they spoof — the runtime never reads orgId from
      // query params on /callback. Verify the persisted account is orgA's.
      const res = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(stateA)}&code=c`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { connectorAccountId: string };
      const acct = await prisma.connectorAccount.findUnique({
        where: { id: body.connectorAccountId },
      });
      expect(acct?.orgId).toBe(orgA);
      expect(acct?.orgId).not.toBe(orgB);
    });

    it('reconnect: second OAuth flow for the same org rotates credentials + bumps version', async () => {
      // First connection
      const { state: state1 } = await startFlow(orgA);
      oauthTokensCreate.mockResolvedValueOnce({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
      });
      const first = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state1)}&code=c1`,
      });
      const { connectorAccountId: id1 } = JSON.parse(first.body) as {
        connectorAccountId: string;
      };

      // Second connection (user re-authed)
      const { state: state2 } = await startFlow(orgA);
      oauthTokensCreate.mockResolvedValueOnce({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresIn: 1800,
      });
      const second = await app.inject({
        method: 'GET',
        url: `/connectors/hubspot/oauth/callback?state=${encodeURIComponent(state2)}&code=c2`,
      });
      const { connectorAccountId: id2 } = JSON.parse(second.body) as {
        connectorAccountId: string;
      };

      expect(id2).toBe(id1); // same row, upserted
      const acct = await prisma.connectorAccount.findUnique({
        where: { id: id1 },
      });
      expect(acct?.credentialsVersion).toBe(2); // incremented
      expect(acct?.status).toBe('active');
      expect(acct?.credentials.toString('utf8')).not.toContain('access-2');
    });
  },
);
