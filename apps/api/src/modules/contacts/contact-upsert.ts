import type { Contact, Prisma, PrismaClient } from '@prisma/client';
import { normalizeEmail } from './identity';

/**
 * Cross-source contact upsert (eng-review pass-2 D2 + codex T2 hardening).
 *
 * The same person across HubSpot + Apollo + CSV must collapse to ONE Contact.
 * Concurrency safety lives in three layers:
 *
 *   1. `pg_advisory_xact_lock(hashtext(orgId), hashtext(normalizedEmail))`
 *      serializes upserts targeting the same identity. Transaction-scoped, so
 *      no leaks under connection pooling.
 *   2. The DB-level `@@unique([orgId, normalizedEmail])` is the real safety —
 *      hashtext() is collision-prone in theory; the constraint catches it.
 *   3. The transaction wraps Contact + ContactEmail + ContactSource writes so
 *      a crash mid-flight leaves zero partial state.
 *
 * Scope for T1b: Contact normalized fields are set ONLY on creation.
 * Subsequent syncs leave Contact.firstName/title/etc untouched and only
 * upsert ContactSource. Per-field precedence (D3) lands in T4.
 *
 * Throws `InvalidEmailError` from `normalizeEmail()` BEFORE opening a
 * transaction — bad input never produces partial DB state.
 */
export interface UpsertContactInput {
  orgId: string;
  emailRaw: string;
  sourceAccountId: string;
  externalId: string;
  externalUrl?: string | null;
  fields?: {
    firstName?: string | null;
    lastName?: string | null;
    title?: string | null;
    company?: string | null;
    linkedinUrl?: string | null;
  };
  rawPayload: Prisma.InputJsonValue;
}

export interface UpsertContactResult {
  contact: Contact;
  /** True iff a new Contact row was created in this call (vs found existing). */
  created: boolean;
  /** True iff a new ContactSource row was created (vs the rawPayload was updated on an existing one). */
  sourceCreated: boolean;
}

export async function upsertContact(
  prisma: PrismaClient,
  input: UpsertContactInput,
): Promise<UpsertContactResult> {
  const normalizedEmail = normalizeEmail(input.emailRaw);

  return prisma.$transaction(async (tx) => {
    // Acquire transaction-scoped advisory lock keyed on (orgId, normalizedEmail).
    // Two-arg form hashes both strings to int4. Lock auto-releases on commit/rollback.
    // Use $executeRaw (not $queryRaw) — pg_advisory_xact_lock returns void, and
    // Prisma can't deserialize void columns from a SELECT result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.orgId}::text), hashtext(${normalizedEmail}::text))`;

    const existing = await tx.contact.findUnique({
      where: {
        orgId_normalizedEmail: {
          orgId: input.orgId,
          normalizedEmail,
        },
      },
    });

    let contact: Contact;
    let created = false;

    if (existing) {
      contact = existing;
    } else {
      contact = await tx.contact.create({
        data: {
          orgId: input.orgId,
          normalizedEmail,
          firstName: input.fields?.firstName ?? null,
          lastName: input.fields?.lastName ?? null,
          title: input.fields?.title ?? null,
          company: input.fields?.company ?? null,
          linkedinUrl: input.fields?.linkedinUrl ?? null,
          fieldProvenance: buildInitialFieldProvenance(
            input.sourceAccountId,
            input.fields ?? {},
          ),
          emails: {
            create: {
              normalizedEmail,
              rawEmail: input.emailRaw.trim(),
              isPrimary: true,
              sourceAccountId: input.sourceAccountId,
            },
          },
        },
      });
      created = true;
    }

    const existingSource = await tx.contactSource.findUnique({
      where: {
        sourceAccountId_externalId: {
          sourceAccountId: input.sourceAccountId,
          externalId: input.externalId,
        },
      },
    });

    if (existingSource) {
      await tx.contactSource.update({
        where: { id: existingSource.id },
        data: {
          rawPayload: input.rawPayload,
          rawPayloadVersion: { increment: 1 },
          lastSyncedAt: new Date(),
          externalUrl: input.externalUrl ?? existingSource.externalUrl,
        },
      });
      return { contact, created, sourceCreated: false };
    }

    await tx.contactSource.create({
      data: {
        contactId: contact.id,
        sourceAccountId: input.sourceAccountId,
        externalId: input.externalId,
        externalUrl: input.externalUrl ?? null,
        rawPayload: input.rawPayload,
      },
    });
    return { contact, created, sourceCreated: true };
  });
}

/**
 * Seed `Contact.fieldProvenance` on creation. Every populated field gets a
 * `{ source: <accountId>, updatedAt: <iso> }` entry. T4's per-field precedence
 * resolver reads this to decide whether a later vendor sync may overwrite.
 */
function buildInitialFieldProvenance(
  sourceAccountId: string,
  fields: Record<string, string | null | undefined>,
): Prisma.InputJsonValue {
  const now = new Date().toISOString();
  const provenance: Record<string, { source: string; updatedAt: string }> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== '') {
      provenance[key] = { source: sourceAccountId, updatedAt: now };
    }
  }
  return provenance;
}
