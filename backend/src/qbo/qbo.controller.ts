import { Body, Controller, Delete, Get, Module, Param, Post, Query, Res } from '@nestjs/common';
import { QboMappingKind } from '@prisma/client';
import type { Response } from 'express';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import { QboCallbackQueryDto, QboMappingDto } from './dto';
import { QboApiService } from './qbo-api.service';
import { QboConnectionService } from './qbo-connection.service';
import { QboExportService } from './qbo-export.service';
import { QboMappingService } from './qbo-mapping.service';

/**
 * Everything an administrator needs to connect this console to QuickBooks
 * Online and map its chart of accounts. Same `admin.manage` gate as
 * SystemConfigModule, spelled out per handler for the same reason — this
 * hands out and revokes a live QuickBooks credential.
 */
@Controller('api/admin/qbo')
export class QboAdminController {
  constructor(
    private readonly connection: QboConnectionService,
    private readonly mapping: QboMappingService,
  ) {}

  @Get('status')
  @Can('admin.manage')
  status() {
    return this.connection.status();
  }

  /**
   * A top-level browser navigation, not a fetch — it has to leave the SPA
   * entirely to reach Intuit's consent screen, so this redirects the whole
   * window rather than returning JSON for the frontend to act on.
   */
  @Get('connect')
  @Can('admin.manage')
  connect(@CurrentUser() user: AuthUser, @Res() res: Response) {
    res.redirect(this.connection.authorizeUrl(user));
  }

  /**
   * Where Intuit sends the browser back to. Also a top-level navigation (the
   * user's whole tab left the SPA to authorize), so failure has to redirect
   * somewhere sensible too rather than render raw JSON — back to the
   * Configuration tab either way, with a query param the frontend reads to
   * show the outcome.
   */
  @Get('callback')
  @Can('admin.manage')
  async callback(@Query() query: QboCallbackQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const back = (params: Record<string, string>) => {
      const base = this.connection.redirectUri().replace(/\/api\/admin\/qbo\/callback$/, '/admin');
      const url = new URL(base);
      url.searchParams.set('tab', 'config');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res.redirect(url.toString());
    };
    try {
      await this.connection.handleCallback(query, user);
      back({ qbo: 'connected' });
    } catch (e) {
      back({ qbo: 'error', qboMessage: e instanceof Error ? e.message : 'Could not connect to QuickBooks' });
    }
  }

  @Post('disconnect')
  @Can('admin.manage')
  async disconnect(@CurrentUser() user: AuthUser) {
    await this.connection.disconnect(user);
    return this.connection.status();
  }

  @Get('mappings')
  @Can('admin.manage')
  mappings() {
    return this.mapping.list();
  }

  @Post('mappings')
  @Can('admin.manage')
  setMapping(@Body() dto: QboMappingDto, @CurrentUser() user: AuthUser) {
    return this.mapping.set(dto.kind, dto.localCode, dto.qboId, dto.qboLabel, user);
  }

  @Delete('mappings/:id')
  @Can('admin.manage')
  removeMapping(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mapping.remove(id, user);
  }

  /** The live QBO objects a mapping of this kind can point at, for the picker. */
  @Get('browse/:kind')
  @Can('admin.manage')
  browse(@Param('kind') kind: QboMappingKind) {
    return this.mapping.browse(kind);
  }
}

/**
 * The read-only connection status any ACCT/ADMIN who can see the QuickBooks
 * screen may check — same permission as the export button itself
 * (`quickbooks.export`), and no admin-only detail (no realm id, no token
 * timing) in the response.
 */
@Controller('api/qbo')
export class QboController {
  constructor(private readonly connection: QboConnectionService) {}

  @Get('status')
  @Can('quickbooks.export')
  async status() {
    const s = await this.connection.status();
    return { connected: s.connected, environment: s.environment, companyName: s.companyName };
  }
}

@Module({
  controllers: [QboAdminController, QboController],
  providers: [QboConnectionService, QboApiService, QboMappingService, QboExportService],
  exports: [QboConnectionService, QboExportService],
})
export class QboModule {}
