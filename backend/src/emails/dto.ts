import { Type } from 'class-transformer';
import { EmailDirection, EmailKind } from '@prisma/client';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const DIRECTIONS: EmailDirection[] = ['OUTBOUND', 'INBOUND'];
const KINDS: EmailKind[] = [
  'OTP',
  'WELCOME',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'INVITATION',
  'INVOICE',
  'TEST',
  'INBOUND',
  'OTHER',
];

/** The Emails list filters — a tab (direction) and an optional kind. */
export class EmailsQueryDto {
  @IsOptional() @IsIn(DIRECTIONS)
  direction?: EmailDirection;

  @IsOptional() @IsIn(KINDS)
  kind?: EmailKind;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

/** Send an already-invoiced submission's PDF to a recipient the user confirms. */
export class SendInvoiceDto {
  @IsString() @MinLength(1)
  submissionId: string;

  // The recipient defaults to the contact's email in the UI but is editable, so
  // it is validated as an address here rather than trusted from the contact.
  @IsEmail()
  to: string;

  @IsString() @MinLength(1) @MaxLength(200)
  subject: string;

  @IsString() @MinLength(1) @MaxLength(5000)
  message: string;
}
