import type { INestApplication } from '@nestjs/common';
import type { Response as SuperagentResponse } from 'superagent';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Logs exports — Activity, Sessions and Users.
 *
 * All three are user-monitoring, so the gate is the point: 'activity.view' is
 * ADMIN-only, and unlike the submissions dataset none of these scope rows to the
 * caller. Accounting can read the audit trail; nobody but an admin gets a file
 * of who was online and what they opened.
 */

const ADMIN = 'it@vanfashionweek.com';
const ACCT = 'accounting@vanfashionweek.com';

function binaryParser(
  res: SuperagentResponse,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('logs exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let acct: string;
  const logs: string[] = [];
  const sessions: string[] = [];

  const pull = async (dataset: string, query = '') => {
    const res = await http(app)
      .get(`/api/export/${dataset}?format=csv${query}`)
      .set('Cookie', admin)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return (res.body as Buffer).toString('utf8');
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
    acct = await loginCookie(app, ACCT);
  }, 60_000);

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { id: { in: logs } } });
    await prisma.userSession.deleteMany({ where: { id: { in: sessions } } });
    await app.close();
  });

  describe.each([
    ['activity', 'Activity'],
    ['sessions', 'Sessions'],
    ['log-users', 'Users'],
  ])('%s (Logs → %s)', (dataset) => {
    it('renders in all three formats', async () => {
      for (const format of ['csv', 'xlsx', 'pdf'] as const) {
        const res = await http(app)
          .get(`/api/export/${dataset}?format=${format}`)
          .set('Cookie', admin)
          .buffer(true)
          .parse(binaryParser)
          .expect(200);
        expect((res.body as Buffer).length).toBeGreaterThan(0);
      }
    }, 30_000);

    it('is admin-only — not even accounting may pull it', async () => {
      await http(app).get(`/api/export/${dataset}?format=csv`).set('Cookie', acct).expect(403);
    });
  });

  it('honours the Activity tab\'s action filter', async () => {
    const mk = async (action: string, detail: string) => {
      const row = await prisma.activityLog.create({ data: { action, detail } });
      logs.push(row.id);
    };
    await mk('LOG_TEST_ONE', 'first log detail');
    await mk('LOG_TEST_TWO', 'second log detail');

    const filtered = await pull('activity', '&action=LOG_TEST_ONE');
    expect(filtered).toContain('first log detail');
    expect(filtered).not.toContain('second log detail');
    expect(filtered).toContain('LOG TEST ONE'); // spelled as the screen spells it
  }, 30_000);

  it('honours the Sessions tab\'s state dropdown, and says so for a live session', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: ADMIN } });
    const open = await prisma.userSession.create({
      data: { userId: user.id, ip: '10.0.0.7' },
    });
    sessions.push(open.id);
    const closed = await prisma.userSession.create({
      data: { userId: user.id, ip: '10.0.0.8', endedAt: new Date(), durationSec: 8040 },
    });
    sessions.push(closed.id);

    const openOnly = await pull('sessions', '&state=open');
    expect(openOnly).toContain('10.0.0.7');
    expect(openOnly).not.toContain('10.0.0.8');
    // A live session has no duration yet, and the file cannot tick — so it says
    // "Still open" rather than printing a number that is wrong on arrival.
    expect(openOnly).toContain('Still open');

    const closedOnly = await pull('sessions', '&state=closed');
    expect(closedOnly).toContain('10.0.0.8');
    expect(closedOnly).not.toContain('10.0.0.7');
    expect(closedOnly).toContain('2h 14m'); // 8040s, as the screen writes it
  }, 30_000);

  it('names the online column for what it is — a snapshot', async () => {
    const csv = await pull('log-users');
    // Live on the screen, true only of the moment the file was made. Every
    // seeded account has signed in by now, so "No" is the honest value here.
    expect(csv).toContain('Online at export');
    expect(csv).toMatch(/,(Yes|No),/);
  }, 30_000);

  it('prints "Never" for an account that has never signed in', async () => {
    // Never having signed in is a finding — a dormant or forgotten account is
    // exactly what someone exports this to look for. An empty cell would read
    // as missing data instead.
    const dormant = await prisma.user.create({
      data: {
        name: 'Dormant Account',
        email: `dormant-${Date.now()}@vanfashionweek.com`,
        passwordHash: 'x',
        role: 'SALES',
      },
    });
    try {
      const csv = await pull('log-users');
      const row = csv.split('\n').find((l) => l.startsWith('Dormant Account'));
      expect(row).toContain('Never');
    } finally {
      await prisma.user.delete({ where: { id: dormant.id } });
    }
  }, 30_000);

  it('keeps the staff roster and the usage view as separate files', async () => {
    // Same people, different questions: `users` is the admin roster (commission,
    // target), `log-users` is console usage. Confusing them would put pay data
    // in a security export.
    const roster = await pull('users');
    const usage = await pull('log-users');
    expect(roster).toContain('Commission %');
    expect(usage).not.toContain('Commission %');
    expect(usage).toContain('Time online');
  }, 30_000);
});
