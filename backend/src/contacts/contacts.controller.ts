import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto';

/**
 * The customer layer, governed at two levels that answer different questions.
 *
 * `@Can` answers "may this ROLE touch contacts at all" — INTERN may not, and
 * only intake roles may create one. The service then answers "WHICH contacts"
 * with a row-level scope: a sales rep sees only brands they sold to or entered,
 * ACCT/MGR/ADMIN see all. Both are needed; neither implies the other.
 */
@Controller('api/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Can('contacts.view')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.contacts.list(user, q);
  }

  @Can('contacts.view')
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.contacts.findOne(id, user);
  }

  @Can('contacts.create')
  @Post()
  create(@Body() dto: CreateContactDto, @CurrentUser() user: AuthUser) {
    return this.contacts.create(dto, user);
  }
}

@Module({
  imports: [SubmissionsModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  // ExportModule reads the customer book through the same scoped `list` this
  // controller serves, so the file cannot hold rows the screen would not.
  exports: [ContactsService],
})
export class ContactsModule {}
