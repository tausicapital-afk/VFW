import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto';

/**
 * The customer layer. Every endpoint is behind the global AuthGuard (a signed-in
 * user is required) and row-level scoped inside the service: a sales rep sees
 * only their own contacts, ACCT/MGR/ADMIN see all.
 */
@Controller('api/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.contacts.list(user, q);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.contacts.findOne(id, user);
  }

  @Post()
  create(@Body() dto: CreateContactDto, @CurrentUser() user: AuthUser) {
    return this.contacts.create(dto, user);
  }
}

@Module({
  imports: [SubmissionsModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
