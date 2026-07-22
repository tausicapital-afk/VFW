import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { EmailsQueryDto, SendInvoiceDto } from './dto';
import { EmailsService } from './emails.service';

/**
 * The Emails module surface.
 *
 * Listing and reading are held by `email.viewOwn` (every role) but row-scoped in
 * the service, so the permission only opens the module — the list a caller
 * actually gets is theirs alone unless they hold `email.viewAll`. Sending an
 * invoice is `email.send` (ACCT/ADMIN), the roles that can generate one.
 */
@Controller('api/emails')
export class EmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Get()
  @Can('email.viewOwn')
  list(@Query() query: EmailsQueryDto, @CurrentUser() user: AuthUser) {
    return this.emails.list(user, query);
  }

  // Declared before :id would matter only if a static segment clashed; there is
  // none, but the send route is a POST so there is no ambiguity either way.
  @Post('invoice')
  @Can('email.send')
  sendInvoice(@Body() dto: SendInvoiceDto, @CurrentUser() user: AuthUser) {
    return this.emails.sendInvoice(dto, user);
  }

  @Get(':id')
  @Can('email.viewOwn')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.emails.get(id, user);
  }
}
