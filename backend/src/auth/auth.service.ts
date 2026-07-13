import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(rawEmail: string, password: string): Promise<{ token: string; user: AuthUser }> {
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

    const authUser: AuthUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    return { token: await this.jwt.signAsync(authUser), user: authUser };
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
}
