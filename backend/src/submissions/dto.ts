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
