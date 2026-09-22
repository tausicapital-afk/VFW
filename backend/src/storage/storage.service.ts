import { Global, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import { ConfigService } from '../config/config.service';

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
  private client: S3Client | null = null;
  /** The config version the memoised client was built against. */
  private clientVersion = -1;

  constructor(private readonly config: ConfigService) {}

  private get bucket(): string {
    return this.config.get('R2_BUCKET') ?? '';
  }

  private endpoint(): string {
    const explicit = this.config.get('R2_ENDPOINT');
    if (explicit) return explicit;
    const account = this.config.get('R2_ACCOUNT_ID');
    return account ? `https://${account}.r2.cloudflarestorage.com` : '';
  }

  private build(): S3Client | null {
    const accessKeyId = this.config.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get('R2_SECRET_ACCESS_KEY');
    const endpoint = this.endpoint();

    if (accessKeyId && secretAccessKey && endpoint && this.bucket) {
      return new S3Client({
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
    }
    return null;
  }

  /**
   * The S3 client, rebuilt whenever the admin changes a storage credential, so a
   * saved setting takes effect on the next upload without a restart. The version
   * counter on ConfigService bumps on every write.
   */
  private getClient(): S3Client | null {
    if (this.clientVersion !== this.config.version) {
      this.client = this.build();
      this.clientVersion = this.config.version;
    }
    return this.client;
  }

  get configured(): boolean {
    return this.getClient() !== null;
  }

  private requireClient(): S3Client {
    const client = this.getClient();
    if (!client) {
      throw new ServiceUnavailableException(
        'Document storage is not configured. Set R2_ENDPOINT (or R2_ACCOUNT_ID), ' +
          'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
      );
    }
    return client;
  }

  /** Prove the credentials can actually reach the bucket — used by the test button. */
  async verify(): Promise<void> {
    const client = this.requireClient();
    await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
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
   *
   * `expiresIn` overrides the default lifetime. A download link wants to be
   * brief; an <img src> does not, because a URL that expires under a page left
   * open turns into a broken image with no way to ask for a fresh one. Callers
   * that render rather than download pass a longer window on purpose.
   */
  presignDownload(
    key: string,
    filename: string,
    inline = false,
    expiresIn = EXPIRES_SECONDS,
  ): Promise<string> {
    const disposition = inline ? 'inline' : 'attachment';
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `${disposition}; filename="${filename.replace(/"/g, '')}"`,
    });
    return getSignedUrl(this.requireClient(), cmd, { expiresIn });
  }

  /**
   * Write bytes straight into the bucket, server-side — for the one caller
   * that has no browser to hand a presigned PUT to: the DocuSign webhook,
   * which fetches a completed envelope's combined PDF from DocuSign's own API
   * and has to land it in R2 itself. Every other write in this app goes
   * through {@link presignUpload} on purpose (see the class doc); this is the
   * narrow exception for content this app receives directly rather than a
   * browser.
   */
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    });
    await this.requireClient().send(cmd);
  }

  /**
   * Read an object's bytes back, server-side — the counterpart to
   * {@link putObject}. Used to hand an already-uploaded Document's content to
   * DocuSign when sending it for signature (the eSignature API needs the
   * actual bytes, not a link); every other download in this app is a
   * presigned GET the browser follows itself (see {@link presignDownload}).
   */
  async getObject(key: string): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const res = await this.requireClient().send(cmd);
    const body = res.Body as Readable | undefined;
    if (!body) throw new ServiceUnavailableException('Document storage returned an empty object');
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
}

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
