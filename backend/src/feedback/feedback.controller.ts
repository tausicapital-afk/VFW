import { BadRequestException, Body, Controller, Get, Injectable, Post } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { CreateFeedbackDto } from '../admin/dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Designer feedback — a star rating and notes against a contact, recorded after
 * a show has run.
 *
 * Anyone client-facing may record it (`feedback.record` — including reps, who
 * are usually the ones collecting it); reading the collected body of it is
 * `feedback.view` (ACCT/MGR/ADMIN).
 *
 * It is a COACHING INPUT. It does not reach the leaderboard score, the ranking,
 * commission or a bonus — see reports/score.ts, whose only input type (RepStats)
 * has no field for it, and score.spec.ts, which asserts a one-star review moves
 * a score by exactly zero.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const feedback = await this.prisma.designerFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        contact: { select: { id: true, brand: true, designer: true } },
        recordedBy: { select: { id: true, name: true } },
      },
    });
    return { feedback };
  }

  async create(dto: CreateFeedbackDto, user: AuthUser) {
    const contact = await this.prisma.contact.findUnique({ where: { id: dto.contactId } });
    if (!contact) throw new BadRequestException('Unknown contact');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.designerFeedback.create({
        data: {
          contactId: contact.id,
          rating: dto.rating,
          body: dto.body,
          recordedById: user.id,
        },
        include: {
          contact: { select: { id: true, brand: true, designer: true } },
          recordedBy: { select: { id: true, name: true } },
        },
      });

      await this.audit.log(
        {
          actorId: user.id,
          action: 'FEEDBACK_RECORDED',
          detail: `${dto.rating}★ recorded for ${contact.brand} (coaching input — excluded from scoring)`,
          payload: { contactId: contact.id, rating: dto.rating },
        },
        tx,
      );

      return created;
    });
  }
}

@Controller('api/feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @Can('feedback.view')
  list() {
    return this.feedback.list();
  }

  @Post()
  @Can('feedback.record')
  create(@Body() dto: CreateFeedbackDto, @CurrentUser() user: AuthUser) {
    return this.feedback.create(dto, user);
  }
}
