import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { CreateCommentDto } from '../admin/dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Internal department comments. CONFIDENTIAL.
 *
 * Three separate things keep this closed, because one would not be enough:
 *
 * 1. **The ACL.** Both routes below are guarded — `internal.view` to read,
 *    `internal.comment` to write. Neither includes SALES or INTERN.
 *
 * 2. **Never the rep the comment is about.** The ACL is about roles, and roles
 *    are not the whole rule: a MGR is in `internal.view` and can also carry
 *    their own deals. `NOT_ABOUT_ME` excludes any comment whose submission
 *    belongs to the person asking — so nobody, at any role, reads the coaching
 *    notes written about their own sale. That is the actual promise the UI makes
 *    and it is enforced here, not in the client.
 *
 * 3. **They are not in the submission payload at all.** `DETAIL` in
 *    submissions.service.ts does not include `comments`, for any role. Comments
 *    are only ever served from these two routes. A rep fetching their own
 *    submission therefore cannot receive one even in principle — there is no
 *    conditional include to get wrong, and no field to forget to strip.
 *    internal.e2e-spec.ts asserts the serialized body, not the rendered UI.
 */
const commentShape = {
  author: { select: { id: true, name: true, role: true } },
  submission: {
    select: {
      id: true,
      ref: true,
      repId: true,
      rep: { select: { id: true, name: true } },
      contact: { select: { brand: true } },
    },
  },
} satisfies Prisma.InternalCommentInclude;

@Injectable()
export class InternalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Rule 2, as a query fragment. Used by every read on this model. */
  private notAboutMe(user: AuthUser): Prisma.InternalCommentWhereInput {
    return { submission: { repId: { not: user.id } } };
  }

  async list(user: AuthUser) {
    const comments = await this.prisma.internalComment.findMany({
      where: this.notAboutMe(user),
      orderBy: { createdAt: 'desc' },
      include: commentShape,
    });
    return { comments };
  }

  async forSubmission(submissionId: string, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, repId: true },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    // Not an empty list — an empty list would read as "nothing has been said
    // about you", which is a different claim and not one this endpoint can make.
    if (submission.repId === user.id) {
      throw new ForbiddenException(
        'Internal comments about your own submissions are not visible to you',
      );
    }

    const comments = await this.prisma.internalComment.findMany({
      where: { submissionId, ...this.notAboutMe(user) },
      orderBy: { createdAt: 'desc' },
      include: commentShape,
    });
    return { comments };
  }

  async create(submissionId: string, dto: CreateCommentDto, user: AuthUser) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, ref: true, repId: true },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    // You cannot file a confidential observation about your own deal into a
    // thread you are not allowed to read.
    if (submission.repId === user.id) {
      throw new ForbiddenException('You cannot record an internal comment on your own submission');
    }

    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.internalComment.create({
        data: {
          submissionId,
          department: dto.department,
          body: dto.body,
          authorId: user.id,
        },
        include: commentShape,
      });

      // The audit entry records THAT a comment was filed, never its text: the
      // per-submission audit trail is visible to the rep, and the comment is not.
      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'INTERNAL_COMMENT',
          detail: `Confidential ${dto.department} comment added (excluded from scoring)`,
          payload: { department: dto.department },
        },
        tx,
      );

      return comment;
    });
  }
}

@Controller('api')
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Get('internal-comments')
  @Can('internal.view')
  list(@CurrentUser() user: AuthUser) {
    return this.internal.list(user);
  }

  @Get('submissions/:id/comments')
  @Can('internal.view')
  forSubmission(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.internal.forSubmission(id, user);
  }

  @Post('submissions/:id/comments')
  @Can('internal.comment')
  create(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.internal.create(id, dto, user);
  }
}
