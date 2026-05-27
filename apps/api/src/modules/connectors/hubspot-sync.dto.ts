import { z } from 'zod';

/**
 * Zod schema for the POST /connectors/hubspot/sync body.
 *
 * Identity (orgId, triggeredBy) is derived from the session by AuthGuard;
 * the body only carries the work-defining fields.
 */
export const HubspotSyncRequestSchema = z.object({
  connectorAccountId: z.string().min(1, 'connectorAccountId is required'),
  listId: z.string().min(1, 'listId is required'),
});

export type HubspotSyncRequest = z.infer<typeof HubspotSyncRequestSchema>;

/** Returned by POST /connectors/hubspot/sync. 202 Accepted. */
export interface HubspotSyncEnqueueResponse {
  syncRunId: string;
  status: 'running';
}

/**
 * Returned by GET /connectors/hubspot/sync-runs/:id. Mirrors the CSV shape
 * for poll-loop reuse on the UI side. `errors` is capped at
 * HUBSPOT_SYNC_ERROR_RESPONSE_CAP entries.
 */
export interface HubspotSyncRunStatusResponse {
  syncRunId: string;
  status: 'running' | 'completed' | 'failed';
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: Array<{
    externalId: string | null;
    reason: string;
    message: string;
  }>;
}

export const HUBSPOT_SYNC_ERROR_RESPONSE_CAP = 100;
