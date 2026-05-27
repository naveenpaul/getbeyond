import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { hubspotSourceAdapter } from './adapters/hubspot.source';
import { CredentialManager } from './credential-manager';

/**
 * HubSpot OAuth flow (T3c.4 → T7.3).
 *
 *   GET  /connectors/hubspot/oauth/start?redirectUri=<callback>
 *        → 200 { authUrl, state }
 *        Caller (UI) redirects the browser to authUrl. The state token is
 *        persisted in `OAuthState` with the session's orgId; HubSpot
 *        echoes it back to /callback.
 *
 *   GET  /connectors/hubspot/oauth/callback?state=<echoed>&code=<auth-code>
 *        → 200 { connectorAccountId }
 *        Verifies + one-shot-consumes the OAuthState row. Defense-in-depth:
 *        the SESSION'S orgId must also match the row's orgId — otherwise a
 *        leaked state token can't be replayed by a different signed-in user.
 *
 * 10-min OAuthState TTL is enforced inline (expired rows are deleted
 * before the verify step); OAuthStateReaper sweeps cancelled flows on a
 * 2-min cadence.
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
@UseGuards(AuthGuard)
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
    @Query('redirectUri') redirectUri: string | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<OAuthStartResponse> {
    if (!redirectUri) {
      throw new BadRequestException('redirectUri query parameter is required');
    }

    const { authUrl, state } = hubspotSourceAdapter.startOAuth(redirectUri);
    await this.prisma.oAuthState.create({
      data: {
        state,
        orgId: user.orgId,
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
    @CurrentUser() user: CurrentUserPayload,
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
    if (row.orgId !== user.orgId) {
      // Different signed-in user trying to consume someone else's state.
      throw new ForbiddenException(
        'OAuth state belongs to a different org than the current session',
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
