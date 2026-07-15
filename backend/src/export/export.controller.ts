import { Controller, ForbiddenException, Get, Module, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActivityModule } from '../activity/activity.controller';
import { ActivityService } from '../activity/activity.service';
import { AdminModule } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { AuditService } from '../audit/audit.service';
import { ContactsModule } from '../contacts/contacts.controller';
import { ContactsService } from '../contacts/contacts.service';
import { FeedbackService } from '../feedback/feedback.controller';
import { InternalService } from '../internal/internal.controller';
import { ReportsModule } from '../reports/reports.controller';
import { ReportsService } from '../reports/reports.service';
import { can } from '../common/acl';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { MessagingGateway } from '../messaging/messaging.gateway';
import { MessagingModule } from '../messaging/messaging.module';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { SubmissionsService } from '../submissions/submissions.service';
import { auditDataset } from './datasets/audit.dataset';
import { addonsDataset, packagesDataset, taxesDataset } from './datasets/catalogue.dataset';
import { contactsDataset } from './datasets/contacts.dataset';
import { invitationsDataset } from './datasets/invitations.dataset';
import { activityDataset, logUsersDataset, sessionsDataset } from './datasets/logs.dataset';
import { feedbackDataset, internalCommentsDataset } from './datasets/people.dataset';
import { qboLedgerDataset } from './datasets/qbo-ledger.dataset';
import { reportDatasets } from './datasets/reports.dataset';
import { submissionsDataset } from './datasets/submissions.dataset';
import { userApprovalsDataset, usersDataset } from './datasets/users.dataset';
import { ExportQueryDto } from './dto';
import { ExportRegistry } from './export.registry';
import { ExportService } from './export.service';

/**
 * One endpoint for every export in the system: GET /api/export/:dataset?format=…
 *
 * The route is generic. What may be exported, and which rows the caller gets,
 * is entirely the dataset's business (see export.registry.ts) — which is what
 * stops "export" from being reimplemented, slightly differently, per screen.
 */
@Controller('api/export')
export class ExportController {
  constructor(
    private readonly registry: ExportRegistry,
    private readonly exports: ExportService,
    private readonly activity: ActivityService,
  ) {}

  @Get(':dataset')
  async download(
    @Param('dataset') key: string,
    @Query() query: ExportQueryDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const dataset = this.registry.get(key);

    // The global guard enforces @Can() on the *route*, and this route serves
    // every dataset — so a dataset's own permission has to be checked here.
    if (dataset.permission && !can(dataset.permission, user.role)) {
      throw new ForbiddenException(`Your role cannot ${dataset.permission}`);
    }

    const { format, tz, ...filters } = query;
    const file = await this.exports.render(dataset, user, format, tz, filters);

    // Bulk data leaving the system is worth a telemetry line — who pulled what,
    // and in what shape. Best-effort, like every other activity write.
    void this.activity
      .log({
        userId: user.id,
        action: 'DATA_EXPORT',
        detail: `${user.name} exported ${dataset.title} as ${format.toUpperCase()}`,
        // The filter is part of "what was pulled": the same dataset exported
        // whole and exported down to one contact are not the same event, and a
        // line that recorded only the key could not tell them apart.
        meta: { dataset: dataset.key, format, ...(Object.keys(filters).length ? { filters } : {}) },
        ctx: { ip: req.ip, userAgent: req.headers['user-agent'] },
      })
      .catch(() => undefined);

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    // The browser reads the filename off the header, which is only visible to a
    // cross-origin fetch if it is explicitly exposed.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Length', file.buffer.length);
    res.end(file.buffer);
  }
}

@Module({
  // MessagingModule for the gateway's live presence set, which the Logs → Users
  // dataset snapshots. AuditModule and ActivityModule are @Global, so their
  // services arrive without being imported here.
  imports: [
    SubmissionsModule,
    ActivityModule,
    AdminModule,
    MessagingModule,
    ContactsModule,
    ReportsModule,
  ],
  controllers: [ExportController],
  providers: [ExportRegistry, ExportService],
})
export class ExportModule {
  /**
   * Where every exportable resource is declared. To make a new one exportable,
   * add a dataset file next to submissions.dataset.ts and register it here.
   *
   * The admin datasets each carry `permission: 'admin.manage'`. They have to:
   * unlike submissions, their `load` returns the same rows to everyone, so the
   * dataset's own permission is the only thing standing between a signed-in rep
   * and the staff list.
   */
  constructor(
    registry: ExportRegistry,
    submissions: SubmissionsService,
    admin: AdminService,
    audit: AuditService,
    activity: ActivityService,
    gateway: MessagingGateway,
    contacts: ContactsService,
    feedback: FeedbackService,
    internal: InternalService,
    reports: ReportsService,
  ) {
    registry.register(submissionsDataset(submissions));
    registry.register(userApprovalsDataset(admin));
    registry.register(invitationsDataset(admin));
    registry.register(usersDataset(admin));
    registry.register(packagesDataset(admin));
    registry.register(addonsDataset(admin));
    registry.register(taxesDataset(admin));
    registry.register(auditDataset(audit));
    registry.register(activityDataset(activity));
    registry.register(sessionsDataset(activity));
    registry.register(logUsersDataset(activity, gateway));
    registry.register(contactsDataset(contacts));
    registry.register(qboLedgerDataset(submissions));
    registry.register(feedbackDataset(feedback));
    registry.register(internalCommentsDataset(internal));
    // One per report — see reports.dataset.ts for why they are not one dataset
    // taking a `type`.
    for (const report of reportDatasets(reports)) registry.register(report);
  }
}
