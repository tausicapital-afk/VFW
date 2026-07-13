import { Currency, DiscountType, PayStatus } from '@prisma/client';
import { PricingService, type PricingInput } from './pricing.service';

/**
 * These lock the PricingService behaviour the Phase 1 money loop now depends on:
 * payments feeding paidAmount / balance / payStatus, reversing entries, and the
 * invariant that commission is struck on NET revenue and never moves with tax.
 *
 * (The full engine matrix — discounts, sponsored packages, mixed currency — is
 * Phase 1.5's job; this covers what the new payment and re-price endpoints rely
 * on.)
 */
describe('PricingService', () => {
  const svc = new PricingService();

  // 10,000 net; 10% tax => 1,000 tax, 11,000 total; 10% commission => 1,000.
  const base: PricingInput = {
    packagePrice: 10000,
    addons: [],
    discountType: DiscountType.PCT,
    discountValue: 0,
    taxRate: 10,
    commissionPct: 10,
  };

  describe('payments drive paidAmount / balance / payStatus', () => {
    it('is UNPAID with no deposit and no payments', () => {
      const r = svc.compute(base);
      expect(r.total.toFixed(2)).toBe('11000.00');
      expect(r.paidAmount.toFixed(2)).toBe('0.00');
      expect(r.balance.toFixed(2)).toBe('11000.00');
      expect(r.payStatus).toBe(PayStatus.UNPAID);
    });

    it('is PARTIAL once a deposit is taken', () => {
      const r = svc.compute({ ...base, deposit: 3000 });
      expect(r.paidAmount.toFixed(2)).toBe('3000.00');
      expect(r.balance.toFixed(2)).toBe('8000.00');
      expect(r.payStatus).toBe(PayStatus.PARTIAL);
    });

    it('is PARTIAL after a payment that does not clear the balance', () => {
      const r = svc.compute({ ...base, deposit: 3000, payments: [2000] });
      expect(r.paidAmount.toFixed(2)).toBe('5000.00');
      expect(r.balance.toFixed(2)).toBe('6000.00');
      expect(r.payStatus).toBe(PayStatus.PARTIAL);
    });

    it('is PAID once deposit + payments cover the total', () => {
      const r = svc.compute({ ...base, deposit: 3000, payments: [8000] });
      expect(r.paidAmount.toFixed(2)).toBe('11000.00');
      expect(r.balance.toFixed(2)).toBe('0.00');
      expect(r.payStatus).toBe(PayStatus.PAID);
    });

    it('is PAID (and shows a credit balance) when overpaid', () => {
      const r = svc.compute({ ...base, payments: [12000] });
      expect(r.paidAmount.toFixed(2)).toBe('12000.00');
      expect(r.balance.toFixed(2)).toBe('-1000.00');
      expect(r.payStatus).toBe(PayStatus.PAID);
    });

    it('a reversing (negative) entry backs a payment out — the ledger is never deleted from', () => {
      const r = svc.compute({ ...base, payments: [11000, -11000] });
      expect(r.paidAmount.toFixed(2)).toBe('0.00');
      expect(r.balance.toFixed(2)).toBe('11000.00');
      expect(r.payStatus).toBe(PayStatus.UNPAID);
    });
  });

  describe('re-pricing on a tax-profile change', () => {
    it('moves tax, total and balance but never the taxable base', () => {
      const before = svc.compute({ ...base, deposit: 5000 });
      const after = svc.compute({ ...base, deposit: 5000, taxRate: 20 });

      expect(before.taxAmount.toFixed(2)).toBe('1000.00');
      expect(before.total.toFixed(2)).toBe('11000.00');
      expect(before.balance.toFixed(2)).toBe('6000.00');

      expect(after.taxAmount.toFixed(2)).toBe('2000.00');
      expect(after.total.toFixed(2)).toBe('12000.00');
      expect(after.balance.toFixed(2)).toBe('7000.00');

      // The net revenue the company recognises does not depend on the tax rate.
      expect(after.taxable.toFixed(2)).toBe(before.taxable.toFixed(2));
      expect(after.taxable.toFixed(2)).toBe('10000.00');
    });

    it('leaves commission struck on net revenue — it never moves with tax', () => {
      const lowTax = svc.compute({ ...base, taxRate: 5 });
      const highTax = svc.compute({ ...base, taxRate: 25 });
      expect(lowTax.commissionAmount.toFixed(2)).toBe('1000.00');
      expect(highTax.commissionAmount.toFixed(2)).toBe('1000.00');
      // ...and not on the tax-inclusive total.
      expect(highTax.commissionAmount.toFixed(2)).not.toBe(
        highTax.total.times(0.1).toFixed(2),
      );
    });
  });

  it('serialises a currency-bearing add-on line onto the priced result', () => {
    const r = svc.compute({
      ...base,
      addons: [{ addonId: 'a1', qty: 2, unitPrice: 500, currency: Currency.USD }],
    });
    expect(r.addonTotal.toFixed(2)).toBe('1000.00');
    expect(r.subtotal.toFixed(2)).toBe('11000.00');
    expect(r.lines[0].amount.toFixed(2)).toBe('1000.00');
  });
});
