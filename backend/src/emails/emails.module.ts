import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.controller';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { InboundMailService } from './inbound.service';
import { RemindersService } from './reminders.service';

/**
 * Emails — the sent/received log, invoice sending, and the two scheduled
 * reminder jobs (overdue-payment / renewal-nudge — see reminders.service.ts).
 *
 * Imports SubmissionsModule (which exports SubmissionsService) so the invoice
 * send reuses the very PDF the Download button produces — one source of truth for
 * the document. Imports ReportsModule (which exports ReportsService) so
 * RemindersService can reuse receivablesRows()/retentionRows() rather than
 * re-deriving "overdue" or "lapsed" from scratch. Neither import creates a
 * cycle — SubmissionsModule and ReportsModule import neither EmailsModule nor
 * each other. EmailService (@Global), PrismaService (@Global) and
 * AuditService (@Global) need no import here.
 *
 * The scheduler that drives InboundMailService and RemindersService is
 * registered once in AppModule (ScheduleModule.forRoot()).
 */
@Module({
  imports: [SubmissionsModule, ReportsModule],
  controllers: [EmailsController],
  providers: [EmailsService, InboundMailService, RemindersService],
})
export class EmailsModule {}
