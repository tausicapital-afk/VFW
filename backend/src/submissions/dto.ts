import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DiscountType } from '@prisma/client';

/**
 * Note what is absent: no price, no subtotal, no tax, no total. The client
 * sends what was *sold* and the server decides what it *costs*.
 */
export class CreateSubmissionDto {
  // --- customer
  @IsString() @MinLength(1) @MaxLength(120)
  designer: string;

  @IsString() @MinLength(1) @MaxLength(120)
  brand: string;

  @IsOptional() @IsString() @MaxLength(160)
  company?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(80)
  country?: string;

  // --- what they bought
  @IsString()
  eventId: string;

  @IsString()
  packageId: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  addonIds?: string[];

  // --- package customization ------------------------------------------------
  // All optional and all independent: setting only `packagePriceOverride` is a
  // negotiated price on an otherwise-catalogue package; setting the other
  // three renames/rebadges it for this sale; setting all four is a fully
  // ad-hoc package that shares nothing with the catalogue anchor but its tax
  // profile, GL account and currency. Whichever combination is set, the server
  // still runs it through PricingService exactly like a catalogue price — see
  // SubmissionsService.resolveSale.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  packageNameOverride?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(999) @Type(() => Number)
  packageLooksOverride?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  packageBlurbOverride?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) @Type(() => Number)
  packagePriceOverride?: number;

  @IsOptional() @IsDateString()
  showDate?: string;

  // --- terms
  @IsOptional() @IsEnum(DiscountType)
  discountType?: DiscountType;

  // Bound loosely here because the meaning depends on discountType; the
  // percentage-specific ceiling is enforced in SubmissionsService.
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) @Type(() => Number)
  discountValue?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  deposit?: number;

  @IsOptional() @IsString() @MaxLength(60)
  paymentMethod?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  notes?: string;
}

export class ApproveDto {
  @IsOptional() @IsString()
  glAccount?: string;

  @IsOptional() @IsString()
  costCentre?: string;

  /**
   * Sign-off that this sale's discount exceeds Settings.discountApprovalPct.
   * Named and explicit, like everything else on this API: an approver has to say
   * out loud that they are overriding the threshold, and the audit entry records
   * that they did. Submissions at or under the threshold ignore it entirely.
   */
  @IsOptional() @IsBoolean()
  acknowledgeDiscountOverride?: boolean;

  /**
   * Sign-off that this sale's package was customized or built ad-hoc rather
   * than sold straight off the rate card — the same "say it out loud"
   * mechanism as acknowledgeDiscountOverride, for the same reason: a rep-typed
   * price or description must never reach approval indistinguishably from a
   * catalogue sale.
   */
  @IsOptional() @IsBoolean()
  acknowledgeCustomPackage?: boolean;
}

export class RejectDto {
  @IsString() @MinLength(1) @MaxLength(400)
  reason: string;

  @IsOptional() @IsString() @MaxLength(4000)
  note?: string;
}

export class ReturnDto {
  @IsString() @MinLength(1) @MaxLength(4000)
  note: string;
}

/**
 * Setting an invoice number by hand.
 *
 * The pattern is deliberately loose — letters, digits, dashes, slashes, dots and
 * spaces — because this number is not ours to dictate. It goes on a document a
 * client files, and a business that has billed as `VFW-2041` for a decade, or
 * needs `2026/03/017` to satisfy a foreign tax office, is not doing anything
 * wrong. What is refused is only what would make the number unusable downstream:
 * an empty string, something that will not fit a PDF header, and characters that
 * have no business in a filename, since the invoice is emailed as `<number>.pdf`.
 */
export class InvoiceNoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, {
    message:
      'An invoice number may use letters, digits, spaces, dots, dashes and slashes, and must start with a letter or digit',
  })
  invoiceNo: string;
}

export class VoidDto {
  // Why the sale was voided — optional, but it lands in the audit trail.
  @IsOptional() @IsString() @MaxLength(4000)
  reason?: string;
}

/**
 * Recording a payment. Amount is deliberately unbounded below zero: a payment is
 * never deleted — a mistake is corrected with a negative (reversing) entry, so
 * the ledger stays append-only and auditable.
 */
export class PaymentDto {
  @IsDateString()
  date: string;

  @IsNumber() @Type(() => Number)
  amount: number;

  @IsString() @MinLength(1) @MaxLength(60)
  method: string;

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;
}

/**
 * Accounting reclassification. Note what is still absent: no total, no tax
 * amount. Changing the tax profile re-prices the sale server-side; the client
 * never sends a figure.
 */
export class PatchSubmissionDto {
  @IsOptional() @IsString() @MaxLength(20)
  glAccount?: string;

  @IsOptional() @IsString() @MaxLength(60)
  costCentre?: string;

  @IsOptional() @IsString() @MaxLength(20)
  taxCode?: string;

  @IsOptional() @IsString() @MaxLength(60)
  department?: string;
}

export class ExportDto {
  // "Invoice" or "Sales Receipt" — a QBO document *format*, not a change of
  // record. The server defaults it from pay status when omitted.
  @IsOptional() @IsString() @MaxLength(40)
  docType?: string;
}
