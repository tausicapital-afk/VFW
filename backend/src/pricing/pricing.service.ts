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
  compute(input: PricingInput): PricingResult {
    const packagePrice = r2(input.packagePrice);

    const lines: PricedLine[] = input.addons.map((l) => ({
      ...l,
      amount: r2(new Decimal(l.unitPrice).times(l.qty || 1)),
    }));
    const addonTotal = r2(lines.reduce((t, l) => t.plus(l.amount), new Decimal(0)));

    const subtotal = r2(packagePrice.plus(addonTotal));

    const discountAmount =
      input.discountType === DiscountType.PCT
        ? r2(subtotal.times(new Decimal(input.discountValue || 0)).dividedBy(100))
        : r2(input.discountValue || 0);

    // A discount can never push a sale negative.
    const taxable = r2(Decimal.max(0, subtotal.minus(discountAmount)));

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
      discountPct: subtotal.gt(0) ? r2(discountAmount.dividedBy(subtotal).times(100)) : new Decimal(0),
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
