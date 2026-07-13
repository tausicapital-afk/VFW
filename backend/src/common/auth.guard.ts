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
import { Role } from '@prisma/client';
import { Request } from 'express';
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

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user,
);

/**
 * Verify a session JWT and return its user. The single definition of "who is
 * this token", shared by the HTTP guard below and the WebSocket gateway — the
 * gateway authenticates its handshake with the same cookie, and must not grow a
 * second, subtly different copy of this rule. Throws on a missing/invalid token.
 */
export async function verifySession(jwt: JwtService, token?: string): Promise<AuthUser> {
  if (!token) throw new UnauthorizedException('Not signed in');
  try {
    return await jwt.verifyAsync<AuthUser>(token);
  } catch {
    throw new UnauthorizedException('Session expired');
  }
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
    const payload = await verifySession(this.jwt, req.cookies?.[SESSION_COOKIE]);
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
