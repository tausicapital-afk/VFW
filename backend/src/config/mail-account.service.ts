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

/**
 * A sending account with its secret decrypted — never leaves the server.
 *
 * `secret` is the SMTP password or the provider API key depending on
 * `provider`; `host`/`port`/`encryption`/`username` are SMTP-only and blank for
 * HTTP providers.
 */
export interface SendingAccount {
  id: string;
  label: string;
  provider: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  secret: string;
  fromAddress: string;
  fromName?: string;
}

/** The browser-safe shape: everything except the secret. */
export interface MailAccountView {
  id: string;
  label: string;
  provider: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  fromAddress: string;
  fromName?: string;
  isActive: boolean;
  /** A stored secret that can no longer be decrypted (root key rotated). */
  decryptError?: boolean;
  updatedAt: string;
}

export interface MailAccountInput {
  label?: string;
  provider?: string;
  host?: string;
  port?: number;
  encryption?: string;
  username?: string;
  password?: string;
  fromAddress?: string;
  fromName?: string;
}

export const PROVIDERS = ['smtp', 'resend', 'relay'];

/**
 * What each provider actually needs. Three near-identical booleans beat one
 * "isHttp" flag, because the providers do not divide cleanly in two: `relay`
 * talks HTTPS like `resend`, but it needs a `host` (its URL) like `smtp`.
 * Collapsing that would either demand an SMTP hostname from Resend or drop the
 * relay's URL on save.
 */
/** Dials a mail server directly — needs port, encryption and a login. */
export const SMTP_PROVIDERS = ['smtp'];
/** Talks HTTPS over 443, so it works where SMTP is blocked. */
export const HTTP_PROVIDERS = ['resend', 'relay'];
/** Stores something in `host`: a hostname for smtp, a full URL for relay. */
export const HOST_PROVIDERS = ['smtp', 'relay'];

export const usesSmtp = (p: string) => SMTP_PROVIDERS.includes(p);
export const needsHost = (p: string) => HOST_PROVIDERS.includes(p);

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
  active(): SendingAccount | undefined {
    const row = this.cache.find((r) => r.isActive);
    return row ? this.resolved(row) : undefined;
  }

  /** A specific mailbox, for the per-row "Send test" button. */
  byId(id: string): SendingAccount | undefined {
    const row = this.cache.find((r) => r.id === id);
    return row ? this.resolved(row) : undefined;
  }

  private resolved(row: Prisma.MailAccountGetPayload<object>): SendingAccount | undefined {
    const secret = this.decrypt(row);
    if (!secret) return undefined;
    return {
      id: row.id,
      label: row.label,
      provider: row.provider,
      host: row.host,
      port: row.port,
      encryption: row.encryption,
      username: row.username,
      secret,
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
      provider: r.provider,
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

  /**
   * `requireAll` is create-vs-edit: create needs the full set for its provider,
   * an edit only needs to be self-consistent. `provider` decides WHICH fields
   * are the full set — demanding an SMTP host for a Resend account would be
   * asking for a value that has no meaning.
   */
  private validate(input: MailAccountInput, requireAll: boolean, provider: string) {
    const need = (v: string | undefined, name: string) => {
      if (requireAll && !v?.trim()) throw new BadRequestException(`${name} is required`);
    };
    if (!PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Provider must be one of: ${PROVIDERS.join(', ')}`);
    }
    need(input.label, 'Name');
    need(input.fromAddress, 'From address');
    need(input.password, provider === 'smtp' ? 'Password' : provider === 'relay' ? 'Relay token' : 'API key');

    if (provider === 'relay') {
      need(input.host, 'Relay URL');
      const url = input.host?.trim();
      if (url) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new BadRequestException('Relay URL must be a full URL, like https://veeb.co.ke/vfw-relay/');
        }
        // The token travels in a header on every send. Over http:// it travels
        // in clear text to anyone on the path, and the token is the relay's
        // entire perimeter.
        if (parsed.protocol !== 'https:') {
          throw new BadRequestException('Relay URL must use https:// — the token is sent with every message');
        }
      }
    } else if (usesSmtp(provider)) {
      need(input.host, 'SMTP server');
      need(input.username, 'Username');

      if (input.host?.includes('@')) {
        throw new BadRequestException(
          'SMTP server must be a hostname like mail.yourdomain.com, not an email address',
        );
      }
      if (
        input.port !== undefined &&
        (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
      ) {
        throw new BadRequestException('Port must be a whole number between 1 and 65535');
      }
      if (input.encryption !== undefined && !ENCRYPTIONS.includes(input.encryption)) {
        throw new BadRequestException(`Encryption must be one of: ${ENCRYPTIONS.join(', ')}`);
      }
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
    const provider = input.provider?.trim() || 'smtp';
    this.validate(input, true, provider);
    const smtp = usesSmtp(provider);

    await this.prisma.$transaction(async (tx) => {
      const first = (await tx.mailAccount.count()) === 0;
      const created = await tx.mailAccount.create({
        data: {
          label: input.label!.trim(),
          provider,
          // Only what this provider actually uses is stored. Anything else is
          // blanked rather than left holding a stale value that implies the row
          // dials a host it never touches.
          host: needsHost(provider) ? input.host!.trim() : '',
          port: smtp ? (input.port ?? 465) : 465,
          encryption: smtp ? (input.encryption ?? 'ssl') : 'ssl',
          username: smtp ? input.username!.trim() : '',
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
          // fromAddress, not username: an HTTP provider has no username, and the
          // from-address is what identifies the sender for every provider.
          detail: `Mail account added: ${created.label} (${created.fromAddress}, via ${created.provider})`,
          payload: { id: created.id, provider: created.provider, host: created.host, activated: first },
        },
        tx,
      );
    });

    await this.bump();
    return this.list();
  }

  /** Blank password = keep the stored one, the same write-only rule as config. */
  async update(id: string, input: MailAccountInput, actor: AuthUser): Promise<MailAccountView[]> {
    const existing = this.cache.find((r) => r.id === id);
    if (!existing) throw new NotFoundException('That mail account no longer exists');
    // An edit that does not mention the provider keeps the stored one.
    const provider = input.provider?.trim() || existing.provider;
    // Blank secret normally means "keep the stored one", but the stored one is a
    // different KIND of credential once the provider changes — an SMTP password
    // is not an API key. Silently carrying it over would produce an account that
    // looks configured and fails on the first real send.
    if (provider !== existing.provider) {
      if (!input.password?.trim()) {
        const kind =
          provider === 'smtp' ? 'password' : provider === 'relay' ? 'relay token' : 'API key';
        throw new BadRequestException(
          `Changing this account to ${provider} needs its ${kind} — ` +
            `the stored one belongs to ${existing.provider}.`,
        );
      }
      // `host` means a different thing per provider: a hostname for smtp, a full
      // URL for relay. Keeping the old value across a switch would leave
      // "mail.veeb.co.ke" sitting in a field that must hold
      // "https://veeb.co.ke/vfw-relay/" — configured-looking and broken.
      if (needsHost(provider) && !input.host?.trim()) {
        throw new BadRequestException(
          provider === 'relay'
            ? 'Changing this account to relay needs its relay URL.'
            : 'Changing this account to smtp needs its SMTP server.',
        );
      }
    }
    this.validate(input, false, provider);
    const smtp = usesSmtp(provider);

    const data: Prisma.MailAccountUpdateInput = { updatedById: actor.id, provider };
    if (input.label?.trim()) data.label = input.label.trim();
    if (input.password?.trim()) data.password = encryptSecret(input.password);
    if (input.fromAddress?.trim()) data.fromAddress = input.fromAddress.trim();
    if (input.fromName !== undefined) data.fromName = input.fromName.trim() || null;

    if (needsHost(provider)) {
      if (input.host?.trim()) data.host = input.host.trim();
    } else {
      // Nothing to dial: do not let the row keep claiming a host.
      data.host = '';
    }
    if (smtp) {
      if (input.port !== undefined) data.port = input.port;
      if (input.encryption) data.encryption = input.encryption;
      if (input.username?.trim()) data.username = input.username.trim();
    } else {
      data.username = '';
    }

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
