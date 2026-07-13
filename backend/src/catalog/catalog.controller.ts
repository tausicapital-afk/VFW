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
    const [events, packages, addons, taxes, glAccounts, cities] = await Promise.all([
      this.prisma.event.findMany({ include: { city: true }, orderBy: { start: 'asc' } }),
      this.prisma.package.findMany({ include: { prices: true }, orderBy: { brand: 'asc' } }),
      this.prisma.addon.findMany({ orderBy: { brand: 'asc' } }),
      this.prisma.taxProfile.findMany(),
      this.prisma.glAccount.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.city.findMany(),
    ]);
    return { events, packages, addons, taxes, glAccounts, cities };
  }
}

@Module({ controllers: [CatalogController] })
export class CatalogModule {}
