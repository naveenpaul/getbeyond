import type { Prisma, PrismaClient, SyncRun } from '@prisma/client';
import { upsertContact } from '../contacts/contact-upsert';
import { InvalidEmailError } from '../contacts/identity';
import { hubspotSourceAdapter } from './adapters/hubspot.source';
import type { CredentialManager } from './credential-manager';
import { CredentialManagerError } from './credential-manager';

/**
 * End-to-end HubSpot list sync (T3d.1).
 *
 * Mirrors the runCsvImport architecture: an existing SyncRun is transitioned
 * from running → terminal as the adapter streams NormalizedContacts and
 * upsertContact resolves them into Contact + ContactSource rows.
 *
 * What's HubSpot-specific (vs CSV):
 *   - Credentials: loaded via CredentialManager. The adapter's three
 *     auto-refresh callbacks (onAuthExpired/onVendorFailure/onVendorSuccess)
 *     are wired to the manager so 401-mid-stream triggers singleflight refresh,
 *     5xx feeds the circuit breaker, and a successful page resets it.
 *   - Cursor: HubSpot pagination tokens flow back through `params.cursor`.
 *     v1 does NOT persist mid-sync — pg-boss retries replay from the original
 *     start. upsertContact is idempotent so re-running is safe; the trade is
 *     wasted vendor calls if a long sync crashes near the end. Mid-sync
 *     checkpointing is a follow-up (lift `cursor` out of the adapter as part
 *     of the contract).
 *   - sourceKind='hubspot' feeds the per-field provenance tier (CRM ranks
 *     higher than vendor data — Apollo will sit below).
 *
 * Errors during upsert (InvalidEmailError, vendor-malformed payload) are
 * collected and surfaced via SyncRun.errors without failing the whole run.
 * Errors during the adapter call itself (auth, network, vendor 5xx) DO fail
 * the SyncRun and rethrow so pg-boss can apply its retry policy.
 */

export interface HubspotSyncInput {
  prisma: PrismaClient;
  credentialManager: CredentialManager;
  /** SyncRun already created by the producer; this function drives it terminal. */
  syncRunId: string;
  orgId: string;
  connectorAccountId: string;
  listId: string;
  triggeredBy: string;
}

export interface HubspotSyncError {
  /** HubSpot contact id when known, otherwise null. */
  externalId: string | null;
  reason: string;
  message: string;
}

export interface HubspotSyncResult {
  syncRun: SyncRun;
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: HubspotSyncError[];
}

export async function runHubspotSync(
  input: HubspotSyncInput,
): Promise<HubspotSyncResult> {
  const { prisma, credentialManager, syncRunId, orgId, connectorAccountId } =
    input;

  let syncRun = await prisma.syncRun.findUnique({
    where: { id: syncRunId },
  });
  if (!syncRun) {
    throw new Error(`SyncRun ${syncRunId} not found`);
  }
  if (syncRun.orgId !== orgId) {
    throw new Error(
      `SyncRun ${syncRunId} belongs to a different org — refusing to proceed`,
    );
  }

  const errors: HubspotSyncError[] = [];
  let yieldedCount = 0;
  let upsertedCount = 0;

  // Load creds upfront — if the account is expired or in a circuit-broken
  // window, fail the SyncRun fast with a clear reason rather than letting
  // pg-boss retry against a known-bad state.
  let creds;
  try {
    creds = await credentialManager.load(connectorAccountId);
  } catch (err) {
    return await failRun(
      prisma,
      syncRun,
      [
        {
          externalId: null,
          reason:
            err instanceof CredentialManagerError ? err.code : 'load_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      yieldedCount,
      upsertedCount,
    );
  }

  try {
    for await (const contact of hubspotSourceAdapter.syncContacts({
      creds,
      config: { kind: 'list', listId: input.listId },
      onAuthExpired: (refresher) =>
        credentialManager.refresh(connectorAccountId, refresher),
      onVendorFailure: (kind) =>
        credentialManager.reportVendorFailure(connectorAccountId, kind),
      onVendorSuccess: () =>
        credentialManager.reportVendorSuccess(connectorAccountId),
    })) {
      yieldedCount++;
      try {
        await upsertContact(prisma, {
          orgId,
          emailRaw: contact.emailRaw,
          sourceAccountId: connectorAccountId,
          sourceKind: 'hubspot',
          externalId: contact.externalId,
          externalUrl: contact.externalUrl ?? null,
          fields: {
            firstName: contact.firstName ?? null,
            lastName: contact.lastName ?? null,
            title: contact.title ?? null,
            company: contact.company ?? null,
            linkedinUrl: contact.linkedinUrl ?? null,
          },
          rawPayload: contact.rawPayload as Prisma.InputJsonValue,
        });
        upsertedCount++;
      } catch (err) {
        if (err instanceof InvalidEmailError) {
          errors.push({
            externalId: contact.externalId,
            reason: `invalid_email_${err.reason}`,
            message: err.message,
          });
          continue;
        }
        // Genuine failure (DB unreachable, transaction deadlock, etc.) —
        // fail the whole run so the upstream retry policy applies.
        throw err;
      }
    }
  } catch (err) {
    return await failRun(
      prisma,
      syncRun,
      [
        ...errors,
        {
          externalId: null,
          reason: 'fatal',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      yieldedCount,
      upsertedCount,
    );
  }

  syncRun = await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      recordsIn: yieldedCount,
      recordsOut: upsertedCount,
      errorCount: errors.length,
      errors: errors as unknown as Prisma.InputJsonValue,
    },
  });

  // Track the last successful sync on the ConnectorAccount so the UI can
  // surface "Last synced 2 minutes ago" without scanning SyncRun history.
  await prisma.connectorAccount.update({
    where: { id: connectorAccountId },
    data: { lastSyncAt: new Date(), lastError: null },
  });

  return {
    syncRun,
    recordsIn: yieldedCount,
    recordsOut: upsertedCount,
    errorCount: errors.length,
    errors,
  };
}

async function failRun(
  prisma: PrismaClient,
  syncRun: SyncRun,
  errors: HubspotSyncError[],
  recordsIn: number,
  recordsOut: number,
): Promise<HubspotSyncResult> {
  const updated = await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      status: 'failed',
      completedAt: new Date(),
      recordsIn,
      recordsOut,
      errorCount: errors.length,
      errors: errors as unknown as Prisma.InputJsonValue,
    },
  });
  return {
    syncRun: updated,
    recordsIn,
    recordsOut,
    errorCount: errors.length,
    errors,
  };
}
