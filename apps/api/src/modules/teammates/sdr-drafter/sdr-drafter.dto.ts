import { z } from 'zod';
import type { SdrDrafterRunRequest } from '@getbeyond/shared';

/**
 * Zod schema for POST /teammates/sdr-drafter/run.
 *
 * `satisfies z.ZodType<SdrDrafterRunRequest>` is the cross-package binding
 * that catches drift between the shared contract and the runtime validator
 * at compile time.
 */
export const SdrDrafterRunRequestSchema = z.object({
  contactId: z.string().min(1),
  briefDraftId: z.string().min(1).optional(),
  goal: z.string().max(500).optional(),
  budgetCents: z.number().int().positive().optional(),
}) satisfies z.ZodType<SdrDrafterRunRequest>;

export type {
  SdrDrafterRunEnqueueResponse,
  SdrDrafterRunStatusResponse,
} from '@getbeyond/shared';
