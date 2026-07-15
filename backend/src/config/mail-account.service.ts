import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from './config.crypto';
import { ConfigService } from './config.service';

/**
 * The SMTP mailboxes the app can send from, and which one is sending.
 *
 * Why a table and not more ConfigSetting rows: a flat key/value store can only
 * describe one mailbox. Holding a second — a cPanel box and a Gmail box, say —
 * meant retyping four fields to switch and losing the old ones in the process.
 * Here every mailbox is a row, exactly one is `isActive`, and switching sender
 * is one click that cannot lose the other set.
 *
 * The cache mirrors ConfigService's: rows are held in memory and refreshed on
 * write, because {@link EmailService} resolves the sending account inside sync
 * getters (`configured`, `from`) and from module-level template helpers that
 * have no `this`. `version` bumps on every write so EmailService knows to
 * rebuild a memoised transporter whose credentials changed under it.
 */

/** A mailbox with its password decrypted — never leaves the server. */
export interface SmtpAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string;
}

/** The browser-safe shape: everything except the password. */
export interface MailAccountView {
  id: string;
  label: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  fromAddress: string;
  fromName?: string;
  isActive: boolean;
  /** A stored password that can no longer be decrypted (root key rotated). */
  decryptError?: boolean;
  updatedAt: string;
}

export interface MailAccountInput {
  label?: string;
  host?: string;
  port?: number;
  encryption?: string;
  username?: string;
  password?: string;
  fromAddress?: string;
  fromName?: string;
}

const ENCRYPTIONS = ['ssl', 'tls', 'none'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Injectable()
export class MailAccountService implements OnModuleInit {
  private readonly log = new Logger(MailAccountService.name);
  private cache: Prisma.MailAccountGetPayload<object>[] = [];
  private _version = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  get version(): number {
    return this._version;
  }

  private async reload() {
    this.cache = await this.prisma.mailAccount.findMany({ orderBy: { createdAt: 'asc' } });
  }

  private decrypt(row: { id: string; password: string }): string | undefined {
    try {
      return decryptSecret(row.password);
    } catch {
      // Do not serve a corrupt credential: treat it as unusable and let the
      // caller fall back or report it, exactly as ConfigService does.
      this.log.error(`Could not decrypt the password for mail account ${row.id}`);
      return undefined;
    }
  }

  /**
   * The mailbox that sends, or undefined if this table cannot supply one.
   *
   * Sync on purpose — see the class note. Returns undefined when the table is
   * empty (EmailService then falls back to the MAIL_* env vars) or when the
   * active row's password will not decrypt.
   */
  active(): SmtpAccount | undefined {
    const row = this.cache.find((r) => r.isActive);
    if (!row) return undefined;
    const password = this.decrypt(row);
    if (!password) return undefined;
    return {
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      encryption: row.encryption,
      username: row.username,
      password,
      fromAddress: row.fromAddress,
      fromName: row.fromName ?? undefined,
    };
  }

  /** A specific mailbox, for the per-row "Send test" button. */
  byId(id: string): SmtpAccount | undefined {
    const row = this.cache.find((r) => r.id === id);
    if (!row) return undefined;
    const password = this.decrypt(row);
    if (!password) return undefined;
    return {
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      encryption: row.encryption,
      username: row.username,
      password,
      fromAddress: row.fromAddress,
      fromName: row.fromName ?? undefined,
    };
  }

  /** True when at least one row exists — i.e. this table, not env, is in charge. */
  get any(): boolean {
    return this.cache.length > 0;
  }

  list(): MailAccountView[] {
    return this.cache.map((r) => ({
      id: r.id,
      label: r.label,
      host: r.host,
      port: r.port,
      encryption: r.encryption,
      username: r.username,
      fromAddress: r.fromAddress,
      fromName: r.fromName ?? undefined,
      isActive: r.isActive,
      ...(this.decrypt(r) === undefined ? { decryptError: true } : {}),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * What the screen shows above the list: whether mail can be sent at all, and
   * by what.
   *
   *  - `account` — an active row here is sending. The normal state.
   *  - `legacy`  — no rows exist, and the MAIL_* settings are still doing the
   *    work. Adding the first account takes over from them.
   *  - `none`    — nothing can send; every email flow will 503.
   *
   * `legacy` deliberately does not say "env": MAIL_* resolves DB-then-env
   * through ConfigService, so the value may be an old ConfigSetting row rather
   * than a Railway variable, and claiming otherwise would send an admin looking
   * in the wrong place.
   */
  status(): { source: 'account' | 'legacy' | 'none'; legacyReady: boolean } {
    const legacyReady = this.config.hasAll([
      'MAIL_HOST',
      'MAIL_USERNAME',
      'MAIL_PASSWORD',
      'MAIL_FROM_ADDRESS',
    ]);
    if (this.active()) return { source: 'account', legacyReady };
    if (!this.any && legacyReady) return { source: 'legacy', legacyReady };
    return { source: 'none', legacyReady };
  }

  private validate(input: MailAccountInput, requireAll: boolean) {
    const need = (v: string | undefined, name: string) => {
      if (requireAll && !v?.trim()) throw new BadRequestException(`${name} is required`);
    };
    need(input.label, 'Name');
    need(input.host, 'SMTP server');
    need(input.username, 'Username');
    need(input.password, 'Password');
    need(input.fromAddress, 'From address');

    if (input.host?.includes('@')) {
      throw new BadRequestException(
        'SMTP server must be a hostname like mail.yourdomain.com, not an email address',
      );
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      throw new BadRequestException('Port must be a whole number between 1 and 65535');
    }
    if (input.encryption !== undefined && !ENCRYPTIONS.includes(input.encryption)) {
      throw new BadRequestException(`Encryption must be one of: ${ENCRYPTIONS.join(', ')}`);
    }
    if (input.fromAddress?.trim() && !EMAIL_RE.test(input.fromAddress.trim())) {
      throw new BadRequestException('From address must be a valid email address');
    }
  }

  /**
   * The first account created becomes active automatically: an admin who adds
   * one mailbox and no second one should not have to then discover a separate
   * "make active" step to make mail work.
   */
  async create(input: MailAccountInput, actor: AuthUser): Promise<MailAccountView[]> {
    this.validate(input, true);

    const row = await this.prisma.$transaction(async (tx) => {
      const first = (await tx.mailAccount.count()) === 0;
      const created = await tx.mailAccount.create({
        data: {
          label: input.label!.trim(),
          host: input.host!.trim(),
          port: input.port ?? 465,
          encryption: input.encryption ?? 'ssl',
          username: input.username!.trim(),
          password: encryptSecret(input.password!),
          fromAddress: input.fromAddress!.trim(),
          fromName: input.fromName?.trim() || null,
          isActive: first,
          updatedById: actor.id,
        },
      });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'MAIL_ACCOUNT_CREATED',
          detail: `Mail account added: ${created.label} (${created.username})`,
          payload: { id: created.id, host: created.host, activated: first },
        },
        tx,
      );
      return created;
    });

    await this.bump();
    return this.list();
  }

  /** Blank password = keep the stored one, the same write-only rule as config. */
  async update(id: string, input: MailAccountInput, actor: AuthUser): Promise<MailAccountView[]> {
    const existing = this.cache.find((r) => r.id === id);
    if (!existing) throw new NotFoundException('That mail account no longer exists');
    this.validate(input, false);

    const data: Prisma.MailAccountUpdateInput = { updatedById: actor.id };
    if (input.label?.trim()) data.label = input.label.trim();
    if (input.host?.trim()) data.host = input.host.trim();
    if (input.port !== undefined) data.port = input.port;
    if (input.encryption) data.encryption = input.encryption;
    if (input.username?.trim()) data.username = input.username.trim();
    if (input.password?.trim()) data.password = encryptSecret(input.password);
    if (input.fromAddress?.trim()) data.fromAddress = input.fromAddress.trim();
    if (input.fromName !== undefined) data.fromName = input.fromName.trim() || null;

    await this.prisma.$transaction(async (tx) => {
      await tx.mailAccount.update({ where: { id }, data });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'MAIL_ACCOUNT_UPDATED',
          detail: `Mail account updated: ${existing.label} (${existing.username})`,
          // The password is never written to the payload — only that it changed.
          payload: {
            id,
            fields: Object.keys(data).filter((k) => k !== 'updatedById' && k !== 'password'),
            passwordChanged: Boolean(input.password?.trim()),
          },
        },
        tx,
      );
    });

    await this.bump();
    return this.list();
  }

  /**
   * Exactly one active row, enforced here rather than by a partial unique index
   * (Prisma cannot express one, and raw SQL for it would read as drift). Both
   * writes are in one transaction, so there is no instant where two rows are
   * active or none is.
   */
  async activate(id: string, actor: AuthUser): Promise<MailAccountView[]> {
    const target = this.cache.find((r) => r.id === id);
    if (!target) throw new NotFoundException('That mail account no longer exists');

    await this.prisma.$transaction(async (tx) => {
      await tx.mailAccount.updateMany({ where: { isActive: true }, data: { isActive: false } });
      await tx.mailAccount.update({ where: { id }, data: { isActive: true, updatedById: actor.id } });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'MAIL_ACCOUNT_ACTIVATED',
          detail: `Outgoing email now sends from ${target.label} (${target.fromAddress})`,
          payload: { id, username: target.username },
        },
        tx,
      );
    });

    await this.bump();
    return this.list();
  }

  /**
   * Deleting the active account would silently stop every sign-up code and
   * password reset, so it is refused: activate another first. Deleting the last
   * one is allowed — that hands sending back to the MAIL_* env vars, or turns
   * email off loudly, which is the documented behaviour either way.
   */
  async remove(id: string, actor: AuthUser): Promise<MailAccountView[]> {
    const row = this.cache.find((r) => r.id === id);
    if (!row) throw new NotFoundException('That mail account no longer exists');
    if (row.isActive && this.cache.length > 1) {
      throw new BadRequestException(
        'This account is the one currently sending. Make another account active first.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mailAccount.delete({ where: { id } });
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'MAIL_ACCOUNT_DELETED',
          detail: `Mail account removed: ${row.label} (${row.username})`,
          payload: { id, host: row.host, wasActive: row.isActive },
        },
        tx,
      );
    });

    await this.bump();
    return this.list();
  }

  private async bump() {
    await this.reload();
    this._version += 1;
  }
}
