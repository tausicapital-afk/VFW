import type { DiscountType, Money } from './types';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Client-side preview of a discount, mirroring the server's PricingService.
 * A discount applies to the PACKAGE PRICE only — never the add-ons — so a
 * percentage is taken off the package, and a fixed amount is capped at the
 * package so it can never spill into an add-on line. The server recomputes the
 * authoritative figure on save; this only shapes the live-total preview.
 */
export function discountPreview(
  packagePrice: number,
  discountType: DiscountType,
  discountValue: number,
): number {
  const raw =
    discountType === 'AMT'
      ? r2(discountValue || 0)
      : r2(packagePrice * ((discountValue || 0) / 100));
  return Math.max(0, Math.min(raw, packagePrice));
}

/**
 * The discount expressed as a percentage of the package price — used only for
 * the "needs Accounting sign-off" hint, so an AMT figure is judged the same way
 * a PCT one is.
 */
export function discountPctOfPackage(
  packagePrice: number,
  discountType: DiscountType,
  discountValue: number,
): number {
  if (discountType === 'PCT') return discountValue || 0;
  return packagePrice > 0 ? ((discountValue || 0) / packagePrice) * 100 : 0;
}

/**
 * What a submission's package actually shows, with any per-sale overrides
 * applied over the catalogue anchor. Price is deliberately not part of this —
 * `sub.packagePrice` is already the effective, server-computed charge.
 */
export function effectivePackage(sub: {
  package: { name: string; looks: number; blurb: string | null };
  packageNameOverride: string | null;
  packageLooksOverride: number | null;
  packageBlurbOverride: string | null;
}): { name: string; looks: number; blurb: string | null } {
  return {
    name: sub.packageNameOverride ?? sub.package.name,
    looks: sub.packageLooksOverride ?? sub.package.looks,
    blurb: sub.packageBlurbOverride ?? sub.package.blurb,
  };
}

/**
 * Client-side preview of the tax, mirroring the server's PricingService. With
 * an add-on rate, the package (after its discount) and the add-ons are taxed
 * apart and each rounds on its own; without one, everything is taxed together
 * at the package's rate.
 */
export function taxPreview(
  packageNet: number,
  addonTotal: number,
  rate: number,
  addonRate: number | null,
): { packageTax: number; addonTax: number; tax: number } {
  if (addonRate == null) {
    const tax = r2((packageNet + addonTotal) * (rate / 100));
    return { packageTax: tax, addonTax: 0, tax };
  }
  const packageTax = r2(packageNet * (rate / 100));
  const addonTax = r2(addonTotal * (addonRate / 100));
  return { packageTax, addonTax, tax: r2(packageTax + addonTax) };
}

/**
 * The tax lines of a saved sale's totals: one when the add-ons were taxed with
 * the package, two when they carry their own rate.
 */
export function taxLines(sub: {
  taxRate: Money; taxAmount: Money; addonTaxRate: Money | null; addonTaxAmount: Money;
}): { label: string; amount: number }[] {
  if (sub.addonTaxRate == null) {
    return [{ label: `Tax (${Number(sub.taxRate)}%)`, amount: Number(sub.taxAmount) }];
  }
  return [
    {
      label: `Package tax (${Number(sub.taxRate)}%)`,
      amount: r2(Number(sub.taxAmount) - Number(sub.addonTaxAmount)),
    },
    { label: `Add-on tax (${Number(sub.addonTaxRate)}%)`, amount: Number(sub.addonTaxAmount) },
  ];
}
