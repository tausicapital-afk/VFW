import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogModule } from './catalog/catalog.controller';
import { AuthGuard, Public } from './common/auth.guard';
import { ContactsModule } from './contacts/contacts.controller';
import { PrismaModule } from './prisma/prisma.service';
import { ReportsModule } from './reports/reports.controller';
import { SubmissionsModule } from './submissions/submissions.controller';

@Controller('api')
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true, service: 'vfw-api', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '30d' },
    }),
    PrismaModule,
    AuditModule,
    CatalogModule,
    SubmissionsModule,
    ContactsModule,
    ReportsModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    AuthService,
    // Global: every route is authenticated unless it opts out with @Public().
    // Locking down by default means a new endpoint cannot leak by omission.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
