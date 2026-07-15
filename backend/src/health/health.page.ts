import { COMPONENTS, ComponentId, DayBucket, ProbeResult, ProbeStatus } from './health.service';

/**
 * The status page, server-rendered.
 *
 * Design notes, so the next person changing this knows what is deliberate:
 *
 * - Every colour and font stack is lifted from frontend/src/styles/console.css.
 *   This page is served by the API and cannot import that stylesheet, so the
 *   tokens are duplicated here. If the console's palette moves, move these.
 * - The console paints its theme from localStorage['vfw-theme'] before first
 *   render (see frontend/index.html). In production the frontend proxies /api,
 *   so this page is same-origin and can read the same key — a user who set the
 *   console to dark gets a dark status page. Falls back to the OS preference.
 * - Numbers are mono and tabular throughout. That is the house rule from
 *   console.css: "Money and IDs are always set in mono, like a ledger." Latency
 *   and uptime are read by scanning a column, so they follow it.
 * - The uptime strip is the one flourish: it prints in left-to-right on load,
 *   like a tape. Everything else is deliberately still.
 *
 * Nothing here reports an error string. This endpoint is public, and a probe
 * failure names internal hosts and ports.
 */

export type Overall = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown';

export interface PageData {
  results: ProbeResult[];
  history: Map<ComponentId, Map<string, DayBucket>>;
  measuringSince: Date | null;
  windowDays: number;
  consoleUrl: string;
  now: Date;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Verdicts ---------------------------------------------------------------

/**
 * The banner.
 *
 * UNCONFIGURED components are not counted: an operator who never set up SMTP
 * has not got an email outage, and letting that paint the page red would train
 * everyone to ignore it.
 */
export function overallOf(results: ProbeResult[]): Overall {
  const live = results.filter((r) => r.status !== 'UNCONFIGURED');
  if (live.length === 0) return 'unknown';

  const down = live.filter((r) => r.status === 'DOWN').length;
  if (down > 0) return down === live.length ? 'major_outage' : 'partial_outage';
  if (live.some((r) => r.status === 'DEGRADED')) return 'degraded';
  return 'operational';
}

const OVERALL_COPY: Record<Overall, string> = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  unknown: 'Checking systems',
};

const OVERALL_TONE: Record<Overall, string> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'warn',
  major_outage: 'bad',
  unknown: 'none',
};

const STATE_COPY: Record<ProbeStatus, string> = {
  OPERATIONAL: 'Operational',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
  UNCONFIGURED: 'Not configured',
};

const STATE_TONE: Record<ProbeStatus, string> = {
  OPERATIONAL: 'ok',
  DEGRADED: 'warn',
  DOWN: 'bad',
  UNCONFIGURED: 'none',
};

type Tone = 'ok' | 'warn' | 'bad' | 'none';

/**
 * One day, one tick. A day with no probes is 'none' (grey), never green —
 * this table started recording on the day it shipped, and claiming uptime for
 * the 89 days before that would be inventing evidence.
 */
function toneOfDay(bucket: DayBucket | undefined): Tone {
  if (!bucket) return 'none';
  const measured = bucket.ok + bucket.degraded + bucket.down;
  if (measured === 0) return 'none';
  const ratio = bucket.ok / measured;
  if (bucket.down > 0) return ratio < 0.95 ? 'bad' : 'warn';
  if (bucket.degraded > 0) return 'warn';
  return 'ok';
}

// --- Formatting -------------------------------------------------------------

/** UTC day keys, oldest first — the axis the ticks are drawn against. */
function windowDays(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function fullDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Latency is only shown for something that answered.
 *
 * A DOWN probe still has a number — the time it took to give up — but printing
 * "10.00 s" next to "Down" reads as a slow reply rather than no reply, and the
 * figure is really just the probe timeout. It stays in the JSON, where a
 * monitor can tell the difference.
 */
function latency(status: ProbeStatus, ms: number | null): string {
  if (ms === null || (status !== 'OPERATIONAL' && status !== 'DEGRADED')) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Truncated, not rounded: 99.996% must not read as 100%. */
function uptimePct(ok: number, measured: number): string {
  const pct = Math.floor((ok / measured) * 10000) / 100;
  return `${pct.toFixed(2)}%`;
}

// --- Fragments --------------------------------------------------------------

function renderTape(days: string[], buckets: Map<string, DayBucket>): string {
  return days
    .map((day, i) => {
      const bucket = buckets.get(day);
      const tone = toneOfDay(bucket);
      const measured = bucket ? bucket.ok + bucket.degraded + bucket.down : 0;
      const title =
        measured === 0
          ? `${longDay(day)} — no data`
          : `${longDay(day)} — ${uptimePct(bucket!.ok, measured)} uptime, ${measured.toLocaleString('en')} checks`;
      // Inline delay: 90 nth-child rules to say the same thing would be worse.
      return `<i class="tick tick--${tone}" style="animation-delay:${i * 3}ms" title="${esc(title)}"></i>`;
    })
    .join('');
}

function renderComponent(
  spec: (typeof COMPONENTS)[number],
  result: ProbeResult | undefined,
  buckets: Map<string, DayBucket>,
  days: string[],
): string {
  const status: ProbeStatus = result?.status ?? 'UNCONFIGURED';
  const tone = STATE_TONE[status];

  let ok = 0;
  let measured = 0;
  for (const day of days) {
    const b = buckets.get(day);
    if (!b) continue;
    ok += b.ok;
    measured += b.ok + b.degraded + b.down;
  }

  const summary =
    status === 'UNCONFIGURED'
      ? 'Not set up on this server'
      : measured === 0
        ? 'No data yet'
        : `${uptimePct(ok, measured)} uptime`;

  const ms = latency(status, result?.latencyMs ?? null);

  return `
    <li class="comp" data-component="${esc(spec.id)}">
      <div class="comp-head">
        <div class="comp-id">
          <h2>${esc(spec.label)}</h2>
          <p>${esc(spec.blurb)}</p>
        </div>
        <div class="comp-state">
          <span class="state state--${tone}" data-state>
            <i class="dot"></i>${esc(STATE_COPY[status])}
          </span>
          <span class="mono lat" data-latency>${esc(ms)}</span>
        </div>
      </div>
      <div class="tape" role="img" aria-label="${esc(`${spec.label}: ${summary} over the past ${days.length} days`)}">
        ${renderTape(days, buckets)}
      </div>
      <div class="tape-foot mono">
        <span>${days.length} days ago</span>
        <span class="tape-rule"></span>
        <span class="tape-num">${esc(summary)}</span>
        <span class="tape-rule"></span>
        <span>Today</span>
      </div>
    </li>`;
}

// --- Page -------------------------------------------------------------------

export function renderStatusPage(data: PageData): string {
  const { results, history, measuringSince, consoleUrl, now } = data;
  const days = windowDays(now, data.windowDays);
  const byId = new Map(results.map((r) => [r.component, r]));
  const overall = overallOf(results);

  const components = COMPONENTS.map((spec) =>
    renderComponent(spec, byId.get(spec.id), history.get(spec.id) ?? new Map(), days),
  ).join('');

  const since = measuringSince
    ? `Uptime measured from ${fullDate(measuringSince)}.`
    : 'Uptime recording starts with the first check.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VFW Status</title>
<meta name="description" content="Live operational status of the VFW Console.">
<meta name="robots" content="noindex">
<script>
  // Mirrors frontend/index.html: paint the console's saved theme before first
  // render, so a user who set the console to dark never gets flashed white.
  (function () {
    try {
      var v = localStorage.getItem('vfw-theme') || 'system';
      var dark = v === 'dark' ||
        (v === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    } catch (e) {}
  })();
</script>
<style>
${STYLES}
</style>
</head>
<body>
<div class="page">

  <header class="head">
    <div class="brand">
      <span class="mark">VFW</span>
      <span class="wordmark">Status</span>
    </div>
    <a class="back" href="${esc(consoleUrl)}">Open console</a>
  </header>

  <section class="banner banner--${OVERALL_TONE[overall]}" data-banner>
    <h1 data-headline>${esc(OVERALL_COPY[overall])}</h1>
    <p class="checked mono">
      Checked <time data-checked datetime="${now.toISOString()}">just now</time>
    </p>
  </section>

  <p class="tape-intro">Uptime over the past ${days.length} days.</p>

  <ul class="components">${components}</ul>

  <footer class="foot">
    <p>Checks run every 60 seconds. ${esc(since)}</p>
    <p class="mono">vfw-api</p>
  </footer>

</div>
<script>
${SCRIPT}
</script>
</body>
</html>`;
}

// --- Styles -----------------------------------------------------------------

const STYLES = `
/* Tokens mirror frontend/src/styles/console.css. Keep them in step. */
:root{
  --paper:#EDEFF2; --card:#FFFFFF; --line:#D8DCE2; --line-soft:#E8EBEF;
  --ink:#0E0E11; --text:#15161A; --muted:#6A7280;
  --blue:#2F6BFF; --green:#0C7A4D; --amber:#A96C05; --red:#B3332A;
  --tick-none:#CFD5DD;
  --r:5px;
  --shadow:0 1px 0 rgba(16,18,22,.04), 0 8px 24px -18px rgba(16,18,22,.35);
}
:root[data-theme="dark"]{
  --paper:#121218; --card:#1C1C23; --line:#2E2E38; --line-soft:#25252E;
  --ink:#0B0B0E; --text:#E7E9ED; --muted:#9BA2AE;
  --blue:#5E8BFF;
  /* The console's light greens/ambers/reds are tuned for white cards and go
     muddy on ink. Lifted here for contrast, same hues. */
  --green:#2FA971; --amber:#D89A25; --red:#E0655A;
  --tick-none:#33333F;
  --shadow:0 1px 0 rgba(0,0,0,.35), 0 12px 30px -20px rgba(0,0,0,.8);
}

*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  font-family:"IBM Plex Sans",system-ui,sans-serif;
  background:var(--paper); color:var(--text);
  font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
h1,h2,.wordmark{font-family:"Archivo","IBM Plex Sans",sans-serif}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
a{color:var(--blue)}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}

.page{max-width:880px;margin:0 auto;padding:40px 20px 64px}

/* --- Header --- */
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:40px}
.brand{display:flex;align-items:center;gap:12px}
.mark{
  width:34px;height:34px;border-radius:50%;background:var(--ink);color:#fff;
  display:grid;place-items:center;
  font-family:"Archivo","IBM Plex Sans",sans-serif;font-weight:800;font-size:10px;letter-spacing:-.3px;
}
:root[data-theme="dark"] .mark{background:#fff;color:#0B0B0E}
.wordmark{font-size:19px;font-weight:800;letter-spacing:-.01em;text-transform:uppercase}
.back{
  font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;
  text-decoration:none;color:var(--muted);border:1px solid var(--line);
  border-radius:100px;padding:7px 14px;background:var(--card);
  transition:color .15s, border-color .15s;
}
.back:hover{color:var(--text);border-color:var(--muted)}

/* --- Banner --- */
.banner{
  border-radius:var(--r);padding:24px 26px;margin-bottom:44px;color:#fff;
  display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
  box-shadow:var(--shadow);
}
.banner h1{font-size:clamp(20px,3vw,27px);font-weight:800;letter-spacing:-.01em;line-height:1.15}
.banner .checked{font-size:12px;opacity:.82}
.banner--ok{background:var(--green)}
.banner--warn{background:var(--amber)}
.banner--bad{background:var(--red)}
.banner--none{background:var(--muted)}
:root[data-theme="dark"] .banner{color:#0B0B0E}
:root[data-theme="dark"] .banner .checked{opacity:.72}

.tape-intro{text-align:right;color:var(--muted);font-size:12px;margin-bottom:10px}

/* --- Components --- */
.components{list-style:none;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.comp{padding:22px 24px 20px}
.comp + .comp{border-top:1px solid var(--line-soft)}
.comp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.comp-id h2{font-size:16px;font-weight:700;letter-spacing:-.01em}
.comp-id p{color:var(--muted);font-size:12px;margin-top:3px}
.comp-state{display:flex;align-items:center;gap:12px;flex-shrink:0}
.state{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600}
.state--ok{color:var(--green)}
.state--warn{color:var(--amber)}
.state--bad{color:var(--red)}
.state--none{color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.lat{font-size:12px;color:var(--muted);min-width:52px;text-align:right}

/* --- The tape: 90 days, one tick each --- */
.tape{display:flex;gap:2px;height:34px;align-items:stretch}
.tick{flex:1 1 0;min-width:0;border-radius:1px;background:var(--tick-none)}
.tick--ok{background:var(--green)}
.tick--warn{background:var(--amber)}
.tick--bad{background:var(--red)}
.tick--none{background:var(--tick-none)}

.tape-foot{display:flex;align-items:center;gap:10px;margin-top:9px;font-size:11px;color:var(--muted)}
.tape-rule{flex:1;height:1px;background:var(--line)}
.tape-num{color:var(--text);font-weight:500}

/* --- Footer --- */
.foot{display:flex;justify-content:space-between;gap:12px;margin-top:28px;color:var(--muted);font-size:11.5px;flex-wrap:wrap}

/* The tape prints in, left to right, once. The only motion on the page. */
@keyframes print{from{transform:scaleY(.2);opacity:0}to{transform:scaleY(1);opacity:1}}
.tick{transform-origin:bottom;animation:print .32s cubic-bezier(.2,.8,.2,1) backwards}

@media (max-width:640px){
  .page{padding:28px 14px 48px}
  .tape{gap:1px;height:30px}
  .comp{padding:18px 16px 16px}
  .comp-head{flex-direction:column;gap:10px}
  .comp-state{width:100%;justify-content:space-between}
  .lat{text-align:left}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
`;

// --- Client script ----------------------------------------------------------

/**
 * Keeps the live half of the page current without a reload: re-reads the same
 * endpoint as JSON and rewrites the banner, the states and the latencies. The
 * tape is not touched — it only changes at a day boundary, and reprinting it
 * every 30s would be noise.
 */
const SCRIPT = `
(function () {
  var TONE = { OPERATIONAL:'ok', DEGRADED:'warn', DOWN:'bad', UNCONFIGURED:'none' };
  var COPY = { OPERATIONAL:'Operational', DEGRADED:'Degraded', DOWN:'Down', UNCONFIGURED:'Not configured' };
  var BANNER = {
    operational:['ok','All systems operational'], degraded:['warn','Degraded performance'],
    partial_outage:['warn','Partial outage'], major_outage:['bad','Major outage'],
    unknown:['none','Checking systems']
  };

  var checked = document.querySelector('[data-checked]');

  function ago() {
    if (!checked) return;
    var secs = Math.max(0, (Date.now() - new Date(checked.dateTime).getTime()) / 1000);
    checked.textContent =
      secs < 45 ? 'just now' :
      secs < 5400 ? Math.round(secs / 60) + ' min ago' :
      Math.round(secs / 3600) + ' hr ago';
  }

  // Mirrors latency() in health.page.ts: only something that answered gets a
  // number. See the comment there.
  function latency(status, ms) {
    if (ms === null || ms === undefined) return '';
    if (status !== 'OPERATIONAL' && status !== 'DEGRADED') return '';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }

  function paint(data) {
    var banner = document.querySelector('[data-banner]');
    var look = BANNER[data.status] || BANNER.unknown;
    banner.className = 'banner banner--' + look[0];
    document.querySelector('[data-headline]').textContent = look[1];

    (data.checks || []).forEach(function (c) {
      var row = document.querySelector('[data-component="' + c.component + '"]');
      if (!row) return;
      var state = row.querySelector('[data-state]');
      state.className = 'state state--' + (TONE[c.status] || 'none');
      state.innerHTML = '<i class="dot"></i>';
      state.appendChild(document.createTextNode(COPY[c.status] || c.status));
      row.querySelector('[data-latency]').textContent = latency(c.status, c.latencyMs);
    });

    if (checked) { checked.dateTime = data.time; ago(); }
  }

  function poll() {
    fetch(location.pathname, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) paint(d); })
      // A failed poll leaves the last known state on screen rather than
      // blanking the page. The timestamp keeps ageing, which is the tell.
      .catch(function () {});
  }

  ago();
  setInterval(ago, 15000);
  setInterval(poll, 30000);
  // Catch up immediately on return, rather than showing a stale tab.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });
})();
`;
