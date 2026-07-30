import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * What a profile picture may be. A whitelist rather than a `startsWith('image/')`
 * check: the content type is what R2 will serve the object back with, and
 * "anything claiming to be an image" includes SVG, which is a document that can
 * carry script. These four are raster formats every browser renders and none of
 * them execute.
 */
export const AVATAR_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** An avatar is displayed at 56px. Anything approaching this is already absurd. */
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * The fields a person may change about themselves.
 *
 * Note what is absent, and why:
 *
 * - **email** is the login identity and the address every one-time code is sent
 *   to. Changing it is an account-recovery act that needs the new inbox proved
 *   before the old one stops working — not a text box on a profile form.
 * - **role, status, commission, target** are grants and obligations other people
 *   make about you. A form that let you raise your own commission would be a
 *   different feature entirely.
 *
 * Everything here is a statement about yourself that only you are well placed to
 * get right, which is exactly the set that should not have to go through an
 * administrator.
 */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  // Nullable so a field can be *cleared*, not only rewritten — `undefined` means
  // "leave it alone" and `null` means "I no longer have one", and the two must
  // not collapse into each other.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  department?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80)
  title?: string | null;

  // The initials-avatar background. Constrained to a full six-digit hex because
  // it is interpolated straight into a style attribute on every screen that
  // renders a person; a free-text colour is a free-text CSS value.
  @IsOptional() @IsString() @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'colour must be a hex value like #2F6BFF',
  })
  colour?: string;
}

/** Step 1 of an avatar change: a URL to PUT the image to. Nothing has moved yet. */
export class AvatarPresignDto {
  @IsString() @MinLength(1) @MaxLength(255)
  filename: string;

  @IsIn(AVATAR_CONTENT_TYPES)
  contentType: (typeof AVATAR_CONTENT_TYPES)[number];

  @IsOptional() @IsInt() @Min(1) @Max(MAX_AVATAR_SIZE)
  size?: number;
}

/** Step 2: the bytes are in R2 — point the account at them. */
export class AvatarCommitDto {
  // Echoed back from the presign response. The service re-checks it is under
  // this user's own prefix, so a client cannot adopt someone else's object.
  @IsString() @MinLength(1) @MaxLength(500)
  storageKey: string;
}

/**
 * Changing your own password. The current one is required even though the caller
 * already holds a valid session: the session proves a browser was left signed in,
 * which is precisely the situation this check exists to catch.
 */
export class ChangePasswordDto {
  @IsString() @MinLength(1)
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(200)
  newPassword: string;
}
