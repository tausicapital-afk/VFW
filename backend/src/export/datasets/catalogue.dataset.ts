import { AdminService } from '../../admin/admin.service';
import { ExportDataset } from '../export.types';

type Catalogue = Awaited<ReturnType<AdminService['catalogue']>>;
type PackageRow = Catalogue['packages'][number];
type AddonRow = Catalogue['addons'][number];
type TaxRow = Catalogue['taxes'][number];

/**
 * The rate card, as the Packages & pricing tab lists it.
 *
 * A package prices differently per city, so the screen stacks those prices inside
 * one cell and this column does the same. It is deliberately not a money column:
 * the values are several, in currencies that may differ, and a spreadsheet must
 * not be invited to sum them. The per-city numbers a reader actually wants to add
 * up live in the submissions export, against real sales.
 */
export function packagesDataset(admin: AdminService): ExportDataset<PackageRow> {
  return {
    key: 'packages',
    title: 'Package rate card',
    filename: 'packages',
    permission: 'admin.manage',
    load: async () => (await admin.catalogue()).packages,
    columns: [
      { header: 'Brand', value: (p) => p.brand, width: 8 },
      { header: 'Package', value: (p) => p.name, width: 24 },
      { header: 'Looks', value: (p) => p.looks, width: 7 },
      {
        header: 'City pricing',
        value: (p) =>
          p.prices.map((pr) => `${pr.city.name} ${pr.currency} ${pr.price}`).join('; '),
        width: 40,
      },
      { header: 'Tax', value: (p) => p.taxCode, width: 8 },
      { header: 'GL', value: (p) => p.glCode, width: 10 },
      // Sponsored packages bill at a nominal fee; listValue is the revenue given
      // up, which is a reporting figure rather than something the rate card shows.
      { header: 'List value', value: (p) => p.listValue, money: true, width: 12, spreadsheetOnly: true },
      { header: 'Cap per event', value: (p) => p.cap, width: 12, spreadsheetOnly: true },
      { header: 'Blurb', value: (p) => p.blurb, width: 40, spreadsheetOnly: true },
    ],
  };
}

/** The add-on catalogue, as its card lists it. One price, so it can be a real number. */
export function addonsDataset(admin: AdminService): ExportDataset<AddonRow> {
  return {
    key: 'addons',
    title: 'Add-on catalogue',
    filename: 'addons',
    permission: 'admin.manage',
    load: async () => (await admin.catalogue()).addons,
    columns: [
      { header: 'Brand', value: (a) => a.brand, width: 8 },
      { header: 'Add-on', value: (a) => a.name, width: 24 },
      { header: 'Price', value: (a) => a.price, money: true, width: 12 },
      { header: 'Currency', value: (a) => a.currency, width: 9 },
      { header: 'GL', value: (a) => a.glCode, width: 10 },
      { header: 'Sold to', value: (a) => a.forBrands.join(', '), width: 16, spreadsheetOnly: true },
      { header: 'Note', value: (a) => a.note, width: 32 },
    ],
  };
}

/**
 * Tax profiles, as the Tax rates tab lists them.
 *
 * The rates are percentages, not money: 13 here means 13%, and formatting it as
 * currency would read as $13.00.
 */
export function taxesDataset(admin: AdminService): ExportDataset<TaxRow> {
  return {
    key: 'taxes',
    title: 'Tax profiles',
    filename: 'tax-rates',
    permission: 'admin.manage',
    load: async () => (await admin.catalogue()).taxes,
    columns: [
      { header: 'Code', value: (t) => t.code, width: 10 },
      { header: 'Label', value: (t) => t.label, width: 24 },
      { header: 'Rate %', value: (t) => t.rate, width: 9 },
      { header: 'GST %', value: (t) => t.gst, width: 9 },
      { header: 'PST %', value: (t) => t.pst, width: 9 },
      { header: 'HST %', value: (t) => t.hst, width: 9 },
      { header: 'Note', value: (t) => t.note, width: 32 },
    ],
  };
}
