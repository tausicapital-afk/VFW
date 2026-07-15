import { IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * A flat map of setting key -> value. The keys are validated against the
 * registry inside ConfigService (anything unknown is ignored), so the DTO only
 * has to assert the shape. Values are strings; blank has meaning (keep a secret,
 * or revert a non-secret to its environment default) — see ConfigService.update.
 */
export class UpdateConfigDto {
  @IsObject()
  entries!: Record<string, string>;
}

/**
 * A mail account, on create or edit. Everything is optional here and the real
 * rules live in MailAccountService.validate(), which knows the difference
 * between the two: create needs the full set, edit only needs what changed, and
 * a blank password on edit means "keep the stored one" rather than "clear it".
 */
export class MailAccountDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() encryption?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() fromAddress?: string;
  @IsOptional() @IsString() fromName?: string;
}
