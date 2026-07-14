import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Filter/page the activity feed. Nothing here writes; it only narrows. */
export class ActivityQueryDto {
  /** Free text over detail and the actor's name. */
  @IsOptional() @IsString() @MaxLength(120)
  q?: string;

  @IsOptional() @IsString() @MaxLength(40)
  action?: string;

  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(200) @Type(() => Number)
  limit?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  offset?: number;
}

export class SessionsQueryDto {
  @IsOptional() @IsString() @MaxLength(60)
  userId?: string;

  /** 'open' = still online, 'closed' = ended, omitted = both. */
  @IsOptional() @IsIn(['open', 'closed'])
  state?: 'open' | 'closed';

  @IsOptional() @IsInt() @Min(1) @Max(200) @Type(() => Number)
  limit?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  offset?: number;
}

/**
 * A self-reported client event. The only action a client may record is opening
 * a module — everything else is written server-side where it cannot be forged.
 * `module` is a route path; `label` is the human name for the feed line.
 */
export class TrackDto {
  @IsIn(['MODULE_VIEW'])
  action: 'MODULE_VIEW';

  @IsString() @MaxLength(60)
  module: string;

  @IsOptional() @IsString() @MaxLength(60)
  label?: string;
}
