/**
 * Researcher teammate HTTP + SSE contracts (T5.2).
 *
 * Lives in @getbeyond/shared (MIT) so the web client, the future Chrome
 * extension, and third-party closed-source clients can implement against
 * them without taking on AGPL obligations.
 *
 * The API DTOs (apps/api/src/modules/teammates/researcher/researcher.dto.ts)
 * re-export the request/response shapes from here. RunEvent stays in the
 * runtime package because it's also the bus-internal shape; the web client
 * imports the type from here for the SSE payload shape.
 */

// ─── POST /teammates/researcher/run ─────────────────────────────────
//
// Identity (orgId, triggeredBy) is no longer accepted in the body. The
// API derives both from the session cookie via @CurrentUser() (T7).

export interface ResearcherRunRequest {
  target: string;
  budgetCents?: number;
}

export interface ResearcherRunEnqueueResponse {
  runId: string;
  status: 'running';
}

// ─── GET /teammates/researcher/runs/:id ─────────────────────────────

export type ResearcherRunStatus =
  | 'running'
  | 'completed'
  | 'abstained'
  | 'failed';

export interface ResearcherDraftClaim {
  id: string;
  text: string;
  citationId: string | null;
  citationUrl: string | null;
  abstained: boolean;
  confidence: number | null;
}

export interface ResearcherDraft {
  id: string;
  type: string;
  content: unknown;
  claims: ResearcherDraftClaim[];
}

export interface ResearcherRunStatusResponse {
  runId: string;
  status: ResearcherRunStatus;
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
  costCents: number;
  toolCallCount: number;
  draft: ResearcherDraft | null;
}

// ─── SSE stream events ──────────────────────────────────────────────
//
// Each SSE `data:` payload is one of these. The `event:` field carries the
// `type`. Web clients use the discriminated union to render the right UI
// per event type.

export type RunEventType =
  | 'model_call_started'
  | 'model_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'draft_emitted'
  | 'run_completed'
  | 'run_abstained'
  | 'run_failed';

interface BaseRunEvent {
  runId: string;
  at: string;
}

export type RunEvent =
  | (BaseRunEvent & {
      type: 'model_call_started';
      data: { modelName: string; turn: number };
    })
  | (BaseRunEvent & {
      type: 'model_call_completed';
      data: {
        modelCallId: string;
        modelName: string;
        inputTokens: number;
        outputTokens: number;
        costCents: number;
        runCostCents: number;
      };
    })
  | (BaseRunEvent & {
      type: 'tool_call_started';
      data: { toolName: string; toolSeq: number; args: unknown };
    })
  | (BaseRunEvent & {
      type: 'tool_call_completed';
      data: {
        toolName: string;
        toolSeq: number;
        durationMs: number;
        isError: boolean;
        summary?: string;
      };
    })
  | (BaseRunEvent & {
      type: 'draft_emitted';
      data: {
        draftId: string;
        persistedClaimCount: number;
        droppedUncitedCount: number;
        droppedDanglingCount: number;
      };
    })
  | (BaseRunEvent & {
      type: 'run_completed';
      data: { draftId: string; costCents: number; toolCallCount: number };
    })
  | (BaseRunEvent & {
      type: 'run_abstained';
      data: { reason: string; costCents: number; toolCallCount: number };
    })
  | (BaseRunEvent & {
      type: 'run_failed';
      data: { message: string };
    });

export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<RunEventType> = new Set([
  'run_completed',
  'run_abstained',
  'run_failed',
]);
