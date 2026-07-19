import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountType, Prisma, SubmissionStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { can } from '../common/acl';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { buildInvoicePdf, type InvoicePdfData } from './invoice-pdf';
import {
  ApproveDto,
  CreateSubmissionDto,
  ExportDto,
  PatchSubmissionDto,
  PaymentDto,
  RejectDto,
} from './dto';

const DETAIL = {
  rep: { select: { id: true, name: true, colour: true, role: true } },
  contact: true,
  event: { include: { city: true } },
  package: true,
  addons: { include: { addon: true } },
  payments: { orderBy: { date: 'asc' } },
  tax: true,
} satisfies Prisma.SubmissionInclude;

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sales reps see only their own customers; ACCT/MGR/ADMIN see everything.
   * Public because ContactsService reuses the exact same rule — there must not
   * be a second, subtly different definition of "whose deals can I see".
   */
  scopeFor(user: AuthUser): Prisma.SubmissionWhereInput {
    return can('submission.viewAll', user.role) ? {} : { repId: user.id };
  }

  async list(user: AuthUser) {
    return this.prisma.submission.findMany({
      // Voided sales are soft-deleted: kept for audit, but absent from every
      // normal list. Restore them from the voided view (listVoided).
      where: { ...this.scopeFor(user), status: { not: SubmissionStatus.VOIDED } },
      include: DETAIL,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The soft-deleted sales, for the roles that can restore them. */
  async listVoided(user: AuthUser) {
    if (!can('submission.void', user.role)) throw new ForbiddenException();
    return this.prisma.submission.findMany({
      where: { status: SubmissionStatus.VOIDED },
      include: DETAIL,
      orderBy: { voidedAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({
      where: { id },
      include: DETAIL,
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (!can('submission.viewAll', user.role) && submission.repId !== user.id) {
      // Same shape as a genuine miss: a rep must not be able to probe for the
      // existence of another rep's deals.
      throw new NotFoundException('Submission not found');
    }
    return submission;
  }

  /**
   * The review pipeline. Accounting works it; a rep reads it to see where their
   * own submission sits. The row scope is what makes that second audience safe —
   * without it this returns every rep's brand, discount and total, which is
   * exactly what `scopeFor` exists to prevent.
   */
  async queue(user: AuthUser) {
    if (!can('submission.queueView', user.role)) throw new ForbiddenException();
    return this.prisma.submission.findMany({
      where: {
        ...this.scopeFor(user),
        status: { in: [SubmissionStatus.PENDING, SubmissionStatus.RETURNED] },
      },
      include: DETAIL,
      orderBy: { submittedAt: 'asc' },
    });
  }

  /**
   * What has already crossed into QuickBooks — the Export ledger card, and the
   * file accounting reconciles against.
   *
   * Newest first, by the moment it was posted rather than the moment it was
   * created: the ledger is read as a record of postings, and the two orders
   * disagree the first time an old approval is exported late.
   */
  async ledger(user: AuthUser) {
    return this.prisma.submission.findMany({
      where: { ...this.scopeFor(user), status: SubmissionStatus.EXPORTED },
      include: DETAIL,
      orderBy: { exportedAt: 'desc' },
    });
  }

  /**
   * Find (or create) the contact this sale is against.
   *
   * A brand is one customer, so selling to a brand somebody else already entered
   * links to their contact rather than making a second one. What it must NOT do
   * is *overwrite* that contact's details. Reads are row-scoped — a rep cannot
   * see another rep's customers — and this write is scoped to match: submitting
   * against a brand you cannot see links to it and leaves its details alone.
   * Without that check, `upsert` here is a blind cross-rep write, letting any rep
   * silently replace the email and phone of a customer they are not allowed to
   * read, just by guessing the brand name.
   */
  private async resolveContact(
    tx: Prisma.TransactionClient,
    dto: CreateSubmissionDto,
    user: AuthUser,
  ) {
    const details = {
      designer: dto.designer,
      company: dto.company,
      email: dto.email,
      phone: dto.phone,
      country: dto.country,
    };

    const existing = await tx.contact.findUnique({ where: { brand: dto.brand } });
    if (!existing) {
      // Still an upsert, so two reps racing the same new brand cannot both
      // insert it — but with an empty `update`, so the loser of the race links
      // to the winner's contact instead of clobbering it.
      return tx.contact.upsert({
        where: { brand: dto.brand },
        update: {},
        create: { brand: dto.brand, ...details, createdById: user.id },
      });
    }

    const mayEdit =
      can('submission.viewAll', user.role) ||
      existing.createdById === user.id ||
      (await tx.submission.count({ where: { contactId: existing.id, repId: user.id } })) > 0;

    if (!mayEdit) return existing;

    return tx.contact.update({ where: { id: existing.id }, data: details });
  }

  /**
   * Validate what was sold and price it. Shared by create and edit/resubmit so
   * the two cannot drift into pricing a sale by two subtly different rules.
   *
   * `repId` is the rep the sale BELONGS to, which is not always the caller: when
   * Accounting edits a rep's submission under `submission.editAny`, commission
   * and department must still come from that rep. Pricing it against the editor
   * would recompute the deal at Accounting's 0% and quietly zero the rep's
   * commission.
   */
  private async resolveSale(dto: CreateSubmissionDto, repId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: dto.eventId },
      include: { city: true },
    });
    if (!event) throw new BadRequestException('Unknown event');

    const pkg = await this.prisma.package.findUnique({
      where: { id: dto.packageId },
      include: { prices: true, tax: true },
    });
    if (!pkg) throw new BadRequestException('Unknown package');
    if (pkg.brand !== event.brand) {
      throw new BadRequestException(`${pkg.name} is not sold at ${event.name}`);
    }

    // Price comes from the catalog, keyed by the city the event runs in. The
    // client never sends a price, so it cannot invent one.
    const price = pkg.prices.find((p) => p.cityId === event.cityId);
    if (!price) {
      throw new BadRequestException(`${pkg.name} has no price for ${event.city.name}`);
    }

    const addonIds = dto.addonIds ?? [];
    const addons = addonIds.length
      ? await this.prisma.addon.findMany({ where: { id: { in: addonIds } } })
      : [];
    if (addons.length !== addonIds.length) throw new BadRequestException('Unknown add-on');

    for (const a of addons) {
      if (!a.forBrands.includes(event.brand)) {
        throw new BadRequestException(`"${a.name}" cannot be sold with a ${event.brand} package`);
      }
      // Mixing currencies inside one invoice has no correct total.
      if (a.currency !== price.currency) {
        throw new BadRequestException(
          `"${a.name}" is priced in ${a.currency} but this sale is in ${price.currency}`,
        );
      }
    }

    const discountType = dto.discountType ?? DiscountType.PCT;
    if (discountType === DiscountType.PCT && (dto.discountValue ?? 0) > 100) {
      throw new BadRequestException('A percentage discount cannot exceed 100%');
    }

    const rep = await this.prisma.user.findUniqueOrThrow({ where: { id: repId } });

    const priced = this.pricing.compute({
      packagePrice: price.price,
      addons: addons.map((a) => ({
        addonId: a.id,
        qty: 1,
        unitPrice: a.price,
        currency: a.currency,
      })),
      discountType,
      discountValue: dto.discountValue ?? 0,
      taxRate: pkg.tax.rate,
      commissionPct: rep.commissionPct,
      deposit: dto.deposit ?? 0,
    });

    return { event, pkg, price, addons, discountType, rep, priced };
  }

  async create(dto: CreateSubmissionDto, user: AuthUser) {
    // On create the caller is the rep — they are selling their own deal.
    const { event, pkg, price, discountType, rep, priced } = await this.resolveSale(dto, user.id);

    return this.prisma.$transaction(async (tx) => {
      const contact = await this.resolveContact(tx, dto, user);

      const ref = await this.nextRef(tx);

      const submission = await tx.submission.create({
        data: {
          ref,
          status: SubmissionStatus.PENDING,
          submittedAt: new Date(),
          repId: user.id,
          contactId: contact.id,
          eventId: event.id,
          cityId: event.cityId,
          packageId: pkg.id,
          showDate: dto.showDate ? new Date(dto.showDate) : null,
          notes: dto.notes,
          currency: price.currency,
          packagePrice: priced.packagePrice.toFixed(2),
          addonTotal: priced.addonTotal.toFixed(2),
          subtotal: priced.subtotal.toFixed(2),
          discountType,
          discountValue: (dto.discountValue ?? 0).toString(),
          discountAmount: priced.discountAmount.toFixed(2),
          taxable: priced.taxable.toFixed(2),
          taxCode: pkg.taxCode,
          taxRate: priced.taxRate.toFixed(3),
          taxAmount: priced.taxAmount.toFixed(2),
          total: priced.total.toFixed(2),
          deposit: (dto.deposit ?? 0).toString(),
          paidAmount: priced.paidAmount.toFixed(2),
          balance: priced.balance.toFixed(2),
          payStatus: priced.payStatus,
          commissionPct: priced.commissionPct.toFixed(2),
          commissionAmount: priced.commissionAmount.toFixed(2),
          paymentMethod: dto.paymentMethod,
          department: rep.department,
          addons: {
            create: priced.lines.map((l) => ({
              addonId: l.addonId,
              qty: l.qty,
              unitPrice: l.unitPrice.toString(),
              currency: l.currency,
              amount: l.amount.toFixed(2),
            })),
          },
        },
        include: DETAIL,
      });

      await this.audit.log(
        {
          submissionId: submission.id,
          actorId: user.id,
          action: 'SUBMITTED',
          detail: 'Sent to Accounting for approval',
          payload: { total: submission.total.toString(), currency: submission.currency },
        },
        tx,
      );

      return submission;
    });
  }

  /**
   * Approve, subject to the discount threshold.
   *
   * A rep may propose any discount up to 100% — sales discretion is not being
   * removed, and create/update stay untouched. The gate is here, at sign-off:
   * a discount deeper than `Settings.discountApprovalPct` cannot be approved
   * silently. The approver must send `acknowledgeDiscountOverride: true`, and
   * the audit entry then records *why* sign-off was needed — the threshold that
   * was in force and the discount that beat it — rather than a bare "APPROVED".
   *
   * The threshold is read here rather than stamped on the submission, so
   * Accounting editing it in Settings changes the next approval with no
   * migration and no backfill.
   */
  async approve(id: string, dto: ApproveDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status !== SubmissionStatus.PENDING) {
      throw new BadRequestException(
        `Only a pending submission can be approved — this one is ${submission.status}`,
      );
    }

    const settings = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const discount = this.pricing.discountApproval(
      // Measured against the package price, because that is the base a discount
      // now applies to — a deep discount on the package must still trip the
      // threshold even when add-ons pad the subtotal.
      submission.packagePrice,
      submission.discountAmount,
      settings.discountApprovalPct,
    );

    if (discount.exceedsThreshold && !dto.acknowledgeDiscountOverride) {
      throw new BadRequestException(
        `This sale is discounted ${discount.discountPct.toFixed(2)}%, above the ` +
          `${discount.thresholdPct.toFixed(2)}% that needs accounting sign-off. ` +
          'Re-send with acknowledgeDiscountOverride: true to approve it anyway.',
      );
    }

    // Only present when the threshold was actually beaten, so a normal approval
    // is byte-for-byte the audit row it was before.
    const override = discount.exceedsThreshold
      ? {
          thresholdPct: discount.thresholdPct.toFixed(2),
          discountPct: discount.discountPct.toFixed(2),
          discountAmount: submission.discountAmount.toString(),
          discountType: submission.discountType,
          subtotal: submission.subtotal.toString(),
          currency: submission.currency,
        }
      : null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.submission.update({
        where: { id },
        data: {
          status: SubmissionStatus.APPROVED,
          approvedAt: new Date(),
          approvedById: user.id,
          glCode: dto.glAccount ?? submission.glCode,
          costCentre: dto.costCentre ?? submission.costCentre,
        },
        include: DETAIL,
      });

      const posted = dto.glAccount ? `Posted to GL ${dto.glAccount}` : 'Approved';

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'APPROVED',
          detail: override
            ? `${posted} — discount override: ${override.discountPct}% exceeds the ` +
              `${override.thresholdPct}% approval threshold, signed off by ${user.name}`
            : posted,
          payload: {
            glAccount: dto.glAccount,
            total: updated.total.toString(),
            ...(override ? { discountOverride: override } : {}),
          },
        },
        tx,
      );

      return updated;
    });
  }

  async reject(id: string, dto: RejectDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status !== SubmissionStatus.PENDING) {
      throw new BadRequestException(
        `Only a pending submission can be rejected — this one is ${submission.status}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.submission.update({
        where: { id },
        data: {
          status: SubmissionStatus.REJECTED,
          rejectedAt: new Date(),
          rejectReason: dto.reason,
        },
        include: DETAIL,
      });

      await this.audit.log(
        { submissionId: id, actorId: user.id, action: 'REJECTED', detail: dto.reason },
        tx,
      );

      return updated;
    });
  }

  /** Send it back for fixes rather than killing it — the rep can resubmit. */
  async returnToSales(id: string, note: string, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status !== SubmissionStatus.PENDING) {
      throw new BadRequestException(`This submission is ${submission.status}, not pending`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.submission.update({
        where: { id },
        data: { status: SubmissionStatus.RETURNED, returnNote: note },
        include: DETAIL,
      });
      await this.audit.log(
        { submissionId: id, actorId: user.id, action: 'RETURNED', detail: note },
        tx,
      );
      return updated;
    });
  }

  /**
   * Re-price a submission that already exists, from its stored line items and
   * recorded payments — the same engine used at creation. Used after a payment
   * lands or the tax profile changes, so no money figure is ever computed
   * outside PricingService.
   */
  private priceExisting(
    submission: Prisma.SubmissionGetPayload<{ include: { addons: true; payments: true } }>,
    taxRate?: Prisma.Decimal,
  ) {
    return this.pricing.compute({
      packagePrice: submission.packagePrice,
      addons: submission.addons.map((a) => ({
        addonId: a.addonId,
        qty: a.qty,
        unitPrice: a.unitPrice,
        currency: a.currency,
      })),
      discountType: submission.discountType,
      discountValue: submission.discountValue,
      taxRate: taxRate ?? submission.taxRate,
      commissionPct: submission.commissionPct,
      deposit: submission.deposit,
      payments: submission.payments.map((p) => p.amount),
    });
  }

  /**
   * Record a payment and let the balance follow from it. paidAmount, balance and
   * payStatus are never set by hand — they come back out of PricingService once
   * the new payment is on the ledger. A payment is never deleted: a mistake is
   * corrected with a negative (reversing) entry, which is why the amount may be
   * negative here.
   */
  async addPayment(id: string, dto: PaymentDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === SubmissionStatus.REJECTED) {
      throw new BadRequestException('A rejected submission cannot take payments');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          submissionId: id,
          date: new Date(dto.date),
          amount: new Decimal(dto.amount).toFixed(2),
          currency: submission.currency,
          method: dto.method,
          reference: dto.reference,
          recordedById: user.id,
        },
      });

      // Re-read with the freshly-inserted payment so the recompute sees it.
      const withLines = await tx.submission.findUniqueOrThrow({
        where: { id },
        include: { addons: true, payments: true },
      });
      const priced = this.priceExisting(withLines);

      const updated = await tx.submission.update({
        where: { id },
        data: {
          paidAmount: priced.paidAmount.toFixed(2),
          balance: priced.balance.toFixed(2),
          payStatus: priced.payStatus,
        },
        include: DETAIL,
      });

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'PAYMENT',
          detail:
            `${new Decimal(dto.amount).toFixed(2)} ${submission.currency} by ${dto.method}` +
            (dto.reference ? ` (ref ${dto.reference})` : ''),
          payload: {
            amount: new Decimal(dto.amount).toFixed(2),
            currency: submission.currency,
            paidAmount: priced.paidAmount.toFixed(2),
            balance: priced.balance.toFixed(2),
            payStatus: priced.payStatus,
          },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * Accounting reclassification: GL account, cost centre, department, tax
   * profile. Changing the tax profile re-prices the sale (tax sits on top of
   * net revenue, so the total and balance move), and every change — pricing or
   * not — writes a before/after payload to the audit trail. This is the most
   * audit-sensitive write in the system.
   */
  async patch(id: string, dto: PatchSubmissionDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({
      where: { id },
      include: { addons: true, payments: true },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const data: Prisma.SubmissionUpdateInput = {};

    if (dto.glAccount !== undefined && dto.glAccount !== submission.glCode) {
      before.glCode = submission.glCode;
      after.glCode = dto.glAccount || null;
      data.gl = dto.glAccount ? { connect: { code: dto.glAccount } } : { disconnect: true };
    }
    if (dto.costCentre !== undefined && dto.costCentre !== submission.costCentre) {
      before.costCentre = submission.costCentre;
      after.costCentre = dto.costCentre || null;
      data.costCentre = dto.costCentre || null;
    }
    if (dto.department !== undefined && dto.department !== submission.department) {
      before.department = submission.department;
      after.department = dto.department || null;
      data.department = dto.department || null;
    }

    if (dto.taxCode !== undefined && dto.taxCode !== submission.taxCode) {
      const tax = await this.prisma.taxProfile.findUnique({ where: { code: dto.taxCode } });
      if (!tax) throw new BadRequestException(`Unknown tax profile ${dto.taxCode}`);

      const priced = this.priceExisting(submission, tax.rate);
      before.tax = {
        taxCode: submission.taxCode,
        taxRate: submission.taxRate.toString(),
        taxAmount: submission.taxAmount.toString(),
        total: submission.total.toString(),
        balance: submission.balance.toString(),
        payStatus: submission.payStatus,
      };
      after.tax = {
        taxCode: dto.taxCode,
        taxRate: priced.taxRate.toFixed(3),
        taxAmount: priced.taxAmount.toFixed(2),
        total: priced.total.toFixed(2),
        balance: priced.balance.toFixed(2),
        payStatus: priced.payStatus,
      };
      data.tax = { connect: { code: dto.taxCode } };
      data.taxRate = priced.taxRate.toFixed(3);
      data.taxAmount = priced.taxAmount.toFixed(2);
      data.total = priced.total.toFixed(2);
      data.balance = priced.balance.toFixed(2);
      data.payStatus = priced.payStatus;
    }

    if (Object.keys(after).length === 0) {
      throw new BadRequestException('No accounting fields were changed');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.submission.update({ where: { id }, data, include: DETAIL });
      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'RECLASSIFIED',
          detail: 'Accounting fields updated',
          payload: { before, after },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Which invoicing brand a sale bills under. A Vancouver show bills as VFW;
   * every other city bills as GFC. Centralised so the rule — and the "Vancouver"
   * it keys on — lives in exactly one place.
   */
  private invoiceBrand(cityName: string): 'VFW' | 'GFC' {
    return /vancouver/i.test(cityName) ? 'VFW' : 'GFC';
  }

  /**
   * Allocate the next invoice number inside a transaction. Incrementing the
   * pinned Settings row takes a row lock, so two concurrent approvals cannot be
   * handed the same number — the sequence is gapless and human-facing.
   *
   * There are two independent sequences: VFW (Vancouver) and GFC (everywhere
   * else). The submission's city decides which one it draws from, so a Vancouver
   * sale reads VFW-2041 and a Toronto sale reads GFC-1001.
   */
  private async allocateInvoice(
    tx: Prisma.TransactionClient,
    cityName: string,
  ): Promise<string> {
    if (this.invoiceBrand(cityName) === 'VFW') {
      const settings = await tx.settings.update({
        where: { id: 1 },
        data: { nextInvoiceSeq: { increment: 1 } },
      });
      return `${settings.invoicePrefix}${settings.nextInvoiceSeq - 1}`;
    }
    const settings = await tx.settings.update({
      where: { id: 1 },
      data: { nextGfcInvoiceSeq: { increment: 1 } },
    });
    return `${settings.gfcInvoicePrefix}${settings.nextGfcInvoiceSeq - 1}`;
  }

  async generateInvoice(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.findUnique({
        where: { id },
        include: { city: true },
      });
      if (!submission) throw new NotFoundException('Submission not found');
      if (
        submission.status !== SubmissionStatus.APPROVED &&
        submission.status !== SubmissionStatus.EXPORTED
      ) {
        throw new BadRequestException('Only an approved submission can be invoiced');
      }
      if (submission.invoiceNo) {
        throw new BadRequestException(`Already invoiced as ${submission.invoiceNo}`);
      }

      const invoiceNo = await this.allocateInvoice(tx, submission.city.name);
      const updated = await tx.submission.update({
        where: { id },
        data: { invoiceNo },
        include: DETAIL,
      });
      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'INVOICE',
          detail: `Invoice ${invoiceNo} generated`,
          payload: { invoiceNo },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Void (soft-delete) a sale. It leaves normal lists and reports but is kept
   * in full for audit, and the status it held is remembered so an unvoid can put
   * it back exactly. Held by Admin/Accounting via `submission.void`.
   */
  async void(id: string, reason: string | undefined, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.findUnique({ where: { id } });
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.status === SubmissionStatus.VOIDED) {
        throw new BadRequestException('This submission is already voided');
      }
      const updated = await tx.submission.update({
        where: { id },
        data: {
          status: SubmissionStatus.VOIDED,
          voidedFrom: submission.status,
          voidedAt: new Date(),
          voidedById: user.id,
        },
        include: DETAIL,
      });
      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'VOIDED',
          detail: reason ? `Voided (soft delete) — ${reason}` : 'Voided (soft delete)',
          payload: { from: submission.status, reason: reason ?? null },
        },
        tx,
      );
      return updated;
    });
  }

  /** Reverse a void, restoring the sale to the exact status it held before. */
  async unvoid(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.findUnique({ where: { id } });
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.status !== SubmissionStatus.VOIDED) {
        throw new BadRequestException('Only a voided submission can be restored');
      }
      const restoreTo = submission.voidedFrom ?? SubmissionStatus.DRAFT;
      const updated = await tx.submission.update({
        where: { id },
        data: { status: restoreTo, voidedFrom: null, voidedAt: null, voidedById: null },
        include: DETAIL,
      });
      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'RESTORED',
          detail: `Restored from void to ${restoreTo}`,
          payload: { to: restoreTo },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Render an already-invoiced sale to a PDF the customer can be sent. The
   * invoice number must exist first (Generate invoice allocates it), so this
   * never mutates anything — it is a pure read that streams a document. Figures
   * come from the stored, server-computed columns, never a re-derivation, so the
   * PDF and the screen can never disagree.
   */
  async invoicePdf(id: string, user: AuthUser): Promise<{ buffer: Buffer; filename: string }> {
    const s = await this.prisma.submission.findUnique({
      where: { id },
      include: { ...DETAIL, city: true },
    });
    if (!s) throw new NotFoundException('Submission not found');
    // Same row scope as findOne: a rep can pull their own invoice, no one else's.
    if (!can('submission.viewAll', user.role) && s.repId !== user.id) {
      throw new NotFoundException('Submission not found');
    }
    if (!s.invoiceNo) {
      throw new BadRequestException('Generate the invoice number first, then download the PDF.');
    }

    const settings = await this.prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    const discountLabel =
      Number(s.discountAmount) > 0
        ? s.discountType === DiscountType.PCT
          ? `Discount (${Number(s.discountValue)}% of package)`
          : 'Discount (package)'
        : null;

    const data: InvoicePdfData = {
      brand: this.invoiceBrand(s.city.name),
      companyName: settings.company,
      invoiceNo: s.invoiceNo,
      docType: s.payStatus === 'PAID' ? 'Sales Receipt' : 'Invoice',
      issuedAt: new Date(),
      currency: s.currency,
      customer: {
        designer: s.contact.designer,
        brand: s.contact.brand,
        company: s.contact.company,
        email: s.contact.email,
        country: s.contact.country,
      },
      event: { name: s.event.name, city: `${s.city.name}, ${s.city.country}`, showDate: s.showDate },
      packageName: s.package.name,
      packagePrice: s.packagePrice.toFixed(2),
      addons: s.addons.map((l) => ({ name: l.addon.name, qty: l.qty, amount: l.amount.toFixed(2) })),
      subtotal: s.subtotal.toFixed(2),
      discountLabel,
      discountAmount: s.discountAmount.toFixed(2),
      taxable: s.taxable.toFixed(2),
      taxRatePct: s.taxRate.toFixed(2),
      taxAmount: s.taxAmount.toFixed(2),
      total: s.total.toFixed(2),
      paidAmount: s.paidAmount.toFixed(2),
      balance: s.balance.toFixed(2),
      paymentMethod: s.paymentMethod,
      paymentTerms: s.paymentTerms,
    };

    return { buffer: await buildInvoicePdf(data), filename: `${s.invoiceNo}.pdf` };
  }

  /**
   * QuickBooks export. Synchronous by design — no Redis, no job queue until
   * retries are actually needed. The QBO OAuth transport is out of scope and
   * stubbed: this moves the record APPROVED -> EXPORTED, allocates an invoice
   * number if one is missing, stores the QBO document number and audits it.
   */
  async export(id: string, dto: ExportDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.findUnique({
        where: { id },
        include: { city: true },
      });
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.status !== SubmissionStatus.APPROVED) {
        throw new BadRequestException(
          `Only an approved submission can be exported — this one is ${submission.status}`,
        );
      }

      const invoiceNo =
        submission.invoiceNo ?? (await this.allocateInvoice(tx, submission.city.name));
      const docType =
        dto.docType ?? (submission.payStatus === 'PAID' ? 'Sales Receipt' : 'Invoice');
      const settings = await tx.settings.findUniqueOrThrow({ where: { id: 1 } });

      // The transport is stubbed — no HTTP call to QuickBooks is made here.
      const updated = await tx.submission.update({
        where: { id },
        data: {
          status: SubmissionStatus.EXPORTED,
          exportedAt: new Date(),
          invoiceNo,
          qbDocNumber: invoiceNo,
        },
        include: DETAIL,
      });

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'EXPORTED',
          detail: `Posted to QuickBooks Online as ${docType} ${invoiceNo}`,
          payload: { docType, qbDocNumber: invoiceNo, realm: settings.qbRealmId ?? '(stub)' },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Edit and resubmit. A RETURNED (or DRAFT) submission is a dead end until the
   * rep can fix it: this re-prices the sale server-side from the catalogue and
   * sends it back to PENDING.
   *
   * Two ways to be allowed in. A rep may edit their OWN record
   * (`submission.editOwn`); ACCT/ADMIN hold `submission.editAny` and may fix
   * anyone's, which is what lets Accounting correct a rep's mistake rather than
   * bouncing it back and waiting. Anyone else gets the same 404 as a record that
   * does not exist, so this cannot be used to probe for other reps' deals.
   */
  async update(id: string, dto: CreateSubmissionDto, user: AuthUser) {
    const existing = await this.prisma.submission.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Submission not found');

    const mayEdit =
      can('submission.editAny', user.role) ||
      (can('submission.editOwn', user.role) && existing.repId === user.id);
    if (!mayEdit) throw new NotFoundException('Submission not found');

    if (
      existing.status !== SubmissionStatus.DRAFT &&
      existing.status !== SubmissionStatus.RETURNED
    ) {
      throw new BadRequestException(
        `Only a draft or returned submission can be edited — this one is ${existing.status}`,
      );
    }

    // Price against the rep who OWNS the submission, not whoever is editing it.
    const { event, price, discountType, rep, priced } = await this.resolveSale(dto, existing.repId);

    return this.prisma.$transaction(async (tx) => {
      const contact = await this.resolveContact(tx, dto, user);

      await tx.submissionAddon.deleteMany({ where: { submissionId: id } });

      const updated = await tx.submission.update({
        where: { id },
        data: {
          status: SubmissionStatus.PENDING,
          submittedAt: new Date(),
          returnNote: null,
          contactId: contact.id,
          eventId: event.id,
          cityId: event.cityId,
          packageId: dto.packageId,
          showDate: dto.showDate ? new Date(dto.showDate) : null,
          notes: dto.notes,
          currency: price.currency,
          packagePrice: priced.packagePrice.toFixed(2),
          addonTotal: priced.addonTotal.toFixed(2),
          subtotal: priced.subtotal.toFixed(2),
          discountType,
          discountValue: (dto.discountValue ?? 0).toString(),
          discountAmount: priced.discountAmount.toFixed(2),
          taxable: priced.taxable.toFixed(2),
          taxRate: priced.taxRate.toFixed(3),
          taxAmount: priced.taxAmount.toFixed(2),
          total: priced.total.toFixed(2),
          deposit: (dto.deposit ?? 0).toString(),
          paidAmount: priced.paidAmount.toFixed(2),
          balance: priced.balance.toFixed(2),
          payStatus: priced.payStatus,
          commissionPct: priced.commissionPct.toFixed(2),
          commissionAmount: priced.commissionAmount.toFixed(2),
          paymentMethod: dto.paymentMethod,
          department: rep.department,
          addons: {
            create: priced.lines.map((l) => ({
              addonId: l.addonId,
              qty: l.qty,
              unitPrice: l.unitPrice.toString(),
              currency: l.currency,
              amount: l.amount.toFixed(2),
            })),
          },
        },
        include: DETAIL,
      });

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'RESUBMITTED',
          detail: 'Corrected and resubmitted for approval',
          payload: { total: updated.total.toString(), currency: updated.currency },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * Refs are human-facing and appear on invoices, so they must be sequential
   * and gapless rather than random.
   *
   * Allocated by incrementing the pinned Settings row, which takes a row lock
   * for the rest of the transaction — exactly as {@link allocateInvoice} does.
   * Deriving the number from `submission.count()` instead would read the same
   * count in two concurrent creates and hand both the same ref, which `ref
   * @unique` then rejects with a 500.
   */
  private async nextRef(tx: Prisma.TransactionClient): Promise<string> {
    const settings = await tx.settings.update({
      where: { id: 1 },
      data: { nextSubmissionSeq: { increment: 1 } },
    });
    const yy = String(settings.fiscalYear).slice(-2);
    return `S-${yy}-${settings.nextSubmissionSeq - 1}`;
  }
}
