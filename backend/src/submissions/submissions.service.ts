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
import { ConfigService } from '../config/config.service';
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

/**
 * The largest value the invoice counters can hold, leaving room to add one.
 * Settings.nextInvoiceSeq is a Postgres `integer`, and a hand-typed number is not
 * obliged to be a sensible size.
 */
const MAX_SEQUENCE = 2_147_483_646;

const DETAIL = {
  rep: { select: { id: true, name: true, colour: true, role: true } },
  contact: true,
  event: { include: { city: true } },
  package: { include: { prices: true } },
  addons: { include: { addon: true } },
  // Date first, then insertion order. `date` is date-only, so a payment and the
  // negative entry that reverses it usually share one — sorting on date alone
  // leaves their order to the planner, and the ledger reads as a reversal that
  // precedes the payment it reverses.
  payments: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] },
  // The payment plan rides on every submission read: it is not confidential, and
  // a rep opening their own sale should see where the designer is in the
  // schedule without a second request.
  installments: {
    orderBy: { seq: 'asc' },
    include: { paidBy: { select: { id: true, name: true } } },
  },
  tax: true,
} satisfies Prisma.SubmissionInclude;

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
    // The Test data switch. Read at the moment a row is written, never cached:
    // an admin can flip it mid-session and the very next sale must land on the
    // right side of it. SystemConfigModule is @Global, so this arrives without
    // SubmissionsModule importing anything.
    private readonly config: ConfigService,
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
        // The flag goes on `create` only, matching the empty `update` above and
        // for the same reason: a brand somebody else already entered is their
        // row, and a test sale against a real customer must not reclassify that
        // customer. Only a contact this sale brings into existence inherits it.
        create: {
          brand: dto.brand,
          ...details,
          createdById: user.id,
          isTestData: this.config.testDataMode,
        },
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

    // A rep may override the package's price and/or its displayed name/looks/
    // description for this one sale. `pkg`/`price` above stay the anchor — its
    // brand, tax profile, GL account and currency are never freeform — but the
    // figure PricingService actually prices is the override when one was given.
    // This is the one line that keeps "the server computes the total" true even
    // for a custom price: nothing downstream (tax, discount, commission) is
    // computed any differently than for a catalogue price.
    const packagePriceInput = dto.packagePriceOverride ?? price.price;
    const packageCustomized = Boolean(
      dto.packageNameOverride?.trim() ||
      dto.packageLooksOverride != null ||
      dto.packageBlurbOverride?.trim() ||
      dto.packagePriceOverride != null,
    );

    const priced = this.pricing.compute({
      packagePrice: packagePriceInput,
      addons: addons.map((a) => ({
        addonId: a.id,
        qty: 1,
        unitPrice: a.price,
        currency: a.currency,
      })),
      discountType,
      discountValue: dto.discountValue ?? 0,
      taxRate: pkg.tax.rate,
      // The rep's rate, unless they are not on commission at all — a salaried
      // account is stamped 0% here rather than filtered out further downstream.
      // This is the ONE place the pay basis touches a sale, and it has to be
      // this one: the percentage is frozen onto the Submission at creation, so
      // every screen that reads commission afterwards (the sale itself, Reports,
      // Payroll) agrees without any of them having to know how the person is
      // paid. Gating it at payroll instead would leave a commission line on a
      // salaried rep's own invoice that nobody was ever going to pay them.
      commissionPct: rep.earnsCommission ? rep.commissionPct : 0,
      deposit: dto.deposit ?? 0,
    });

    return {
      event, pkg, price, addons, discountType, rep, priced,
      packageCustomized,
      packageNameOverride: dto.packageNameOverride?.trim() || null,
      packageLooksOverride: dto.packageLooksOverride ?? null,
      packageBlurbOverride: dto.packageBlurbOverride?.trim() || null,
      packagePriceOverride: dto.packagePriceOverride != null ? new Decimal(dto.packagePriceOverride) : null,
    };
  }

  async create(dto: CreateSubmissionDto, user: AuthUser) {
    // On create the caller is the rep — they are selling their own deal.
    const {
      event, pkg, price, discountType, rep, priced,
      packageCustomized, packageNameOverride, packageLooksOverride,
      packageBlurbOverride, packagePriceOverride,
    } = await this.resolveSale(dto, user.id);

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
          packageCustomized,
          packageNameOverride,
          packageLooksOverride,
          packageBlurbOverride,
          packagePriceOverride: packagePriceOverride?.toFixed(2) ?? null,
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
          // Stamped once, at creation. The edit path below deliberately does not
          // carry it: an amendment, an approval or a void changes where a sale
          // is in its life, never what it was entered as.
          isTestData: this.config.testDataMode,
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
          detail: packageCustomized
            ? 'Sent to Accounting for approval — package customized from the rate card'
            : 'Sent to Accounting for approval',
          payload: {
            total: submission.total.toString(),
            currency: submission.currency,
            ...(packageCustomized
              ? {
                  packageOverride: {
                    anchorName: pkg.name,
                    anchorLooks: pkg.looks,
                    anchorPrice: price.price.toString(),
                    name: packageNameOverride,
                    looks: packageLooksOverride,
                    blurb: packageBlurbOverride,
                    price: packagePriceOverride?.toFixed(2) ?? null,
                  },
                }
              : {}),
          },
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

    // The same "say it out loud" gate as the discount one above, for the same
    // reason: a rep-typed price or description must never reach approval
    // indistinguishably from a catalogue sale.
    if (submission.packageCustomized && !dto.acknowledgeCustomPackage) {
      throw new BadRequestException(
        'This sale uses a customized or non-catalogue package. ' +
          'Re-send with acknowledgeCustomPackage: true to approve it as priced.',
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
      const notes: string[] = [];
      if (override) {
        notes.push(
          `discount override: ${override.discountPct}% exceeds the ${override.thresholdPct}% ` +
            `approval threshold, signed off by ${user.name}`,
        );
      }
      if (submission.packageCustomized) {
        notes.push(`customized/non-catalogue package, signed off by ${user.name}`);
      }

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'APPROVED',
          detail: notes.length ? `${posted} — ${notes.join('; ')}` : posted,
          payload: {
            glAccount: dto.glAccount,
            total: updated.total.toString(),
            ...(override ? { discountOverride: override } : {}),
            ...(submission.packageCustomized ? { customPackageAcknowledged: true } : {}),
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
   * Re-derive paidAmount, balance and payStatus from whatever is on the ledger
   * right now, and write them back. Called inside the transaction that just
   * changed the ledger, so the recompute sees the new row.
   *
   * Public because the installment plan posts payments too (see
   * InstallmentsService): there must be exactly one way for a payment to move a
   * balance, or the two paths drift and only one of them stays right.
   */
  async recomputeMoney(tx: Prisma.TransactionClient, id: string) {
    const withLines = await tx.submission.findUniqueOrThrow({
      where: { id },
      include: { addons: true, payments: true },
    });
    const priced = this.priceExisting(withLines);

    const submission = await tx.submission.update({
      where: { id },
      data: {
        paidAmount: priced.paidAmount.toFixed(2),
        balance: priced.balance.toFixed(2),
        payStatus: priced.payStatus,
      },
      include: DETAIL,
    });

    return { submission, priced };
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
          // A payment inherits the sale it settles: money moved against a
          // rehearsal is rehearsal money whatever the switch says today, and a
          // ledger where the sale is marked and its payments are not would read
          // as if a test invoice had been really paid.
          isTestData: submission.isTestData || this.config.testDataMode,
        },
      });

      const { submission: updated, priced } = await this.recomputeMoney(tx, id);

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

  /**
   * Keep the automatic sequence ahead of a number somebody typed.
   *
   * Without this, hand-setting `VFW-2041` while the counter also sits at 2041
   * means the next approval allocates the same number and dies on the unique
   * index — an error at the worst possible moment, on somebody else's sale, with
   * nothing on screen to explain it. Nudging the counter past a manual number
   * turns that collision into a gap in the sequence, which is the far cheaper of
   * the two: a missing number is a question, a duplicated one is a liability.
   *
   * Only numbers that actually look like they came from one of our two sequences
   * move it. A client's own reference ("2026/03/017") is none of our business.
   */
  private async advanceSequencePast(tx: Prisma.TransactionClient, invoiceNo: string) {
    const settings = await tx.settings.findUniqueOrThrow({ where: { id: 1 } });

    for (const [prefix, field] of [
      [settings.invoicePrefix, 'nextInvoiceSeq'],
      [settings.gfcInvoicePrefix, 'nextGfcInvoiceSeq'],
    ] as const) {
      if (!prefix || !invoiceNo.startsWith(prefix)) continue;

      const seq = Number(invoiceNo.slice(prefix.length));
      if (!Number.isInteger(seq) || seq < settings[field]) continue;
      // A number too large for the column to hold. `VFW-1774472300992` is a
      // plausible thing to paste in (it is a timestamp), and writing it into an
      // int4 counter is a 500 on a request that had nothing wrong with it. There
      // is nothing to protect against anyway: the sequence counts up from ~2000
      // and will not reach a number this size, so it cannot collide.
      if (seq >= MAX_SEQUENCE) continue;

      await tx.settings.update({ where: { id: 1 }, data: { [field]: seq + 1 } });
      return;
    }
  }

  /**
   * Set or change the invoice number by hand.
   *
   * Who may do it changes at approval, which is the whole point of this endpoint:
   *
   * - **Before approval** (draft, pending, returned) it is whoever may edit the
   *   sale — the rep who owns it, or Accounting under `submission.editAny`. The
   *   number is not yet on a document anyone has seen, so correcting it is
   *   ordinary data entry.
   * - **After approval** (approved, exported) it is `invoice.generate` only —
   *   Accounting and Admin. By then the number is on a PDF that may already be in
   *   a client's inbox and in their ledger, so changing it is an accounting act
   *   with consequences outside this system, not a typo fix.
   *
   * A rejected or voided sale is refused outright: neither is a live document, and
   * numbering one would put a gap in the sequence for a sale that is not billed.
   */
  async setInvoiceNo(id: string, invoiceNo: string, user: AuthUser) {
    const trimmed = invoiceNo.trim();

    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.findUnique({ where: { id } });
      // 404, not 403, for a sale this caller could not see anyway — the same
      // "cannot even probe for it" boundary findOne draws.
      if (!submission) throw new NotFoundException('Submission not found');

      const approved =
        submission.status === SubmissionStatus.APPROVED ||
        submission.status === SubmissionStatus.EXPORTED;

      if (approved) {
        if (!can('invoice.generate', user.role)) {
          throw new ForbiddenException(
            'This sale is approved — only Accounting or an administrator can change its invoice number now',
          );
        }
      } else if (
        submission.status === SubmissionStatus.REJECTED ||
        submission.status === SubmissionStatus.VOIDED
      ) {
        throw new BadRequestException(
          `A ${submission.status.toLowerCase()} sale cannot be invoiced`,
        );
      } else {
        const mayEdit =
          can('submission.editAny', user.role) ||
          (can('submission.editOwn', user.role) && submission.repId === user.id);
        if (!mayEdit) throw new NotFoundException('Submission not found');
      }

      if (submission.invoiceNo === trimmed) return submission;

      // Checked here rather than left to the unique index, so the answer names
      // the sale already holding the number instead of surfacing a raw
      // constraint violation. The index is still what makes it true under a race.
      const clash = await tx.submission.findUnique({
        where: { invoiceNo: trimmed },
        select: { ref: true },
      });
      if (clash) {
        throw new BadRequestException(`Invoice ${trimmed} is already used by ${clash.ref}`);
      }

      await this.advanceSequencePast(tx, trimmed);

      const updated = await tx.submission.update({
        where: { id },
        data: { invoiceNo: trimmed },
        include: DETAIL,
      });

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: submission.invoiceNo ? 'INVOICE_RENUMBERED' : 'INVOICE',
          detail: submission.invoiceNo
            ? `Invoice number changed from ${submission.invoiceNo} to ${trimmed}`
            : `Invoice ${trimmed} set by hand`,
          payload: { invoiceNo: trimmed, previous: submission.invoiceNo },
        },
        tx,
      );

      return updated;
    });
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
      packageName: s.packageNameOverride ?? s.package.name,
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
   * Edit and resubmit. This re-prices the sale server-side from the catalogue,
   * so an edit can never carry a total the client chose.
   *
   * Two ways to be allowed in. A rep may edit their OWN record
   * (`submission.editOwn`); ACCT/ADMIN hold `submission.editAny` and may fix
   * anyone's, which is what lets Accounting correct a rep's mistake rather than
   * bouncing it back and waiting. Anyone else gets the same 404 as a record that
   * does not exist, so this cannot be used to probe for other reps' deals.
   *
   * **Which statuses are editable, and by whom, is where the real rule lives.**
   *
   * - `DRAFT`, `RETURNED`, `PENDING` — editable by whoever may edit it at all.
   *   Nothing has been decided yet, so a correction is just a correction. Note
   *   what happens to `submittedAt`: a draft or returned sale is *entering* the
   *   queue and gets a fresh one, while a pending sale is already in it and keeps
   *   the one it has. The queue is ordered by that column, so re-stamping it
   *   would send a rep to the back of the line for fixing their own typo — and
   *   give anyone who noticed a way to jump it by editing something trivial.
   * - `APPROVED`, `EXPORTED` — editable **only** under `submission.editAny`, so
   *   Accounting and Admin. Approval is a decision someone made about these
   *   figures; changing them afterwards is an amendment to a decided record, and
   *   the sale keeps its approval rather than quietly reverting to pending. The
   *   audit line says AMENDED, not UPDATED, because the two are not the same
   *   event when a reviewer reads the trail back.
   * - `REJECTED`, `VOIDED` — refused. Neither is a live sale; the way back is to
   *   return or unvoid it, which are decisions with their own audit entries.
   *
   * Amending an EXPORTED sale is allowed but is genuinely lossy: those figures
   * are already in QuickBooks, and this system cannot reach in and change them.
   * The audit entry says so, and so does the screen.
   */
  async update(id: string, dto: CreateSubmissionDto, user: AuthUser) {
    const existing = await this.prisma.submission.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Submission not found');

    const mayEdit =
      can('submission.editAny', user.role) ||
      (can('submission.editOwn', user.role) && existing.repId === user.id);
    if (!mayEdit) throw new NotFoundException('Submission not found');

    const decided =
      existing.status === SubmissionStatus.APPROVED ||
      existing.status === SubmissionStatus.EXPORTED;
    // Arriving in the review queue for the first time, or after a return.
    const entering =
      existing.status === SubmissionStatus.DRAFT ||
      existing.status === SubmissionStatus.RETURNED;

    if (decided && !can('submission.editAny', user.role)) {
      throw new ForbiddenException(
        'This sale is approved — only Accounting or an administrator can amend it now',
      );
    }

    if (
      existing.status === SubmissionStatus.REJECTED ||
      existing.status === SubmissionStatus.VOIDED
    ) {
      throw new BadRequestException(
        existing.status === SubmissionStatus.VOIDED
          ? 'This sale is voided — restore it before editing'
          : 'This sale was rejected — return it to sales before editing',
      );
    }

    // Price against the rep who OWNS the submission, not whoever is editing it.
    const {
      event, price, discountType, rep, priced,
      packageCustomized, packageNameOverride, packageLooksOverride,
      packageBlurbOverride, packagePriceOverride,
    } = await this.resolveSale(dto, existing.repId);

    return this.prisma.$transaction(async (tx) => {
      const contact = await this.resolveContact(tx, dto, user);

      await tx.submissionAddon.deleteMany({ where: { submissionId: id } });

      const updated = await tx.submission.update({
        where: { id },
        data: {
          // An amendment keeps the approval it already carries; everything else
          // lands in (or stays in) the review queue.
          status: decided ? existing.status : SubmissionStatus.PENDING,
          // Only a sale arriving in the queue is stamped. See the note above.
          submittedAt: entering ? new Date() : existing.submittedAt,
          returnNote: null,
          contactId: contact.id,
          eventId: event.id,
          cityId: event.cityId,
          packageId: dto.packageId,
          packageCustomized,
          packageNameOverride,
          packageLooksOverride,
          packageBlurbOverride,
          packagePriceOverride: packagePriceOverride?.toFixed(2) ?? null,
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

      // An amendment to a decided sale is not a resubmission, and the trail has
      // to be able to tell them apart months later. Exported is called out by
      // name: the figures QuickBooks holds are now stale, and nothing in this
      // system can go and fix them.
      const amendment = {
        action: 'AMENDED',
        detail:
          existing.status === SubmissionStatus.EXPORTED
            ? `Approved sale amended after export — the figures in QuickBooks (${existing.qbDocNumber ?? 'exported'}) no longer match and must be re-synced`
            : 'Approved sale amended by Accounting',
      };
      const resubmission = {
        action: 'RESUBMITTED',
        detail:
          existing.status === SubmissionStatus.PENDING
            ? 'Corrected while awaiting approval'
            : 'Corrected and resubmitted for approval',
      };
      const { action, detail } = decided ? amendment : resubmission;

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action,
          detail,
          payload: {
            total: updated.total.toString(),
            currency: updated.currency,
            // What it was worth before, so the trail shows the movement rather
            // than only the landing point.
            previousTotal: existing.total.toString(),
            previousStatus: existing.status,
          },
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
