import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// The three documents the sale actually needs, plus a catch-all. Kept as a
// small whitelist so the type column stays queryable rather than free-text.
export const DOCUMENT_TYPES = ['contract', 'po', 'receipt', 'other'] as const;

// R2 is cheap but not free, and this is contracts and POs, not video. Cap the
// declared size so a client cannot request a presign for something absurd.
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

/** Step 1: ask for a URL to upload to. No file has moved yet. */
export class PresignDto {
  @IsIn(DOCUMENT_TYPES)
  type: (typeof DOCUMENT_TYPES)[number];

  @IsString() @MinLength(1) @MaxLength(255)
  filename: string;

  @IsString() @MinLength(1) @MaxLength(150)
  contentType: string;

  @IsOptional() @IsInt() @Min(1) @Max(MAX_SIZE)
  size?: number;
}

/** Step 2: the bytes are in R2; record the row that points at them. */
export class CreateDocumentDto {
  @IsIn(DOCUMENT_TYPES)
  type: (typeof DOCUMENT_TYPES)[number];

  @IsString() @MinLength(1) @MaxLength(255)
  filename: string;

  // Echoed back from the presign response — the service checks it is namespaced
  // under this submission, so a client cannot register an arbitrary key.
  @IsString() @MinLength(1) @MaxLength(500)
  storageKey: string;

  @IsOptional() @IsString() @MaxLength(150)
  contentType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(MAX_SIZE)
  size?: number;
}
