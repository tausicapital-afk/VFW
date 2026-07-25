import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { ActivityService } from '../activity/activity.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser, SessionClaims } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { avatarKeyPrefix, avatarUrl } from './avatar';
import { AvatarCommitDto, AvatarPresignDto, ChangePasswordDto, UpdateProfileDto } from './dto';

/**
 * The shape of a profile as its owner sees it. Deliberately wider than the
 * session payload (`auth.me`) — this is the edit form's model, so it carries the
 * fields you may change plus the read-only ones the screen shows back to you so
 * you can see who to ask about them.
 */
const PROFILE_FIELDS = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  department: true,
  title: true,
  colour: true,
  avatarKey: true,
  employeeId: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly jwt: JwtService,
  ) {}

  /** Add the signed picture link to a row selected with PROFILE_FIELDS. */
  private async withAvatar<T extends { avatarKey: string | null }>(row: T) {
    const { avatarKey, ...rest } = row;
    return { ...rest, hasAvatar: avatarKey !== null, avatarUrl: await avatarUrl(this.storage, avatarKey) };
  }

  private async load(userId: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_FIELDS,
    });
    if (!row) throw new NotFoundException('Account not found');
    return row;
  }

  async get(user: AuthUser) {
    return this.withAvatar(await this.load(user.id));
  }

  /**
   * Save the caller's own details.
   *
   * There is no `id` parameter, and that is the whole security model: this
   * service can only ever write the row named by the session, so there is no
   * "edit someone else's profile" path to get the scoping wrong on. Changing
   * another account stays in AdminService behind `admin.manage`.
   */
  async update(dto: UpdateProfileDto, user: AuthUser) {
    const current = await this.load(user.id);

    const data: Prisma.UserUpdateInput = {};
    const changed: string[] = [];

    // Trim before comparing, or "Ann " re-saves as a change every time.
    const name = dto.name?.trim();
    if (name !== undefined && name !== current.name) {
      if (!name) throw new BadRequestException('Name cannot be empty');
      data.name = name;
      changed.push('name');
    }

    // The nullable trio: a blank string is a clearing, the same as an explicit
    // null. Storing "" would leave a field that renders as present and empty.
    for (const field of ['phone', 'department', 'title'] as const) {
      const raw = dto[field];
      if (raw === undefined) continue;
      const next = raw === null ? null : raw.trim() || null;
      if (next !== current[field]) {
        data[field] = next;
        changed.push(field);
      }
    }

    if (dto.colour !== undefined && dto.colour !== current.colour) {
      data.colour = dto.colour;
      changed.push('colour');
    }

    if (changed.length === 0) return this.withAvatar(current);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data,
      select: PROFILE_FIELDS,
    });

    await this.record(user, `${user.name} updated their profile (${changed.join(', ')})`, {
      fields: changed,
    });

    return this.withAvatar(updated);
  }

  // -------------------------------------------------------------------------
  // Avatar
  // -------------------------------------------------------------------------

  /** Step 1: a short-lived URL to PUT the image bytes to. */
  async presignAvatar(dto: AvatarPresignDto, user: AuthUser) {
    // The server owns the key, exactly as it does for submission documents. A
    // random segment stops two uploads of "photo.jpg" colliding, and the prefix
    // is what the commit below checks against.
    const safeName = dto.filename.replace(/[^\w.\- ]+/g, '_').slice(-80);
    const storageKey = `${avatarKeyPrefix(user.id)}${randomUUID()}-${safeName}`;
    const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType);

    return {
      uploadUrl,
      storageKey,
      method: 'PUT' as const,
      headers: { 'Content-Type': dto.contentType },
    };
  }

  /**
   * Step 2: the bytes are in R2 — point the account at them.
   *
   * The prefix check is load-bearing. Without it a client could commit any key in
   * the bucket, and since the API happily signs a read for whatever key an
   * account names, "set my avatar to submissions/<id>/contract.pdf" would be a
   * general-purpose read of other people's documents wearing a profile picture.
   */
  async commitAvatar(dto: AvatarCommitDto, user: AuthUser) {
    if (!dto.storageKey.startsWith(avatarKeyPrefix(user.id))) {
      throw new BadRequestException('storageKey does not belong to this account');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarKey: dto.storageKey },
      select: PROFILE_FIELDS,
    });

    await this.record(user, `${user.name} changed their profile picture`);
    return this.withAvatar(updated);
  }

  /**
   * Drop the picture and fall back to initials.
   *
   * The object itself is left in R2 rather than deleted. Removing it would make
   * this endpoint a delete primitive driven by a key held in a row, and the
   * bucket is shared with signed contracts; an orphaned 40 KB thumbnail is the
   * cheaper mistake by a wide margin. R2 lifecycle rules are the right tool for
   * reclaiming them, not a request handler.
   */
  async removeAvatar(user: AuthUser) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarKey: null },
      select: PROFILE_FIELDS,
    });

    await this.record(user, `${user.name} removed their profile picture`);
    return this.withAvatar(updated);
  }

  // -------------------------------------------------------------------------
  // Password
  // -------------------------------------------------------------------------

  /**
   * Change your own password, and hand back a session token that survives it.
   *
   * Bumping `tokenVersion` is the point of the exercise: it invalidates every
   * cookie already issued for this account, which is what someone changing their
   * password after leaving a laptop in a hotel is actually asking for. The token
   * returned here is minted *after* the bump, so the browser doing the changing
   * is the one session that stays signed in — the caller must set it as the new
   * cookie or it will be logged out by its own request.
   */
  async changePassword(dto: ChangePasswordDto, user: AuthUser) {
    const row = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { id: true, email: true, name: true, role: true, passwordHash: true },
    });
    if (!row) throw new NotFoundException('Account not found');

    const ok = await argon2.verify(row.passwordHash, dto.currentPassword).catch(() => false);
    if (!ok) throw new UnauthorizedException('Your current password is incorrect');

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('The new password must be different from the current one');
    }

    const passwordHash = await argon2.hash(dto.newPassword);

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.user.update({
        where: { id: row.id },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });

      // Any outstanding reset link is now a spare key to a lock that changed.
      await tx.passwordReset.updateMany({
        where: { userId: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await this.audit.log(
        {
          actorId: row.id,
          action: 'PASSWORD_CHANGED',
          detail: `${row.name} changed their own password`,
        },
        tx,
      );

      return saved;
    });

    const claims: SessionClaims = {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      tv: updated.tokenVersion,
    };

    await this.record(user, `${row.name} changed their password`);

    return { token: await this.jwt.signAsync(claims) };
  }

  /** A telemetry line for the Logs screen. Best-effort, like every other one. */
  private async record(user: AuthUser, detail: string, meta?: Prisma.InputJsonValue) {
    await this.activity
      .log({ userId: user.id, action: 'PROFILE_UPDATED', detail, meta })
      .catch(() => undefined);
  }
}
