import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { InboundMailService } from './inbound.service';

/**
 * Emails — the sent/received log plus invoice sending.
 *
 * Imports SubmissionsModule (which exports SubmissionsService) so the invoice
 * send reuses the very PDF the Download button produces — one source of truth for
 * the document. There is no reverse import, so no cycle. EmailService (@Global),
 * PrismaService (@Global) and AuditService (@Global) need no import here.
 *
 * The scheduler that drives InboundMailService is registered once in AppModule
 * (ScheduleModule.forRoot()).
 */
@Module({
  imports: [SubmissionsModule],
  controllers: [EmailsController],
  providers: [EmailsService, InboundMailService],
})
export class EmailsModule {}
