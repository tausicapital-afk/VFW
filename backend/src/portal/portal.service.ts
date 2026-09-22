import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SignatureRequestStatus, SubmissionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { EmailNotConfiguredError, EmailService } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SubmissionsService } from '../submissions/submissions.service';

/**
 * How long a contact-portal link stays usable, unlike PasswordReset (30
 * minutes, single-use). This is a standing "check on your sale" link a
 * designer may come back to over days or weeks, not a one-shot credential —
 * see the note on the ContactPortalToken model for the full reasoning. 60
 * days comfortably outlasts a payment plan's typical instalment cadence
 * without the link going stale mid-schedule; a fresh one is one click away
 * (Send portal link) if it ever does.
 */
const PORTAL_TOKEN_TTL_DAYS = 60;

/**
 * What the portal is allowed to show for one submission. A deliberate
 * allowlist, not "everything minus the sensitive bits" — this is data leaving
 * the system to an unauthenticated party, so under-expose rather than
 * over-expose. Notably absent: internal notes, designer feedback, cost
 * centre/GL/department, discount mechanics, the rep who sold it, and anything
 * about any OTHER contact.
 */
export interface PortalSubmission {
  id: string;
  ref: string;
  status: SubmissionStatus;
  currency: string;
  total: string;
  paidAmount: string;
  balance: string;
  payStatus: string;
  invoiceNo: string | null;
  event: string;
  package: string;
  showDate: Date | null;
  createdAt: Date;
  // The most recent DocuSign request against this sale's contract, if any —
  // lets the portal show "sent for signature" / "signed" without exposing
  // anything about the request beyond that (no envelope id, no internal doc
  // id — see PortalService.signedContractUrl for how the signed copy itself
  // is fetched, on demand, rather than handed out here).
  signature: { status: SignatureRequestStatus; sentAt: Date; completedAt: Date | null } | null;
}

export interface PortalData {
  contact: { brand: string; designer: string; company: string | null };
  submissions: PortalSubmission[];
}

@Injectable()
export class PortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly submissions: SubmissionsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Mint a link and email it to the contact's address on file. Held by
   * `email.send` (ACCT/ADMIN) at the controller — the same roles that may send
   * an invoice, because this is the same kind of act: handing a document (here,
   * a standing view) to the customer.
   *
   * Unlike a reset link, the token here is not consumed by anything and there
   * is nothing to compare-and-set: minting one is a pure insert. Any earlier
   * links for this contact are left alone (unlike PasswordReset, which
   * invalidates outstanding ones on a real password change) — a portal link is
   * not a credential that guards an account, so an old one being emailed
   * separately is not a "the previous message is now a stale trap" situation,
   * and revoking someone's still-valid earlier link the moment a new one is
   * sent would only break a bookmark they already have.
   */
  async sendLink(contactId: string, user: AuthUser): Promise<{ ok: true; to: string }> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!contact.email) {
      throw new BadRequestException('This contact has no email on file — add one first.');
    }

    if (!this.email.configured) throw new EmailNotConfiguredError();

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_DAYS * 24 * 60 * 60_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.contactPortalToken.create({ data: { token, contactId, expiresAt } });
      await this.audit.log(
        {
          actorId: user.id,
          action: 'PORTAL_LINK_SENT',
          detail: `Portal link sent to ${contact.email} for ${contact.brand}, valid ${PORTAL_TOKEN_TTL_DAYS} days`,
          payload: { contactId, to: contact.email },
        },
        tx,
      );
    });

    await this.email.send(
      this.email.portalLink(contact.email, contact.designer || contact.brand, token, PORTAL_TOKEN_TTL_DAYS),
    );

    return { ok: true, to: contact.email };
  }

  /**
   * Resolve a live token down to a contactId. Existence and expiry are
   * checked in ONE query — `findFirst` with both conditions in the WHERE
   * clause — rather than a `findUnique` on the token followed by an
   * application-code check of `expiresAt`. There is no write here to race
   * (this table has no `usedAt` to compare-and-set), so the atomicity is not
   * about a concurrency window the way PasswordReset's is; it is the same
   * discipline applied for its own sake — one query, evaluated against `now()`
   * at a single instant, is simply the correct way to ask "is this valid right
   * now", and it is the pattern already established in this codebase for a
   * token table (see AuthService.reset).
   *
   * A missing token and an expired one return the exact same error, so a
   * portal link can never be used to learn which of the two happened —
   * mirroring the 404-not-403 existence-hiding convention used everywhere
   * else in this codebase (e.g. SubmissionsService.findOne).
   */
  private async resolveContactId(token: string): Promise<string> {
    const invalid = new NotFoundException('This link is invalid or has expired.');
    if (!token) throw invalid;
    const row = await this.prisma.contactPortalToken.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: { contactId: true },
    });
    if (!row) throw invalid;
    return row.contactId;
  }

  async getPortalData(token: string): Promise<PortalData> {
    const contactId = await this.resolveContactId(token);

    // A second existence check would be redundant — the token's foreign key
    // guarantees the contact still exists (portal tokens cascade-delete with
    // their contact) — but the fields returned here are chosen with the same
    // allowlist discipline as the submission rows below.
    const contact = await this.prisma.contact.findUniqueOrThrow({
      where: { id: contactId },
      select: { brand: true, designer: true, company: true },
    });

    const submissions = await this.prisma.submission.findMany({
      // Voided sales are soft-deleted everywhere else in the app; the portal
      // is not the exception that resurrects them for the one audience who
      // never sees the void reason.
      where: { contactId, status: { not: SubmissionStatus.VOIDED } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        ref: true,
        status: true,
        currency: true,
        total: true,
        paidAmount: true,
        balance: true,
        payStatus: true,
        invoiceNo: true,
        showDate: true,
        createdAt: true,
        event: { select: { name: true } },
        package: { select: { name: true } },
        packageNameOverride: true,
      },
    });

    // One extra query rather than a nested `include` with `take: 1` — kept as
    // a plain findMany + reduce so "which one is latest" is explicit here
    // rather than resting on a nested-relation ordering guarantee. A
    // contact's own submission list is never large enough for this to matter.
    const latestSignatureBySubmission = new Map<
      string,
      { status: SignatureRequestStatus; sentAt: Date; completedAt: Date | null }
    >();
    if (submissions.length) {
      const requests = await this.prisma.signatureRequest.findMany({
        where: { submissionId: { in: submissions.map((s) => s.id) } },
        orderBy: { sentAt: 'desc' },
        select: { submissionId: true, status: true, sentAt: true, completedAt: true },
      });
      for (const r of requests) {
        if (!latestSignatureBySubmission.has(r.submissionId)) {
          latestSignatureBySubmission.set(r.submissionId, r);
        }
      }
    }

    return {
      contact,
      submissions: submissions.map((s) => ({
        id: s.id,
        ref: s.ref,
        status: s.status,
        currency: s.currency,
        total: s.total.toFixed(2),
        paidAmount: s.paidAmount.toFixed(2),
        balance: s.balance.toFixed(2),
        payStatus: s.payStatus,
        invoiceNo: s.invoiceNo,
        event: s.event.name,
        package: s.packageNameOverride ?? s.package.name,
        showDate: s.showDate,
        createdAt: s.createdAt,
        signature: latestSignatureBySubmission.get(s.id) ?? null,
      })),
    };
  }

  /** The PDF download, scoped the same way — see SubmissionsService.invoicePdfForPortal. */
  async invoicePdf(token: string, submissionId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contactId = await this.resolveContactId(token);
    return this.submissions.invoicePdfForPortal(submissionId, contactId);
  }

  /**
   * Resolve a token down to a contactId for another module that is scoped by
   * the same portal token — today, PaymentsService's checkout-session create.
   * A thin public wrapper around {@link resolveContactId} rather than widening
   * that method itself, so the token-lifecycle rule (same 404 for missing and
   * expired) has exactly one implementation that everything else calls into.
   */
  async contactIdForToken(token: string): Promise<string> {
    return this.resolveContactId(token);
  }

  /**
   * A short-lived download link for the signed contract, once one exists.
   * Scoped exactly like invoicePdf above: the token resolves to a contactId,
   * and the submission — and, through it, the completed SignatureRequest and
   * its signedDocument — must belong to that same contact, or this 404s the
   * same way a bad token does. Read-only, like everything else the portal
   * exposes: this hands back a presigned GET URL rather than embedding any
   * signing capability in the portal itself (there is nothing here for the
   * contact to sign — DocuSign already emailed them their own signing link
   * when the request was sent; this is only for retrieving the result).
   */
  async signedContractUrl(token: string, submissionId: string): Promise<{ url: string; filename: string }> {
    const contactId = await this.resolveContactId(token);
    const notFound = new NotFoundException('No signed contract found for this sale.');

    const submission = await this.prisma.submission.findFirst({
      where: { id: submissionId, contactId },
      select: { id: true },
    });
    if (!submission) throw notFound;

    const request = await this.prisma.signatureRequest.findFirst({
      where: { submissionId, status: SignatureRequestStatus.COMPLETED, signedDocumentId: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: { signedDocument: { select: { storageKey: true, filename: true } } },
    });
    if (!request?.signedDocument) throw notFound;

    const url = await this.storage.presignDownload(request.signedDocument.storageKey, request.signedDocument.filename);
    return { url, filename: request.signedDocument.filename };
  }
}
