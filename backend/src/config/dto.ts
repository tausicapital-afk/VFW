import { IsObject } from 'class-validator';

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
