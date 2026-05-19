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
  Query,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
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
 * HubSpot sync HTTP endpoints (T3d.3).
 *
 *   POST /connectors/hubspot/sync
 *     Body: { orgId, connectorAccountId, listId, triggeredBy }
 *     → 202 { syncRunId, status: 'running' }
 *     Creates the SyncRun + enqueues the worker job. Validates the account
 *     exists, belongs to the org, is kind=hubspot, and isn't already in a
 *     terminal-bad state (expired/circuit_broken). Caller polls
 *     GET /connectors/hubspot/sync-runs/:id for completion.
 *
 *   GET /connectors/hubspot/sync-runs/:id?orgId=
 *     → 200 status payload (mirrors CSV shape for UI poll reuse)
 *
 * Auth (pre-real-auth stub): `orgId` lives in the body / query — same
 * pattern as csv-import.controller. Real auth wires this from OrgContext.
 */

@Controller('connectors/hubspot')
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
  async sync(@Body() body: unknown): Promise<HubspotSyncEnqueueResponse> {
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
    if (account.orgId !== parsed.data.orgId) {
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
        orgId: parsed.data.orgId,
        connectorAccountId: parsed.data.connectorAccountId,
        direction: 'pull',
        status: 'running',
      },
    });

    await this.queue.send<HubspotSyncJobPayload>(HUBSPOT_SYNC_QUEUE, {
      syncRunId: syncRun.id,
      orgId: parsed.data.orgId,
      connectorAccountId: parsed.data.connectorAccountId,
      listId: parsed.data.listId,
      triggeredBy: parsed.data.triggeredBy,
    });

    return { syncRunId: syncRun.id, status: 'running' };
  }

  @Get('sync-runs/:id')
  async getSyncRun(
    @Param('id') id: string,
    @Query('orgId') orgId: string | undefined,
  ): Promise<HubspotSyncRunStatusResponse> {
    if (!orgId) {
      throw new BadRequestException('orgId query parameter is required');
    }
    const syncRun = await this.prisma.syncRun.findUnique({ where: { id } });
    if (!syncRun) {
      throw new NotFoundException(`SyncRun ${id} not found`);
    }
    if (syncRun.orgId !== orgId) {
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
