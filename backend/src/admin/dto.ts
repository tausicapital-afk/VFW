import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateInvitationDto {
  @IsEnum(Role)
  role: Role;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  department?: string;

  /** Leave blank for an open code that anyone holding it may redeem. */
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  expiresInDays?: number;
}

export class RejectUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// --- Catalogue -------------------------------------------------------------
//
// Money arrives as a string, not a number: a price that round-trips through a
// JS float has already lost the argument. `IsNumber` would accept 33100.00000001
// and be none the wiser, so these take a decimal string and parse it with
// decimal.js server-side.

export class CityPriceDto {
  @IsString()
  cityId: string;

  @IsString()
  price: string;
}

export class UpdatePackageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  taxCode?: string;

  @IsOptional()
  @IsString()
  glCode?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CityPriceDto)
  prices?: CityPriceDto[];
}

export class UpdateAddonDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  price?: string;

  @IsOptional()
  @IsString()
  glCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class UpdateTaxDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  rate?: string;

  @IsOptional()
  @IsString()
  gst?: string;

  @IsOptional()
  @IsString()
  pst?: string;

  @IsOptional()
  @IsString()
  hst?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class ScoreWeightsDto {
  @IsNumber() @Min(0) @Max(100) revenue: number;
  @IsNumber() @Min(0) @Max(100) approved: number;
  @IsNumber() @Min(0) @Max(100) collection: number;
  @IsNumber() @Min(0) @Max(100) retention: number;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  invoicePrefix?: string;

  @IsOptional()
  @IsString()
  discountApprovalPct?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  qbRealmId?: string;

  /** Rates to CAD, the reporting currency. Keyed by currency code. */
  @IsOptional()
  fxRates?: Record<string, number>;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScoreWeightsDto)
  scoreWeights?: ScoreWeightsDto;
}

// --- People ----------------------------------------------------------------

export class CreateFeedbackDto {
  @IsString()
  contactId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;
}

export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  department: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}
