import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { MAX_IMPORT_FILE_BYTES, UploadedCsvFile } from '../common/csv-import';
import { PortalModule } from '../portal/portal.controller';
import { PortalService } from '../portal/portal.service';
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
  constructor(
    private readonly contacts: ContactsService,
    private readonly portal: PortalService,
  ) {}

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

  @Can('contacts.create')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_BYTES } }))
  importContacts(@UploadedFile() file: UploadedCsvFile, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('No file was uploaded — choose a CSV file first');
    return this.contacts.importContacts(file.buffer.toString('utf8'), user);
  }

  // Mints and emails a magic link into the read-only contact portal — the same
  // permission as sending an invoice (`email.send`, ACCT/ADMIN), since it is
  // the same kind of act: handing the customer a document/view of their own
  // account.
  @Can('email.send')
  @Post(':id/portal-link')
  sendPortalLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.portal.sendLink(id, user);
  }
}

@Module({
  imports: [SubmissionsModule, PortalModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  // ExportModule reads the customer book through the same scoped `list` this
  // controller serves, so the file cannot hold rows the screen would not.
  exports: [ContactsService],
})
export class ContactsModule {}
