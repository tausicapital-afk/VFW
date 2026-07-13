import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { SubmissionsModule } from '../submissions/submissions.controller';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto, PresignDto } from './dto';

/**
 * Documents hang off a submission. Every endpoint is authenticated by the global
 * guard and access-scoped in the service to whoever may see the submission —
 * the file never passes through here, only presigned URLs to R2 do.
 */
@Controller('api/submissions/:id/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documents.list(id, user);
  }

  // Step 1 of an upload: hand back a short-lived URL to PUT the bytes to.
  @Post('presign')
  presign(@Param('id') id: string, @Body() dto: PresignDto, @CurrentUser() user: AuthUser) {
    return this.documents.presign(id, dto, user);
  }

  // Step 2: the bytes are in R2 — record the row that points at them.
  @Post()
  create(@Param('id') id: string, @Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documents.create(id, dto, user);
  }

  @Get(':docId/download')
  download(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.downloadUrl(id, docId, user);
  }
}

@Module({
  imports: [SubmissionsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
