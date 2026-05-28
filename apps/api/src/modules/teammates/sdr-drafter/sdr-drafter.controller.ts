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
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { AuthGuard } from '../../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../auth/current-user.decorator';
import { RUN_EVENT_BUS, type RunEventBus } from '../runtime/run-event-bus';
import { buildRunStreamObservable } from '../runtime/sse-stream';
import { SDR_DRAFTER_NAME } from './sdr-drafter.service';
import {
  SDR_DRAFTER_RUN_QUEUE,
  type SdrDrafterRunJobPayload,
} from './sdr-drafter.worker';
import {
  SdrDrafterRunRequestSchema,
  type SdrDrafterRunEnqueueResponse,
  type SdrDrafterRunStatusResponse,
} from './sdr-drafter.dto';

/**
 * SDR Drafter HTTP endpoints. Same shape as the Researcher (POST run →
 * 202 + enqueued worker job · GET runs/:id · SSE runs/:id/stream).
 */
@Controller('teammates/sdr-drafter')
@UseGuards(AuthGuard)
export class SdrDrafterController {
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;
  private readonly eventBus: RunEventBus;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
    @Inject(RUN_EVENT_BUS) eventBus: RunEventBus,
  ) {
    this.prisma = prisma;
    this.queue = queue;
    this.eventBus = eventBus;
  }

  @Post('run')
  @HttpCode(202)
  async enqueue(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SdrDrafterRunEnqueueResponse> {
    const parsed = SdrDrafterRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    // Fail fast on cross-tenant or missing contact BEFORE minting the
    // AgentRun row. Skips the worker dance + the user gets a clear 404
    // synchronously.
    const contact = await this.prisma.contact.findFirst({
      where: { id: parsed.data.contactId, orgId: user.orgId },
    });
    if (!contact) {
      throw new NotFoundException(
        `Contact ${parsed.data.contactId} not found in your org`,
      );
    }
    if (!contact.normalizedEmail) {
      throw new BadRequestException(
        `Contact ${parsed.data.contactId} has no email — cannot draft outreach`,
      );
    }

    if (parsed.data.briefDraftId) {
      const brief = await this.prisma.draft.findFirst({
        where: {
          id: parsed.data.briefDraftId,
          orgId: user.orgId,
          type: 'research_brief',
        },
        select: { id: true },
      });
      if (!brief) {
        throw new NotFoundException(
          `Research brief ${parsed.data.briefDraftId} not found in your org`,
        );
      }
    }

    const run = await this.prisma.agentRun.create({
      data: {
        orgId: user.orgId,
        teammate: SDR_DRAFTER_NAME,
        triggeredBy: user.userId,
        status: 'running',
        inputContext: {
          contactId: parsed.data.contactId,
          briefDraftId: parsed.data.briefDraftId ?? null,
          goal: parsed.data.goal ?? null,
        } satisfies Record<string, unknown>,
      },
    });

    await this.queue.send<SdrDrafterRunJobPayload>(SDR_DRAFTER_RUN_QUEUE, {
      runId: run.id,
      orgId: user.orgId,
      triggeredBy: user.userId,
      contactId: parsed.data.contactId,
      briefDraftId: parsed.data.briefDraftId,
      goal: parsed.data.goal,
      budgetCents: parsed.data.budgetCents,
    });

    return { runId: run.id, status: 'running' };
  }

  @Get('runs/:id')
  async getRun(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SdrDrafterRunStatusResponse> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id },
      include: {
        drafts: {
          where: { teammate: SDR_DRAFTER_NAME },
          include: { claims: { include: { citation: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        toolCalls: { select: { id: true } },
      },
    });

    if (!run) {
      throw new NotFoundException(`AgentRun ${id} not found`);
    }
    if (run.orgId !== user.orgId) {
      throw new ForbiddenException('AgentRun belongs to another org');
    }

    const draftRow = run.drafts[0];
    const draft = draftRow
      ? {
          id: draftRow.id,
          type: 'email' as const,
          content: draftRow.content,
          recipient: (draftRow.recipient ?? null) as {
            contactId: string;
            email: string;
            name: string | null;
          } | null,
          claims: draftRow.claims.map((c) => ({
            id: c.id,
            text: c.text,
            citationId: c.citationId,
            citationUrl: c.citation?.url ?? null,
            abstained: c.abstained,
            confidence: c.confidence,
          })),
        }
      : null;

    return {
      runId: run.id,
      status: run.status as SdrDrafterRunStatusResponse['status'],
      reason: run.reason,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      costCents: run.costCents,
      toolCallCount: run.toolCalls.length,
      draft,
    };
  }

  @Sse('runs/:id/stream')
  async stream(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<Observable<MessageEvent>> {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException(`AgentRun ${id} not found`);
    }
    if (run.orgId !== user.orgId) {
      throw new ForbiddenException('AgentRun belongs to another org');
    }

    return buildRunStreamObservable({
      runId: id,
      runStatus: run.status,
      eventBus: this.eventBus,
    });
  }
}
