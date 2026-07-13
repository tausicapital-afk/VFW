import { Global, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Presigned URLs are deliberately short-lived: long enough to push or pull one
// file, not long enough to be a durable capability if the link leaks.
const EXPIRES_SECONDS = 300;

/**
 * Object storage for submission documents (Cloudflare R2 via its S3-compatible
 * API). The file never passes through this API: the client uploads straight to
 * R2 with a presigned PUT and downloads with a presigned GET.
 *
 * Credentials come from R2_* env vars. There is intentionally NO local-disk
 * fallback — a fallback would look like it works right up until the first
 * redeploy ate a signed contract. If it isn't configured, uploads fail loudly.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client | null;
  private readonly bucket = process.env.R2_BUCKET ?? '';

  constructor() {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const endpoint =
      process.env.R2_ENDPOINT ||
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : '');

    if (accessKeyId && secretAccessKey && endpoint && this.bucket) {
      this.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        // Modern aws-sdk defaults to adding a CRC32 checksum header, which it
        // then bakes into a presigned PUT signature. R2 does not expect that
        // header from a plain browser fetch, so the upload fails with a
        // signature mismatch. Only sign checksums when the caller asks for one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    } else {
      this.client = null;
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Document storage is not configured. Set R2_ENDPOINT (or R2_ACCOUNT_ID), ' +
          'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
      );
    }
    return this.client;
  }

  /** A short-lived URL the client PUTs the raw file bytes to. */
  presignUpload(key: string, contentType: string): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.requireClient(), cmd, { expiresIn: EXPIRES_SECONDS });
  }

  /**
   * A short-lived URL that streams the file back.
   *
   * `inline` controls the disposition: an attachment (the default) forces a
   * download, which is right for a contract; `inline: true` lets the browser
   * render it in place, which is what a chat image wants.
   */
  presignDownload(key: string, filename: string, inline = false): Promise<string> {
    const disposition = inline ? 'inline' : 'attachment';
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `${disposition}; filename="${filename.replace(/"/g, '')}"`,
    });
    return getSignedUrl(this.requireClient(), cmd, { expiresIn: EXPIRES_SECONDS });
  }
}

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
