import { z } from 'zod';

/**
 * Per-DraftActionKind Zod schemas (eng-review pass-2 D7 + codex T7).
 *
 * Every DraftAction.payload is validated at enqueue AND dequeue time against
 * the schema for its `kind`. Schema versioning is carried on
 * `DraftAction.payloadSchemaVersion`; mismatched versions land in dead-letter
 * rather than executing with a shape the worker doesn't understand. (Schema
 * version migrations live in T5.2 — for now everything is version 1.)
 *
 * Adding a new DraftActionKind: add an entry below, register a destination
 * adapter that declares the kind in its `supports[]`, done.
 */

export const SendEmailPayload = z.object({
  to: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** Optional preheader text. Most email clients show this in the inbox preview. */
  preheader: z.string().optional(),
});
export type SendEmailPayload = z.infer<typeof SendEmailPayload>;

export const PostLinkedinPayload = z.object({
  content: z.string().min(1).max(3000),
  /** UTC ISO-8601. Null = post immediately. */
  scheduledFor: z.string().datetime().nullable().optional(),
});
export type PostLinkedinPayload = z.infer<typeof PostLinkedinPayload>;

export const PostTwitterPayload = z.object({
  content: z.string().min(1).max(280),
});
export type PostTwitterPayload = z.infer<typeof PostTwitterPayload>;

export const CrmLogActivityPayload = z.object({
  /** Contact (in our DB) that this activity references. */
  contactId: z.string().min(1),
  /** Activity type — vendor-agnostic; adapters map to vendor types. */
  type: z.enum(['email_sent', 'note', 'task', 'call', 'meeting']),
  summary: z.string().min(1),
  body: z.string().optional(),
});
export type CrmLogActivityPayload = z.infer<typeof CrmLogActivityPayload>;

export const CrmUpdateFieldPayload = z.object({
  contactId: z.string().min(1),
  field: z.string().min(1),
  /** Value to set. Adapters coerce per-vendor expectations. */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type CrmUpdateFieldPayload = z.infer<typeof CrmUpdateFieldPayload>;

/** Archive carries no payload. Acts as a "user said no, do nothing else" marker. */
export const ArchivePayload = z.object({});
export type ArchivePayload = z.infer<typeof ArchivePayload>;

/**
 * Lookup table: DraftActionKind (Prisma enum value) → Zod schema.
 * Worker reads this at dequeue time to validate the payload shape.
 */
export const PAYLOAD_SCHEMAS = {
  send_email: SendEmailPayload,
  post_linkedin: PostLinkedinPayload,
  post_twitter: PostTwitterPayload,
  crm_log_activity: CrmLogActivityPayload,
  crm_update_field: CrmUpdateFieldPayload,
  archive: ArchivePayload,
} as const;

export type DraftActionKind = keyof typeof PAYLOAD_SCHEMAS;

export class UnknownDraftActionKindError extends Error {
  constructor(public readonly kind: string) {
    super(`No payload schema registered for DraftActionKind "${kind}"`);
    this.name = 'UnknownDraftActionKindError';
  }
}

export function getPayloadSchema(kind: string): z.ZodSchema<unknown> {
  if (!(kind in PAYLOAD_SCHEMAS)) {
    throw new UnknownDraftActionKindError(kind);
  }
  return PAYLOAD_SCHEMAS[kind as DraftActionKind] as z.ZodSchema<unknown>;
}

/**
 * Currently-deployed schema version. Bump when a payload shape changes in a
 * non-backward-compatible way; legacy queue jobs with older versions land in
 * dead-letter so a new shape can't mis-execute against an old worker.
 */
export const CURRENT_PAYLOAD_SCHEMA_VERSION = 1;
