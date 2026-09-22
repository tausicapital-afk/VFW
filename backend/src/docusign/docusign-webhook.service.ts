import { Injectable, Logger } from '@nestjs/common';
import { SignatureRequestStatus } from '@prisma/client';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { DocuSignConnectionService } from './docusign-connection.service';
import { DocuSignConnectPayload } from './dto';
import { TrackedEnvelopeStatus, TRACKED_ENVELOPE_STATUSES, apiAccountBase, docusignApiError } from './docusign.types';

/**
 * The hidden, ACTIVE service account every webhook-created Document is
 * attributed to — nobody actually uploaded the signed copy, the webhook did.
 * Same convention as User.hidden's doc comment describes for demo/test
 * logins, applied here for the same reason: `uploadedById` is a required FK
 * (see Document in schema.prisma), so there has to be a real User row, but it
 * must never appear on the admin Users tab or authenticate as anyone
 * meaningfully could. Least-privileged role (INTERN) and a discarded,
 * cryptographically random password — nobody is ever meant to sign in as
 * this account, and the random password (never emailed, never logged) makes
 * that true regardless of role.
 *
 * The `.internal` suffix is load-bearing, not decorative: it is an
 * IETF-reserved special-use domain (RFC 9476) no registrar will issue and
 * Google will never verify a Workspace/Gmail address against, which is what
 * keeps this row unreachable through Google SSO's link-by-verified-email flow
 * (AuthService.loginWithGoogle) — see the identical note on
 * payments.service.ts's SYSTEM_USER_EMAIL, the sibling account this same
 * pattern was introduced for. Do not repoint this at a real, registrable
 * domain.
 */
const SYSTEM_USER_EMAIL = 'docusign@system.internal';

@Injectable()
export class DocuSignWebhookService {
  private readonly log = new Logger(DocuSignWebhookService.name);
  private systemUserIdCache: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly connection: DocuSignConnectionService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * DocuSign Connect's HMAC scheme signs the raw JSON payload bytes with
   * HMAC-SHA256 and base64-encodes the result into the `X-DocuSign-Signature-1`
   * header (DocuSign supports up to 5 keys/headers for rotation; this checks
   * the first). That means — unlike a re-serialize-and-compare approach —
   * this needs the EXACT bytes DocuSign sent, not `JSON.stringify(req.body)`
   * after Nest's JSON body parser has already parsed and potentially
   * reformatted it (key order, number formatting and whitespace are not
   * guaranteed to round-trip identically). This app therefore enables Nest's
   * `rawBody: true` option (see main.ts and test/app.ts) purely to expose
   * `req.rawBody` alongside the normal parsed `req.body` — it does not
   * disable or change JSON parsing for this or any other route, so it is
   * safe to leave on globally.
   *
   * Verification is skipped (returns true) when no DOCUSIGN_HMAC_KEY is
   * configured — HMAC signing is an opt-in DocuSign Connect setting, not a
   * given. Without it, this endpoint's security boundary is entirely the
   * envelope-id lookup in {@link handleNotification} — a caller can hit this
   * URL with any body, but can only ever affect a SignatureRequest this
   * console itself created and already knows the envelope id for.
   */
  verifySignature(rawBody: Buffer | undefined, signatureHeader: string | string[] | undefined): boolean {
    const key = this.config.get('DOCUSIGN_HMAC_KEY');
    if (!key) return true; // not configured — nothing to check against

    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!signature || !rawBody) return false;

    const expected = createHmac('sha256', key).update(rawBody).digest();
    let given: Buffer;
    try {
      given = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    // timingSafeEqual throws on a length mismatch rather than returning
    // false, so guard it explicitly — a wrong-length signature is simply
    // wrong, not a crash.
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  }

  /** Pull the envelope id and status out of either Connect payload shape (see DocuSignConnectPayload). */
  extractEnvelope(body: DocuSignConnectPayload): { envelopeId: string | null; status: TrackedEnvelopeStatus | null } {
    const envelopeId = body.data?.envelopeId ?? body.envelopeId ?? null;
    const rawStatus = (body.data?.envelopeSummary?.status ?? body.status ?? body.event?.replace(/^envelope-/, '')) as
      | string
      | undefined;
    const status = rawStatus?.toLowerCase();
    const tracked = TRACKED_ENVELOPE_STATUSES.find((s) => s === status) ?? null;
    return { envelopeId, status: tracked };
  }

  /**
   * Process one notification. The envelope id is looked up against a
   * SignatureRequest this console itself created via sendForSignature — that
   * lookup, not anything else in the payload, is what scopes this write to a
   * real submission/document. An envelope id this app never issued matches
   * no row and does nothing, whatever else the body claims.
   */
  async handleNotification(envelopeId: string, status: TrackedEnvelopeStatus): Promise<void> {
    const existing = await this.prisma.signatureRequest.findUnique({ where: { docusignEnvelopeId: envelopeId } });
    if (!existing) {
      this.log.warn(`DocuSign webhook for unknown envelope ${envelopeId} — ignored`);
      return;
    }

    if (status === 'completed') {
      await this.handleCompleted(envelopeId, existing.submissionId, existing.documentId);
      return;
    }

    const next = STATUS_MAP[status];
    // Never let a stale, out-of-order "sent"/"delivered" retry regress a
    // request that has already reached a terminal state.
    const claimed = await this.prisma.signatureRequest.updateMany({
      where: { docusignEnvelopeId: envelopeId, status: { notIn: TERMINAL } },
      data: { status: next },
    });
    if (claimed.count === 0) return; // idempotent no-op: already terminal, or already at/after this status

    if (next === SignatureRequestStatus.DECLINED || next === SignatureRequestStatus.VOIDED) {
      // envelopeId deliberately excluded from detail/payload — see
      // SIGNATURE_REQUEST_SELECT's comment in docusign.service.ts. The
      // submission's audit trail is readable by anyone signed in, a wider
      // audience than this id should ever reach.
      await this.audit.log({
        submissionId: existing.submissionId,
        action: next === SignatureRequestStatus.DECLINED ? 'SIGNATURE_REQUEST_DECLINED' : 'SIGNATURE_REQUEST_VOIDED',
        detail: `The signature request was ${next.toLowerCase()}`,
        payload: { documentId: existing.documentId },
      });
    }
  }

  /**
   * The `completed` path: claim the transition atomically (so a duplicate or
   * retried "completed" delivery — DocuSign Connect redelivers on any
   * non-2xx response, and can redeliver even on a 2xx — creates at most one
   * signed Document), then fetch the combined signed PDF and store it.
   */
  private async handleCompleted(envelopeId: string, submissionId: string, sourceDocumentId: string): Promise<void> {
    // Atomic compare-and-set: only the delivery that actually flips status
    // away from a non-terminal state proceeds past this point. A replay
    // that arrives after this has already landed sees count === 0 and stops
    // here — no second fetch from DocuSign, no second Document row.
    const claimed = await this.prisma.signatureRequest.updateMany({
      where: { docusignEnvelopeId: envelopeId, status: { notIn: TERMINAL } },
      data: { status: SignatureRequestStatus.COMPLETED, completedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const sourceDoc = await this.prisma.document.findUnique({ where: { id: sourceDocumentId } });
    if (!sourceDoc) {
      this.log.error(`SignatureRequest for envelope ${envelopeId} points at a missing source Document — cannot store the signed copy`);
      return;
    }

    const { accessToken, accountId, baseUri } = await this.connection.ensureFreshToken();
    const res = await fetch(`${apiAccountBase(baseUri, accountId)}/envelopes/${envelopeId}/documents/combined`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // The status transition above already landed — a later manual retry
      // (or the next Connect redelivery, since DocuSign resends while it has
      // not seen a 2xx) can still pick the document fetch back up. Losing
      // this half must not leave the request stuck claiming SENT/DELIVERED
      // forever, so the status write stands even though the fetch failed.
      this.log.error(`Could not fetch the signed document for envelope ${envelopeId}: ${await docusignApiError(res)}`);
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    const filename = signedFilename(sourceDoc.filename);
    const storageKey = `submissions/${submissionId}/${randomUUID()}-${filename}`;
    await this.storage.putObject(storageKey, buffer, 'application/pdf');

    const systemUserId = await this.systemUserId();

    await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          submissionId,
          type: 'Signed Contract',
          filename,
          storageKey,
          contentType: 'application/pdf',
          size: buffer.length,
          uploadedById: systemUserId,
        },
      });
      await tx.signatureRequest.update({
        where: { docusignEnvelopeId: envelopeId },
        data: { signedDocumentId: doc.id },
      });
      await this.audit.log(
        {
          submissionId,
          actorId: systemUserId,
          action: 'SIGNATURE_REQUEST_COMPLETED',
          detail: `Signed copy stored: ${filename}`,
          payload: { documentId: doc.id, sourceDocumentId },
        },
        tx,
      );
    });
  }

  /**
   * Find-or-lazily-create the hidden "DocuSign" service user — see the class
   * doc comment. Memoised for the life of the process; a P2002 on the create
   * (two webhooks racing the very first time) just means someone else won the
   * insert, so this falls back to reading the row that already exists.
   */
  private async systemUserId(): Promise<string> {
    if (this.systemUserIdCache) return this.systemUserIdCache;

    const existing = await this.prisma.user.findUnique({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } });
    if (existing) {
      this.systemUserIdCache = existing.id;
      return existing.id;
    }

    const randomPassword = randomBytes(32).toString('hex');
    try {
      const created = await this.prisma.user.create({
        data: {
          name: 'DocuSign',
          email: SYSTEM_USER_EMAIL,
          passwordHash: await argon2.hash(randomPassword),
          role: 'INTERN',
          status: 'ACTIVE',
          hidden: true,
        },
        select: { id: true },
      });
      this.systemUserIdCache = created.id;
      return created.id;
    } catch {
      // Lost the create race — another webhook call created it first.
      const row = await this.prisma.user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } });
      this.systemUserIdCache = row.id;
      return row.id;
    }
  }
}

const STATUS_MAP: Record<Exclude<TrackedEnvelopeStatus, 'completed'>, SignatureRequestStatus> = {
  sent: SignatureRequestStatus.SENT,
  delivered: SignatureRequestStatus.DELIVERED,
  declined: SignatureRequestStatus.DECLINED,
  voided: SignatureRequestStatus.VOIDED,
};

const TERMINAL: SignatureRequestStatus[] = [
  SignatureRequestStatus.COMPLETED,
  SignatureRequestStatus.DECLINED,
  SignatureRequestStatus.VOIDED,
];

function signedFilename(originalFilename: string): string {
  const dot = originalFilename.lastIndexOf('.');
  const base = dot > 0 ? originalFilename.slice(0, dot) : originalFilename;
  return `${base} (signed).pdf`;
}
