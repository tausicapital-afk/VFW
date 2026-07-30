import { Controller, Get, Module, Query } from '@nestjs/common';
import { Can } from '../common/auth.guard';
import { LeaderboardQueryDto, ReportQueryDto } from './dto';
import { REPORTS, ReportsService } from './reports.service';

/**
 * Insight. Everything here is read-only; nothing in this module writes a row.
 *
 * The two guards differ on purpose, and they follow the mockup's matrix:
 * reports are financial and are for ACCT/MGR/ADMIN, while the leaderboard is
 * visible to everyone — a rep is meant to see where they stand.
 */
@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** The catalogue of report types, so the UI does not have to hardcode it. */
  @Can('reports.view')
  @Get('types')
  types() {
    return Object.entries(REPORTS).map(([key, name]) => ({ key, name }));
  }

  @Can('reports.view')
  @Get('summary')
  summary(@Query() q: ReportQueryDto) {
    const { type, ...filters } = q;
    return this.reports.summary(type, filters);
  }

  @Can('leaderboard.view')
  @Get('leaderboard')
  leaderboard(@Query() q: LeaderboardQueryDto) {
    return this.reports.leaderboard(q);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  // ExportModule builds each report's file from the same `summary` this
  // controller serves, so an exported report is the table on screen rather than
  // a second implementation of it.
  exports: [ReportsService],
})
export class ReportsModule {}
