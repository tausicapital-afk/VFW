import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ActivityModule } from './activity/activity.controller';
import { AdminModule } from './admin/admin.controller';
import { AuditModule } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogModule } from './catalog/catalog.controller';
import { AuthGuard } from './common/auth.guard';
import { EmailModule } from './common/email';
import { HealthModule } from './health/health.controller';
import { SystemConfigModule } from './config/config.controller';
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
    HealthModule,
    AuditModule,
    SystemConfigModule,
    EmailModule,
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
  controllers: [AuthController],
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
