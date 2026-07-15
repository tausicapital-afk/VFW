import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Invitation, Prisma, UserStatus } from '@prisma/client';
import { randomInt } from 'crypto';
import { Decimal } from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAddonDto,
  CreateInvitationDto,
  CreatePackageDto,
  RejectUserDto,
  UpdateAddonDto,
  UpdateInvitationDto,
  UpdatePackageDto,
  UpdatePendingUserDto,
  UpdateSettingsDto,
  UpdateTaxDto,
} from './dto';

/** No I, O, 0 or 1 — these codes get read off a screen and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const DEFAULT_EXPIRY_DAYS = 14;

export type InvitationStatus = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';

/** Derived, never stored — a stored status would drift out of date silently the
 *  moment an invitation expired without anyone touching the row. */
export function invitationStatus(i: Invitation, now = new Date()): InvitationStatus {
  if (i.revokedAt) return 'REVOKED';
  if (i.usedAt) return 'USED';
  if (i.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

/** Money and rates: parse from a string, keep in Decimal, store to fixed scale. */
function decimal(raw: string, field: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(raw);
  } catch {
    throw new BadRequestException(`${field} is not a valid number`);
  }
  if (!d.isFinite() || d.isNegative()) {
    throw new BadRequestException(`${field} must be a positive number`);
  }
  return d;
}

/**
 * Catalogue ids are read by people — they appear in QuickBooks exports and in
 * every audit payload that names a package — so a new row gets a derived id
 * rather than a cuid, spelled the way the seed spells them: VFW + "Bronze
 * Package" -> VFW-BRONZE. The word "Package" is dropped because every package
 * has it and an id that repeats its own noun says nothing.
 *
 * Admin.tsx previews this id in the new-package modal and applies the same
 * rules; keep the two in step.
 */
export function catalogueId(brand: string, name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/\bPACKAGE\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new BadRequestException('That name has no letters or digits to build an id from');
  return `${brand.toUpperCase()}-${slug}`;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // -------------------------------------------------------------------------
  // Invitations — signup is invite-only by design
  // -------------------------------------------------------------------------

  private async uniqueCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const body = Array.from({ length: CODE_LENGTH }, () =>
        CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join('');
      const code = `VFW-${body}`;
      if (!(await this.prisma.invitation.findUnique({ where: { code } }))) return code;
    }
    throw new BadRequestException('Could not allocate an invitation code — try again');
  }

  async createInvitation(dto: CreateInvitationDto, user: AuthUser) {
    const email = dto.email?.trim().toLowerCase();

    if (email && (await this.prisma.user.findUnique({ where: { email } }))) {
      throw new BadRequestException('An account already exists for that email');
    }

    const code = await this.uniqueCode();
    const expiresAt = new Date(
      Date.now() + (dto.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000,
    );

    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          code,
          role: dto.role,
          department: dto.department,
          email,
          expiresAt,
          createdById: user.id,
        },
      });
      await this.audit.log(
        {
          actorId: user.id,
          action: 'INVITE_CREATED',
          detail: `Invitation ${code} issued for ${dto.role}${email ? ` (${email})` : ' — open code'}`,
          payload: { invitationId: created.id, code, role: dto.role, email: email ?? null },
        },
        tx,
      );
      return created;
    });

    // The code exists whether or not the email goes out, so a dead transport
    // costs the admin a copy-paste rather than the whole invitation. Reported
    // honestly in `emailed` — the UI says which happened.
    let emailed = false;
    let emailError: string | null = null;
    if (email && this.email.configured) {
      try {
        await this.email.send(this.email.invitation(email, code, dto.role));
        emailed = true;
      } catch (e) {
        emailError = e instanceof Error ? e.message : 'The invitation email could not be sent';
      }
    } else if (email) {
      emailError = 'Email is not configured on this server — send the code manually';
    }

    return { ...this.shape(invitation, user.name), emailed, emailError };
  }

  async listInvitations() {
    const rows = await this.prisma.invitation.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { name: true } } },
    });
    return { invitations: rows.map((i) => this.shape(i, i.createdBy.name)) };
  }

  /**
   * Role, department and email only — see UpdateInvitationDto for why the code
   * and the expiry are not editable. Changing the email does not re-send the
   * invitation: the admin is told to pass on the link, the same as at create,
   * rather than us quietly mailing a stranger.
   */
  async updateInvitation(id: string, dto: UpdateInvitationDto, actor: AuthUser) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id, deletedAt: null },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');

    // A redeemed invitation is a historical fact — it already produced an
    // account, and editing the role here would not move that account.
    if (invitation.usedAt) {
      throw new BadRequestException('That invitation has been redeemed and can no longer be edited');
    }

    const email = dto.email === null ? null : dto.email?.trim().toLowerCase();
    if (email && email !== invitation.email) {
      const taken = await this.prisma.user.findUnique({ where: { email } });
      if (taken) throw new BadRequestException('An account already exists for that email');
    }

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.InvitationUpdateInput = {};

    if (dto.role !== undefined && dto.role !== invitation.role) {
      before.role = invitation.role;
      after.role = dto.role;
      data.role = dto.role;
    }
    if (dto.department !== undefined && dto.department !== invitation.department) {
      before.department = invitation.department;
      after.department = dto.department;
      data.department = dto.department;
    }
    if (email !== undefined && email !== invitation.email) {
      before.email = invitation.email;
      after.email = email;
      data.email = email;
    }

    if (!Object.keys(data).length) return this.shape(invitation, actor.name);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.invitation.update({ where: { id }, data });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'INVITE_UPDATED',
          detail: `Invitation ${invitation.code} edited (${Object.keys(after).join(', ')})`,
          payload: { invitationId: id, code: invitation.code, before, after },
        },
        tx,
      );
      return this.shape(updated, actor.name);
    });
  }

  /**
   * Soft delete: the row leaves the admin list but stays on file, because the
   * audit entries that name this invitation have to keep resolving. It also
   * stops being redeemable — see the signup path, which checks `deletedAt`.
   */
  async deleteInvitation(id: string, actor: AuthUser) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id, deletedAt: null },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'INVITE_DELETED',
          detail: `Invitation ${invitation.code} deleted`,
          payload: { invitationId: id, code: invitation.code, email: invitation.email },
        },
        tx,
      );
      return { ok: true };
    });
  }

  async revokeInvitation(id: string, user: AuthUser) {
    const invitation = await this.prisma.invitation.findUnique({ where: { id } });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.usedAt) {
      throw new BadRequestException('That invitation has already been redeemed');
    }
    if (invitation.revokedAt) throw new BadRequestException('That invitation is already revoked');

    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.invitation.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      await this.audit.log(
        {
          actorId: user.id,
          action: 'INVITE_REVOKED',
          detail: `Invitation ${invitation.code} revoked`,
          payload: { invitationId: id, code: invitation.code },
        },
        tx,
      );
      return this.shape(revoked, user.name);
    });
  }

  private shape(i: Invitation, createdBy: string) {
    return {
      id: i.id,
      code: i.code,
      role: i.role,
      department: i.department,
      email: i.email,
      status: invitationStatus(i),
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt,
      createdBy,
    };
  }

  // -------------------------------------------------------------------------
  // Users — a redeemed invitation is a request, not an account
  // -------------------------------------------------------------------------

  private readonly userFields = {
    id: true, name: true, email: true, phone: true, role: true, department: true,
    status: true, employeeId: true, commissionPct: true, target: true, colour: true,
    createdAt: true,
  } satisfies Prisma.UserSelect;

  async listUsers() {
    return {
      // `hidden` accounts (demo / test logins) are deliberately omitted here.
      // They still authenticate — this filter only keeps them off the Users tab.
      users: await this.prisma.user.findMany({
        where: { hidden: false, deletedAt: null },
        select: this.userFields,
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }),
    };
  }

  async pendingUsers() {
    return {
      users: await this.prisma.user.findMany({
        where: { status: UserStatus.PENDING, hidden: false, deletedAt: null },
        select: this.userFields,
        orderBy: { createdAt: 'asc' },
      }),
    };
  }

  /**
   * Corrections made while reviewing a signup — the role and department someone
   * typed into the form are a request, not a fact, and an admin fixing them
   * before approving beats approving and then re-editing.
   *
   * Email is not editable: it is the login identity, it is what the OTP was
   * sent to, and it is the one field the account holder has already proved.
   */
  async updatePendingUser(id: string, dto: UpdatePendingUserDto, actor: AuthUser) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== UserStatus.PENDING) {
      throw new BadRequestException(`That account is ${user.status}, not pending`);
    }

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.UserUpdateInput = {};

    const name = dto.name?.trim();
    if (name !== undefined && name !== user.name) {
      before.name = user.name;
      after.name = name;
      data.name = name;
    }
    if (dto.phone !== undefined && dto.phone !== user.phone) {
      before.phone = user.phone;
      after.phone = dto.phone;
      data.phone = dto.phone;
    }
    if (dto.role !== undefined && dto.role !== user.role) {
      before.role = user.role;
      after.role = dto.role;
      data.role = dto.role;
    }
    if (dto.department !== undefined && dto.department !== user.department) {
      before.department = user.department;
      after.department = dto.department;
      data.department = dto.department;
    }

    if (!Object.keys(data).length) {
      return { user: await this.prisma.user.findUniqueOrThrow({ where: { id }, select: this.userFields }) };
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data, select: this.userFields });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'USER_UPDATED',
          detail: `Edited pending account for ${user.name} (${Object.keys(after).join(', ')})`,
          payload: { userId: id, email: user.email, before, after },
        },
        tx,
      );
      return { user: updated };
    });
  }

  /**
   * Soft delete, for a signup that should never have reached the queue at all —
   * spam, a duplicate, a typo'd address. Distinct from reject, which is a
   * decision on record about a real request; this is a decision that there was
   * no real request. The row stays for the audit trail, and tokenVersion is
   * bumped so anything already holding a session for it dies now.
   */
  async deleteUser(id: string, actor: AuthUser) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    if (user.id === actor.id) throw new BadRequestException('You cannot delete your own account');

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), tokenVersion: { increment: 1 } },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'USER_DELETED',
          detail: `Deleted account for ${user.name} (${user.email})`,
          payload: { userId: id, email: user.email, role: user.role, status: user.status },
        },
        tx,
      );
      return { ok: true };
    });
  }

  async approveUser(id: string, actor: AuthUser) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== UserStatus.PENDING) {
      throw new BadRequestException(`That account is ${user.status}, not pending`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { status: UserStatus.ACTIVE },
        select: this.userFields,
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'USER_APPROVED',
          detail: `Approved account for ${user.name} (${user.role})`,
          payload: { userId: id, email: user.email, role: user.role },
        },
        tx,
      );
      return { user: updated };
    });
  }

  /**
   * Rejection is a status, not a delete. The account stays on file with the
   * audit entry that explains it — the same reason a rejected submission is
   * never removed.
   */
  async rejectUser(id: string, dto: RejectUserDto, actor: AuthUser) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== UserStatus.PENDING) {
      throw new BadRequestException(`That account is ${user.status}, not pending`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { status: UserStatus.REJECTED },
        select: this.userFields,
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'USER_REJECTED',
          detail: `Rejected account request for ${user.name}${dto.reason ? ` — ${dto.reason}` : ''}`,
          payload: { userId: id, email: user.email, reason: dto.reason ?? null },
        },
        tx,
      );
      return { user: updated };
    });
  }

  // -------------------------------------------------------------------------
  // Catalogue
  //
  // THE PROPERTY THAT MATTERS: editing a price here changes what a rep can sell
  // tomorrow. It does not, and must not, move a sale that has already been
  // priced. Nothing below writes to Submission or SubmissionAddon, and that is
  // not an oversight — SubmissionAddon copies unitPrice and amount onto the line
  // at submission time, and Submission stores packagePrice, precisely so that a
  // rate-card change cannot reach backwards into the books. The only code that
  // reads a catalogue price is PricingService, at create/resubmit time.
  // catalog.spec.ts holds this line with a test.
  // -------------------------------------------------------------------------

  private async assertTaxAndGl(taxCode: string, glCode: string) {
    if (!(await this.prisma.taxProfile.findUnique({ where: { code: taxCode } }))) {
      throw new BadRequestException(`Unknown tax profile ${taxCode}`);
    }
    if (!(await this.prisma.glAccount.findUnique({ where: { code: glCode } }))) {
      throw new BadRequestException(`Unknown GL account ${glCode}`);
    }
  }

  /**
   * A new package is only ever additive: it appears on the new-submission form
   * from now on and touches nothing that has already been sold. Created with its
   * city prices in one transaction, because a package with no price is not
   * sellable and half of one is not worth leaving behind.
   */
  async createPackage(dto: CreatePackageDto, actor: AuthUser) {
    const brand = dto.brand.trim().toUpperCase();
    const name = dto.name.trim();
    const id = catalogueId(brand, name);

    if (await this.prisma.package.findUnique({ where: { id } })) {
      throw new BadRequestException(
        `${brand} already has a package with the id ${id} — give this one a different name`,
      );
    }
    await this.assertTaxAndGl(dto.taxCode, dto.glCode);

    // Two prices for one city would otherwise reach the @@unique constraint and
    // come back as a 500 rather than as something the admin can act on.
    const cityIds = dto.prices.map((p) => p.cityId);
    if (new Set(cityIds).size !== cityIds.length) {
      throw new BadRequestException('A package can only carry one price per city');
    }
    const cities = await this.prisma.city.findMany({ where: { id: { in: cityIds } } });
    for (const cityId of cityIds) {
      if (!cities.some((c) => c.id === cityId)) {
        throw new BadRequestException(`Unknown city ${cityId}`);
      }
    }

    const prices = dto.prices.map((p) => ({
      cityId: p.cityId,
      currency: p.currency,
      price: decimal(p.price, `Price for ${p.cityId}`).toFixed(2),
    }));

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.package.create({
        data: {
          id,
          brand,
          name,
          looks: dto.looks,
          blurb: dto.blurb?.trim() || null,
          taxCode: dto.taxCode,
          glCode: dto.glCode,
          prices: { create: prices },
        },
        include: { prices: { include: { city: true } } },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CATALOG_PACKAGE_CREATED',
          detail: `Package added to the rate card: ${brand} ${name}`,
          payload: {
            packageId: id,
            brand,
            name,
            looks: dto.looks,
            taxCode: dto.taxCode,
            glCode: dto.glCode,
            prices,
          },
        },
        tx,
      );
      return created;
    });
  }

  async createAddon(dto: CreateAddonDto, actor: AuthUser) {
    const brand = dto.brand.trim().toUpperCase();
    const name = dto.name.trim();
    const id = catalogueId(brand, name);

    if (await this.prisma.addon.findUnique({ where: { id } })) {
      throw new BadRequestException(
        `${brand} already has an add-on with the id ${id} — give this one a different name`,
      );
    }
    if (!(await this.prisma.glAccount.findUnique({ where: { code: dto.glCode } }))) {
      throw new BadRequestException(`Unknown GL account ${dto.glCode}`);
    }

    const forBrands = dto.forBrands.map((b) => b.trim().toUpperCase());
    const price = decimal(dto.price, 'Price').toFixed(2);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.addon.create({
        data: {
          id,
          brand,
          name,
          price,
          currency: dto.currency,
          note: dto.note?.trim() || null,
          forBrands,
          glCode: dto.glCode,
        },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CATALOG_ADDON_CREATED',
          detail: `Add-on added to the catalogue: ${brand} ${name}`,
          payload: {
            addonId: id,
            brand,
            name,
            price,
            currency: dto.currency,
            forBrands,
            glCode: dto.glCode,
          },
        },
        tx,
      );
      return created;
    });
  }

  async updatePackage(id: string, dto: UpdatePackageDto, actor: AuthUser) {
    const pkg = await this.prisma.package.findUnique({
      where: { id },
      include: { prices: true },
    });
    if (!pkg) throw new NotFoundException('Package not found');

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.PackageUpdateInput = {};

    if (dto.name !== undefined && dto.name !== pkg.name) {
      before.name = pkg.name;
      after.name = dto.name;
      data.name = dto.name;
    }
    if (dto.taxCode !== undefined && dto.taxCode !== pkg.taxCode) {
      if (!(await this.prisma.taxProfile.findUnique({ where: { code: dto.taxCode } }))) {
        throw new BadRequestException(`Unknown tax profile ${dto.taxCode}`);
      }
      before.taxCode = pkg.taxCode;
      after.taxCode = dto.taxCode;
      data.tax = { connect: { code: dto.taxCode } };
    }
    if (dto.glCode !== undefined && dto.glCode !== pkg.glCode) {
      if (!(await this.prisma.glAccount.findUnique({ where: { code: dto.glCode } }))) {
        throw new BadRequestException(`Unknown GL account ${dto.glCode}`);
      }
      before.glCode = pkg.glCode;
      after.glCode = dto.glCode;
      data.gl = { connect: { code: dto.glCode } };
    }

    const priceUpdates = (dto.prices ?? []).flatMap((p) => {
      const existing = pkg.prices.find((x) => x.cityId === p.cityId);
      if (!existing) {
        throw new BadRequestException(`${pkg.name} is not sold in ${p.cityId}`);
      }
      const next = decimal(p.price, `Price for ${p.cityId}`).toFixed(2);
      if (next === existing.price.toFixed(2)) return [];
      return [{ id: existing.id, cityId: p.cityId, from: existing.price.toFixed(2), to: next }];
    });

    if (!Object.keys(after).length && !priceUpdates.length) {
      throw new BadRequestException('Nothing was changed');
    }
    if (priceUpdates.length) {
      before.prices = priceUpdates.map((p) => ({ cityId: p.cityId, price: p.from }));
      after.prices = priceUpdates.map((p) => ({ cityId: p.cityId, price: p.to }));
    }

    return this.prisma.$transaction(async (tx) => {
      for (const p of priceUpdates) {
        await tx.packagePrice.update({ where: { id: p.id }, data: { price: p.to } });
      }
      const updated = Object.keys(data).length
        ? await tx.package.update({ where: { id }, data, include: { prices: true } })
        : await tx.package.findUniqueOrThrow({ where: { id }, include: { prices: true } });

      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CATALOG_PACKAGE_UPDATED',
          detail: `Rate card updated: ${pkg.name}`,
          payload: { packageId: id, before, after },
        },
        tx,
      );
      return updated;
    });
  }

  async updateAddon(id: string, dto: UpdateAddonDto, actor: AuthUser) {
    const addon = await this.prisma.addon.findUnique({ where: { id } });
    if (!addon) throw new NotFoundException('Add-on not found');

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.AddonUpdateInput = {};

    if (dto.name !== undefined && dto.name !== addon.name) {
      before.name = addon.name;
      after.name = dto.name;
      data.name = dto.name;
    }
    if (dto.note !== undefined && dto.note !== addon.note) {
      before.note = addon.note;
      after.note = dto.note;
      data.note = dto.note;
    }
    if (dto.glCode !== undefined && dto.glCode !== addon.glCode) {
      if (!(await this.prisma.glAccount.findUnique({ where: { code: dto.glCode } }))) {
        throw new BadRequestException(`Unknown GL account ${dto.glCode}`);
      }
      before.glCode = addon.glCode;
      after.glCode = dto.glCode;
      data.gl = { connect: { code: dto.glCode } };
    }
    if (dto.price !== undefined) {
      const next = decimal(dto.price, 'Price').toFixed(2);
      if (next !== addon.price.toFixed(2)) {
        before.price = addon.price.toFixed(2);
        after.price = next;
        data.price = next;
      }
    }

    if (!Object.keys(after).length) throw new BadRequestException('Nothing was changed');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.addon.update({ where: { id }, data });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CATALOG_ADDON_UPDATED',
          detail: `Add-on updated: ${addon.name}`,
          payload: { addonId: id, before, after },
        },
        tx,
      );
      return updated;
    });
  }

  async updateTax(code: string, dto: UpdateTaxDto, actor: AuthUser) {
    const tax = await this.prisma.taxProfile.findUnique({ where: { code } });
    if (!tax) throw new NotFoundException('Tax profile not found');

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.TaxProfileUpdateInput = {};

    if (dto.label !== undefined && dto.label !== tax.label) {
      before.label = tax.label;
      after.label = dto.label;
      data.label = dto.label;
    }
    if (dto.note !== undefined && dto.note !== tax.note) {
      before.note = tax.note;
      after.note = dto.note;
      data.note = dto.note;
    }
    for (const key of ['rate', 'gst', 'pst', 'hst'] as const) {
      const raw = dto[key];
      if (raw === undefined) continue;
      const next = decimal(raw, key.toUpperCase());
      if (next.greaterThan(100)) {
        throw new BadRequestException(`${key.toUpperCase()} cannot exceed 100%`);
      }
      const fixed = next.toFixed(3);
      if (fixed !== tax[key].toFixed(3)) {
        before[key] = tax[key].toFixed(3);
        after[key] = fixed;
        data[key] = fixed;
      }
    }

    if (!Object.keys(after).length) throw new BadRequestException('Nothing was changed');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.taxProfile.update({ where: { code }, data });
      // A tax rate is the one catalogue figure Accounting will be asked to
      // justify, so the before/after payload matters more here than anywhere.
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CATALOG_TAX_UPDATED',
          detail: `Tax profile updated: ${tax.label}`,
          payload: { taxCode: code, before, after },
        },
        tx,
      );
      return updated;
    });
  }

  async settings() {
    return this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  }

  async updateSettings(dto: UpdateSettingsDto, actor: AuthUser) {
    const current = await this.settings();

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.SettingsUpdateInput = {};

    const scalars = ['company', 'fiscalYear', 'invoicePrefix', 'qbRealmId'] as const;
    for (const key of scalars) {
      const next = dto[key];
      if (next === undefined || next === current[key]) continue;
      before[key] = current[key];
      after[key] = next;
      (data as Record<string, unknown>)[key] = next;
    }

    if (dto.discountApprovalPct !== undefined) {
      const next = decimal(dto.discountApprovalPct, 'Discount approval threshold');
      if (next.greaterThan(100)) {
        throw new BadRequestException('The discount threshold cannot exceed 100%');
      }
      const fixed = next.toFixed(2);
      if (fixed !== current.discountApprovalPct.toFixed(2)) {
        before.discountApprovalPct = current.discountApprovalPct.toFixed(2);
        after.discountApprovalPct = fixed;
        data.discountApprovalPct = fixed;
      }
    }

    if (dto.fxRates) {
      // CAD is the reporting currency: converting it to itself at anything other
      // than 1 would silently restate every consolidated figure in the system.
      if (dto.fxRates.CAD !== undefined && Number(dto.fxRates.CAD) !== 1) {
        throw new BadRequestException('CAD is the reporting currency — its rate is always 1');
      }
      for (const [cur, rate] of Object.entries(dto.fxRates)) {
        if (!(rate > 0)) throw new BadRequestException(`The ${cur} rate must be greater than zero`);
      }
      const next = { ...(current.fxRates as object), ...dto.fxRates, CAD: 1 };
      before.fxRates = current.fxRates as Prisma.InputJsonValue;
      after.fxRates = next;
      data.fxRates = next;
    }

    if (dto.scoreWeights) {
      const w = dto.scoreWeights;
      const total = w.revenue + w.approved + w.collection + w.retention;
      if (total !== 100) {
        throw new BadRequestException(`The score weights must total 100 — these total ${total}`);
      }
      before.scoreWeights = current.scoreWeights as Prisma.InputJsonValue;
      after.scoreWeights = { ...w };
      data.scoreWeights = { ...w };
    }

    if (!Object.keys(after).length) throw new BadRequestException('Nothing was changed');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.settings.update({ where: { id: 1 }, data });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'SETTINGS_UPDATED',
          detail: `Settings updated: ${Object.keys(after).join(', ')}`,
          payload: { before, after } as Prisma.InputJsonValue,
        },
        tx,
      );
      return updated;
    });
  }

  /** The catalogue as the admin screen needs it — prices and cities included. */
  async catalogue() {
    const [packages, addons, taxes, glAccounts, cities, events] = await Promise.all([
      this.prisma.package.findMany({
        include: { prices: { include: { city: true } } },
        orderBy: [{ brand: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.addon.findMany({ orderBy: [{ brand: 'asc' }, { name: 'asc' }] }),
      this.prisma.taxProfile.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.glAccount.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.city.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.event.findMany({ include: { city: true }, orderBy: { start: 'asc' } }),
    ]);
    return { packages, addons, taxes, glAccounts, cities, events };
  }
}
