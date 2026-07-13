import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Media is images and the odd document, not video. Cap the declared size so a
// client cannot request a presign for something absurd.
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB

// A whitelist, not free text: the presign hands out a capability to write to the
// bucket, so we only sign content types we are willing to serve back inline.
export const ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export class CreateConversationDto {
  @IsIn(['DM', 'GROUP'])
  kind: 'DM' | 'GROUP';

  // The other people in the chat (never includes the creator — the service adds
  // them). A DM has exactly one; a group has at least one.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  userIds: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;
}

export class AttachmentInputDto {
  // Echoed back from a presign response; the service checks it is namespaced
  // under this conversation, so a client cannot register an arbitrary key.
  @IsString() @MinLength(1) @MaxLength(500)
  storageKey: string;

  @IsString() @MinLength(1) @MaxLength(255)
  filename: string;

  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: (typeof ALLOWED_CONTENT_TYPES)[number];

  @IsOptional() @IsInt() @Min(0) @Max(MAX_ATTACHMENT_SIZE)
  size?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100000)
  width?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100000)
  height?: number;
}

export class SendMessageDto {
  // A message is text, media, or both — the service rejects one that is neither.
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentInputDto)
  attachments?: AttachmentInputDto[];
}

export class PresignAttachmentDto {
  @IsString() @MinLength(1) @MaxLength(255)
  filename: string;

  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: (typeof ALLOWED_CONTENT_TYPES)[number];

  @IsOptional() @IsInt() @Min(1) @Max(MAX_ATTACHMENT_SIZE)
  size?: number;
}

export class RenameConversationDto {
  @IsString() @MinLength(1) @MaxLength(120)
  title: string;
}

export class AddParticipantsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  userIds: string[];
}

export class ReadDto {
  // Mark read up to this ordinal. Omitted → up to the latest message.
  @IsOptional() @IsInt() @Min(0)
  seq?: number;
}

export class MessagesQueryDto {
  // Cursor pagination: fetch messages with seq < before (older). Omitted → newest.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  before?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
