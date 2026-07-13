import { Currency, DiscountType, PayStatus } from '@prisma/client';
import { PricingService, type PricingInput } from './pricing.service';

/**
 * PricingService is a direct port of calc() in vfw-console.html (line 1069),
 * which is the oracle these tests check against. Every figure the company
 * reports comes out of here, so the assertions are on exact Decimal strings —
 * never floats.
 */
describe('PricingService', () => {
  const svc = new PricingService();

  // 10,000 net; 5% tax => 500 tax, 10,500 total; 10% commission => 1,000.
  const base: PricingInput = {
    packagePrice: 10000,
    addons: [],
    discountType: DiscountType.PCT,
    discountValue: 0,
    taxRate: 5,
    commissionPct: 10,
  };

  describe('discounts', () => {
    it('applies a percentage discount off the subtotal', () => {
      const r = svc.compute({ ...base, discountType: DiscountType.PCT, discountValue: 15 });
      expect(r.subtotal.toFixed(2)).toBe('10000.00');
      expect(r.discountAmount.toFixed(2)).toBe('1500.00');
      expect(r.taxable.toFixed(2)).toBe('8500.00');
      expect(r.taxAmount.toFixed(2)).toBe('425.00');
      expect(r.total.toFixed(2)).toBe('8925.00');
    });

    it('applies a fixed (AMT) discount as an absolute amount', () => {
      const r = svc.compute({ ...base, discountType: DiscountType.AMT, discountValue: 2500 });
      expect(r.discountAmount.toFixed(2)).toBe('2500.00');
      expect(r.taxable.toFixed(2)).toBe('7500.00');
      expect(r.total.toFixed(2)).toBe('7875.00');
    });

    it('clamps a discount that would push the sale negative to zero — it never inverts', () => {
      const r = svc.compute({ ...base, discountType: DiscountType.AMT, discountValue: 15000 });
      // The recorded discount is what was entered, but the sale floors at zero.
      expect(r.discountAmount.toFixed(2)).toBe('15000.00');
      expect(r.taxable.toFixed(2)).toBe('0.00');
      expect(r.taxAmount.toFixed(2)).toBe('0.00');
      expect(r.total.toFixed(2)).toBe('0.00');
      expect(r.total.isNegative()).toBe(false);
      expect(r.taxable.isNegative()).toBe(false);
    });
  });

  describe('tax', () => {
    it('charges no tax on a zero-rated / exempt profile', () => {
      const r = svc.compute({ ...base, taxRate: 0 });
      expect(r.taxAmount.toFixed(2)).toBe('0.00');
      expect(r.total.toFixed(2)).toBe('10000.00');
      // Commission is still struck on the net revenue.
      expect(r.commissionAmount.toFixed(2)).toBe('1000.00');
    });

    it('rounds tax half-up to two places', () => {
      // 12,345.67 * 8% = 987.6536 -> 987.65
      const r = svc.compute({ ...base, packagePrice: 12345.67, taxRate: 8, commissionPct: 0 });
      expect(r.taxable.toFixed(2)).toBe('12345.67');
      expect(r.taxAmount.toFixed(2)).toBe('987.65');
      expect(r.total.toFixed(2)).toBe('13333.32');
    });
  });

  describe('sponsored package', () => {
    it('prices on the nominal fee only — the forgone list value never enters the sale', () => {
      // The sponsored package bills a $600 fee; its $7,700 listValue lives on the
      // Package (for reporting) and is deliberately NOT a pricing input, so it
      // can never inflate the invoice, the tax or the commission.
      const r = svc.compute({ packagePrice: 600, addons: [], discountType: DiscountType.PCT, discountValue: 0, taxRate: 5, commissionPct: 8 });
      expect(r.subtotal.toFixed(2)).toBe('600.00');
      expect(r.taxable.toFixed(2)).toBe('600.00');
      expect(r.taxAmount.toFixed(2)).toBe('30.00');
      expect(r.total.toFixed(2)).toBe('630.00');
      expect(r.commissionAmount.toFixed(2)).toBe('48.00');
    });
  });

  describe('add-on lines', () => {
    it('extends qty x unit price onto each line and into the subtotal', () => {
      const r = svc.compute({
        ...base,
        addons: [{ addonId: 'a1', qty: 2, unitPrice: 500, currency: Currency.USD }],
      });
      expect(r.lines[0].amount.toFixed(2)).toBe('1000.00');
      expect(r.addonTotal.toFixed(2)).toBe('1000.00');
      expect(r.subtotal.toFixed(2)).toBe('11000.00');
    });
  });

  describe('payments drive paidAmount / balance / payStatus', () => {
    it('is UNPAID with no deposit and no payments', () => {
      const r = svc.compute(base);
      expect(r.total.toFixed(2)).toBe('10500.00');
      expect(r.paidAmount.toFixed(2)).toBe('0.00');
      expect(r.balance.toFixed(2)).toBe('10500.00');
      expect(r.payStatus).toBe(PayStatus.UNPAID);
    });

    it('is PARTIAL on a deposit that does not clear the total', () => {
      const r = svc.compute({ ...base, deposit: 3000 });
      expect(r.paidAmount.toFixed(2)).toBe('3000.00');
      expect(r.balance.toFixed(2)).toBe('7500.00');
      expect(r.payStatus).toBe(PayStatus.PARTIAL);
    });

    it('is PARTIAL after a part-payment on top of the deposit', () => {
      const r = svc.compute({ ...base, deposit: 3000, payments: [2000] });
      expect(r.paidAmount.toFixed(2)).toBe('5000.00');
      expect(r.balance.toFixed(2)).toBe('5500.00');
      expect(r.payStatus).toBe(PayStatus.PARTIAL);
    });

    it('is PAID once deposit + payments cover the total', () => {
      const r = svc.compute({ ...base, deposit: 3000, payments: [7500] });
      expect(r.paidAmount.toFixed(2)).toBe('10500.00');
      expect(r.balance.toFixed(2)).toBe('0.00');
      expect(r.payStatus).toBe(PayStatus.PAID);
    });

    it('a reversing (negative) entry backs a payment out — the ledger is never deleted from', () => {
      const r = svc.compute({ ...base, payments: [10500, -10500] });
      expect(r.paidAmount.toFixed(2)).toBe('0.00');
      expect(r.balance.toFixed(2)).toBe('10500.00');
      expect(r.payStatus).toBe(PayStatus.UNPAID);
    });
  });

  describe('commission is struck on net revenue, never on tax', () => {
    it('bases commission on taxable, not on the tax-inclusive total', () => {
      const r = svc.compute({ ...base, discountValue: 0, taxRate: 20, commissionPct: 10 });
      // 10,000 net -> 1,000 commission; NOT 12,000 total * 10% = 1,200.
      expect(r.taxable.toFixed(2)).toBe('10000.00');
      expect(r.commissionAmount.toFixed(2)).toBe('1000.00');
      expect(r.commissionAmount.toFixed(2)).not.toBe(r.total.times(0.1).toFixed(2));
    });

    it('does not move when only the tax rate changes', () => {
      const low = svc.compute({ ...base, taxRate: 5 });
      const high = svc.compute({ ...base, taxRate: 25 });
      expect(low.commissionAmount.toFixed(2)).toBe('1000.00');
      expect(high.commissionAmount.toFixed(2)).toBe('1000.00');
      // ...while tax, total and balance all do move.
      expect(high.taxAmount.toFixed(2)).not.toBe(low.taxAmount.toFixed(2));
      expect(high.total.toFixed(2)).not.toBe(low.total.toFixed(2));
    });
  });
});
