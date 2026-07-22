import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { can } from '../common/acl';
import { AuthUser } from '../common/auth.guard';
import { EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { EmailsQueryDto, SendInvoiceDto } from './dto';

/**
 * The Emails module's read + send surface.
 *
 * Reading is row-scoped exactly like submissions: a `email.viewAll` role
 * (ACCT/MGR/ADMIN) sees the whole log; everyone else sees only mail THEY
 * triggered. Because inbound and system mail (OTP, resets) carry no
 * `triggeredById`, a rep sees neither — only their own outbound sends, which is
 * the intent. Out-of-scope reads 404, the project's existence-hiding boundary.
 *
 * Recording is not done here: EmailService.send() is the one choke point every
 * outbound message passes through, and it writes the row (redacting secrets).
 * This service only sends the invoice and lets that same path log it.
 */

// The list is a summary — never the full body. `preview` is the safe snippet.
const LIST_SELECT = {
  id: true,
  direction: true,
  status: true,
  kind: true,
  fromAddress: true,
  fromName: true,
  toAddress: true,
  subject: true,
  preview: true,
  provider: true,
  error: true,
  sentAt: true,
  receivedAt: true,
  createdAt: true,
  triggeredBy: { select: { id: true, name: true } },
  submission: { select: { id: true, ref: true, invoiceNo: true } },
} satisfies Prisma.EmailMessageSelect;

@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly submissions: SubmissionsService,
    private readonly audit: AuditService,
  ) {}

  /** The scope predicate: viewAll sees everything, everyone else their own sends. */
  private scope(user: AuthUser): Prisma.EmailMessageWhereInput {
    return can('email.viewAll', user.role) ? {} : { triggeredById: user.id };
  }

  async list(user: AuthUser, query: EmailsQueryDto) {
    const where: Prisma.EmailMessageWhereInput = { ...this.scope(user) };
    if (query.direction) where.direction = query.direction;
    if (query.kind) where.kind = query.kind;

    return this.prisma.emailMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 100,
      select: LIST_SELECT,
    });
  }

  async get(id: string, user: AuthUser) {
    const email = await this.prisma.emailMessage.findFirst({
      // The scope goes in the WHERE, not a post-fetch check, so an out-of-scope
      // id is indistinguishable from a missing one — 404 either way.
      where: { id, ...this.scope(user) },
      include: {
        triggeredBy: { select: { id: true, name: true } },
        submission: { select: { id: true, ref: true, invoiceNo: true } },
      },
    });
    if (!email) throw new NotFoundException('Email not found');
    return email;
  }

  /**
   * Email an invoice PDF to a recipient the sender has confirmed.
   *
   * `SubmissionsService.invoicePdf` re-does its own row-scope and insists the
   * invoice number already exists, so this cannot leak or send a half-built
   * document. The send is logged by EmailService (kind INVOICE, attributed to
   * this user and sale); the audit entry here is the money-relevant fact —
   * "invoice X went to Y" — which belongs on the submission's trail.
   */
  async sendInvoice(dto: SendInvoiceDto, user: AuthUser) {
    const { buffer, filename } = await this.submissions.invoicePdf(dto.submissionId, user);
    const invoiceNo = filename.replace(/\.pdf$/i, '');

    await this.email.send(
      this.email.invoiceEmail({
        to: dto.to,
        subject: dto.subject,
        message: dto.message,
        invoiceNo,
        pdf: buffer,
        triggeredById: user.id,
        submissionId: dto.submissionId,
      }),
    );

    await this.audit.log({
      submissionId: dto.submissionId,
      actorId: user.id,
      action: 'INVOICE_EMAILED',
      detail: `Invoice ${invoiceNo} emailed to ${dto.to}`,
      payload: { invoiceNo, to: dto.to },
    });

    return { ok: true, invoiceNo, to: dto.to };
  }
}
