import { overallOf, renderStatusPage } from './health.page';
import { ProbeResult } from './health.service';

const at = new Date('2026-07-15T08:00:00.000Z');

const probe = (
  component: ProbeResult['component'],
  status: ProbeResult['status'],
  latencyMs: number | null = 5,
): ProbeResult => ({ component, status, latencyMs, error: null, checkedAt: at });

describe('overallOf', () => {
  it('is operational when everything answers', () => {
    expect(overallOf([probe('api', 'OPERATIONAL'), probe('database', 'OPERATIONAL')])).toBe(
      'operational',
    );
  });

  it('is a partial outage when some but not all are down', () => {
    expect(overallOf([probe('api', 'OPERATIONAL'), probe('database', 'DOWN')])).toBe(
      'partial_outage',
    );
  });

  it('is a major outage only when nothing answers', () => {
    expect(overallOf([probe('api', 'DOWN'), probe('database', 'DOWN')])).toBe('major_outage');
  });

  it('reports down over degraded — the worse news wins', () => {
    expect(overallOf([probe('api', 'DEGRADED'), probe('database', 'DOWN')])).toBe('partial_outage');
  });

  /**
   * The point of the UNCONFIGURED status. An operator who never set up SMTP has
   * not got an email outage, and painting the banner red for one would train
   * everyone to ignore the banner.
   */
  it('does not count an unconfigured component as an outage', () => {
    const results = [probe('api', 'OPERATIONAL'), probe('email', 'UNCONFIGURED', null)];
    expect(overallOf(results)).toBe('operational');
  });

  it('is unknown before the first probe lands, not operational', () => {
    expect(overallOf([])).toBe('unknown');
    expect(overallOf([probe('email', 'UNCONFIGURED', null)])).toBe('unknown');
  });
});

describe('renderStatusPage', () => {
  const base = {
    results: [probe('api', 'OPERATIONAL'), probe('database', 'OPERATIONAL', 4)],
    history: new Map(),
    measuringSince: null,
    windowDays: 90,
    consoleUrl: 'https://console.example.com',
    now: at,
  };

  it('draws one tick per day in the window', () => {
    const html = renderStatusPage({ ...base });
    // Four components on the page, 90 days each.
    expect(html.split('class="tick').length - 1).toBe(4 * 90);
  });

  /**
   * The load-bearing honesty check. This table started recording on the day it
   * shipped; a green bar for the 89 days before that would be fabricated.
   */
  it('draws days with no probes as no-data, never as uptime', () => {
    const html = renderStatusPage({ ...base });
    // Match rendered ticks, not the stylesheet — it defines every tone class
    // whether or not a tick uses one.
    expect(html).toContain('class="tick tick--none"');
    expect(html).not.toContain('class="tick tick--ok"');
    expect(html).toContain('No data yet');
  });

  it('reports uptime from real buckets', () => {
    const history = new Map([
      ['database', new Map([['2026-07-15', { day: '2026-07-15', ok: 99, degraded: 0, down: 1 }]])],
    ]);
    const html = renderStatusPage({ ...base, history: history as never });
    expect(html).toContain('99.00% uptime');
  });

  it('truncates uptime rather than rounding a bad day up to 100%', () => {
    const history = new Map([
      [
        'database',
        new Map([['2026-07-15', { day: '2026-07-15', ok: 99_996, degraded: 0, down: 4 }]]),
      ],
    ]);
    const html = renderStatusPage({ ...base, history: history as never });
    expect(html).toContain('99.99% uptime');
    expect(html).not.toContain('100.00% uptime');
  });

  /**
   * This route is public. A probe failure names internal hosts and ports, so
   * the page must never carry one — see HealthProbe.error in schema.prisma.
   */
  it('never leaks a probe error onto the page', () => {
    const leaky: ProbeResult = {
      component: 'database',
      status: 'DOWN',
      latencyMs: 12,
      error: 'connect ECONNREFUSED 10.0.0.5:5432',
      checkedAt: at,
    };
    const html = renderStatusPage({ ...base, results: [probe('api', 'OPERATIONAL'), leaky] });
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).not.toContain('10.0.0.5');
    expect(html).toContain('Partial outage');
  });

  /**
   * A down probe's "latency" is just how long it waited before giving up. Next
   * to the word "Down" it reads as a slow reply rather than no reply.
   */
  it('does not print a latency for something that never answered', () => {
    const down: ProbeResult = {
      component: 'database',
      status: 'DOWN',
      latencyMs: 10_002,
      error: 'timed out',
      checkedAt: at,
    };
    const html = renderStatusPage({ ...base, results: [down] });
    expect(html).not.toContain('10.00 s');
    expect(html).toContain('Down');
  });

  it('prints a latency for something that did answer', () => {
    const html = renderStatusPage({ ...base, results: [probe('database', 'DEGRADED', 890)] });
    expect(html).toContain('890 ms');
  });

  it('escapes what it interpolates', () => {
    const html = renderStatusPage({ ...base, consoleUrl: 'https://x.test/"><script>bad()</script>' });
    expect(html).not.toContain('<script>bad()');
  });
});
