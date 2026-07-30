import { Body, Controller, Delete, Get, Module, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { SESSION_COOKIE, sessionCookie } from '../common/cookie';
import { PayrollModule } from '../payroll/payroll.controller';
import { ProfileService } from './profile.service';
import { AvatarCommitDto, AvatarPresignDto, ChangePasswordDto, UpdateProfileDto } from './dto';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Your own account: the details, the picture, the password.
 *
 * There is no ACL permission on any of these and no `:id` on any route. That is
 * deliberate and is the entire authorization story — every handler acts on
 * `@CurrentUser()`, so "may I edit this profile?" is not a question that can be
 * asked, let alone answered wrongly. Editing *someone else's* account is a
 * different act with a different audience and lives in AdminController behind
 * `admin.manage`.
 */
@Controller('api/profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.profile.get(user);
  }

  @Patch()
  update(@Body() dto: UpdateProfileDto, @CurrentUser() user: AuthUser) {
    return this.profile.update(dto, user);
  }

  // Two steps, like every other upload here: presign, then record. The bytes go
  // straight to R2 and never pass through this API.
  @Post('avatar/presign')
  presignAvatar(@Body() dto: AvatarPresignDto, @CurrentUser() user: AuthUser) {
    return this.profile.presignAvatar(dto, user);
  }

  @Put('avatar')
  commitAvatar(@Body() dto: AvatarCommitDto, @CurrentUser() user: AuthUser) {
    return this.profile.commitAvatar(dto, user);
  }

  @Delete('avatar')
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.profile.removeAvatar(user);
  }

  /**
   * A successful change invalidates every session this account holds — including
   * the cookie that authorised this very request. Re-issuing here is what keeps
   * the person who just changed their password from being signed out by it,
   * while every *other* browser is signed out, which is the point.
   *
   * The replacement lasts a day: the old cookie's remaining lifetime is not
   * knowable from here, and a day is the same window a login without "remember
   * me" gets.
   */
  @Post('password')
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.profile.changePassword(dto, user);
    res.cookie(SESSION_COOKIE, token, sessionCookie(DAY_MS));
    return { ok: true };
  }
}

@Module({
  imports: [PayrollModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
