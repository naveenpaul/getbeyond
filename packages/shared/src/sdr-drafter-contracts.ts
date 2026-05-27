/**
 * SDR Drafter teammate HTTP + SSE contracts (T9.5).
 *
 * The SSE event shape is shared with the Researcher — RunEvent is defined
 * once in researcher-contracts and reused here. Only the request +
 * status-response shapes differ.
 */

// ─── POST /teammates/sdr-drafter/run ────────────────────────────────

export interface SdrDrafterRunRequest {
  /** Contact.id to draft for. Resolved server-side; tenant-scoped. */
  contactId: string;
  /** Optional prior research_brief Draft.id used as context. */
  briefDraftId?: string;
  /**
   * Optional founder-supplied angle for the email
   * (e.g. "follow-up on pricing question", "intro for our case study").
   */
  goal?: string;
  budgetCents?: number;
}

export interface SdrDrafterRunEnqueueResponse {
  runId: string;
  status: 'running';
}

// ─── GET /teammates/sdr-drafter/runs/:id ────────────────────────────

export type SdrDrafterRunStatus =
  | 'running'
  | 'completed'
  | 'abstained'
  | 'failed';

export interface SdrDrafterDraftClaim {
  id: string;
  text: string;
  citationId: string | null;
  citationUrl: string | null;
  abstained: boolean;
  confidence: number | null;
}

export interface SdrDrafterDraftRecipient {
  contactId: string;
  email: string;
  name: string | null;
}

export interface SdrDrafterDraft {
  id: string;
  type: 'email';
  /** { subject, body } — typed loose because the runtime stores Json. */
  content: unknown;
  recipient: SdrDrafterDraftRecipient | null;
  claims: SdrDrafterDraftClaim[];
}

export interface SdrDrafterRunStatusResponse {
  runId: string;
  status: SdrDrafterRunStatus;
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
  costCents: number;
  toolCallCount: number;
  draft: SdrDrafterDraft | null;
}
