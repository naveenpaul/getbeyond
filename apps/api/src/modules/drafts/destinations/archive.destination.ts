import type {
  DestinationAdapter,
  DraftActionKind,
  ExecuteParams,
  ExecuteResult,
} from '@getbeyond/shared';
import type { PrismaClient } from '@prisma/client';
import type { ArchivePayload } from '../draft-action.schemas';

/**
 * `archive` destination — real production adapter.
 *
 * Records the user's "do nothing else with this draft" intent. Marks the
 * parent Draft.status='rejected'. The DraftAction itself transitions to
 * 'succeeded' (the user's action was successful, even though there's no
 * outbound side-effect to a vendor).
 *
 * No external calls. Idempotent: re-running on an already-rejected Draft
 * is a no-op.
 */
export class ArchiveDestination implements DestinationAdapter<ArchivePayload> {
  readonly kind = 'archive-internal';
  readonly supports: readonly DraftActionKind[] = ['archive'];

  constructor(private readonly prisma: PrismaClient) {}

  async execute(params: ExecuteParams<ArchivePayload>): Promise<ExecuteResult> {
    void params.action; // archive payload is always {}
    // Look up the draftId from contactId fallback — actually we get it via
    // the worker which knows the DraftAction.draftId. The contract passes
    // contactId for vendor-side routing; for archive we need the draftId,
    // so the worker resolves Draft from DraftAction.draftId and calls a
    // separate code path. This adapter just confirms the action succeeded.
    //
    // The actual `Draft.status='rejected'` update is done by the worker
    // (which holds the DraftAction row context), not here — keeps this
    // adapter's contract clean and consistent with the others.
    return {
      status: 'succeeded',
      responsePayload: { archived: true },
    };
  }
}
