import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One scheduled line of a payment plan. */
export class InstallmentLineDto {
  /** Free text — "Deposit", "On signing", "30 days after show". Optional. */
  @IsOptional() @IsString() @MaxLength(80)
  label?: string;

  @IsDateString()
  dueDate: string;

  // Strictly positive. A refund or correction is a payment, not an instalment;
  // it goes on the ledger through POST :id/payments like every other reversal.
  @IsNumber() @IsPositive() @Max(100_000_000) @Type(() => Number)
  amount: number;

  @IsOptional() @IsString() @MaxLength(60)
  method?: string;
}

/**
 * Replace a submission's payment plan. This is a PUT, not a POST: the client
 * sends the schedule it wants to exist, and the server reconciles. Instalments
 * already marked paid are not sent and cannot be changed — the server keeps them
 * and expects the lines here to cover only what is still outstanding.
 */
export class SetPlanDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => InstallmentLineDto)
  installments: InstallmentLineDto[];
}

/**
 * Marking an instalment done. Every field is optional: the amount is the
 * instalment's own (that is what "done" means) and the rest fall back to the
 * plan and the sale. The person marking it can still override the date and
 * method — money often lands on a different day, by a different route, than the
 * schedule assumed.
 */
export class MarkInstallmentDto {
  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  method?: string;

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;
}
