import { QboMappingKind } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** What Intuit appends to the redirect URI after the consent screen. */
export class QboCallbackQueryDto {
  @IsOptional() @IsString() @MaxLength(2000)
  code?: string;

  @IsOptional() @IsString() @MaxLength(80)
  realmId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  state?: string;

  @IsOptional() @IsString() @MaxLength(200)
  error?: string;
}

export class QboMappingDto {
  @IsEnum(QboMappingKind)
  kind!: QboMappingKind;

  @IsString() @MaxLength(60)
  localCode!: string;

  @IsString() @MaxLength(80)
  qboId!: string;

  @IsString() @MaxLength(200)
  qboLabel!: string;
}
