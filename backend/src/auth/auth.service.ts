import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { ActivityService, ActivityContext } from '../activity/activity.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { EmailNotConfiguredError, EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { ForgotDto, ResetDto, SignupDto } from './dto';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** A reset link is a bearer credential in an inbox. It should not live long. */
const RESET_TTL_MINUTES = 30;

const AVATAR_COLOURS = ['#2F6BFF', '#0C7A4D', '#6B4BC4', '#A96C05', '#B3332A'];

/**
 * The same answer whether or not the address is registered. Anything that varies
 * with existence — a different message, a different status, a slower response —
 * turns this endpoint into a way to enumerate who works here.
 */
const FORGOT_REPLY = {
  message: 'If an account exists for that address, a reset link has been sent.',
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async login(
    rawEmail: string,
    password: string,
    ctx?: ActivityContext,
  ): Promise<{ token: string; user: AuthUser }> {
    const email = rawEmail.trim().toLowerCase();

    const attempt = await this.prisma.loginAttempt.findUnique({ where: { email } });
    if (attempt?.lockUntil && attempt.lockUntil > new Date()) {
      const mins = Math.ceil((attempt.lockUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many attempts. Try again in ${mins} minute(s).`);
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    // Verify against a dummy hash when the account does not exist, so the
    // response time does not reveal which emails are registered.
    const hash = user?.passwordHash ?? (await argon2.hash('no-such-user'));
    const ok = await argon2.verify(hash, password).catch(() => false);

    if (!user || !ok) {
      await this.recordFailure(email);
      throw new UnauthorizedException('Email or password is incorrect');
    }

    // A valid password is still not a login if the account has not been let in.
    if (user.status !== UserStatus.ACTIVE) {
      const reason =
        user.status === UserStatus.PENDING
          ? 'Your account is awaiting administrator approval'
          : 'This account is not active';
      throw new UnauthorizedException(reason);
    }

    await this.prisma.loginAttempt.deleteMany({ where: { email } });

    // Telemetry for the Logs screen: stamp lastLoginAt and record the sign-in.
    // Best-effort — a logging hiccup must never turn a valid login into a 500.
    await this.activity
      .recordLogin(user.id, user.name, ctx)
      .catch(() => undefined);

    const authUser: AuthUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    return { token: await this.jwt.signAsync(authUser), user: authUser };
  }

  /** Record a sign-out for the Logs screen. Best-effort, like login. */
  async recordLogout(user: AuthUser, ctx?: ActivityContext) {
    await this.activity.recordLogout(user.id, user.name, ctx).catch(() => undefined);
  }

  private async recordFailure(email: string) {
    const prev = await this.prisma.loginAttempt.findUnique({ where: { email } });
    const count = (prev?.count ?? 0) + 1;
    const lockUntil = count >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null;
    await this.prisma.loginAttempt.upsert({
      where: { email },
      update: { count, lockUntil },
      create: { email, count, lockUntil },
    });
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, role: true, department: true,
        employeeId: true, commissionPct: true, target: true, colour: true,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Self-service: signup (invite-only), forgot password, reset password
  // -------------------------------------------------------------------------

  /**
   * Redeem an invitation and create a PENDING account.
   *
   * Two things are load-bearing here:
   *
   * 1. **The role comes from the invitation, never from the request.** The
   *    signup form posts a role because the mockup's form has the field, but an
   *    invitation issued for a Sales rep cannot be redeemed into an Admin
   *    account. Whatever the client sends is discarded.
   *
   * 2. **The invitation is consumed with a conditional update inside the
   *    transaction** (`updateMany` on the still-unused row), not a read followed
   *    by a write. Two people racing the same code cannot both get an account:
   *    the second update matches zero rows and the whole transaction rolls back.
   */
  async signup(dto: SignupDto) {
    const email = dto.email.trim().toLowerCase();
    const code = dto.code.trim().toUpperCase();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new BadRequestException('An account already exists for that email');
    }

    const invitation = await this.prisma.invitation.findUnique({ where: { code } });
    const invalid = new BadRequestException(
      'That invitation code is not recognised, has expired, or has already been used',
    );
    if (!invitation) throw invalid;
    if (invitation.usedAt || invitation.revokedAt) throw invalid;
    if (invitation.expiresAt <= new Date()) throw invalid;

    // An invitation addressed to someone is not a bearer token for anyone.
    if (invitation.email && invitation.email.toLowerCase() !== email) {
      throw new BadRequestException('That invitation was issued for a different email address');
    }

    const passwordHash = await argon2.hash(dto.password);
    const role = invitation.role;
    const department = invitation.department ?? dto.department ?? null;

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid;

      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email,
          phone: dto.phone,
          passwordHash,
          role,
          department,
          // PENDING: a redeemed invitation gets you a request, not an account.
          // An administrator still has to let you in.
          status: UserStatus.PENDING,
          commissionPct: role === 'SALES' ? '8' : '0',
          target: role === 'SALES' ? '60000' : '0',
          colour: AVATAR_COLOURS[Math.floor(Math.random() * AVATAR_COLOURS.length)],
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { usedById: user.id },
      });

      await this.audit.log(
        {
          actorId: user.id,
          action: 'SIGNUP',
          detail: `${user.name} redeemed invitation ${code} (${role}) — awaiting administrator approval`,
          payload: { invitationId: invitation.id, role, email },
        },
        tx,
      );

      return { id: user.id, name: user.name, email: user.email, status: user.status };
    });
  }

  /**
   * Issue a reset link.
   *
   * The transport is checked FIRST, before the account is even looked up. If
   * that check came later, an unconfigured server would answer 503 for a real
   * address and 200 for an unknown one — which is exactly the account-enumeration
   * oracle the uniform reply above exists to prevent.
   */
  async forgot(dto: ForgotDto): Promise<{ message: string; devResetToken?: string }> {
    const email = dto.email.trim().toLowerCase();
    const echo = this.devEcho();

    if (!this.email.configured && !echo) throw new EmailNotConfiguredError();

    const user = await this.prisma.user.findUnique({ where: { email } });
    // No such account: say the same thing, do nothing, take the same path.
    if (!user || user.status === UserStatus.REJECTED) return FORGOT_REPLY;

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.passwordReset.create({ data: { token, userId: user.id, expiresAt } });
      await this.audit.log(
        {
          actorId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          detail: `Reset link issued, valid for ${RESET_TTL_MINUTES} minutes`,
        },
        tx,
      );
    });

    if (this.email.configured) {
      await this.email.send(this.email.passwordReset(user.email, token, RESET_TTL_MINUTES));
      return FORGOT_REPLY;
    }

    // DEV_ECHO_LINKS: hand the token back in the response instead of mailing it.
    // Off by default, ignored outright in production (see devEcho), and named in
    // the response so nobody can mistake it for a working mail setup.
    return { ...FORGOT_REPLY, devResetToken: token };
  }

  /**
   * Consume a reset token and set the new password.
   *
   * Single-use and expiring are enforced as one atomic compare-and-set: the
   * `updateMany` only matches a row that is still unused and still in date, and
   * stamps `usedAt` in the same statement. Reading the row, checking it, then
   * writing it would leave a window in which the same link works twice.
   */
  async reset(dto: ResetDto) {
    const invalid = new BadRequestException('This reset link is invalid, expired, or already used');
    const passwordHash = await argon2.hash(dto.password);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordReset.updateMany({
        where: { token: dto.token, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid;

      const reset = await tx.passwordReset.findUniqueOrThrow({ where: { token: dto.token } });
      const user = await tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      });

      // Any other outstanding link for this account is now stale — a password
      // change should not leave a second key lying in an old email.
      await tx.passwordReset.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      // Clear the brute-force counter: the person who just proved control of the
      // inbox should not be locked out by whoever was guessing at their password.
      await tx.loginAttempt.deleteMany({ where: { email: user.email } });

      await this.audit.log(
        {
          actorId: user.id,
          action: 'PASSWORD_RESET',
          detail: `Password reset for ${user.email}`,
        },
        tx,
      );

      return { ok: true };
    });
  }

  /** Never in production, whatever the env says. */
  private devEcho(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.DEV_ECHO_LINKS === 'true';
  }
}
