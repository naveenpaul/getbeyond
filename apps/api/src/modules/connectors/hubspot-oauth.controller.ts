import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { hubspotSourceAdapter } from './adapters/hubspot.source';
import { CredentialManager } from './credential-manager';

/**
 * HubSpot OAuth flow (T3c.4).
 *
 *   GET  /connectors/hubspot/oauth/start
 *        ?orgId=<org>&redirectUri=<callback>
 *        → 200 { authUrl, state }
 *        Caller (UI) redirects the browser to authUrl. The state token is
 *        persisted in `OAuthState`; HubSpot echoes it back to /callback.
 *
 *   GET  /connectors/hubspot/oauth/callback
 *        ?state=<echoed>&code=<auth-code>
 *        → 200 { connectorAccountId }
 *        Verifies + one-shot-consumes the OAuthState row, exchanges the
 *        code for credentials, encrypts + upserts the ConnectorAccount.
 *
 * The 10-min OAuthState TTL is enforced inline (expired rows are deleted
 * before the verify step); OAuthStateReaper sweeps any rows missed by
 * cancelled flows on a 2-min cadence.
 *
 * Auth (pre-real-auth stub): /start takes `orgId` as a query param. Real
 * auth wires this from session context — same pattern as csv-import.controller.
 */

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStartResponse {
  authUrl: string;
  state: string;
}

interface OAuthCallbackResponse {
  connectorAccountId: string;
}

@Controller('connectors/hubspot/oauth')
export class HubspotOauthController {
  private readonly prisma: PrismaService;
  private readonly credentialManager: CredentialManager;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentialManager: CredentialManager,
  ) {
    this.prisma = prisma;
    this.credentialManager = credentialManager;
  }

  @Get('start')
  async start(
    @Query('orgId') orgId: string | undefined,
    @Query('redirectUri') redirectUri: string | undefined,
  ): Promise<OAuthStartResponse> {
    if (!orgId) {
      throw new BadRequestException('orgId query parameter is required');
    }
    if (!redirectUri) {
      throw new BadRequestException('redirectUri query parameter is required');
    }
    // Verify the org exists so we fail fast instead of writing an OAuthState
    // row that no callback can ever consume.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }

    const { authUrl, state } = hubspotSourceAdapter.startOAuth(redirectUri);
    await this.prisma.oAuthState.create({
      data: {
        state,
        orgId,
        kind: 'hubspot',
        redirectUri,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });

    return { authUrl, state };
  }

  @Get('callback')
  async callback(
    @Query('state') state: string | undefined,
    @Query('code') code: string | undefined,
  ): Promise<OAuthCallbackResponse> {
    if (!state) {
      throw new BadRequestException('state query parameter is required');
    }
    if (!code) {
      throw new BadRequestException('code query parameter is required');
    }

    const row = await this.prisma.oAuthState.findUnique({
      where: { state },
    });
    if (!row) {
      throw new NotFoundException('OAuth state not found (expired or replay)');
    }
    if (row.kind !== 'hubspot') {
      // State token from another vendor's flow — refuse outright.
      throw new BadRequestException(
        `OAuth state belongs to kind=${row.kind}, not hubspot`,
      );
    }
    if (row.expiresAt.getTime() < Date.now()) {
      // Clean up + reject. One-shot semantics; the user must restart the flow.
      await this.prisma.oAuthState
        .delete({ where: { state } })
        .catch(() => undefined);
      throw new BadRequestException('OAuth state has expired');
    }

    // One-shot: consume immediately to prevent replay even if the token
    // exchange below errors. The user retries by re-initiating /start.
    await this.prisma.oAuthState.delete({ where: { state } });

    const creds = await hubspotSourceAdapter.completeOAuth(
      code,
      state,
      row.redirectUri,
    );

    const connectorAccountId =
      await this.credentialManager.persistInitialCredentials({
        orgId: row.orgId,
        kind: 'hubspot',
        authMode: 'oauth',
        creds,
        // Initial scopes are the HUBSPOT_SCOPES the adapter requested. The
        // adapter's ping() can refine this with what the user actually granted.
        scopes: ['oauth', 'crm.objects.contacts.read', 'crm.lists.read'],
      });

    return { connectorAccountId };
  }
}
