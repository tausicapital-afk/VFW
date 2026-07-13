import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

const DEPARTMENTS = [
  'Sales',
  'Accounting',
  'Marketing',
  'Production',
  'Media',
  'International',
  'Administration',
] as const;

export class SignupDto {
  @IsString()
  @MinLength(1)
  code: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsEmail()
  email: string;

  // Long enough to be worth hashing. Argon2 handles the rest.
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(200)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsIn(DEPARTMENTS)
  department?: string;

  /**
   * Accepted so the mockup's form (which posts one) is not rejected by the
   * whitelist — and then **ignored**. The account's role is taken from the
   * invitation. See AuthService.signup().
   */
  @IsOptional()
  @IsString()
  role?: string;
}

export class ForgotDto {
  @IsEmail()
  email: string;
}

export class ResetDto {
  @IsString()
  @MinLength(1)
  token: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(200)
  password: string;
}
