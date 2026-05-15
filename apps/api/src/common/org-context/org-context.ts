import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request org-scoping context. Set in the auth middleware; read by the
 * Prisma scoping extension to inject `orgId` into every tenant-scoped query.
 *
 * Architecture invariant (eng-review pass-1 Issue 4A + pass-2 D2):
 *   - All tenant-scoped queries are filtered by orgId.
 *   - Postgres RLS is the second enforcement layer; this is the first.
 *   - If a service tries to read tenant data without an active context, it
 *     throws — never returns cross-tenant rows.
 */
export interface OrgContext {
  orgId: string;
  userId: string;
  role: 'owner' | 'member';
}

const storage = new AsyncLocalStorage<OrgContext>();

export function withOrgContext<T>(ctx: OrgContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getOrgContext(): OrgContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No active OrgContext. Code is reading tenant data outside an authenticated request. ' +
        'Wrap the operation in withOrgContext(...) or run it inside an HTTP request handler.',
    );
  }
  return ctx;
}

export function getOrgContextOrNull(): OrgContext | null {
  return storage.getStore() ?? null;
}
