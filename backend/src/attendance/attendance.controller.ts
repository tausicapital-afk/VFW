import { Body, Controller, Delete, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { AttendanceService } from './attendance.service';
import { AttendanceQueryDto, ClockDto, TeamQueryDto, UpsertAttendanceDto } from './dto';

/**
 * Timesheets: which days someone worked, and for how long.
 *
 * Every route carries `attendance.mark`, which every role holds — including the
 * read routes, because the base case of reading a timesheet is reading your own,
 * and an intern who could not see their own hours would have no reason to record
 * them. Widening to *someone else's* is not a route-level decision at all: it
 * happens per request in the service, which resolves the subject and demands
 * `attendance.viewTeam` the moment it is not the caller. `GET /team` is the one
 * exception and re-checks that permission itself, since it has no subject to
 * resolve — it is everybody by definition.
 */
@Controller('api/attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // Declared before the :date routes so "team" is never read as a date.
  @Get('team')
  @Can('attendance.mark')
  team(@Query() query: TeamQueryDto, @CurrentUser() user: AuthUser) {
    return this.attendance.team(query, user);
  }

  @Get()
  @Can('attendance.mark')
  list(@Query() query: AttendanceQueryDto, @CurrentUser() user: AuthUser) {
    return this.attendance.list(query, user);
  }

  @Post('clock-in')
  @Can('attendance.mark')
  clockIn(@Body() dto: ClockDto, @CurrentUser() user: AuthUser) {
    return this.attendance.clockIn(dto, user);
  }

  @Post('clock-out')
  @Can('attendance.mark')
  clockOut(@Body() dto: ClockDto, @CurrentUser() user: AuthUser) {
    return this.attendance.clockOut(dto, user);
  }

  @Put(':date')
  @Can('attendance.mark')
  upsert(
    @Param('date') date: string,
    @Body() dto: UpsertAttendanceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attendance.upsert(date, dto, user);
  }

  @Delete(':date')
  @Can('attendance.mark')
  remove(
    @Param('date') date: string,
    @Query() query: AttendanceQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attendance.remove(date, query.userId, user);
  }
}

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService],
  // Exported for the export dataset, which reads the same month through the same
  // scoping rather than running a second query that could disagree with it.
  exports: [AttendanceService],
})
export class AttendanceModule {}
