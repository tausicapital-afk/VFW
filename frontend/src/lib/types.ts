export type Role = 'SALES' | 'INTERN' | 'ACCT' | 'MGR' | 'ADMIN';
export type SubmissionStatus =
  | 'DRAFT' | 'PENDING' | 'RETURNED' | 'APPROVED' | 'REJECTED' | 'EXPORTED';
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
  currency: Currency; note: string | null; forBrands: string[];
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
  company: string | null; email: string | null; country: string | null;
}

export interface Submission {
  id: string;
  ref: string;
  status: SubmissionStatus;
  currency: Currency;
  packagePrice: Money;
  addonTotal: Money;
  subtotal: Money;
  discountAmount: Money;
  taxable: Money;
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
  glCode: string | null;
  costCentre: string | null;
  rejectReason: string | null;
  returnNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rep: { id: string; name: string; colour: string };
  contact: Contact;
  event: EventRow;
  package: PackageRow;
  addons: { addonId: string; qty: number; amount: Money; addon: AddonRow }[];
  tax: TaxProfile;
}

export interface AuditEntry {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
  actor: { id: string; name: string; role: Role } | null;
}
