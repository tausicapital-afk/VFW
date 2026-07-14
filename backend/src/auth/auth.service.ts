import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, randomInt } from 'crypto';
import { ActivityService, ActivityContext } from '../activity/activity.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { EmailNotConfiguredError, EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { ForgotDto, ResetDto, SignupDto, VerifyOtpDto } from './dto';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** A reset link is a bearer credential in an inbox. It should not live long. */
const RESET_TTL_MINUTES = 30;

/** A signup code lands the caller straight in their account, so keep it short-lived. */
const OTP_TTL_MINUTES = 10;
/** Wrong guesses before a six-digit code is burned — far below what brute force needs. */
const MAX_OTP_ATTEMPTS = 5;

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
  private readonly log = new Logger(AuthService.name);

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
          ? 'Please verify your email to activate your account'
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
   * Redeem an invitation and create an unverified (PENDING) account, then email a
   * one-time code. The account cannot log in until that code is entered at
   * {@link verifyOtp}, which flips it ACTIVE and issues the session — email
   * verification, not an administrator, is the gate.
   *
   * Three things are load-bearing here:
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
   *
   * 3. **Email is required.** The account is useless until a code is delivered,
   *    so if the transport is not configured we refuse up front rather than
   *    stranding a PENDING account nobody can ever verify.
   */
  async signup(dto: SignupDto): Promise<{ email: string; otpRequired: true; devOtp?: string }> {
    const email = dto.email.trim().toLowerCase();
    const code = dto.code.trim().toUpperCase();

    const echo = this.devEcho();
    if (!this.email.configured && !echo) throw new EmailNotConfiguredError();

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

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid;

      const created = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email,
          phone: dto.phone,
          passwordHash,
          role,
          department,
          // PENDING = email not yet verified. verifyOtp() flips it to ACTIVE once
          // the code we email below is entered; until then it cannot log in.
          status: UserStatus.PENDING,
          commissionPct: role === 'SALES' ? '8' : '0',
          target: role === 'SALES' ? '60000' : '0',
          colour: AVATAR_COLOURS[Math.floor(Math.random() * AVATAR_COLOURS.length)],
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { usedById: created.id },
      });

      await this.audit.log(
        {
          actorId: created.id,
          action: 'SIGNUP',
          detail: `${created.name} redeemed invitation ${code} (${role}) — awaiting email verification`,
          payload: { invitationId: invitation.id, role, email },
        },
        tx,
      );

      return created;
    });

    // The account exists; now the code that unlocks it. Minted after the commit
    // so a mail hiccup leaves a recoverable PENDING account (resend re-issues)
    // rather than rolling back an already-claimed invitation.
    const otp = await this.issueOtp(user.id);
    if (this.email.configured) {
      await this.email.send(this.email.welcome(user.email, user.name, otp, OTP_TTL_MINUTES));
      return { email: user.email, otpRequired: true };
    }
    // DEV_ECHO_LINKS: hand the code back instead of mailing it. Off by default,
    // ignored in production, and named so nobody mistakes it for real delivery.
    return { email: user.email, otpRequired: true, devOtp: otp };
  }

  /**
   * Mint a fresh six-digit signup code for a user and return the plaintext once.
   *
   * Any earlier unconsumed code is retired first, so only the newest one works —
   * a resent code silently invalidating the previous email is the behaviour users
   * expect, and it keeps the attempt counters from being split across rows.
   * Only the argon2 hash is stored; the plaintext lives only in the email.
   */
  private async issueOtp(userId: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await argon2.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.emailOtp.updateMany({
        where: { userId, purpose: OtpPurpose.SIGNUP, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.emailOtp.create({
        data: { userId, purpose: OtpPurpose.SIGNUP, codeHash, expiresAt },
      });
    });

    return code;
  }

  /**
   * Verify a signup code: on success the account goes ACTIVE and a session is
   * issued, so the caller lands straight on the dashboard.
   *
   * The reply is deliberately uniform. Unknown email, wrong code, expired code,
   * too many attempts — all answer with the same message, so this endpoint never
   * becomes a way to learn which addresses are registered or how far a guess got.
   */
  async verifyOtp(dto: VerifyOtpDto): Promise<{ token: string; user: AuthUser }> {
    const email = dto.email.trim().toLowerCase();
    const submitted = dto.code.trim();
    const invalid = new BadRequestException('That code is invalid or has expired. Request a new one.');

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Already verified accounts have no live code; anything but PENDING is a no-op.
    if (!user || user.status !== UserStatus.PENDING) throw invalid;

    const otp = await this.prisma.emailOtp.findFirst({
      where: { userId: user.id, purpose: OtpPurpose.SIGNUP, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt <= new Date()) throw invalid;

    if (otp.attempts >= MAX_OTP_ATTEMPTS) {
      // Burn it so a fresh code must be requested, then refuse.
      await this.prisma.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
      throw invalid;
    }

    const ok = await argon2.verify(otp.codeHash, submitted).catch(() => false);
    if (!ok) {
      await this.prisma.emailOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw invalid;
    }

    const authUser = await this.prisma.$transaction(async (tx) => {
      await tx.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
      const activated = await tx.user.update({
        where: { id: user.id },
        data: { status: UserStatus.ACTIVE },
      });
      // Whoever just proved control of the inbox should not inherit a lockout
      // left by someone guessing at the password.
      await tx.loginAttempt.deleteMany({ where: { email: activated.email } });
      await this.audit.log(
        { actorId: activated.id, action: 'EMAIL_VERIFIED', detail: `${activated.email} verified their email and activated their account` },
        tx,
      );
      return {
        id: activated.id,
        email: activated.email,
        name: activated.name,
        role: activated.role,
      } satisfies AuthUser;
    });

    return { token: await this.jwt.signAsync(authUser), user: authUser };
  }

  /**
   * Re-issue a signup code. Uniform reply for the same enumeration reason as
   * {@link forgot}: it says the same thing whether or not the address maps to an
   * account still waiting to be verified.
   */
  async resendOtp(email: string): Promise<{ message: string; devOtp?: string }> {
    const reply = { message: 'If that account is awaiting verification, a new code has been sent.' };
    const addr = email.trim().toLowerCase();
    const echo = this.devEcho();

    if (!this.email.configured && !echo) throw new EmailNotConfiguredError();

    const user = await this.prisma.user.findUnique({ where: { email: addr } });
    if (!user || user.status !== UserStatus.PENDING) return reply;

    const code = await this.issueOtp(user.id);
    if (this.email.configured) {
      await this.email.send(this.email.otp(user.email, user.name, code, OTP_TTL_MINUTES));
      return reply;
    }
    return { ...reply, devOtp: code };
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

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordReset.updateMany({
        where: { token: dto.token, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid;

      const reset = await tx.passwordReset.findUniqueOrThrow({ where: { token: dto.token } });
      const updated = await tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      });

      // Any other outstanding link for this account is now stale — a password
      // change should not leave a second key lying in an old email.
      await tx.passwordReset.updateMany({
        where: { userId: updated.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      // Clear the brute-force counter: the person who just proved control of the
      // inbox should not be locked out by whoever was guessing at their password.
      await tx.loginAttempt.deleteMany({ where: { email: updated.email } });

      await this.audit.log(
        {
          actorId: updated.id,
          action: 'PASSWORD_RESET',
          detail: `Password reset for ${updated.email}`,
        },
        tx,
      );

      return updated;
    });

    // Confirmation is best-effort: the reset already succeeded, so a mail failure
    // here must not turn a completed password change into an error for the user.
    if (this.email.configured) {
      await this.email.send(this.email.passwordChanged(user.email)).catch((err) => {
        this.log.error(`Password-changed notice failed to send: ${err?.message ?? err}`);
      });
    }

    return { ok: true };
  }

  /** Never in production, whatever the env says. */
  private devEcho(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.DEV_ECHO_LINKS === 'true';
  }
}
