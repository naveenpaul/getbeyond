import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createAuth } from './auth.config';
import type { CurrentUserPayload } from './current-user.decorator';

/**
 * Session-based auth guard (T7.1).
 *
 * Reads the session cookie from the incoming Fastify request, calls
 * better-auth's `auth.api.getSession({ headers })` to validate + load the
 * user, and attaches the resolved identity (`userId`, `orgId`, `email`,
 * `role`) to the request as `req.user`.
 *
 * Throws 401 when no session is present or the cookie is invalid. Routes
 * that need to be reachable anonymously (the auth handler itself, health
 * checks) simply don't apply this guard at the controller level.
 *
 * Why not a global guard via APP_GUARD: applying it globally would also
 * block /api/auth/sign-in/magic-link before better-auth ever sees it.
 * Explicit @UseGuards at the controller level is one line per controller
 * and keeps the public/private boundary visible at the call site.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly prisma: PrismaService;
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    // The auth instance is cheap to construct; we cache one per guard
    // instance so we don't re-init better-auth on every request.
    this.auth = createAuth(prisma);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    // Fastify headers are Node's IncomingHttpHeaders; better-auth wants a
    // Web Headers object. Coerce + flatten.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }

    const result = await this.auth.api.getSession({ headers });
    if (!result || !result.user) {
      throw new UnauthorizedException('Sign in to access this resource');
    }

    const user = result.user as {
      id: string;
      email: string;
      orgId?: string;
      role?: string | null;
    };
    if (!user.orgId) {
      // Should be impossible — the user.create.before hook always sets
      // orgId. Surface as 500 territory (UnauthorizedException is close
      // enough for the client; the API logs reveal the underlying issue).
      throw new UnauthorizedException(
        'Session user has no orgId — re-sign-in',
      );
    }

    const payload: CurrentUserPayload = {
      userId: user.id,
      orgId: user.orgId,
      email: user.email,
      role: user.role ?? null,
    };
    (req as FastifyRequest & { user?: CurrentUserPayload }).user = payload;
    return true;
  }
}
