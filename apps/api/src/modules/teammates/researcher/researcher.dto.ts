import { z } from 'zod';
import type {
  ResearcherRunEnqueueResponse,
  ResearcherRunRequest,
  ResearcherRunStatusResponse,
} from '@getbeyond/shared';

/**
 * POST /teammates/researcher/run request body — Zod validator.
 *
 * The public *type* lives in @getbeyond/shared so the
 * web client + Chrome extension + third-party clients import it without
 * pulling in the API package. This file binds the Zod runtime to the same
 * shape via the `satisfies` checker below — a drift on either side fails
 * the build instead of leaking past tests.
 *
 * Pre-auth stub: orgId + triggeredBy live in the body. When real auth
 * lands, both come from OrgContext and the DTO shrinks to { target }.
 */
export const ResearcherRunRequestSchema = z.object({
  orgId: z.string().min(1, 'orgId is required'),
  triggeredBy: z.string().min(1, 'triggeredBy is required'),
  target: z.string().min(1, 'target is required'),
  budgetCents: z.number().int().min(1).max(10_000).optional(),
}) satisfies z.ZodType<ResearcherRunRequest>;

// Re-export the public types so existing API call sites that imported them
// from this file keep working.
export type {
  ResearcherRunEnqueueResponse,
  ResearcherRunRequest,
  ResearcherRunStatusResponse,
};
