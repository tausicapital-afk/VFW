import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QboApiService } from './qbo-api.service';
import { QboMappingService } from './qbo-mapping.service';

/**
 * The shape this service needs from a Submission — a subset of
 * SubmissionsService's own DETAIL include. Any query that includes at least
 * this much satisfies it structurally; it does not have to be this exact
 * include.
 */
export type SubmissionForQbo = Prisma.SubmissionGetPayload<{
  include: {
    contact: true;
    event: true;
    package: true;
    addons: { include: { addon: true } };
  };
}>;

export interface QboPostResult {
  qboId: string;
  docNumber: string;
}

/**
 * Turns an approved Submission into a real QuickBooks Invoice or Sales
 * Receipt: resolves (finding or creating) the QBO Customer and line Items,
 * resolves the tax/department refs through QboMappingService, and posts it.
 *
 * Customers and Items are found-or-created automatically — there are too many
 * of them, and new ones appear too often, for an admin to map by hand.
 * Tax codes, GL accounts and departments are the opposite: a small, stable
 * set where getting the mapping wrong means money lands in the wrong QBO
 * account, so those are never guessed — see QboMappingService.resolve.
 */
@Injectable()
export class QboExportService {
  constructor(
    private readonly api: QboApiService,
    private readonly mapping: QboMappingService,
  ) {}

  private async findOrCreateCustomer(contact: { brand: string; company: string | null; email: string | null; phone: string | null }): Promise<string> {
    const displayName = contact.company || contact.brand;
    const existing = await this.api.query<{ Id: string }>('Customer', `DisplayName = '${QboApiService.escape(displayName)}'`);
    if (existing[0]) return existing[0].Id;
    const created = await this.api.create<{ Id: string }>('Customer', {
      DisplayName: displayName,
      ...(contact.company ? { CompanyName: contact.company } : {}),
      ...(contact.email ? { PrimaryEmailAddr: { Address: contact.email } } : {}),
      ...(contact.phone ? { PrimaryPhone: { FreeFormNumber: contact.phone } } : {}),
    });
    return created.Id;
  }

  private async findOrCreateItem(name: string, glCode: string): Promise<string> {
    const existing = await this.api.query<{ Id: string }>('Item', `Name = '${QboApiService.escape(name)}'`);
    if (existing[0]) return existing[0].Id;
    const incomeAccountId = await this.mapping.resolve('GL', glCode);
    const created = await this.api.create<{ Id: string }>('Item', {
      Name: name,
      Type: 'Service',
      IncomeAccountRef: { value: incomeAccountId },
    });
    return created.Id;
  }

  async postSubmission(s: SubmissionForQbo, docType: string, invoiceNo: string): Promise<QboPostResult> {
    const customerId = await this.findOrCreateCustomer(s.contact);
    const taxCodeId = await this.mapping.resolve('TAX', s.taxCode);
    const departmentId = s.department ? await this.mapping.resolve('DEPARTMENT', s.department) : undefined;

    const packageName = s.packageNameOverride ?? s.package.name;
    const packageLooks = s.packageLooksOverride ?? s.package.looks;
    const packageItemId = await this.findOrCreateItem(packageName, s.package.glCode);

    const lines: Record<string, unknown>[] = [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: Number(s.packagePrice),
        Description: `${packageName} — up to ${packageLooks} looks (${s.event.name})`,
        SalesItemLineDetail: {
          ItemRef: { value: packageItemId },
          Qty: 1,
          UnitPrice: Number(s.packagePrice),
        },
      },
    ];
    for (const line of s.addons) {
      const itemId = await this.findOrCreateItem(line.addon.name, line.addon.glCode);
      lines.push({
        DetailType: 'SalesItemLineDetail',
        Amount: Number(line.amount),
        Description: line.addon.name,
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: line.qty,
          UnitPrice: Number(line.unitPrice),
        },
      });
    }
    if (Number(s.discountAmount) > 0) {
      lines.push({
        DetailType: 'DiscountLineDetail',
        Amount: Number(s.discountAmount),
        DiscountLineDetail: {
          PercentBased: s.discountType === 'PCT',
          ...(s.discountType === 'PCT' ? { DiscountPercent: Number(s.discountValue) } : {}),
        },
      });
    }

    const doc: Record<string, unknown> = {
      DocNumber: invoiceNo,
      TxnDate: new Date().toISOString().slice(0, 10),
      CurrencyRef: { value: s.currency },
      CustomerRef: { value: customerId },
      ...(s.contact.email ? { BillEmail: { Address: s.contact.email } } : {}),
      Line: lines,
      TxnTaxDetail: {
        TxnTaxCodeRef: { value: taxCodeId },
        TotalTax: Number(s.taxAmount),
      },
      ...(departmentId ? { DepartmentRef: { value: departmentId } } : {}),
      PrivateNote: `Ref: ${s.ref}`,
      TotalAmt: Number(s.total),
    };

    const entity = docType === 'Sales Receipt' ? 'SalesReceipt' : 'Invoice';
    const created = await this.api.create<{ Id: string; DocNumber?: string }>(entity, doc);
    return { qboId: created.Id, docNumber: created.DocNumber ?? invoiceNo };
  }
}
