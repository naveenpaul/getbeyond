import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { DestinationRegistry } from './destination-registry';
import {
  CURRENT_PAYLOAD_SCHEMA_VERSION,
  getPayloadSchema,
  UnknownDraftActionKindError,
} from './draft-action.schemas';

export const DRAFT_ACTION_QUEUE = 'draft-action';

export interface DraftActionJobPayload {
  draftActionId: string;
}

/**
 * DraftAction outbox worker (eng-review pass-2 D5 + codex T6 — minimal slice).
 *
 * For each enqueued DraftAction id:
 *   1. Load the row; short-circuit if already terminal (idempotent replay).
 *   2. Reject mismatched payloadSchemaVersion → 'failed' (no execute).
 *   3. Validate payload via the per-kind Zod schema. Schema failure →
 *      'failed' without calling any vendor.
 *   4. Resolve the destination adapter from the registry. Missing → 'failed'.
 *   5. Claim the row (status='running') and execute via the adapter.
 *   6. Persist the terminal status from the adapter result.
 *   7. For archive kind specifically: also transition Draft.status='rejected'.
 *
 * What's deliberately NOT in this slice:
 *   - dependsOnId ordering (T5.2)
 *   - retries + exponential backoff (T5.2)
 *   - dead-letter handling (T5.2)
 *   - stale-running reaper (handled by cleanup pass)
 *
 * Real vendor destinations (Gmail, Resend, HubSpot write, Salesforce write,
 * LinkedIn) come as separate slices.
 */
@Injectable()
export class DraftActionWorker implements OnModuleInit {
  private readonly logger = new Logger(DraftActionWorker.name);
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;
  private readonly registry: DestinationRegistry;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
    @Inject(DestinationRegistry) registry: DestinationRegistry,
  ) {
    this.prisma = prisma;
    this.queue = queue;
    this.registry = registry;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work<DraftActionJobPayload>(
      DRAFT_ACTION_QUEUE,
      async (job) => {
        await this.processOnce(job.data.draftActionId);
      },
    );
    this.logger.log(`registered worker for queue "${DRAFT_ACTION_QUEUE}"`);
  }

  /**
   * Process a single DraftAction. Exposed (vs. private) so tests can drive
   * the worker logic directly without going through pg-boss.
   */
  async processOnce(draftActionId: string): Promise<void> {
    const action = await this.prisma.draftAction.findUnique({
      where: { id: draftActionId },
    });
    if (!action) {
      this.logger.warn(
        `DraftAction ${draftActionId} not found — silently completing job`,
      );
      return;
    }

    // Idempotent replay: terminal rows are already settled, do nothing.
    if (
      action.status === 'succeeded' ||
      action.status === 'failed' ||
      action.status === 'dead_lettered'
    ) {
      this.logger.log(
        `DraftAction ${draftActionId} already terminal (status=${action.status}); skipping`,
      );
      return;
    }

    if (action.payloadSchemaVersion !== CURRENT_PAYLOAD_SCHEMA_VERSION) {
      await this.terminalFail(action.id, {
        reason: 'payload_schema_version_mismatch',
        gotVersion: action.payloadSchemaVersion,
        expectedVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
      });
      return;
    }

    let validatedPayload: unknown;
    try {
      const schema = getPayloadSchema(action.kind);
      validatedPayload = schema.parse(action.payload);
    } catch (err) {
      if (err instanceof UnknownDraftActionKindError) {
        await this.terminalFail(action.id, {
          reason: 'unknown_kind',
          kind: action.kind,
        });
        return;
      }
      if (err instanceof z.ZodError) {
        await this.terminalFail(action.id, {
          reason: 'payload_validation_failed',
          issues: err.issues,
        });
        return;
      }
      throw err;
    }

    const adapter = this.registry.getForKind(action.kind);
    if (!adapter) {
      await this.terminalFail(action.id, {
        reason: 'no_destination_adapter',
        kind: action.kind,
      });
      return;
    }

    // Claim the row before executing. If two workers race, the unique
    // claim-by-id update is the safety net (Prisma update on a primary key
    // is atomic).
    await this.prisma.draftAction.update({
      where: { id: action.id },
      data: { status: 'running', attempts: { increment: 1 } },
    });

    const result = await adapter.execute({
      creds: {}, // no creds in v1 — real destinations decrypt ConnectorAccount.credentials here
      action: validatedPayload as Record<string, unknown>,
      idempotencyKey: action.idempotencyKey,
      contactId: '', // T5.2 wires Draft.recipient → contactId
    });

    if (result.status === 'succeeded') {
      await this.terminalSucceed(action.id, action.draftId, action.kind, result);
    } else {
      await this.terminalFail(action.id, {
        reason: 'adapter_returned_failed',
        adapterError: result.error,
        responsePayload: result.responsePayload,
      });
    }
  }

  private async terminalSucceed(
    actionId: string,
    draftId: string,
    kind: string,
    result: { externalId?: string; responsePayload: unknown },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.draftAction.update({
        where: { id: actionId },
        data: {
          status: 'succeeded',
          responsePayload: result.responsePayload as Prisma.InputJsonValue,
          executedAt: new Date(),
        },
      });
      // archive is a meta-action: success means the draft is rejected.
      if (kind === 'archive') {
        await tx.draft.update({
          where: { id: draftId },
          data: { status: 'rejected' },
        });
      }
    });
  }

  private async terminalFail(
    actionId: string,
    diagnostic: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.draftAction.update({
      where: { id: actionId },
      data: {
        status: 'failed',
        responsePayload: diagnostic as Prisma.InputJsonValue,
        executedAt: new Date(),
      },
    });
  }
}
