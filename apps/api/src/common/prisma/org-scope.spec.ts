import { describe, expect, it } from 'vitest';
import type { OrgContext } from '../org-context/org-context';
import {
  applyOrgScope,
  isTenantScopedModel,
  OrgScopeError,
  TENANT_SCOPED_MODELS,
} from './org-scope';

const CTX: OrgContext = { orgId: 'org_A', userId: 'usr_1', role: 'owner' };
const OTHER_CTX: OrgContext = { orgId: 'org_B', userId: 'usr_2', role: 'owner' };

describe('isTenantScopedModel', () => {
  it('returns true for every model in TENANT_SCOPED_MODELS', () => {
    for (const model of TENANT_SCOPED_MODELS) {
      expect(isTenantScopedModel(model)).toBe(true);
    }
  });

  it('returns false for non-tenant-scoped models', () => {
    expect(isTenantScopedModel('TeammateConfig')).toBe(false);
    expect(isTenantScopedModel('Claim')).toBe(false);
    expect(isTenantScopedModel('Citation')).toBe(false);
    expect(isTenantScopedModel('ContactEmail')).toBe(false);
    expect(isTenantScopedModel('DraftAction')).toBe(false);
  });

  it('includes every load-bearing tenant table', () => {
    const required = [
      'Organization',
      'User',
      'CompanyBrain',
      'AgentRun',
      'Draft',
      'ConnectorAccount',
      'Contact',
      'ContactList',
      'SyncRun',
    ];
    for (const model of required) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });
});

describe('applyOrgScope — non-tenant-scoped models', () => {
  it('passes args through unchanged for non-tenant models', () => {
    const args = { where: { id: 'cuid_1' } };
    const result = applyOrgScope({
      args,
      model: 'TeammateConfig',
      operation: 'findUnique',
      ctx: CTX,
    });
    expect(result).toBe(args);
    expect(result.where).toEqual({ id: 'cuid_1' });
  });

  it('does not require an OrgContext for non-tenant models', () => {
    expect(() =>
      applyOrgScope({
        args: {},
        model: 'TeammateConfig',
        operation: 'findMany',
        ctx: null,
      }),
    ).not.toThrow();
  });
});

describe('applyOrgScope — missing context', () => {
  it('throws OrgScopeError on tenant-scoped reads with no context', () => {
    expect(() =>
      applyOrgScope({
        args: {},
        model: 'Contact',
        operation: 'findMany',
        ctx: null,
      }),
    ).toThrow(OrgScopeError);
  });

  it('error message names the model + operation', () => {
    try {
      applyOrgScope({
        args: {},
        model: 'Draft',
        operation: 'create',
        ctx: null,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OrgScopeError);
      expect((err as Error).message).toContain('Draft.create');
      expect((err as Error).message).toContain('OrgContext');
    }
  });
});

describe('applyOrgScope — read operations', () => {
  it('injects orgId into empty where for findMany', () => {
    const args: Record<string, unknown> = {};
    applyOrgScope({ args, model: 'Contact', operation: 'findMany', ctx: CTX });
    expect(args.where).toEqual({ orgId: 'org_A' });
  });

  it('preserves existing where filters when injecting orgId', () => {
    const args = { where: { title: 'CTO' } };
    applyOrgScope({ args, model: 'Contact', operation: 'findMany', ctx: CTX });
    expect(args.where).toEqual({ title: 'CTO', orgId: 'org_A' });
  });

  it('handles all read operation variants', () => {
    const ops = [
      'findMany',
      'findFirst',
      'findUnique',
      'findFirstOrThrow',
      'findUniqueOrThrow',
      'count',
      'aggregate',
      'groupBy',
    ];
    for (const op of ops) {
      const args: Record<string, unknown> = {};
      applyOrgScope({ args, model: 'Contact', operation: op, ctx: CTX });
      expect(args.where).toEqual({ orgId: 'org_A' });
    }
  });
});

describe('applyOrgScope — create operations', () => {
  it('injects orgId into create data when absent', () => {
    const args = { data: { firstName: 'Sasha' } };
    applyOrgScope({ args, model: 'Contact', operation: 'create', ctx: CTX });
    expect(args.data).toEqual({ firstName: 'Sasha', orgId: 'org_A' });
  });

  it('accepts matching orgId on create data', () => {
    const args = { data: { firstName: 'Sasha', orgId: 'org_A' } };
    expect(() =>
      applyOrgScope({ args, model: 'Contact', operation: 'create', ctx: CTX }),
    ).not.toThrow();
    expect(args.data.orgId).toBe('org_A');
  });

  it('throws on mismatched orgId in create data (cross-tenant attempt)', () => {
    const args = { data: { firstName: 'Sasha', orgId: 'org_B' } };
    expect(() =>
      applyOrgScope({ args, model: 'Contact', operation: 'create', ctx: CTX }),
    ).toThrow(OrgScopeError);
  });

  it('error message includes both attempted and expected orgId', () => {
    try {
      applyOrgScope({
        args: { data: { orgId: 'evil_org' } },
        model: 'Contact',
        operation: 'create',
        ctx: CTX,
      });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('evil_org');
      expect(msg).toContain('org_A');
    }
  });

  it('handles createMany with array data — all rows get orgId', () => {
    const args = {
      data: [
        { firstName: 'A' },
        { firstName: 'B' },
        { firstName: 'C', orgId: 'org_A' },
      ],
    };
    applyOrgScope({
      args,
      model: 'Contact',
      operation: 'createMany',
      ctx: CTX,
    });
    expect(args.data).toEqual([
      { firstName: 'A', orgId: 'org_A' },
      { firstName: 'B', orgId: 'org_A' },
      { firstName: 'C', orgId: 'org_A' },
    ]);
  });

  it('throws on createMany if any row has mismatched orgId', () => {
    const args = {
      data: [
        { firstName: 'A' },
        { firstName: 'B', orgId: 'org_B' },
      ],
    };
    expect(() =>
      applyOrgScope({
        args,
        model: 'Contact',
        operation: 'createMany',
        ctx: CTX,
      }),
    ).toThrow(OrgScopeError);
  });
});

describe('applyOrgScope — mutate operations', () => {
  it('scopes update by orgId in where', () => {
    const args = { where: { id: 'cuid_1' }, data: { title: 'CEO' } };
    applyOrgScope({ args, model: 'Contact', operation: 'update', ctx: CTX });
    expect(args.where).toEqual({ id: 'cuid_1', orgId: 'org_A' });
  });

  it('scopes delete by orgId in where', () => {
    const args = { where: { id: 'cuid_1' } };
    applyOrgScope({ args, model: 'Draft', operation: 'delete', ctx: CTX });
    expect(args.where).toEqual({ id: 'cuid_1', orgId: 'org_A' });
  });

  it('scopes upsert + deleteMany + updateMany', () => {
    for (const op of ['upsert', 'deleteMany', 'updateMany']) {
      const args = { where: { status: 'pending' } };
      applyOrgScope({ args, model: 'Draft', operation: op, ctx: CTX });
      expect(args.where).toEqual({ status: 'pending', orgId: 'org_A' });
    }
  });
});

describe('applyOrgScope — unknown operations', () => {
  it('passes through unknown operations on tenant-scoped models', () => {
    const args = { somethingNew: true };
    expect(() =>
      applyOrgScope({
        args,
        model: 'Contact',
        operation: 'futurePrismaVerb',
        ctx: CTX,
      }),
    ).not.toThrow();
    expect(args).toEqual({ somethingNew: true });
  });
});

describe('applyOrgScope — isolation between orgs', () => {
  it('does not leak orgId from a prior call into a subsequent call with different ctx', () => {
    const args1: Record<string, unknown> = {};
    applyOrgScope({ args: args1, model: 'Contact', operation: 'findMany', ctx: CTX });
    expect(args1.where).toEqual({ orgId: 'org_A' });

    const args2: Record<string, unknown> = {};
    applyOrgScope({
      args: args2,
      model: 'Contact',
      operation: 'findMany',
      ctx: OTHER_CTX,
    });
    expect(args2.where).toEqual({ orgId: 'org_B' });
  });
});
