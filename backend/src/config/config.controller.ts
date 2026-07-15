import { Body, Controller, Delete, Get, Global, Module, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { EmailService } from '../common/email';
import { StorageService } from '../storage/storage.service';
import { ConfigService } from './config.service';
import { MailAccountService } from './mail-account.service';
import { MailAccountDto, UpdateConfigDto } from './dto';

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

  /** Send a real test email to the signed-in admin, from whatever is sending now. */
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

/**
 * The mailboxes the app can send from, and which one is sending.
 *
 * Same guard rule as ConfigController — `admin.manage`, spelled out per handler
 * rather than once on the class, because these routes hand out and revoke live
 * SMTP credentials.
 *
 * Every mutating route returns the whole list, not just the row it touched: the
 * "exactly one active" rule means changing one row can change another, and a
 * client that patched its cache from a single-row response would draw two active
 * accounts.
 */
@Controller('api/admin/mail-accounts')
export class MailAccountController {
  constructor(
    private readonly accounts: MailAccountService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @Can('admin.manage')
  list() {
    return { accounts: this.accounts.list(), status: this.accounts.status() };
  }

  @Post()
  @Can('admin.manage')
  async create(@Body() dto: MailAccountDto, @CurrentUser() user: AuthUser) {
    const accounts = await this.accounts.create(dto, user);
    return { accounts, status: this.accounts.status() };
  }

  @Patch(':id')
  @Can('admin.manage')
  async update(@Param('id') id: string, @Body() dto: MailAccountDto, @CurrentUser() user: AuthUser) {
    const accounts = await this.accounts.update(id, dto, user);
    return { accounts, status: this.accounts.status() };
  }

  @Post(':id/activate')
  @Can('admin.manage')
  async activate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const accounts = await this.accounts.activate(id, user);
    return { accounts, status: this.accounts.status() };
  }

  @Delete(':id')
  @Can('admin.manage')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const accounts = await this.accounts.remove(id, user);
    return { accounts, status: this.accounts.status() };
  }

  /**
   * Prove one specific mailbox works, before trusting it with real mail.
   *
   * Returns `{ ok: false, error }` rather than throwing: a failed test is the
   * expected outcome of a diagnostic, not a server error, and the SMTP message
   * ("invalid login", "connection timeout") is the entire value of running it.
   */
  @Post(':id/test')
  @Can('admin.manage')
  async test(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    try {
      await this.email.sendTest(user.email, user.name, id);
      return { ok: true, sentTo: user.email };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'The test email could not be sent' };
    }
  }
}

@Global()
@Module({
  controllers: [ConfigController, MailAccountController],
  providers: [ConfigService, MailAccountService],
  exports: [ConfigService, MailAccountService],
})
export class SystemConfigModule {}
