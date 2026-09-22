import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { DocuSignConnectionService } from './docusign-connection.service';
import { apiAccountBase, docusignApiError, fileExtensionOf } from './docusign.types';

/**
 * Every field a client is allowed to see about a SignatureRequest —
 * deliberately an allowlist via `select`, NOT `include` (which would default
 * to every scalar column). `docusignEnvelopeId` is excluded on purpose: it is
 * the ONLY thing the public webhook trusts to decide which SignatureRequest a
 * notification concerns (see DocuSignWebhookService.handleNotification), so
 * it must never reach even an authenticated client — handing it out would
 * let anyone who can merely VIEW a submission (a much wider audience than
 * `email.send`) call the public webhook themselves and force that request
 * into COMPLETED early.
 */
const SIGNATURE_REQUEST_SELECT = {
  id: true,
  documentId: true,
  status: true,
  sentAt: true,
  completedAt: true,
  signedDocumentId: true,
  sentBy: { select: { id: true, name: true } },
} satisfies Prisma.SignatureRequestSelect;

/**
 * The part of e-signature a staff member does: pick an already-uploaded
 * Document and send it to DocuSign for signature. The reverse direction
 * (DocuSign telling us it was signed) is DocuSignWebhookService — a
 * deliberately separate class, since that one runs unauthenticated and has
 * to be paranoid about what it trusts from its caller in a way this one does
 * not.
 */
@Injectable()
export class DocuSignApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: DocuSignConnectionService,
    private readonly storage: StorageService,
    private readonly submissions: SubmissionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Access to a submission's signature requests is exactly access to the
   * submission — same reasoning as DocumentsService.assertAccess, and reusing
   * findOne() means a rep probing another rep's submission gets the same
   * existence-hiding 404 every other read on this record gives.
   */
  private async assertAccess(submissionId: string, user: AuthUser) {
    return this.submissions.findOne(submissionId, user);
  }

  async list(submissionId: string, user: AuthUser) {
    await this.assertAccess(submissionId, user);
    return this.prisma.signatureRequest.findMany({
      where: { submissionId },
      orderBy: { sentAt: 'desc' },
      select: SIGNATURE_REQUEST_SELECT,
    });
  }

  /**
   * Send an already-uploaded Document out for signature: reads its bytes
   * back out of R2, hands them to DocuSign as a new envelope, and records the
   * SignatureRequest that tracks it from here.
   */
  async sendForSignature(submissionId: string, documentId: string, user: AuthUser) {
    const submission = await this.assertAccess(submissionId, user);

    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.submissionId !== submissionId) {
      throw new NotFoundException('Document not found');
    }

    const signerEmail = submission.contact.email;
    if (!signerEmail) {
      throw new BadRequestException('This contact has no email on file — add one first.');
    }
    const signerName = submission.contact.designer || submission.contact.brand;

    const { accessToken, accountId, baseUri } = await this.connection.ensureFreshToken();
    const bytes = await this.storage.getObject(doc.storageKey);

    // See docusign.types.ts's file header: this envelope shape is built from
    // training-data knowledge of the eSignature API v2.1, not confirmed
    // against a live DocuSign account. Most likely to need adjustment on a
    // real account: the fixed sign-here tab position below, which assumes an
    // arbitrary uploaded PDF with no anchor text of its own to key off — a
    // production integration would more likely use DocuSign's tagging UI
    // (embedded sender view) or require the source PDF to carry an anchor
    // string, rather than a hardcoded page-1 coordinate.
    const envelopeDefinition = {
      emailSubject: `Please sign: ${doc.filename}`,
      documents: [
        {
          documentId: '1',
          name: doc.filename,
          fileExtension: fileExtensionOf(doc.filename),
          documentBase64: bytes.toString('base64'),
        },
      ],
      recipients: {
        signers: [
          {
            recipientId: '1',
            routingOrder: '1',
            email: signerEmail,
            name: signerName,
            tabs: {
              signHereTabs: [{ documentId: '1', pageNumber: '1', xPosition: '100', yPosition: '700' }],
            },
          },
        ],
      },
      status: 'sent',
      // Per-envelope Connect subscription: this is what makes the webhook
      // below fire at all, without also requiring an admin to separately
      // configure an account-level Connect configuration in DocuSign's own
      // admin console. `includeDocuments: false` on purpose — the webhook
      // fetches the completed envelope's combined PDF itself via the
      // envelope-documents API rather than carrying it in the notification
      // body, per the task's own design (see DocuSignWebhookService).
      eventNotification: {
        url: this.connection.redirectUri().replace(/\/api\/admin\/docusign\/callback$/, '/api/docusign/webhook'),
        requireAcknowledgment: true,
        envelopeEvents: [
          { envelopeEventStatusCode: 'sent' },
          { envelopeEventStatusCode: 'delivered' },
          { envelopeEventStatusCode: 'completed' },
          { envelopeEventStatusCode: 'declined' },
          { envelopeEventStatusCode: 'voided' },
        ],
        includeDocuments: false,
      },
    };

    const res = await fetch(`${apiAccountBase(baseUri, accountId)}/envelopes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(envelopeDefinition),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new BadRequestException(`Could not send to DocuSign: ${await docusignApiError(res)}`);
    }
    const { envelopeId } = (await res.json()) as { envelopeId: string };

    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.signatureRequest.create({
        data: {
          submissionId,
          documentId,
          docusignEnvelopeId: envelopeId,
          status: 'SENT',
          sentById: user.id,
        },
        select: SIGNATURE_REQUEST_SELECT,
      });
      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'SIGNATURE_REQUEST_SENT',
          // The envelope id is deliberately NOT recorded here (detail or
          // payload): GET /api/submissions/:id/audit has no extra permission
          // gate beyond being signed in at all, a wider audience than
          // `email.send`, and that id is the one thing the public webhook
          // trusts — see SIGNATURE_REQUEST_SELECT's comment above and
          // DocuSignWebhookService.handleNotification.
          detail: `Sent "${doc.filename}" for signature via DocuSign`,
          payload: { documentId },
        },
        tx,
      );
      return created;
    });

    return request;
  }
}
