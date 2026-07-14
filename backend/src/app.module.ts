import { Controller, Get, Module, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { ActivityModule } from './activity/activity.controller';
import { AdminModule } from './admin/admin.controller';
import { AuditModule } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogModule } from './catalog/catalog.controller';
import { AuthGuard, Public } from './common/auth.guard';
import { EmailModule } from './common/email';
import { loggerOptions } from './common/logging';
import { VfwThrottlerGuard, throttlerOptions } from './common/throttler';
import { ContactsModule } from './contacts/contacts.controller';
import { DocumentsModule } from './documents/documents.controller';
import { ExportModule } from './export/export.controller';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.service';
import { ReportsModule } from './reports/reports.controller';
import { StorageModule } from './storage/storage.service';
import { SubmissionsModule } from './submissions/submissions.controller';

@Controller('api')
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true, service: 'vfw-api', time: new Date().toISOString() };
  }

  /**
   * How this app sees the caller, once the proxy chain has been unwound.
   *
   * The rate limiter keys on `ip`. If that shows the proxy's address rather than
   * the caller's, every user shares one bucket and the limiter is worthless.
   * `TRUST_PROXY_HOPS` tunes it, and this is how you check it: call this through
   * the real front door and confirm `ip` is your own address.
   *
   * Echoes only the caller's own request back to them — no secrets, and nothing
   * they did not already send.
   */
  @Public()
  @Get('health/ip')
  ip(@Req() req: Request) {
    return {
      ip: req.ip,
      ips: req.ips,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      socket: req.socket.remoteAddress,
      trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
    };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot(loggerOptions),
    ThrottlerModule.forRoot(throttlerOptions),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '30d' },
    }),
    PrismaModule,
    EmailModule,
    AuditModule,
    CatalogModule,
    SubmissionsModule,
    ContactsModule,
    StorageModule,
    DocumentsModule,
    ReportsModule,
    AdminModule,
    MessagingModule,
    ActivityModule,
    ExportModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    AuthService,
    // Order matters: global guards run in the order they are registered.
    // Throttle first, so a flood is turned away before it costs us a JWT
    // verification, a database round-trip, or an argon2 hash.
    { provide: APP_GUARD, useClass: VfwThrottlerGuard },
    // Global: every route is authenticated unless it opts out with @Public().
    // Locking down by default means a new endpoint cannot leak by omission.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
