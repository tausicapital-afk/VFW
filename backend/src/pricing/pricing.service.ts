import { Injectable } from '@nestjs/common';
import { Currency, DiscountType, PayStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';

/**
 * The single pricing engine, ported from calc() in vfw-console.html (line 1069).
 * Every figure the system reports comes from here. No controller, no view and
 * no client is allowed to do its own arithmetic.
 *
 * The mockup's version ran on JS numbers; this one runs on Decimal, so
 * 0.1 + 0.2 is 0.3 and a tax line never drifts by a cent.
 */

export interface AddonLine {
  addonId: string;
  qty: number;
  unitPrice: Decimal.Value;
  currency: Currency;
}

export interface PricingInput {
  packagePrice: Decimal.Value;
  addons: AddonLine[];
  discountType: DiscountType;
  discountValue: Decimal.Value;
  taxRate: Decimal.Value;
  commissionPct: Decimal.Value;
  deposit?: Decimal.Value;
  payments?: Decimal.Value[];
}

export interface PricedLine extends AddonLine {
  amount: Decimal;
}

export interface DiscountApproval {
  /** The discount as a percentage of the package price, whatever type it was entered as. */
  discountPct: Decimal;
  /** Settings.discountApprovalPct as it stood when the question was asked. */
  thresholdPct: Decimal;
  exceedsThreshold: boolean;
}

export interface PricingResult {
  packagePrice: Decimal;
  lines: PricedLine[];
  addonTotal: Decimal;
  subtotal: Decimal;
  discountAmount: Decimal;
  discountPct: Decimal;
  taxable: Decimal;
  taxRate: Decimal;
  taxAmount: Decimal;
  total: Decimal;
  paidAmount: Decimal;
  balance: Decimal;
  commissionPct: Decimal;
  commissionAmount: Decimal;
  payStatus: PayStatus;
}

/** Money rounds to 2dp, half-up — the convention an accountant expects. */
const r2 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

@Injectable()
export class PricingService {
  /**
   * Whether a sale's discount is deep enough to need Accounting's explicit
   * sign-off, per Settings.discountApprovalPct.
   *
   * Derived, never stored. The answer is computed from the submission's own
   * money at the moment it is asked, so moving the threshold in Settings changes
   * the verdict on the next approval — a persisted flag would still be carrying
   * the answer to the old threshold, and would need a backfill to correct.
   *
   * The comparison is on the discount's share of the package price (the base a
   * discount now applies to — never the add-ons), not on `discountValue`, so an
   * AMT discount is measured against the same threshold a PCT one is: 9,000 off
   * a 10,000 package is a 90% discount however it was keyed.
   */
  discountApproval(
    packageBase: Decimal.Value,
    discountAmount: Decimal.Value,
    thresholdPct: Decimal.Value,
  ): DiscountApproval {
    const base = new Decimal(packageBase || 0);
    const exact = base.gt(0)
      ? new Decimal(discountAmount || 0).dividedBy(base).times(100)
      : new Decimal(0);
    const threshold = new Decimal(thresholdPct || 0);

    return {
      // Reported to 2dp, because that is what a human reads on the screen and in
      // the audit row...
      discountPct: r2(exact),
      thresholdPct: threshold,
      // ...but compared unrounded. Rounding first would quietly widen the rule:
      // 15.004% off would round to 15.00% and slide under a 15% threshold, which
      // is not what "exceeds the threshold" means.
      exceedsThreshold: exact.gt(threshold),
    };
  }

  compute(input: PricingInput): PricingResult {
    const packagePrice = r2(input.packagePrice);

    const lines: PricedLine[] = input.addons.map((l) => ({
      ...l,
      amount: r2(new Decimal(l.unitPrice).times(l.qty || 1)),
    }));
    const addonTotal = r2(lines.reduce((t, l) => t.plus(l.amount), new Decimal(0)));

    const subtotal = r2(packagePrice.plus(addonTotal));

    // A discount is struck against the PACKAGE PRICE only, never the add-ons.
    // A percentage is taken off the package; a fixed (AMT) amount is the
    // accountant's explicit figure. This is what keeps an add-on line at full
    // price no matter how the package is discounted.
    const discountAmount =
      input.discountType === DiscountType.PCT
        ? r2(packagePrice.times(new Decimal(input.discountValue || 0)).dividedBy(100))
        : r2(input.discountValue || 0);

    // The discount reduces the PACKAGE only, so however it was keyed its *effect*
    // is capped at the package price — a fixed amount larger than the package can
    // never spill over and discount an add-on line. (A PCT discount is already
    // ≤ package since the percentage is taken off the package.) The full figure
    // the rep entered is still recorded in `discountAmount`.
    const appliedDiscount = Decimal.min(discountAmount, packagePrice);

    // A discount can never push a sale negative.
    const taxable = r2(Decimal.max(0, subtotal.minus(appliedDiscount)));

    const taxRate = new Decimal(input.taxRate || 0);
    const taxAmount = r2(taxable.times(taxRate).dividedBy(100));
    const total = r2(taxable.plus(taxAmount));

    const paidAmount = r2(
      (input.payments ?? []).reduce<Decimal>(
        (t, p) => t.plus(new Decimal(p)),
        new Decimal(input.deposit || 0),
      ),
    );
    const balance = r2(total.minus(paidAmount));

    // Commission is struck on net revenue, never on the tax the company merely
    // collects on behalf of a government.
    const commissionPct = new Decimal(input.commissionPct || 0);
    const commissionAmount = r2(taxable.times(commissionPct).dividedBy(100));

    let payStatus: PayStatus = PayStatus.UNPAID;
    if (paidAmount.gte(total) && total.gt(0)) payStatus = PayStatus.PAID;
    else if (paidAmount.gt(0)) payStatus = PayStatus.PARTIAL;

    return {
      packagePrice,
      lines,
      addonTotal,
      subtotal,
      discountAmount,
      discountPct: packagePrice.gt(0) ? r2(discountAmount.dividedBy(packagePrice).times(100)) : new Decimal(0),
      taxable,
      taxRate,
      taxAmount,
      total,
      paidAmount,
      balance,
      commissionPct,
      commissionAmount,
      payStatus,
    };
  }
}
