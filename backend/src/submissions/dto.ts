import { Type } from 'class-transformer';
import {
  IsArray,
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
