import { Controller, Get, Module, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { ContactsModule } from '../contacts/contacts.controller';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { SearchService } from './search.service';

/**
 * Cross-entity jump-to search (Cmd/Ctrl-K). No `@Can` here on purpose: every
 * role that can reach the console holds some search surface (at minimum its
 * own submissions), and which entity types actually come back is decided
 * per-type inside SearchService, the same way each entity type's own screen
 * decides it — see the note there.
 */
@Controller('api/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  get(@Query('q') q: string | undefined, @CurrentUser() user: AuthUser) {
    return this.search.search(user, q ?? '');
  }
}

@Module({
  imports: [SubmissionsModule, ContactsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
