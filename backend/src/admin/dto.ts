import { Currency, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
  ValidateIf,
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

/**
 * Every field optional: the modal PATCHes what the admin actually touched, and
 * the service diffs against the row so the audit entry records the change and
 * not the form. The code and the expiry are deliberately absent — the code is
 * already in someone's inbox, and the expiry is what `revoke` is for.
 *
 * `email: null` is meaningful and distinct from omitting it: it clears the
 * address, turning an addressed invitation back into an open code.
 */
export class UpdateInvitationDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  department?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEmail()
  email?: string | null;
}

/** Corrections an admin makes while reviewing a signup, before approving it. */
export class UpdatePendingUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  department?: string | null;
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

/**
 * A price on a package being created carries its own currency, which is not
 * always the city's: VFW sells Vancouver in USD, and the Emerging Designer
 * package sells the same city in CAD. The city cannot be asked.
 */
export class CreatePackagePriceDto {
  @IsString()
  cityId: string;

  @IsEnum(Currency)
  currency: Currency;

  @IsString()
  price: string;
}

/**
 * The id is absent on purpose — the service derives it from brand and name
 * (VFW + "Bronze Package" -> VFW-BRONZE), the way the seed spells them, because
 * these ids are read by people in exports and audit payloads.
 *
 * At least one city price is required: a package with no price would show up on
 * the new-submission form and then fail to price, which is worse than not
 * existing.
 */
export class CreatePackageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  brand: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsInt()
  @Min(1)
  @Max(200)
  looks: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  blurb?: string;

  @IsString()
  taxCode: string;

  @IsString()
  glCode: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePackagePriceDto)
  prices: CreatePackagePriceDto[];
}

export class CreateAddonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  brand: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsString()
  price: string;

  @IsEnum(Currency)
  currency: Currency;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** Which brands may buy it — an add-on is not always sold only by its own. */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  forBrands: string[];

  @IsString()
  glCode: string;
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
