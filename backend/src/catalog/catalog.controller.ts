import { Controller, Get, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reference data the new-submission form needs. One round trip rather than six,
 * because the form cannot render anything useful until it has all of it.
 */
@Controller('api/catalog')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async all() {
    const [events, packages, addons, taxes, glAccounts, cities, seasons, settings] = await Promise.all([
      this.prisma.event.findMany({ include: { city: true }, orderBy: { start: 'asc' } }),
      this.prisma.package.findMany({ include: { prices: true }, orderBy: { brand: 'asc' } }),
      this.prisma.addon.findMany({ orderBy: { brand: 'asc' } }),
      this.prisma.taxProfile.findMany(),
      this.prisma.glAccount.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.city.findMany(),
      this.prisma.season.findMany({ orderBy: { label: 'asc' } }),
      // Just the one figure the Queue screen needs to flag a deep discount —
      // not the rest of Settings, which stays behind admin.manage. A hardcoded
      // frontend copy of this threshold would silently drift from the real one
      // the backend enforces at approval time.
      this.prisma.settings.findUnique({ where: { id: 1 }, select: { discountApprovalPct: true } }),
    ]);
    return {
      events,
      packages,
      addons,
      taxes,
      glAccounts,
      cities,
      seasons,
      discountApprovalPct: settings?.discountApprovalPct ?? 0,
    };
  }
}

@Module({ controllers: [CatalogController] })
export class CatalogModule {}
