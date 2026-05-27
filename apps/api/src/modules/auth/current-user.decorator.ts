import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Resolved identity attached to the request by AuthGuard.
 *
 * Always carries `orgId` (the additional field on User from better-auth's
 * config). `userId` is the better-auth user.id which matches our User.id
 * primary key.
 */
export interface CurrentUserPayload {
  userId: string;
  orgId: string;
  email: string;
  /** Owner | member. May be null on the rare older row that predates the field. */
  role: string | null;
}

/**
 * Param decorator that reads the user payload AuthGuard attached to the
 * request. Throws if no payload is present — that means AuthGuard didn't
 * run, which is a wiring bug (apply @UseGuards(AuthGuard) on the controller
 * or method).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const user = (req as FastifyRequest & { user?: CurrentUserPayload }).user;
    if (!user) {
      // Treat as 401 rather than 500 — defensive: if the decorator runs
      // before the guard (route misconfig) we still don't leak data.
      throw new UnauthorizedException(
        'Missing session — apply @UseGuards(AuthGuard) on this route',
      );
    }
    return user;
  },
);
