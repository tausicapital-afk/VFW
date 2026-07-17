import { Body, Controller, Get, Global, Module, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { MessagingModule } from '../messaging/messaging.module';
import { MessagingGateway } from '../messaging/messaging.gateway';
import { ActivityService } from './activity.service';
import { ActivityQueryDto, SessionsQueryDto, TrackDto } from './dto';

/** Pull the caller's origin off the request for a log line. `req.ip` has already
 * been unwound through the proxy chain (see TRUST_PROXY_HOPS in main). */
function context(req: Request) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * The Logs screen. Reading it needs `activity.view`, held by Admin and
 * Accounting — it is user-monitoring, not an operational dashboard. The one
 * write, `track`, is the
 * exception: any signed-in user may record that they opened a module (they can
 * only ever log their own view, so there is nothing to abuse), which is why it
 * carries no `activity.view` gate.
 */
@Controller('api/activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly gateway: MessagingGateway,
  ) {}

  /** Client-reported module view. Records the current user only. */
  @Post('track')
  async track(@Body() dto: TrackDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.activity.trackModuleView(
      user.id,
      dto.module,
      dto.label ?? dto.module,
      context(req),
    );
    return { ok: true };
  }

  @Can('activity.view')
  @Get('users')
  users() {
    return this.activity.usersOverview(new Set(this.gateway.onlineUserIds()));
  }

  @Can('activity.view')
  @Get()
  feed(@Query() q: ActivityQueryDto) {
    return this.activity.feed(q);
  }

  @Can('activity.view')
  @Get('actions')
  actions() {
    return this.activity.actions();
  }

  @Can('activity.view')
  @Get('sessions')
  sessions(@Query() q: SessionsQueryDto) {
    return this.activity.sessions(q);
  }
}

/**
 * Global so AuthService, the messaging gateway and anywhere else that needs to
 * append an event can inject ActivityService without importing this module —
 * the same pattern AuditModule uses. Imports MessagingModule for the gateway's
 * live presence set; MessagingModule does not import this one (it reaches
 * ActivityService through the global provider), so there is no cycle.
 */
@Global()
@Module({
  imports: [MessagingModule],
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
