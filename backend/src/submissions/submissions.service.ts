import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountType, Prisma, SubmissionStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { can } from '../common/acl';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { ApproveDto, CreateSubmissionDto, RejectDto } from './dto';

const DETAIL = {
  rep: { select: { id: true, name: true, colour: true, role: true } },
  contact: true,
  event: { include: { city: true } },
  package: true,
  addons: { include: { addon: true } },
  payments: true,
  tax: true,
} satisfies Prisma.SubmissionInclude;

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /** Sales reps see only their own customers; ACCT/MGR/ADMIN see everything. */
  private scopeFor(user: AuthUser): Prisma.SubmissionWhereInput {
    return can('submission.viewAll', user.role) ? {} : { repId: user.id };
  }

  async list(user: AuthUser) {
    return this.prisma.submission.findMany({
      where: this.scopeFor(user),
      include: DETAIL,
      orderBy: { createdAt: 'desc' },
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

  async queue(user: AuthUser) {
    if (!can('submission.approve', user.role)) throw new ForbiddenException();
    return this.prisma.submission.findMany({
      where: { status: { in: [SubmissionStatus.PENDING, SubmissionStatus.RETURNED] } },
      include: DETAIL,
      orderBy: { submittedAt: 'asc' },
    });
  }

  async create(dto: CreateSubmissionDto, user: AuthUser) {
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

    const rep = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

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

    return this.prisma.$transaction(async (tx) => {
      // A brand is one customer. The mockup auto-creates the contact the first
      // time a sale is submitted for a brand nobody has sold to before.
      const contact = await tx.contact.upsert({
        where: { brand: dto.brand },
        update: {
          designer: dto.designer,
          company: dto.company,
          email: dto.email,
          phone: dto.phone,
          country: dto.country,
        },
        create: {
          brand: dto.brand,
          designer: dto.designer,
          company: dto.company,
          email: dto.email,
          phone: dto.phone,
          country: dto.country,
          createdById: user.id,
        },
      });

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

  async approve(id: string, dto: ApproveDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status !== SubmissionStatus.PENDING) {
      throw new BadRequestException(
        `Only a pending submission can be approved — this one is ${submission.status}`,
      );
    }

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

      await this.audit.log(
        {
          submissionId: id,
          actorId: user.id,
          action: 'APPROVED',
          detail: dto.glAccount ? `Posted to GL ${dto.glAccount}` : 'Approved',
          payload: { glAccount: dto.glAccount, total: updated.total.toString() },
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
   * Refs are human-facing and appear on invoices, so they must be sequential
   * and gapless per fiscal year rather than random.
   */
  private async nextRef(tx: Prisma.TransactionClient): Promise<string> {
    const settings = await tx.settings.findUniqueOrThrow({ where: { id: 1 } });
    const yy = String(settings.fiscalYear).slice(-2);
    const count = await tx.submission.count();
    return `S-${yy}-${1000 + count + 1}`;
  }
}
