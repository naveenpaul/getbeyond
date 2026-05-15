import type { OrgContext } from '../org-context/org-context';

/**
 * Set of tenant-scoped Prisma models. Reads/writes through {@link applyOrgScope}
 * automatically inject `orgId` from the active OrgContext.
 *
 * Architecture invariant (eng-review pass-1 Issue 4A):
 *   Every model that holds tenant data MUST appear here.
 *   Postgres RLS is the second enforcement layer; this is the first.
 *
 * Models NOT in this set:
 *   - TeammateConfig: global config (not tenant-scoped).
 *   - Citation, Claim, ModelCall, ToolCall: scoped transitively via parent AgentRun/Draft.
 *   - ContactEmail, ContactSource: scoped transitively via parent Contact.
 *   - ContactListMember: scoped transitively via parent ContactList.
 *   - DraftAction: scoped transitively via parent Draft.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Organization',
  'User',
  'CompanyBrain',
  'AgentRun',
  'Draft',
  'ConnectorAccount',
  'Contact',
  'ContactList',
  'SyncRun',
]);

export function isTenantScopedModel(model: string): boolean {
  return TENANT_SCOPED_MODELS.has(model);
}

export class OrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgScopeError';
  }
}

type DataRow = { orgId?: string } & Record<string, unknown>;
type WhereClause = Record<string, unknown>;

interface PrismaArgs {
  where?: WhereClause;
  data?: DataRow | DataRow[];
  [key: string]: unknown;
}

export interface OrgScopeParams {
  args: PrismaArgs;
  model: string;
  operation: string;
  ctx: OrgContext | null;
}

const READ_OPS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const CREATE_OPS = new Set(['create', 'createMany']);

const MUTATE_OPS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * Pure function: given args + model + operation + active OrgContext, mutate
 * args in-place to enforce tenant scoping. Returns the same args reference.
 *
 * - Non-tenant-scoped models pass through unchanged.
 * - Tenant-scoped models without an active context throw `OrgScopeError`.
 * - Reads inject `orgId` into `where`.
 * - Creates verify `data.orgId` matches context (or sets it). Mismatch throws.
 * - Updates/deletes/upserts scope `where` by `orgId`.
 * - Unknown operations pass through (Prisma adds new operation types occasionally;
 *   we'd rather not fail closed on an unknown verb than block legitimate work).
 */
export function applyOrgScope({
  args,
  model,
  operation,
  ctx,
}: OrgScopeParams): PrismaArgs {
  if (!isTenantScopedModel(model)) {
    return args;
  }
  if (!ctx) {
    throw new OrgScopeError(
      `Tenant query without OrgContext: ${model}.${operation}. ` +
        'Wrap in withOrgContext(...) or run inside an authenticated request.',
    );
  }

  if (READ_OPS.has(operation) || MUTATE_OPS.has(operation)) {
    args.where = { ...(args.where ?? {}), orgId: ctx.orgId };
    return args;
  }

  if (CREATE_OPS.has(operation)) {
    const data = args.data;
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row.orgId !== undefined && row.orgId !== ctx.orgId) {
          throw new OrgScopeError(
            `${model}.${operation}: orgId mismatch with active context ` +
              `(got "${row.orgId}", expected "${ctx.orgId}")`,
          );
        }
        row.orgId = ctx.orgId;
      }
    } else if (data && typeof data === 'object') {
      if (data.orgId !== undefined && data.orgId !== ctx.orgId) {
        throw new OrgScopeError(
          `${model}.${operation}: orgId mismatch with active context ` +
            `(got "${data.orgId}", expected "${ctx.orgId}")`,
        );
      }
      data.orgId = ctx.orgId;
    }
    return args;
  }

  // Unknown operation — pass through. Prisma occasionally adds new verbs;
  // failing closed on an unknown one would block legitimate work without
  // catching a real bug. Surface via depcruise/lint if we want stricter.
  return args;
}
