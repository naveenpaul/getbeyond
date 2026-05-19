import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

export const OAUTH_STATE_REAPER_QUEUE = 'reap-expired-oauth-states';

/**
 * OAuthState rows live for 10 min (the time it takes a user to click through
 * a vendor's consent screen with room to spare). After expiry they're useless
 * and accumulate unboundedly. This reaper deletes them outright — unlike
 * SyncRun/DraftAction reapers which mark stale rows `failed`, an expired
 * OAuthState has no diagnostic value worth preserving.
 *
 * The /callback handler already rejects rows where `expiresAt < now()`, so
 * the reaper is a pure storage-hygiene pass.
 */
export const OAUTH_STATE_REAPER_CRON = '*/2 * * * *';

@Injectable()
export class OAuthStateReaper implements OnModuleInit {
  private readonly logger = new Logger(OAuthStateReaper.name);
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work(OAUTH_STATE_REAPER_QUEUE, async () => {
      const reaped = await this.reap();
      if (reaped > 0) {
        this.logger.log(`reaped ${reaped} expired OAuthState(s)`);
      }
    });
    await this.queue.schedule(
      OAUTH_STATE_REAPER_QUEUE,
      OAUTH_STATE_REAPER_CRON,
    );
    this.logger.log(
      `scheduled OAuthState reaper (cron="${OAUTH_STATE_REAPER_CRON}")`,
    );
  }

  /**
   * Delete OAuthState rows whose `expiresAt` has passed. Returns the count
   * of rows deleted. Exposed (vs private) so tests can drive it directly.
   *
   * Optional `now` parameter for clock injection in tests.
   */
  async reap(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
