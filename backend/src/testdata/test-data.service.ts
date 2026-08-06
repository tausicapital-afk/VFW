import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.guard';
import { ConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CatalogueMarkResult,
  DEMO_SUBMISSION_REFS,
  MarkResult,
  markCatalogueTestData,
  markTestData,
} from './test-data.marker';

/** The most refs one call may carry. A backfill is a surgical act, not a sweep. */
const MAX_REFS = 500;

@Injectable()
export class TestDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What the Test data card shows: whether the runtime switch is on, and how
   * many rows of each kind currently carry the flag.
   *
   * The counts are the honest answer to "did the backfill do anything" — the
   * only other way to find out is to go and look at every module table, which is
   * the thing this feature exists to save you from.
   */
  async summary() {
    const [submissions, contacts, payments, emails, events, packages, addons, attendance, payroll] =
      await Promise.all([
        this.prisma.submission.count({ where: { isTestData: true } }),
        this.prisma.contact.count({ where: { isTestData: true } }),
        this.prisma.payment.count({ where: { isTestData: true } }),
        this.prisma.emailMessage.count({ where: { isTestData: true } }),
        this.prisma.event.count({ where: { isTestData: true } }),
        this.prisma.package.count({ where: { isTestData: true } }),
        this.prisma.addon.count({ where: { isTestData: true } }),
        this.prisma.attendanceEntry.count({ where: { isTestData: true } }),
        this.prisma.payrollInvoice.count({ where: { isTestData: true } }),
      ]);

    return {
      /** Mirrors TEST_DATA_MODE, so the card never disagrees with the switch above it. */
      mode: this.config.testDataMode,
      demoRefs: DEMO_SUBMISSION_REFS,
      counts: {
        submissions,
        contacts,
        payments,
        emails,
        events,
        packages,
        addons,
        attendance,
        payroll,
      },
    };
  }

  /**
   * Mark existing submissions (and what belongs to them) as test data.
   *
   * `refs` empty means the five demo sales this system shipped with — the one
   * case common enough to be worth a button rather than typing five references
   * into a box. Everything else has to be named.
   *
   * Audited like any other administrative write. A backfill changes how every
   * table in the console reads, and "who decided these rows were a rehearsal"
   * is exactly the question someone asks three months later.
   */
  async mark(
    dto: { refs?: string[]; includeRelated?: boolean; unmark?: boolean },
    actor: AuthUser,
  ): Promise<MarkResult> {
    const refs = dto.refs?.length ? dto.refs : DEMO_SUBMISSION_REFS;
    if (refs.length > MAX_REFS) {
      throw new BadRequestException(
        `Too many references at once (${refs.length}). Mark at most ${MAX_REFS} per request.`,
      );
    }

    const result = await this.prisma.$transaction((tx) =>
      markTestData(tx, {
        refs,
        includeRelated: dto.includeRelated,
        unmark: dto.unmark,
      }),
    );

    await this.audit.log({
      actorId: actor.id,
      action: dto.unmark ? 'TEST_DATA_UNMARKED' : 'TEST_DATA_MARKED',
      detail:
        `${result.submissions} submission(s) ${dto.unmark ? 'cleared' : 'marked'} as test data` +
        (result.unknownRefs.length ? ` — ${result.unknownRefs.length} unknown reference(s)` : ''),
      payload: { refs, ...result } as unknown as Prisma.InputJsonValue,
    });

    return result;
  }

  /** The catalogue half — a show or a package that only ever existed for a demo. */
  async markCatalogue(
    dto: { eventIds?: string[]; packageIds?: string[]; addonIds?: string[]; unmark?: boolean },
    actor: AuthUser,
  ): Promise<CatalogueMarkResult> {
    const result = await this.prisma.$transaction((tx) => markCatalogueTestData(tx, dto));

    await this.audit.log({
      actorId: actor.id,
      action: dto.unmark ? 'TEST_DATA_UNMARKED' : 'TEST_DATA_MARKED',
      detail:
        `Catalogue ${dto.unmark ? 'cleared' : 'marked'} as test data: ` +
        `${result.events} show(s), ${result.packages} package(s), ${result.addons} add-on(s)`,
      payload: { ...dto, ...result } as unknown as Prisma.InputJsonValue,
    });

    return result;
  }
}
