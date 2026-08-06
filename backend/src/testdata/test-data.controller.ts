import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { MarkCatalogueTestDataDto, MarkTestDataDto } from './dto';
import { TestDataService } from './test-data.service';

/**
 * The test-data backfill — marking records that already exist.
 *
 * It sits next to Configuration in the UI because it is the other half of the
 * same idea: the switch there decides what NEW rows are, this decides what old
 * ones were. It is a separate controller because it is a different kind of
 * write — Configuration edits settings, this edits the book — and folding a
 * bulk row update into the settings endpoint would put it behind a handler
 * whose whole contract is "nothing here touches records".
 *
 * `admin.manage` on every handler, spelled out per route for the same reason
 * AdminController and ConfigController do it: a class-level guard is easy to
 * lose in a refactor, and losing this one means anyone with a session can
 * reclassify a real sale as a rehearsal.
 */
@Controller('api/admin/test-data')
export class TestDataController {
  constructor(private readonly testData: TestDataService) {}

  @Get()
  @Can('admin.manage')
  summary() {
    return this.testData.summary();
  }

  @Post('mark')
  @Can('admin.manage')
  mark(@Body() dto: MarkTestDataDto, @CurrentUser() user: AuthUser) {
    return this.testData.mark(dto, user);
  }

  @Post('mark-catalogue')
  @Can('admin.manage')
  markCatalogue(@Body() dto: MarkCatalogueTestDataDto, @CurrentUser() user: AuthUser) {
    return this.testData.markCatalogue(dto, user);
  }
}

@Module({
  controllers: [TestDataController],
  providers: [TestDataService],
  exports: [TestDataService],
})
export class TestDataModule {}
