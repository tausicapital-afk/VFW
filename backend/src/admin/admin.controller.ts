import { Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { AdminService } from './admin.service';
import {
  CreateInvitationDto,
  RejectUserDto,
  UpdateAddonDto,
  UpdatePackageDto,
  UpdateSettingsDto,
  UpdateTaxDto,
} from './dto';
import { FeedbackController, FeedbackService } from '../feedback/feedback.controller';
import { InternalController, InternalService } from '../internal/internal.controller';

/**
 * Administration. Every route here is `admin.manage` — ADMIN only.
 *
 * The guard is applied per handler rather than to the class, because a
 * class-level decorator is easy to lose in a refactor and the cost of losing it
 * is that user approval and the rate card become open to everyone with a
 * session. It is spelled out on each one, on purpose.
 */
@Controller('api')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // --- Invitations ---------------------------------------------------------

  @Get('invitations')
  @Can('admin.manage')
  listInvitations() {
    return this.admin.listInvitations();
  }

  @Post('invitations')
  @Can('admin.manage')
  createInvitation(@Body() dto: CreateInvitationDto, @CurrentUser() user: AuthUser) {
    return this.admin.createInvitation(dto, user);
  }

  @Post('invitations/:id/revoke')
  @Can('admin.manage')
  revokeInvitation(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.admin.revokeInvitation(id, user);
  }

  // --- Users ---------------------------------------------------------------

  @Get('users')
  @Can('admin.manage')
  listUsers() {
    return this.admin.listUsers();
  }

  // Declared before :id-shaped routes so "pending" is not read as an id.
  @Get('users/pending')
  @Can('admin.manage')
  pendingUsers() {
    return this.admin.pendingUsers();
  }

  @Post('users/:id/approve')
  @Can('admin.manage')
  approveUser(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.admin.approveUser(id, user);
  }

  @Post('users/:id/reject')
  @Can('admin.manage')
  rejectUser(
    @Param('id') id: string,
    @Body() dto: RejectUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.rejectUser(id, dto, user);
  }

  // --- Catalogue -----------------------------------------------------------

  @Get('admin/catalogue')
  @Can('admin.manage')
  catalogue() {
    return this.admin.catalogue();
  }

  @Patch('admin/packages/:id')
  @Can('admin.manage')
  updatePackage(
    @Param('id') id: string,
    @Body() dto: UpdatePackageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.updatePackage(id, dto, user);
  }

  @Patch('admin/addons/:id')
  @Can('admin.manage')
  updateAddon(
    @Param('id') id: string,
    @Body() dto: UpdateAddonDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.updateAddon(id, dto, user);
  }

  @Patch('admin/tax/:code')
  @Can('admin.manage')
  updateTax(
    @Param('code') code: string,
    @Body() dto: UpdateTaxDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.updateTax(code, dto, user);
  }

  @Get('admin/settings')
  @Can('admin.manage')
  settings() {
    return this.admin.settings();
  }

  @Patch('admin/settings')
  @Can('admin.manage')
  updateSettings(@Body() dto: UpdateSettingsDto, @CurrentUser() user: AuthUser) {
    return this.admin.updateSettings(dto, user);
  }
}

@Module({
  controllers: [AdminController, FeedbackController, InternalController],
  providers: [AdminService, FeedbackService, InternalService],
})
export class AdminModule {}
