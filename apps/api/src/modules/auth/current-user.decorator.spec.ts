import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { resolveCurrentUser } from './current-user.decorator';

/**
 * Tests for the helper that backs the @CurrentUser decorator. Exercises
 * the "no user on req → 401" defensive branch that no live controller can
 * trigger (every route applies AuthGuard before the decorator). The
 * branch is the safety net for a future route misconfig.
 */

function makeCtx(reqUser: unknown): ExecutionContext {
  const req = { user: reqUser };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('resolveCurrentUser', () => {
  it('returns the payload AuthGuard attached to the request', () => {
    const payload = {
      userId: 'u1',
      orgId: 'o1',
      email: 'alice@test.com',
      role: 'owner' as const,
    };
    expect(resolveCurrentUser(makeCtx(payload))).toEqual(payload);
  });

  it('throws 401 when AuthGuard did not run', () => {
    expect(() => resolveCurrentUser(makeCtx(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
