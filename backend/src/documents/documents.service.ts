import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { CreateDocumentDto, PresignDto } from './dto';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly submissions: SubmissionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Access to a submission's documents is exactly access to the submission.
   * findOne() already 404s (not 403s) another rep's record, so reusing it means
   * documents inherit that same "cannot even probe for it" boundary for free.
   */
  private async assertAccess(submissionId: string, user: AuthUser) {
    await this.submissions.findOne(submissionId, user);
  }

  private keyPrefix(submissionId: string) {
    return `submissions/${submissionId}/`;
  }

  async presign(submissionId: string, dto: PresignDto, user: AuthUser) {
    await this.assertAccess(submissionId, user);

    // Server owns the key. A random segment keeps two files of the same name
    // from colliding; the filename tail keeps the object recognisable in R2.
    const safeName = dto.filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
    const storageKey = `${this.keyPrefix(submissionId)}${randomUUID()}-${safeName}`;
    const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType);

    return {
      uploadUrl,
      storageKey,
      method: 'PUT' as const,
      headers: { 'Content-Type': dto.contentType },
    };
  }

  async create(submissionId: string, dto: CreateDocumentDto, user: AuthUser) {
    await this.assertAccess(submissionId, user);

    // The key must be one we handed out for THIS submission — never a raw key a
    // client invented, which could point anywhere in the bucket.
    if (!dto.storageKey.startsWith(this.keyPrefix(submissionId))) {
      throw new BadRequestException('storageKey does not belong to this submission');
    }

    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          submissionId,
          type: dto.type,
          filename: dto.filename,
          storageKey: dto.storageKey,
          contentType: dto.contentType,
          size: dto.size,
          uploadedById: user.id,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      await this.audit.log(
        {
          submissionId,
          actorId: user.id,
          action: 'DOCUMENT_ATTACHED',
          detail: `${dto.type}: ${dto.filename}`,
        },
        tx,
      );

      return doc;
    });
  }

  async list(submissionId: string, user: AuthUser) {
    await this.assertAccess(submissionId, user);
    return this.prisma.document.findMany({
      where: { submissionId },
      orderBy: { uploadedAt: 'desc' },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
  }

  async downloadUrl(submissionId: string, documentId: string, user: AuthUser) {
    await this.assertAccess(submissionId, user);
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.submissionId !== submissionId) {
      throw new NotFoundException('Document not found');
    }
    const url = await this.storage.presignDownload(doc.storageKey, doc.filename);
    return { url, filename: doc.filename };
  }
}
