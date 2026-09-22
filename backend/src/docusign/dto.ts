import { IsOptional, IsString, MaxLength } from 'class-validator';

/** What DocuSign appends to the redirect URI after the consent screen. */
export class DocuSignCallbackQueryDto {
  @IsOptional() @IsString() @MaxLength(2000)
  code?: string;

  @IsOptional() @IsString() @MaxLength(200)
  state?: string;

  @IsOptional() @IsString() @MaxLength(200)
  error?: string;
}

/**
 * The DocuSign Connect notification body. Deliberately NOT run through
 * class-validator: the global ValidationPipe is `whitelist: true,
 * forbidNonWhitelisted: true`, and a real Connect payload carries far more
 * fields (apiVersion, uri, retryCount, generatedDateTime, the full envelope
 * summary, …) than this app reads. A decorated DTO here would 400 every
 * genuine delivery the moment DocuSign's shape drifted even slightly from
 * this file's guess at it.
 *
 * This is a plain interface, not a class, on purpose: Nest's ValidationPipe
 * only validates/whitelists when the parameter's reflected metatype is an
 * actual class, and an interface erases to `Object` at runtime — see
 * `toValidate()` in @nestjs/common's ValidationPipe. Typing the controller
 * parameter as this interface therefore documents the shape without
 * triggering stripping. Only `event` and the envelope id nested under `data`
 * are ever read (see DocuSignWebhookService) — everything else is ignored,
 * not validated against.
 */
export interface DocuSignConnectPayload {
  /** e.g. "envelope-sent" | "envelope-delivered" | "envelope-completed" | "envelope-declined" | "envelope-voided" */
  event?: string;
  data?: {
    envelopeId?: string;
    accountId?: string;
    envelopeSummary?: { status?: string };
  };
  // Older/aggregate Connect payload shapes carry the envelope id and status
  // one level up instead of nested under `data` — tolerated as a fallback,
  // see DocuSignWebhookService.extractEnvelope.
  envelopeId?: string;
  status?: string;
  [key: string]: unknown;
}
