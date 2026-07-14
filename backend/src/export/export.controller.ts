import { Controller, ForbiddenException, Get, Module, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActivityModule } from '../activity/activity.controller';
import { ActivityService } from '../activity/activity.service';
import { can } from '../common/acl';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { SubmissionsService } from '../submissions/submissions.service';
import { submissionsDataset } from './datasets/submissions.dataset';
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

    const file = await this.exports.render(dataset, user, query.format, query.tz);

    // Bulk data leaving the system is worth a telemetry line — who pulled what,
    // and in what shape. Best-effort, like every other activity write.
    void this.activity
      .log({
        userId: user.id,
        action: 'DATA_EXPORT',
        detail: `${user.name} exported ${dataset.title} as ${query.format.toUpperCase()}`,
        meta: { dataset: dataset.key, format: query.format },
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
  imports: [SubmissionsModule, ActivityModule],
  controllers: [ExportController],
  providers: [ExportRegistry, ExportService],
})
export class ExportModule {
  /**
   * Where every exportable resource is declared. To make a new one exportable,
   * add a dataset file next to submissions.dataset.ts and register it here.
   */
  constructor(registry: ExportRegistry, submissions: SubmissionsService) {
    registry.register(submissionsDataset(submissions));
  }
}
