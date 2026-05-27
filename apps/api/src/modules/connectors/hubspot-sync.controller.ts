import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { QueueService } from '../queue/queue.service';
import {
  HUBSPOT_SYNC_ERROR_RESPONSE_CAP,
  HubspotSyncRequestSchema,
  type HubspotSyncEnqueueResponse,
  type HubspotSyncRunStatusResponse,
} from './hubspot-sync.dto';
import {
  HUBSPOT_SYNC_QUEUE,
  type HubspotSyncJobPayload,
} from './hubspot-sync.worker';

/**
 * HubSpot sync HTTP endpoints (T3d.3 → T7.3).
 *
 *   POST /connectors/hubspot/sync
 *     Body: { connectorAccountId, listId }
 *     → 202 { syncRunId, status: 'running' }
 *     Creates the SyncRun + enqueues the worker job. Validates the account
 *     exists, belongs to the session's org, is kind=hubspot, and isn't
 *     already in a terminal-bad state.
 *
 *   GET /connectors/hubspot/sync-runs/:id
 *     → 200 status payload (mirrors CSV shape for UI poll reuse)
 *
 * Identity (orgId, triggeredBy) comes from the session — never from
 * body/query. Cross-org ConnectorAccount access → 403.
 */
@Controller('connectors/hubspot')
@UseGuards(AuthGuard)
export class HubspotSyncController {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  @Post('sync')
  @HttpCode(202)
  async sync(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<HubspotSyncEnqueueResponse> {
    const parsed = HubspotSyncRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const account = await this.prisma.connectorAccount.findUnique({
      where: { id: parsed.data.connectorAccountId },
    });
    if (!account) {
      throw new NotFoundException(
        `ConnectorAccount ${parsed.data.connectorAccountId} not found`,
      );
    }
    if (account.orgId !== user.orgId) {
      throw new ForbiddenException('ConnectorAccount belongs to another org');
    }
    if (account.kind !== 'hubspot') {
      throw new BadRequestException(
        `ConnectorAccount kind is ${account.kind}, not hubspot`,
      );
    }
    if (account.status === 'expired' || account.status === 'revoked') {
      throw new BadRequestException(
        `ConnectorAccount is ${account.status} — reconnect HubSpot before syncing`,
      );
    }
    // circuit_broken accounts are not rejected at enqueue: by the time the
    // worker picks the job up, the cooldown may have elapsed and the
    // half-open probe in CredentialManager.load() handles the transition.

    const syncRun = await this.prisma.syncRun.create({
      data: {
        orgId: user.orgId,
        connectorAccountId: parsed.data.connectorAccountId,
        direction: 'pull',
        status: 'running',
      },
    });

    await this.queue.send<HubspotSyncJobPayload>(HUBSPOT_SYNC_QUEUE, {
      syncRunId: syncRun.id,
      orgId: user.orgId,
      connectorAccountId: parsed.data.connectorAccountId,
      listId: parsed.data.listId,
      triggeredBy: user.userId,
    });

    return { syncRunId: syncRun.id, status: 'running' };
  }

  @Get('sync-runs/:id')
  async getSyncRun(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<HubspotSyncRunStatusResponse> {
    const syncRun = await this.prisma.syncRun.findUnique({ where: { id } });
    if (!syncRun) {
      throw new NotFoundException(`SyncRun ${id} not found`);
    }
    if (syncRun.orgId !== user.orgId) {
      throw new ForbiddenException('SyncRun belongs to another org');
    }

    const rawErrors = Array.isArray(syncRun.errors) ? syncRun.errors : [];
    const errors = rawErrors
      .slice(0, HUBSPOT_SYNC_ERROR_RESPONSE_CAP)
      .map((e: unknown) => {
        if (typeof e === 'object' && e !== null) {
          const obj = e as {
            externalId?: unknown;
            reason?: unknown;
            message?: unknown;
          };
          return {
            externalId:
              typeof obj.externalId === 'string' ? obj.externalId : null,
            reason: typeof obj.reason === 'string' ? obj.reason : 'unknown',
            message: typeof obj.message === 'string' ? obj.message : '',
          };
        }
        return { externalId: null, reason: 'unknown', message: '' };
      });

    return {
      syncRunId: syncRun.id,
      status: syncRun.status as 'running' | 'completed' | 'failed',
      recordsIn: syncRun.recordsIn,
      recordsOut: syncRun.recordsOut,
      errorCount: syncRun.errorCount,
      errors,
    };
  }
}
