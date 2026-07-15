import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Permission, can } from './acl';
import { SESSION_COOKIE } from './cookie';

export const PUBLIC_KEY = 'vfw:public';
/** Opt an endpoint out of authentication entirely (login, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const PERMISSION_KEY = 'vfw:permission';
/** Require an ACL permission. Authentication is implied. */
export const Can = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** What we actually sign. `tv` pins the token to a User.tokenVersion. */
export interface SessionClaims extends AuthUser {
  tv: number;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user,
);

/**
 * Verify a session and return its user. The single definition of "who is this
 * token", shared by the HTTP guard below and the WebSocket gateway — the gateway
 * authenticates its handshake with the same cookie, and must not grow a second,
 * subtly different copy of this rule.
 *
 * A valid signature is necessary but not sufficient. The token is a claim about
 * who signed in, not a standing grant, so role and status are re-read from the
 * database on every request rather than trusted from the payload. Without that
 * read, a 30-day JWT means a demoted admin keeps admin for 30 days and a
 * disabled account keeps working for 30 days — the token has no idea anything
 * changed. One indexed primary-key lookup is the price of being able to revoke.
 */
export async function verifySession(
  jwt: JwtService,
  prisma: PrismaService,
  token?: string,
): Promise<AuthUser> {
  if (!token) throw new UnauthorizedException('Not signed in');

  let claims: SessionClaims;
  try {
    claims = await jwt.verifyAsync<SessionClaims>(token);
  } catch {
    throw new UnauthorizedException('Session expired');
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.id },
    select: {
      id: true, email: true, name: true, role: true,
      status: true, deletedAt: true, tokenVersion: true,
    },
  });

  // Deleted, disabled, rejected, or still awaiting email verification — none of
  // those may act, whatever the token says.
  if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
    throw new UnauthorizedException('This account is no longer active');
  }

  // Explicitly revoked (password reset, forced sign-out) since this was minted.
  if ((claims.tv ?? 0) !== user.tokenVersion) {
    throw new UnauthorizedException('Session expired');
  }

  // Note the role comes from `user`, not `claims`: a role change takes effect on
  // the very next request.
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/**
 * One guard for both concerns: it verifies the session cookie, then checks the
 * ACL permission the route declared. Applied globally, so an endpoint is
 * locked down unless it is explicitly marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // This guard reads an HTTP request/cookie. It is registered globally, and a
    // global guard also fires on WebSocket message handlers — where there is no
    // such request. The gateway authenticates its own handshake (see
    // messaging.gateway.ts), so anything that is not HTTP is not our concern.
    if (ctx.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const payload = await verifySession(this.jwt, this.prisma, req.cookies?.[SESSION_COOKIE]);
    req.user = payload;

    const permission = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (permission && !can(permission, payload.role)) {
      throw new ForbiddenException(`Your role cannot ${permission}`);
    }

    return true;
  }
}
