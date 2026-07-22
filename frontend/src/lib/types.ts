export type Role = 'SALES' | 'INTERN' | 'ACCT' | 'MGR' | 'ADMIN';
export type SubmissionStatus =
  | 'DRAFT' | 'PENDING' | 'RETURNED' | 'APPROVED' | 'REJECTED' | 'EXPORTED' | 'VOIDED';
export type PayStatus = 'UNPAID' | 'PARTIAL' | 'PAID';
export type Currency = 'USD' | 'CAD' | 'GBP' | 'EUR' | 'JPY';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  department?: string | null;
  colour?: string;
}

/**
 * Money arrives as a string, not a number — the API serializes Decimal that way
 * on purpose so a total cannot lose a cent to a float on the way here. Format
 * it for display; never do arithmetic on it.
 */
export type Money = string;

export interface City { id: string; name: string; country: string; currency: Currency }
export interface EventRow {
  id: string; brand: string; name: string; season: string;
  venue: string | null; start: string; end: string; cityId: string; city: City;
}
export interface PackagePrice { cityId: string; currency: Currency; price: Money }
export interface PackageRow {
  id: string; brand: string; name: string; looks: number; blurb: string | null;
  taxCode: string; glCode: string; prices: PackagePrice[];
}
export interface AddonRow {
  id: string; brand: string; name: string; price: Money;
  currency: Currency; note: string | null; forBrands: string[]; glCode: string;
}
export interface TaxProfile { code: string; label: string; rate: Money; note: string | null }
export interface GlAccount { code: string; name: string }

export interface Catalog {
  events: EventRow[];
  packages: PackageRow[];
  addons: AddonRow[];
  taxes: TaxProfile[];
  glAccounts: GlAccount[];
  cities: City[];
}

export interface Contact {
  id: string; brand: string; designer: string;
  company: string | null; email: string | null;
  phone?: string | null; country: string | null;
  type?: string;
}

/** A single line of a contact's submission history, flattened by the API. */
export interface ContactSubmission {
  id: string; ref: string; event: string; brand: string;
  package: string; total: Money; currency: Currency;
  status: SubmissionStatus; createdAt: string;
}

export interface ContactDetail {
  contact: Contact;
  // Lifetime value is per-currency — currencies are never summed together.
  lifetimeValue: Record<string, Money>;
  submissions: ContactSubmission[];
}

export type DocumentType = 'contract' | 'po' | 'receipt' | 'other';

/** A file attached to a submission. The bytes live in R2; this is the pointer. */
export interface SubmissionDocument {
  id: string;
  type: DocumentType;
  filename: string;
  contentType: string | null;
  size: number | null;
  uploadedAt: string;
  uploadedBy: { id: string; name: string } | null;
}

export type DiscountType = 'PCT' | 'AMT';

export interface Payment {
  id: string;
  date: string;
  amount: Money;
  currency: Currency;
  method: string;
  reference: string | null;
  createdAt: string;
}

export type InstallmentStatus = 'PENDING' | 'PAID';

/**
 * One line of a payment plan. A plan is just the ordered set of these on a
 * submission — there is no separate plan object to fetch.
 *
 * Note there is no "paid amount" here: marking one done posts a real Payment
 * for `amount`, so the sale's paidAmount/balance are the only figures that ever
 * say how much has been received.
 */
export interface Installment {
  id: string;
  seq: number;
  label: string | null;
  dueDate: string;
  amount: Money;
  currency: Currency;
  method: string | null;
  status: InstallmentStatus;
  paidAt: string | null;
  paidBy: { id: string; name: string } | null;
  paymentId: string | null;
}

export interface Submission {
  id: string;
  ref: string;
  status: SubmissionStatus;
  currency: Currency;
  packagePrice: Money;
  addonTotal: Money;
  subtotal: Money;
  discountType: DiscountType;
  discountValue: Money;
  discountAmount: Money;
  taxable: Money;
  taxCode: string;
  taxRate: Money;
  taxAmount: Money;
  total: Money;
  deposit: Money;
  paidAmount: Money;
  balance: Money;
  payStatus: PayStatus;
  commissionPct: Money;
  commissionAmount: Money;
  notes: string | null;
  showDate: string | null;
  paymentMethod: string | null;
  glCode: string | null;
  costCentre: string | null;
  department: string | null;
  invoiceNo: string | null;
  qbDocNumber: string | null;
  voidedFrom: SubmissionStatus | null;
  voidedAt: string | null;
  rejectReason: string | null;
  returnNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  exportedAt: string | null;
  rep: { id: string; name: string; colour: string; role?: Role };
  contact: Contact;
  event: EventRow;
  package: PackageRow;
  addons: { addonId: string; qty: number; amount: Money; addon: AddonRow }[];
  payments: Payment[];
  installments: Installment[];
  tax: TaxProfile;
}

export interface AuditEntry {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
  actor: { id: string; name: string; role: Role } | null;
}

// --- Emails: the sent/received log (backend/src/emails) -----------------------

export type EmailDirection = 'OUTBOUND' | 'INBOUND';
export type EmailStatus = 'SENT' | 'FAILED' | 'RECEIVED';
export type EmailKind =
  | 'OTP' | 'WELCOME' | 'PASSWORD_RESET' | 'PASSWORD_CHANGED'
  | 'INVITATION' | 'INVOICE' | 'TEST' | 'INBOUND' | 'OTHER';

/** A row in the Emails list — the summary shape, without the full body. */
export interface EmailRow {
  id: string;
  direction: EmailDirection;
  status: EmailStatus;
  kind: EmailKind;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string;
  /** A safe snippet — shown even when the body itself is withheld. */
  preview: string | null;
  provider: string | null;
  error: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  triggeredBy: { id: string; name: string } | null;
  submission: { id: string; ref: string; invoiceNo: string | null } | null;
}

/** The detail shape — the row plus the stored body (null when redacted). */
export interface EmailDetail extends EmailRow {
  bodyText: string | null;
  bodyHtml: string | null;
}

/** The result of POST /api/emails/invoice. */
export interface SendInvoiceResult {
  ok: boolean;
  invoiceNo: string;
  to: string;
}

// --- Insight: reports, leaderboard, audit trail ------------------------------

/**
 * A report arrives as columns and rows, already aggregated and already converted
 * to CAD by the server. The client renders it and never sums it — consolidating
 * five currencies is the server's job, and doing it here would put money
 * arithmetic back in a float.
 */
export interface ReportCol {
  label: string;
  num?: boolean;
  /** A money column — always rendered to 2dp, cents included. */
  money?: boolean;
}
export type ReportCell = string | number | null;
export interface ReportTable {
  key: string;
  name: string;
  cols: ReportCol[];
  rows: ReportCell[][];
}
export interface ReportType {
  key: string;
  name: string;
}

export interface ScoreWeights {
  revenue: number;
  approved: number;
  collection: number;
  retention: number;
}

export interface LeaderboardRep {
  id: string;
  name: string;
  employeeId: string | null;
  colour: string;
  rank: number;
  count: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  decidedCount: number;
  revenue: Money;
  invoiced: Money;
  collected: Money;
  outstanding: Money;
  commission: Money;
  commissionPending: Money;
  customerCount: number;
  repeatCount: number;
  target: Money;
  targetPct: number;
  /** Each part is a ratio in [0, 1] — revenue, approved, collection, retention. */
  parts: ScoreWeights;
  score: number;
  rating: { stars: number; label: string; cls: string };
}

export interface Leaderboard {
  weights: ScoreWeights;
  reps: LeaderboardRep[];
}

export interface AuditRow extends AuditEntry {
  submission: { id: string; ref: string; contact: { brand: string } } | null;
}

export interface AuditPage {
  total: number;
  limit: number;
  offset: number;
  entries: AuditRow[];
}

// --- Logs: user-activity telemetry (admin only) ------------------------------

export type ActivityAction =
  | 'LOGIN' | 'LOGOUT' | 'CONNECT' | 'DISCONNECT' | 'MODULE_VIEW' | 'MESSAGE_SENT'
  | string;

/** One user's row on the overview tab: identity + derived activity. */
export interface ActivityUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  colour: string;
  department: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  neverLoggedIn: boolean;
  eventCount: number;
  messageCount: number;
  lastActivityAt: string | null;
  sessionCount: number;
  totalActiveSec: number;
}

export interface ActivityLogRow {
  id: string;
  action: ActivityAction;
  detail: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; role: Role; colour: string } | null;
}

export interface ActivityPage {
  total: number;
  limit: number;
  offset: number;
  entries: ActivityLogRow[];
}

export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  ip: string | null;
  user: { id: string; name: string; role: Role; colour: string } | null;
}

export interface SessionPage {
  total: number;
  limit: number;
  offset: number;
  sessions: SessionRow[];
}

// --- People: administration, feedback, internal comments ---------------------

export type UserStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DISABLED';
export type InvitationStatus = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';

export interface AdminUser extends User {
  phone: string | null;
  status: UserStatus;
  employeeId: string | null;
  commissionPct: Money;
  target: Money;
  createdAt: string;
}

export interface Invitation {
  id: string;
  code: string;
  role: Role;
  department: string | null;
  email: string | null;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdBy: string;
  /** Only on the create response: whether the invite actually got mailed. */
  emailed?: boolean;
  emailError?: string | null;
}

export interface Settings {
  company: string;
  fiscalYear: number;
  invoicePrefix: string;
  nextInvoiceSeq: number;
  gfcInvoicePrefix: string;
  nextGfcInvoiceSeq: number;
  discountApprovalPct: Money;
  qbRealmId: string | null;
  fxRates: Record<string, number>;
  scoreWeights: ScoreWeights;
}

/** The rate card as the admin screen edits it: prices carry their own id and city. */
export interface AdminPackagePrice extends PackagePrice {
  id: string;
  city: City;
}
export interface AdminPackage {
  id: string; brand: string; name: string; looks: number; blurb: string | null;
  taxCode: string; glCode: string;
  prices: AdminPackagePrice[];
}
export interface AdminTaxProfile extends TaxProfile {
  gst: Money; pst: Money; hst: Money;
}

export interface AdminCatalogue {
  packages: AdminPackage[];
  addons: AddonRow[];
  taxes: AdminTaxProfile[];
  glAccounts: GlAccount[];
  cities: City[];
  events: EventRow[];
}

export interface DesignerFeedback {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  contact: { id: string; brand: string; designer: string };
  recordedBy: { id: string; name: string };
}

/**
 * Confidential. Served only from /api/internal-comments and
 * /api/submissions/:id/comments, both guarded with 'internal.view' — never as
 * part of a submission payload. See backend/src/internal/internal.controller.ts.
 */
export interface InternalComment {
  id: string;
  department: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string; role: Role };
  submission: {
    id: string;
    ref: string;
    repId: string;
    rep: { id: string; name: string };
    contact: { brand: string };
  };
}

// ---------------------------------------------------------------------------
// System configuration (Administration → Configuration)
//
// Data-driven: the backend registry describes the fields, and the UI renders
// from it. A secret's plaintext is never sent here — only whether it is set.
// See backend/src/config/config.registry.ts.
// ---------------------------------------------------------------------------
export type ConfigSource = 'db' | 'env' | 'default';
export type ConfigFieldType = 'text' | 'number' | 'email' | 'color' | 'secret' | 'select';

export interface ConfigFieldState {
  key: string;
  source: ConfigSource;
  value?: string; // non-secret effective value; absent for secrets
  isSet: boolean;
  hasEnv: boolean;
  decryptError?: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  help?: string;
  placeholder?: string;
  options?: string[];
  required?: boolean;
  state: ConfigFieldState;
}

export interface ConfigGroup {
  id: 'email' | 'storage';
  title: string;
  blurb: string;
  /** null when the group requires nothing — draw no status pill. */
  configured: boolean | null;
  fields: ConfigField[];
}

export interface EnvPanelRow {
  key: string;
  label: string;
  secret: boolean;
  help: string;
  isSet: boolean;
  value?: string;
}

export interface ConfigState {
  groups: ConfigGroup[];
  env: EnvPanelRow[];
}

export interface ConfigTestResult {
  ok: boolean;
  error?: string;
  sentTo?: string;
}

// ---------------------------------------------------------------------------
// Mail accounts — the SMTP mailboxes the app can send from. Exactly one is
// active; switching is one click. The password is never sent here, in either
// direction, except when the admin is setting a new one.
// See backend/src/config/mail-account.service.ts.
// ---------------------------------------------------------------------------
export interface MailAccount {
  id: string;
  /** smtp = a mailbox dialled directly; resend = an HTTP API over 443. */
  provider: string;
  label: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  fromAddress: string;
  fromName?: string;
  isActive: boolean;
  /** Stored secret can no longer be decrypted — it must be re-entered. */
  decryptError?: boolean;
  updatedAt: string;
}

export interface MailStatus {
  /** account = a row is sending; legacy = the old MAIL_* settings are; none = nothing can. */
  source: 'account' | 'legacy' | 'none';
  legacyReady: boolean;
}

export interface MailAccountsState {
  accounts: MailAccount[];
  status: MailStatus;
}

/**
 * The editable shape. `password` blank on an edit means "keep the stored one" —
 * except when the provider changes, where the server demands the new credential
 * rather than carrying an SMTP password over as an API key.
 */
export interface MailAccountInput {
  label: string;
  provider: string;
  host: string;
  port: number;
  encryption: string;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}
