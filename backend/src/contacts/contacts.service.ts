import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubmissionStatus } from '@prisma/client';
import { AuthUser } from '../common/auth.guard';
import { can } from '../common/acl';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { CreateContactDto } from './dto';

// Lifetime value counts only revenue the company has actually booked — an
// approved (or exported) deal — not a draft or a pending quote.
const BOOKED: SubmissionStatus[] = [SubmissionStatus.APPROVED, SubmissionStatus.EXPORTED];

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly submissions: SubmissionsService,
  ) {}

  /**
   * Which contacts this user may see. Reps see a brand they have either sold to
   * or entered themselves; ACCT/MGR/ADMIN see all. The "sold to" half reuses
   * SubmissionsService.scopeFor() so there is exactly one definition of whose
   * deals a rep can see.
   */
  private scopeFor(user: AuthUser): Prisma.ContactWhereInput {
    if (can('submission.viewAll', user.role)) return {};
    return {
      OR: [
        { submissions: { some: this.submissions.scopeFor(user) } },
        { createdById: user.id },
      ],
    };
  }

  async list(user: AuthUser, q?: string) {
    const search = q?.trim();
    const filters: Prisma.ContactWhereInput[] = [this.scopeFor(user)];
    if (search) {
      filters.push({
        OR: [
          { brand: { contains: search, mode: 'insensitive' } },
          { designer: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    return this.prisma.contact.findMany({
      where: { AND: filters },
      orderBy: { brand: 'asc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    // Fold the row-level scope into the lookup: a contact the user may not see
    // returns the same "not found" as one that does not exist, so a rep cannot
    // probe for the existence of another rep's customers.
    const contact = await this.prisma.contact.findFirst({
      where: { AND: [{ id }, this.scopeFor(user)] },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    // History is itself scoped: a rep viewing a brand they share with another
    // rep sees only their own deals for it, never the other rep's.
    const submissions = await this.prisma.submission.findMany({
      where: { AND: [{ contactId: id }, this.submissions.scopeFor(user)] },
      orderBy: { createdAt: 'desc' },
      include: {
        event: { select: { name: true, brand: true } },
        package: { select: { name: true } },
      },
    });

    // Lifetime value, per currency. Never add two currencies together — each is
    // summed on its own, as Decimals, so no cent drifts through a float.
    const lifetimeValue: Record<string, string> = {};
    for (const s of submissions) {
      if (!BOOKED.includes(s.status)) continue;
      const prev = lifetimeValue[s.currency];
      lifetimeValue[s.currency] = (prev ? s.total.add(prev) : s.total).toFixed(2);
    }

    return {
      contact,
      lifetimeValue,
      submissions: submissions.map((s) => ({
        id: s.id,
        ref: s.ref,
        event: s.event.name,
        brand: s.event.brand,
        package: s.package.name,
        total: s.total.toFixed(2),
        currency: s.currency,
        status: s.status,
        createdAt: s.createdAt,
      })),
    };
  }

  async create(dto: CreateContactDto, user: AuthUser) {
    const existing = await this.prisma.contact.findUnique({ where: { brand: dto.brand } });
    if (existing) {
      throw new BadRequestException(`A contact for "${dto.brand}" already exists`);
    }
    return this.prisma.contact.create({
      data: {
        brand: dto.brand,
        designer: dto.designer ?? '',
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        country: dto.country,
        type: dto.type ?? 'Designer',
        createdById: user.id,
      },
    });
  }
}
