import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decryptSecret } from '../config/config.crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Received email — pulled over IMAP from the active mailbox, on a timer.
 *
 * This is opt-in and SMTP-only: it runs only when the active MailAccount has
 * `inboundEnabled` AND is an `smtp` provider (a Resend/relay account has no
 * mailbox to read). It reuses that row's username + decrypted password, dialing
 * IMAP on `imapHost` (falling back to `host` — a cPanel mailbox answers IMAP on
 * the same domain it answers SMTP).
 *
 * It fails QUIETLY: an unreachable IMAP port is a deployment fact, not a crash.
 * Many hosts (Railway among them) block outbound IMAP outright — there the poll
 * simply keeps failing to connect and Sent is unaffected. The warning says why;
 * it never throws out of the cron.
 *
 * Idempotent: each message is deduped by (mailAccountId, messageId), so the same
 * mail pulled on the next tick lands on the same row rather than a duplicate.
 */
@Injectable()
export class InboundMailService {
  private readonly log = new Logger(InboundMailService.name);
  // Guards against a slow poll overlapping the next tick's start.
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.log.warn(
        `Inbound mail poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const account = await this.prisma.mailAccount.findFirst({
      where: { isActive: true, inboundEnabled: true, provider: 'smtp' },
    });
    // Inbound off, or the active mailbox is an HTTP provider with nothing to read.
    if (!account) return;

    let secret: string;
    try {
      secret = decryptSecret(account.password);
    } catch {
      this.log.error(`Inbound: cannot decrypt the password for mail account ${account.id}`);
      return;
    }

    const host = (account.imapHost || account.host).trim();
    if (!host) return;
    const port = account.imapPort || 993;

    const client = new ImapFlow({
      host,
      port,
      // 993 is implicit TLS; anything else (143) starts plaintext and upgrades.
      secure: port === 993,
      auth: { user: account.username, pass: secret },
      // imapflow is chatty at info level; we do our own one-line logging.
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Bound the work: only the last two weeks. Dedupe does the rest, so a
        // message already stored is skipped rather than re-inserted.
        const since = new Date(Date.now() - 14 * 86_400_000);
        const uids = (await client.search({ since }, { uid: true })) || [];
        if (!uids.length) return;

        for await (const message of client.fetch(
          uids,
          { envelope: true, source: true },
          { uid: true },
        )) {
          await this.persist(account.id, account.fromAddress, message);
        }
      } finally {
        lock.release();
      }
    } finally {
      // logout() is the clean close; fall back to a hard close if it errors.
      await client.logout().catch(() => client.close());
    }
  }

  private async persist(
    mailAccountId: string,
    mailboxAddress: string,
    message: { uid: number; source?: Buffer; envelope?: { messageId?: string } },
  ): Promise<void> {
    const messageId = message.envelope?.messageId || `uid:${mailAccountId}:${message.uid}`;

    // Cheap dedupe before the parse; the unique constraint is the real guarantee.
    const seen = await this.prisma.emailMessage.findFirst({
      where: { mailAccountId, messageId },
      select: { id: true },
    });
    if (seen || !message.source) return;

    const parsed = await simpleParser(message.source);
    const from = parsed.from?.value?.[0];
    const text = parsed.text ?? '';
    const html = typeof parsed.html === 'string' ? parsed.html : null;

    try {
      await this.prisma.emailMessage.create({
        data: {
          direction: 'INBOUND',
          status: 'RECEIVED',
          kind: 'INBOUND',
          fromAddress: from?.address ?? '(unknown)',
          fromName: from?.name || null,
          toAddress: mailboxAddress,
          subject: parsed.subject || '(no subject)',
          bodyText: text || null,
          bodyHtml: html,
          preview: previewOf(text || parsed.subject || ''),
          provider: 'imap',
          mailAccountId,
          messageId,
          receivedAt: parsed.date ?? new Date(),
        },
      });
    } catch (err) {
      // A concurrent tick that inserted the same message first — the unique
      // constraint did its job. Anything else is worth a line.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }
}

/** A short, whitespace-collapsed snippet for the list row. */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
