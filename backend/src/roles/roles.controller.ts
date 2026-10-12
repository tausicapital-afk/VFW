import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  PERMISSION_INFO,
  Permission,
  isPermission,
} from '../common/acl';
import { AuthUser, Can, CurrentUser, effectivePermissions } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

export class CreateRoleDto {
  @IsString() @MinLength(1) @MaxLength(40)
  label: string;

  @IsArray() @ArrayUnique() @IsString({ each: true }) @Type(() => String)
  permissions: string[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  label?: string;

  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true }) @Type(() => String)
  permissions?: string[];
}

/**
 * Where an orphaned historical reference goes when its role is deleted: a
 * deleted account or a closed invitation cannot be edited from any screen, but
 * still points at the role, so it is moved to the least-privileged built-in.
 */
const FALLBACK_ROLE = 'INTERN';

/**
 * Roles: create, rename, re-permission, delete. The key a role is created with
 * is what accounts hold, so it never changes; the label is what every screen
 * shows. See the schema comment on RoleDef for why the built-ins can be edited
 * but not deleted, and why ADMIN always holds everything.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const [roles, counts] = await Promise.all([
      this.prisma.roleDef.findMany({ orderBy: [{ builtIn: 'desc' }, { label: 'asc' }] }),
      this.prisma.user.groupBy({ by: ['role'], where: { deletedAt: null }, _count: { _all: true } }),
    ]);
    const held = new Map(counts.map((c) => [c.role, c._count._all]));
    return {
      roles: roles.map((r) => ({
        key: r.key,
        label: r.label,
        builtIn: r.builtIn,
        locked: r.key === ADMIN_ROLE,
        permissions: effectivePermissions(r.key, r.permissions),
        users: held.get(r.key) ?? 0,
      })),
      permissions: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSION_INFO[key] })),
    };
  }

  async create(dto: CreateRoleDto, actor: AuthUser) {
    const label = dto.label.trim();
    await this.assertLabelFree(label);
    const permissions = this.validPermissions(dto.permissions);
    const key = await this.freeKey(label);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.roleDef.create({ data: { key, label, permissions } });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'ROLE_CREATED',
          detail: `Role added: ${label}`,
          payload: { key, label, permissions },
        },
        tx,
      );
      return created;
    });
  }

  async update(key: string, dto: UpdateRoleDto, actor: AuthUser) {
    const role = await this.prisma.roleDef.findUnique({ where: { key } });
    if (!role) throw new NotFoundException('Role not found');

    const label = dto.label?.trim();
    if (label !== undefined && label.toLowerCase() !== role.label.toLowerCase()) {
      await this.assertLabelFree(label, key);
    }

    let permissions: Permission[] | undefined;
    if (dto.permissions !== undefined) {
      // ADMIN keeps everything whatever is sent — see effectivePermissions.
      permissions = key === ADMIN_ROLE ? [...ALL_PERMISSIONS] : this.validPermissions(dto.permissions);
      // Taking Administration away from your own role is the one edit here that
      // would lock you out of undoing it.
      if (key === actor.role && !permissions.includes('admin.manage')) {
        throw new BadRequestException('You cannot remove Administration from your own role');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.roleDef.update({
        where: { key },
        data: {
          ...(label !== undefined ? { label } : {}),
          ...(permissions !== undefined ? { permissions } : {}),
        },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'ROLE_UPDATED',
          detail: `Role updated: ${updated.label}`,
          payload: {
            key,
            before: { label: role.label, permissions: role.permissions },
            after: { label: updated.label, permissions: updated.permissions },
          },
        },
        tx,
      );
      return updated;
    });
  }

  async remove(key: string, actor: AuthUser) {
    const role = await this.prisma.roleDef.findUnique({ where: { key } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.builtIn) {
      throw new BadRequestException(`${role.label} is a built-in role — it can be edited but not deleted`);
    }

    const now = new Date();
    const [liveUsers, openInvitations] = await Promise.all([
      this.prisma.user.count({ where: { role: key, deletedAt: null } }),
      this.prisma.invitation.count({
        where: { role: key, deletedAt: null, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      }),
    ]);
    if (liveUsers || openInvitations) {
      const parts = [
        liveUsers ? `${liveUsers} account${liveUsers === 1 ? '' : 's'}` : '',
        openInvitations ? `${openInvitations} open invitation${openInvitations === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      throw new BadRequestException(
        `${parts.join(' and ')} still use ${role.label} — move them to another role first`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const movedUsers = await tx.user.updateMany({ where: { role: key }, data: { role: FALLBACK_ROLE } });
      const movedInvitations = await tx.invitation.updateMany({
        where: { role: key },
        data: { role: FALLBACK_ROLE },
      });
      await tx.roleDef.delete({ where: { key } });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'ROLE_DELETED',
          detail: `Role deleted: ${role.label}`,
          payload: {
            key,
            label: role.label,
            permissions: role.permissions,
            // Deleted accounts and closed invitations that still named it.
            movedToFallback: { role: FALLBACK_ROLE, users: movedUsers.count, invitations: movedInvitations.count },
          },
        },
        tx,
      );
      return { ok: true };
    });
  }

  private validPermissions(list: string[]): Permission[] {
    const unknown = list.filter((p) => !isPermission(p));
    if (unknown.length) throw new BadRequestException(`Unknown permission: ${unknown.join(', ')}`);
    return list as Permission[];
  }

  private async assertLabelFree(label: string, exceptKey?: string) {
    const clash = await this.prisma.roleDef.findFirst({
      where: { label: { equals: label, mode: 'insensitive' }, ...(exceptKey ? { key: { not: exceptKey } } : {}) },
    });
    if (clash) throw new BadRequestException(`A role called "${clash.label}" already exists`);
  }

  /** "Field Rep" -> FIELD_REP, or FIELD_REP_2 if that is taken. */
  private async freeKey(label: string): Promise<string> {
    const base =
      label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'ROLE';
    const taken = new Set(
      (await this.prisma.roleDef.findMany({ where: { key: { startsWith: base } }, select: { key: true } }))
        .map((r) => r.key)
        .concat(BUILT_IN_ROLES),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }
}

@Controller('api/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  // Any signed-in user: every screen that names someone's role reads the label here.
  @Get()
  list() {
    return this.roles.list();
  }

  @Post()
  @Can('admin.manage')
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.create(dto, user);
  }

  @Patch(':key')
  @Can('admin.manage')
  update(@Param('key') key: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.update(key, dto, user);
  }

  @Delete(':key')
  @Can('admin.manage')
  remove(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.roles.remove(key, user);
  }
}

@Module({
  providers: [RolesService],
  controllers: [RolesController],
})
export class RolesModule {}
