import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CredentialManager } from './credential-manager';
import { runHubspotSync } from './hubspot-sync.service';

export const HUBSPOT_SYNC_QUEUE = 'hubspot-sync';

/**
 * Worker for asynchronous HubSpot list syncs (T3d.2).
 *
 * Mirrors `csv-import.worker` — producer creates the SyncRun + enqueues a
 * job, this consumer drives the SyncRun to terminal. Lives in its own queue
 * (not `csv-import`) so a long HubSpot sync doesn't starve user-uploaded
 * CSV imports for the same org. Per-org concurrency caps + cost guards land
 * in T9.
 *
 * Failure semantics: `runHubspotSync` already transitions the SyncRun to
 * `failed` on any thrown error before re-throwing. So a thrown error from
 * this handler triggers pg-boss retry against an *already-failed* SyncRun
 * — which is fine because the retry creates the job loop, not the SyncRun
 * loop. The user sees the failure immediately via polling instead of
 * waiting for retries to exhaust.
 */
export interface HubspotSyncJobPayload {
  syncRunId: string;
  orgId: string;
  connectorAccountId: string;
  listId: string;
  triggeredBy: string;
}

@Injectable()
export class HubspotSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(HubspotSyncWorker.name);
  private readonly queue: QueueService;
  private readonly prisma: PrismaService;
  private readonly credentialManager: CredentialManager;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentialManager: CredentialManager,
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.credentialManager = credentialManager;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<HubspotSyncJobPayload>(
      HUBSPOT_SYNC_QUEUE,
      async (job) => {
        this.logger.log(
          `processing hubspot-sync job ${job.id} for SyncRun ${job.data.syncRunId} ` +
            `(account=${job.data.connectorAccountId}, list=${job.data.listId})`,
        );
        const result = await runHubspotSync({
          prisma: this.prisma,
          credentialManager: this.credentialManager,
          syncRunId: job.data.syncRunId,
          orgId: job.data.orgId,
          connectorAccountId: job.data.connectorAccountId,
          listId: job.data.listId,
          triggeredBy: job.data.triggeredBy,
        });
        this.logger.log(
          `completed hubspot-sync job ${job.id}: ` +
            `status=${result.syncRun.status} in=${result.recordsIn} out=${result.recordsOut} errors=${result.errorCount}`,
        );
      },
    );
    this.logger.log(`registered worker for queue "${HUBSPOT_SYNC_QUEUE}"`);
  }
}
