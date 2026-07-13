import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Adding a contact directly. A contact is unique per brand — the same brand
 * cannot be created twice — so brand is the one required field. Everything else
 * is descriptive and optional, matching the mockup's "New contact" modal.
 */
export class CreateContactDto {
  @IsString() @MinLength(1) @MaxLength(120)
  brand: string;

  @IsOptional() @IsString() @MaxLength(120)
  designer?: string;

  @IsOptional() @IsString() @MaxLength(160)
  company?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(80)
  country?: string;

  @IsOptional() @IsString() @MaxLength(40)
  type?: string;
}
