import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * The backfill request. Everything is optional, and the defaults are the common
 * case spelled out in TestDataService.mark: no refs means the five demo sales,
 * related rows come along, and the direction is "mark" rather than "clear".
 *
 * The array caps are here rather than only in the service so an oversized body
 * is rejected before it reaches a transaction, but the service keeps its own
 * check — a DTO guards the HTTP door, and the script does not come through it.
 */
export class MarkTestDataDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) refs?: string[];
  @IsOptional() @IsBoolean() includeRelated?: boolean;
  @IsOptional() @IsBoolean() unmark?: boolean;
}

/** The catalogue half — a show, package or add-on that only existed for a demo. */
export class MarkCatalogueTestDataDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) eventIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) packageIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) addonIds?: string[];
  @IsOptional() @IsBoolean() unmark?: boolean;
}
