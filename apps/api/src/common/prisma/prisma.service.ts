import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getOrgContextOrNull } from '../org-context/org-context';
import { applyOrgScope } from './org-scope';

/**
 * PrismaService wraps PrismaClient with NestJS lifecycle hooks and exposes
 * an org-scoped client via {@link scoped}. The actual scoping logic lives in
 * `org-scope.ts` as a pure function so it's unit-testable without a DB.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'production'
          ? ['error', 'warn']
          : ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Returns an org-scoped Prisma client. Tenant-scoped reads inject
   * `where.orgId`; tenant-scoped writes verify `data.orgId` matches context.
   * Throws `OrgScopeError` if called on a tenant-scoped model outside an
   * active `OrgContext` — no silent cross-tenant leaks.
   */
  scoped(): ReturnType<PrismaClient['$extends']> {
    return this.$extends({
      name: 'org-scope',
      query: {
        $allModels: {
          async $allOperations({ args, query, model, operation }) {
            const ctx = getOrgContextOrNull();
            const scopedArgs = applyOrgScope({
              args: args as Parameters<typeof applyOrgScope>[0]['args'],
              model,
              operation,
              ctx,
            });
            return query(scopedArgs);
          },
        },
      },
    });
  }
}
