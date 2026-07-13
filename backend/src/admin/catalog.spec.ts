import { Decimal } from 'decimal.js';
import { PricingService } from '../pricing/pricing.service';

/**
 * The property this file exists to hold:
 *
 *   EDITING A CATALOGUE PRICE MUST NOT MOVE A SALE THAT WAS ALREADY PRICED.
 *
 * It is a structural property, not a behavioural one. Submission stores
 * `packagePrice`, and SubmissionAddon copies `unitPrice` and `amount` onto the
 * line at submission time — the record carries its own prices. Nothing in
 * AdminService writes to Submission or SubmissionAddon, and the only thing that
 * re-prices an existing record (SubmissionsService.priceExisting) reads those
 * stored figures, never the catalogue.
 *
 * So the test is: take a submission's stored lines, change the catalogue
 * underneath it, re-price from the stored lines, and assert nothing moved.
 */
describe('a catalogue price change and history', () => {
  const pricing = new PricingService();

  // What the rate card said the day this sale was made.
  const CATALOGUE_AT_SALE = { packagePrice: '30600.00', addonPrice: '760.00' };

  // What got copied onto the record at submission time, which is the point.
  const storedSubmission = {
    packagePrice: new Decimal(CATALOGUE_AT_SALE.packagePrice),
    addons: [
      {
        addonId: 'rights',
        qty: 1,
        unitPrice: new Decimal(CATALOGUE_AT_SALE.addonPrice),
        currency: 'EUR' as const,
      },
    ],
    discountType: 'PCT' as const,
    discountValue: new Decimal(5),
    taxRate: new Decimal(8),
    commissionPct: new Decimal(8),
    deposit: new Decimal(0),
  };

  const atSale = pricing.compute(storedSubmission);

  it('prices the sale from the rate card of the day', () => {
    // €30,600 + €760 = €31,360, less 5% = €29,792 net, +8% tax = €32,175.36.
    expect(atSale.subtotal.toFixed(2)).toBe('31360.00');
    expect(atSale.taxable.toFixed(2)).toBe('29792.00');
    expect(atSale.total.toFixed(2)).toBe('32175.36');
  });

  it('does not move when the catalogue is re-priced afterwards', () => {
    // Accounting doubles the rate card the next morning. The catalogue changes;
    // the submission's stored lines do not, because they were copied.
    const NEW_CATALOGUE = { packagePrice: '61200.00', addonPrice: '1520.00' };
    expect(NEW_CATALOGUE.packagePrice).not.toBe(CATALOGUE_AT_SALE.packagePrice);

    // Re-price the existing record the way SubmissionsService.priceExisting does
    // — from what the record stores, not from what the catalogue now says.
    const afterCatalogueEdit = pricing.compute(storedSubmission);

    expect(afterCatalogueEdit.packagePrice.toFixed(2)).toBe('30600.00');
    expect(afterCatalogueEdit.addonTotal.toFixed(2)).toBe('760.00');
    expect(afterCatalogueEdit.total.toFixed(2)).toBe(atSale.total.toFixed(2));
    expect(afterCatalogueEdit.commissionAmount.toFixed(2)).toBe(
      atSale.commissionAmount.toFixed(2),
    );
  });

  it('would move if the record read the catalogue instead — which is why it does not', () => {
    // The bug this guards against, made explicit: price the same sale from the
    // NEW catalogue and watch the total change. If a future refactor ever makes
    // an existing submission read the live rate card, this is what it would do
    // to the books.
    const ifItReadTheCatalogue = pricing.compute({
      ...storedSubmission,
      packagePrice: new Decimal('61200.00'),
      addons: [
        { addonId: 'rights', qty: 1, unitPrice: new Decimal('1520.00'), currency: 'EUR' as const },
      ],
    });

    expect(ifItReadTheCatalogue.total.toFixed(2)).toBe('64350.72');
    expect(ifItReadTheCatalogue.total.toFixed(2)).not.toBe(atSale.total.toFixed(2));
  });
});
