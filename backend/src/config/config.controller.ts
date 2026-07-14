import { Body, Controller, Get, Global, Module, Patch, Post } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { EmailService } from '../common/email';
import { StorageService } from '../storage/storage.service';
import { ConfigService } from './config.service';
import { UpdateConfigDto } from './dto';

/**
 * System configuration — SMTP and object-storage credentials an administrator
 * can set without a developer or a redeploy.
 *
 * Every route is `admin.manage` (ADMIN only), spelled out per handler for the
 * same reason AdminController does: a class-level guard is easy to lose in a
 * refactor, and the cost of losing this one is that live mail/storage
 * credentials become editable by anyone with a session.
 *
 * A GET never returns a secret's plaintext — only whether it is set and where it
 * comes from. The two `test/*` routes let the admin prove a credential works
 * from the screen, rather than discovering it is wrong when the next user's
 * sign-up email silently fails to send.
 */
@Controller('api/admin/config')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @Can('admin.manage')
  get() {
    return this.config.state();
  }

  @Patch()
  @Can('admin.manage')
  update(@Body() dto: UpdateConfigDto, @CurrentUser() user: AuthUser) {
    return this.config.update(dto.entries ?? {}, user);
  }

  /** Send a real test email to the signed-in admin, using the current settings. */
  @Post('test/email')
  @Can('admin.manage')
  async testEmail(@CurrentUser() user: AuthUser) {
    try {
      await this.email.sendTest(user.email, user.name);
      return { ok: true, sentTo: user.email };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'The test email could not be sent' };
    }
  }

  /** Confirm the storage credentials can actually reach the bucket. */
  @Post('test/storage')
  @Can('admin.manage')
  async testStorage() {
    try {
      await this.storage.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not reach the storage bucket' };
    }
  }
}

@Global()
@Module({
  controllers: [ConfigController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class SystemConfigModule {}
