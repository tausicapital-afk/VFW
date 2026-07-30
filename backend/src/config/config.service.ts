import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from './config.crypto';
import {
  CONFIG_GROUPS,
  ConfigField,
  ENV_PANEL,
  FIELD_BY_KEY,
  isSecretKey,
} from './config.registry';

export type ConfigSource = 'db' | 'env' | 'default';

/** Per-field state for the admin screen — never carries a secret's plaintext. */
export interface FieldState {
  key: string;
  source: ConfigSource;
  /** Non-secret effective value. Omitted for secrets. */
  value?: string;
  /** For secrets: whether a value is set anywhere (db or env). */
  isSet: boolean;
  /** Whether an environment variable would supply this if the DB row were cleared. */
  hasEnv: boolean;
  /** A stored secret that could not be decrypted (root key changed). */
  decryptError?: boolean;
}

@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly log = new Logger(ConfigService.name);

  /** DB rows only, keyed by name. Env is resolved on top of this at read time. */
  private cache = new Map<string, { value: string; encrypted: boolean }>();

  /**
   * Bumped on every write. Long-lived consumers (EmailService transport,
   * StorageService S3 client) memoise an expensive object and compare this to
   * know when a credential changed under them and the object must be rebuilt.
   */
  private _version = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  get version(): number {
    return this._version;
  }

  private async reload() {
    const rows = await this.prisma.configSetting.findMany();
    this.cache = new Map(rows.map((r) => [r.key, { value: r.value, encrypted: r.encrypted }]));
  }

  /** Decrypt a cached row's value; returns undefined if it cannot be decrypted. */
  private decoded(key: string): string | undefined {
    const row = this.cache.get(key);
    if (!row) return undefined;
    if (!row.encrypted) return row.value;
    try {
      return decryptSecret(row.value);
    } catch {
      // A stored secret we can no longer read (root key rotated). Do not serve a
      // corrupt credential — treat it as unset so resolution falls through to env.
      this.log.error(`Could not decrypt stored config secret "${key}" — falling back to env`);
      return undefined;
    }
  }

  /**
   * The effective value of a setting: DB row (decrypted, non-empty) first, then
   * the environment variable of the same name, then undefined. Empty is treated
   * as unset at every level so a blank never shadows a real value below it.
   */
  get(key: string): string | undefined {
    const db = this.decoded(key);
    if (db && db.trim()) return db;
    const env = process.env[key]?.trim();
    if (env) return env;
    return undefined;
  }

  getNumber(key: string): number | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private source(key: string): ConfigSource {
    if (this.decoded(key)?.trim()) return 'db';
    if (process.env[key]?.trim()) return 'env';
    return 'default';
  }

  /** True when every one of the given keys resolves to a value. */
  hasAll(keys: string[]): boolean {
    return keys.every((k) => this.get(k) !== undefined);
  }

  // -------------------------------------------------------------------------
  // Admin surface
  // -------------------------------------------------------------------------

  /** The full state the Configuration screen renders from. No secret plaintext. */
  state() {
    const fieldState = (f: ConfigField): FieldState => {
      const secret = f.type === 'secret';
      const dbRow = this.cache.get(f.key);
      const decryptError = Boolean(dbRow?.encrypted) && this.decoded(f.key) === undefined;
      const s: FieldState = {
        key: f.key,
        source: this.source(f.key),
        isSet: this.get(f.key) !== undefined,
        hasEnv: Boolean(process.env[f.key]?.trim()),
      };
      if (!secret) s.value = this.get(f.key) ?? '';
      if (decryptError) s.decryptError = true;
      return s;
    };

    const groups = CONFIG_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      blurb: g.blurb,
      // null, not true: a group with nothing required cannot be "not
      // configured", and a permanently green pill is just noise. The UI draws no
      // pill at all for these.
      configured: g.requiredKeys.length ? this.hasAll(g.requiredKeys) : null,
      fields: g.fields.map((f) => ({ ...f, state: fieldState(f) })),
    }));

    const env = ENV_PANEL.map((e) => ({
      key: e.key,
      label: e.label,
      secret: e.secret,
      help: e.help,
      isSet: Boolean(process.env[e.key]?.trim()),
      value: e.secret ? undefined : (process.env[e.key]?.trim() ?? ''),
    }));

    return { groups, env };
  }

  private validate(field: ConfigField, value: string) {
    if (value === '') return; // clearing / keeping — handled by the caller
    switch (field.type) {
      case 'number':
        if (!Number.isFinite(Number(value))) {
          throw new BadRequestException(`${field.label} must be a number`);
        }
        break;
      case 'email':
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
          throw new BadRequestException(`${field.label} must be a valid email address`);
        }
        break;
      case 'color':
        if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
          throw new BadRequestException(`${field.label} must be a hex colour like #0C7A4D`);
        }
        break;
      case 'select':
        if (field.options && !field.options.includes(value)) {
          throw new BadRequestException(
            `${field.label} must be one of: ${field.options.join(', ')}`,
          );
        }
        break;
    }
  }

  /**
   * Apply a set of changes. Only registry keys are honoured (whitelist). The
   * conventions, chosen so the UI reads naturally:
   *
   *  - Secret, blank  -> leave the stored secret untouched (write-only field).
   *  - Secret, value  -> encrypt and store.
   *  - Non-secret, blank -> delete the row, reverting to the env var / default.
   *  - Non-secret, value -> store as plaintext.
   *
   * The audit entry records WHICH keys changed and, for non-secrets, their
   * before/after. A secret's value is never written to the audit payload — only
   * that it changed — for the same reason it never reaches a log line (§10.2).
   */
  async update(entries: Record<string, string>, actor: AuthUser) {
    const changed: Record<string, { before: string; after: string }> = {};

    await this.prisma.$transaction(async (tx) => {
      for (const [key, rawValue] of Object.entries(entries)) {
        const field = FIELD_BY_KEY.get(key);
        if (!field) continue; // ignore anything not in the registry

        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        this.validate(field, value);

        const secret = isSecretKey(key);
        const beforeSet = this.get(key) !== undefined;

        if (secret) {
          if (value === '') continue; // blank = keep current secret
          await tx.configSetting.upsert({
            where: { key },
            create: { key, value: encryptSecret(value), encrypted: true, updatedById: actor.id },
            update: { value: encryptSecret(value), encrypted: true, updatedById: actor.id },
          });
          changed[key] = { before: beforeSet ? '••••••' : '(unset)', after: '•••••• (updated)' };
        } else if (value === '') {
          // Revert to env/default only if a DB row actually exists.
          if (this.cache.has(key)) {
            await tx.configSetting.delete({ where: { key } });
            changed[key] = { before: this.decoded(key) ?? '', after: '(reverted to environment)' };
          }
        } else {
          const before = this.decoded(key) ?? '';
          if (before === value) continue; // no-op
          await tx.configSetting.upsert({
            where: { key },
            create: { key, value, encrypted: false, updatedById: actor.id },
            update: { value, encrypted: false, updatedById: actor.id },
          });
          changed[key] = { before: before || '(unset)', after: value };
        }
      }

      if (!Object.keys(changed).length) {
        throw new BadRequestException('Nothing was changed');
      }

      await this.audit.log(
        {
          actorId: actor.id,
          action: 'CONFIG_UPDATED',
          detail: `System configuration updated: ${Object.keys(changed).join(', ')}`,
          payload: { changed } as Prisma.InputJsonValue,
        },
        tx,
      );
    });

    await this.reload();
    this._version += 1;
    return this.state();
  }
}
