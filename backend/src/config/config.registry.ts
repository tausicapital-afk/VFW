/**
 * The registry of configurable settings.
 *
 * This is the single source of truth for what the Configuration screen shows,
 * what may be written, and how each field is validated. The admin GET returns it
 * verbatim (plus each field's resolved state), so the frontend renders the form
 * from data rather than hard-coding a copy that would drift.
 *
 * A field's `key` is deliberately the SAME string as the environment variable it
 * shadows, because ConfigService resolves DB -> process.env -> default by that
 * one name. Add a field here and it is editable in the UI and honoured by the
 * resolver; nothing else has to change.
 *
 * WHAT BELONGS HERE: operational settings a business owner should be able to set
 * without a developer, where ONE value per deployment is the right shape —
 * object storage credentials, email appearance, the app's public URL.
 *
 * WHAT MOVED OUT: the SMTP credentials. A mailbox is not one value per
 * deployment — you may hold several and switch sender — so they live in the
 * MailAccount table (see mail-account.service.ts). The MAIL_* keys are still
 * honoured as a fallback while that table is empty, which is why ConfigService
 * still resolves them even though they are no longer listed here.
 *
 * WHAT DELIBERATELY DOES NOT: the bootstrap/infra variables (DATABASE_URL,
 * JWT_SECRET, NODE_ENV, PORT, TRUST_PROXY_HOPS, CORS_ORIGIN, …). They are read
 * once at boot, several are security-critical to get exactly right, and a couple
 * are needed *before* the database is even reachable — so they cannot be stored
 * in it. Those are surfaced read-only through ENV_PANEL below, so an admin can
 * see what is set and know to ask a developer, but cannot foot-gun them.
 */

export type FieldType = 'text' | 'number' | 'email' | 'color' | 'secret' | 'select';

export interface ConfigField {
  key: string;
  label: string;
  type: FieldType;
  /** Shown under the input as guidance for a non-technical admin. */
  help?: string;
  placeholder?: string;
  /** For `select`, the allowed values. */
  options?: string[];
  /** A field that must be present for the group to count as "configured". */
  required?: boolean;
}

export interface ConfigGroup {
  id: 'email' | 'storage' | 'quickbooks' | 'data';
  title: string;
  blurb: string;
  /** Keys that must all resolve to a value for the group to be usable. */
  requiredKeys: string[];
  fields: ConfigField[];
}

export const CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'email',
    title: 'Email appearance & links',
    blurb:
      'How every email looks and where its links point. These apply to all mail accounts — ' +
      'the mailboxes themselves are managed above.',
    // Nothing here is required: each field has a working default, and whether
    // email can be sent at all is a property of the mail accounts, not of this
    // group. An empty list also tells the UI not to draw a configured/not
    // configured pill it would have no honest value for.
    requiredKeys: [],
    fields: [
      {
        key: 'MAIL_FROM_NAME',
        label: 'Default brand name',
        type: 'text',
        placeholder: 'VFW Console',
        help: 'The brand shown at the top of every email, for accounts that do not set their own sender name.',
      },
      {
        key: 'MAIL_BRAND_COLOUR',
        label: 'Brand colour',
        type: 'color',
        placeholder: '#0C7A4D',
        help: 'Accent colour for the email header and buttons.',
      },
      {
        key: 'MAIL_SUPPORT_ADDRESS',
        label: 'Support address',
        type: 'email',
        help: "Shown in the email footer. Defaults to the sending account's from address if left blank.",
      },
      {
        key: 'APP_URL',
        label: 'App web address',
        type: 'text',
        placeholder: 'https://console.yourdomain.com',
        help: 'The public address of this console, so emailed links (reset, invite) point somewhere real.',
      },
    ],
  },
  {
    id: 'storage',
    title: 'Document storage (Cloudflare R2 / S3)',
    blurb:
      'Where uploaded documents (signed contracts, POs, receipts) and chat attachments ' +
      'are stored. Files go straight from the browser to storage; the app only holds the keys. ' +
      'Until this is set, uploads and downloads fail rather than writing to disk.',
    requiredKeys: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'],
    fields: [
      {
        key: 'R2_ACCOUNT_ID',
        label: 'Account ID',
        type: 'text',
        help: 'Your Cloudflare account ID. The endpoint is derived from it — provide this OR the endpoint below.',
      },
      {
        key: 'R2_ENDPOINT',
        label: 'Endpoint (S3 URL)',
        type: 'text',
        placeholder: 'https://<account>.r2.cloudflarestorage.com',
        help: 'The S3-compatible endpoint. Only needed if you are not using the account ID above, or a non-R2 provider.',
      },
      {
        key: 'R2_ACCESS_KEY_ID',
        label: 'Access key ID',
        type: 'text',
        required: true,
        help: 'From the R2 API token you created.',
      },
      {
        key: 'R2_SECRET_ACCESS_KEY',
        label: 'Secret access key',
        type: 'secret',
        required: true,
        help: 'The secret half of the R2 API token. Stored encrypted; leave blank to keep the current one.',
      },
      {
        key: 'R2_BUCKET',
        label: 'Bucket name',
        type: 'text',
        required: true,
        help: 'The bucket documents are stored in.',
      },
    ],
  },
  {
    id: 'quickbooks',
    title: 'QuickBooks Online',
    blurb:
      'The Intuit app credentials that let this console connect to QuickBooks Online. Set these ' +
      'first, then use the Connect button below to authorize a specific QuickBooks company — the ' +
      'credentials here identify the app, not a company connection by themselves.',
    requiredKeys: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'],
    fields: [
      {
        key: 'QBO_ENVIRONMENT',
        label: 'Environment',
        type: 'select',
        options: ['sandbox', 'production'],
        help:
          'Sandbox talks to a test QuickBooks company for trying this out safely; production posts ' +
          'to the real book. Switching this does not move an existing connection — reconnect after ' +
          'changing it.',
      },
      {
        key: 'QBO_CLIENT_ID',
        label: 'Client ID',
        type: 'text',
        required: true,
        help: 'From the app you registered at developer.intuit.com — the sandbox and production keys are different.',
      },
      {
        key: 'QBO_CLIENT_SECRET',
        label: 'Client secret',
        type: 'secret',
        required: true,
        help: 'The secret half of the same app credential. Stored encrypted; leave blank to keep the current one.',
      },
    ],
  },
  {
    id: 'data',
    title: 'Test data',
    blurb:
      'Demo and rehearsal records live in this database alongside the real book. While the ' +
      'switch below is on, everything created is stamped as test data and the console marks ' +
      'those rows wherever they appear. Existing records are not affected — use the backfill ' +
      'below to mark rows that already exist.',
    // Nothing is required: the switch has a working default (off), and a
    // configured/not-configured pill on a setting whose "unset" state is a
    // legitimate answer would be permanently red for no reason.
    requiredKeys: [],
    fields: [
      {
        key: 'TEST_DATA_MODE',
        label: 'Flag new records as test data',
        type: 'select',
        options: ['off', 'on'],
        // A `select` rather than a new boolean field type: the registry, its
        // validator and the admin form already handle selects end to end, and a
        // tenth field type earning its keep on one setting is a poor trade.
        // ConfigService.testDataMode is the one place that reads the string, so
        // nothing else has to know it is spelled "on".
        help:
          'While ON, every submission, contact, payment, timesheet day and email created is ' +
          'marked as test data. Turn it off before entering anything real.',
      },
    ],
  },
];

/** Every writable key, and the subset that are secrets. */
export const ALL_FIELDS: ConfigField[] = CONFIG_GROUPS.flatMap((g) => g.fields);
export const FIELD_BY_KEY = new Map(ALL_FIELDS.map((f) => [f.key, f]));
export const SECRET_KEYS = new Set(ALL_FIELDS.filter((f) => f.type === 'secret').map((f) => f.key));

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/**
 * Read-only view of the bootstrap/infra environment. These are never editable
 * here — they are shown so an admin can confirm what is set and know a developer
 * has to change them. `secret: true` masks the value (present / not set only).
 */
export interface EnvPanelItem {
  key: string;
  label: string;
  secret: boolean;
  help: string;
}

export const ENV_PANEL: EnvPanelItem[] = [
  {
    key: 'DATABASE_URL',
    label: 'Database connection',
    secret: true,
    help: 'The database this console reads and writes. Set by your host; it cannot be stored in the database it points at.',
  },
  {
    key: 'JWT_SECRET',
    label: 'Session signing key',
    secret: true,
    help: 'Signs the login session. Changing it signs everyone out, so it is deliberately not editable here.',
  },
  {
    key: 'NODE_ENV',
    label: 'Environment',
    secret: false,
    help: 'production or development. Determines cookie security; set by your host.',
  },
  {
    key: 'APP_URL',
    label: 'App web address',
    secret: false,
    help: 'Also shown under Email — the public address of this console.',
  },
  {
    key: 'CORS_ORIGIN',
    label: 'Allowed origin',
    secret: false,
    help: 'The web address the browser is allowed to call the API from. Set by your host.',
  },
  {
    key: 'TRUST_PROXY_HOPS',
    label: 'Proxy hops',
    secret: false,
    help: 'How many proxies sit in front of the app. Security-critical for rate limiting; must be measured, not guessed. Ask a developer.',
  },
  {
    key: 'SENTRY_DSN',
    label: 'Error tracking (Sentry)',
    secret: true,
    help: 'Optional error reporting. Read once at start-up, so changing it needs a restart. Ask a developer.',
  },
  {
    key: 'LOG_LEVEL',
    label: 'Log level',
    secret: false,
    help: 'How much the server logs. Read once at start-up; ask a developer to change.',
  },
];
