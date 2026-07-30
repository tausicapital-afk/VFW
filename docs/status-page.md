# VFW Console — Status Page & Health Probes

How `GET /api/health` came to serve both a machine probe and a public status
page, what it measures, and which parts are deliberately conservative. Written
for whoever picks it up next.

---

## 1. What this is, and what it is not

`/api/health` used to return one line of JSON. It still does — but a browser now
gets a status page instead: a banner, four components, and 90 days of daily
uptime bars.

It is **one URL with two audiences**, resolved by content negotiation:

| Caller | `Accept` | Gets |
| --- | --- | --- |
| Railway probe, curl, monitors | `*/*` or absent | The same JSON as always, plus `checks` |
| A person in a browser | `text/html,…` | The status page |

What it is **not**:

- **Not an incident tool.** There is no subscribe button, no incident history, no
  maintenance windows. The reference design (`status.claude.com`) has those; we
  have no system behind them, and a button that does nothing is worse than no
  button.
- **Not an external monitor.** Every probe runs *from inside the API process*.
  This matters more than it sounds — see §8.
- **Not a replacement for `ok`.** The healthcheck contract Railway restarts the
  container on is unchanged. See §3.

---

## 2. Why the history table exists

Uptime cannot be computed from the present tense. A live check can only ever say
"up right now"; the bars need a record of what was true on each of the last 90
days, and nothing in the system had one.

So `HealthProbe` exists, and the bars only start filling in **from the day it
shipped**. The 89 days before that are drawn grey — "no data" — and the footer
says so. Green bars for days nobody was watching would have been fabricated
evidence, which in a system whose whole premise is that records are evidence is
not a small thing.

This is the honest cost of the feature: it looks sparse for its first quarter.
Do not be tempted to backfill it.

---

## 3. The contract that did not change

```jsonc
{
  "ok": true,              // unchanged
  "service": "vfw-api",    // unchanged
  "time": "2026-07-15T…",  // unchanged
  "status": "operational", // added
  "checks": [ … ]          // added
}
```

**`ok: true` means "this process is up and serving". It does NOT mean "every
dependency is healthy".** That distinction is load-bearing and deliberate:

Railway restarts the container when this endpoint fails. If a Postgres blip made
`/api/health` return 503, a brief database wobble would take the API down too and
restart-loop until the database came back — converting a recoverable outage into
a compound one. So the process reports on itself, and per-component state lives
in `checks`, where a monitor can read it *without* holding a restart trigger.

If you ever want "fail the deploy when Postgres is down", that is a new endpoint,
not a change to this one.

---

## 4. Data model

### `HealthProbe` — one row per component per check

```prisma
model HealthProbe {
  id        String   @id @default(cuid())
  component String   // "api" | "database" | "storage" | "email"
  status    String   // OPERATIONAL | DEGRADED | DOWN | UNCONFIGURED
  latencyMs Int?
  error     String?
  checkedAt DateTime @default(now())

  @@index([component, checkedAt])
  @@index([checkedAt])
}
```

Migration: `20260715170000_health_probes`.

Like `ActivityLog`, this is **operational telemetry and deliberately not
`AuditEntry`** — it is not financial evidence, it touches nothing in the money
loop, and nothing writes back over a row. A probe is a dated observation: written
once, aged out at 90 days by a sweep that runs hourly (`RETENTION_DAYS`).

### The four statuses, and why `UNCONFIGURED` is one of them

`UNCONFIGURED` is **not an outage**. An operator who never set up SMTP does not
have an email outage — there is nothing there to be down. It is excluded from
uptime maths and from the banner entirely.

This is a correctness rule, not a cosmetic one. A banner that goes red because
R2 was never configured in dev is a banner everyone learns to ignore, and then
nobody notices the real outage.

### `error` is stored, never served

The column holds *why* a probe failed, for an operator reading the table
directly. It is **never** rendered on the page and **never** returned by the
API: `/api/health` is public and a connection error names internal hosts and
ports. `health.spec.ts` asserts that `ECONNREFUSED 10.0.0.5:5432` cannot reach
the page.

---

## 5. The prober

`HealthService` runs a cycle every **60s**, keeps the newest result per component
in memory, and appends each fresh observation to the table.

**The request path never probes.** Railway hits this endpoint every few seconds;
a healthcheck that opened a database connection and an SMTP session per call
would be a self-inflicted outage. Requests read the in-memory snapshot, which is
at most one cycle stale.

| Component | Label | Probe | Degraded above | Sampled every |
| --- | --- | --- | --- | --- |
| `api` | API | none — this process is answering | n/a, never timed | cycle (60s) |
| `database` | Database | `SELECT 1` | 250 ms | cycle (60s) |
| `storage` | Document storage | `HeadBucketCommand` (moves no bytes) | 1500 ms | 5 min |
| `email` | Outbound email | `transporter.verify()` (sends nothing) | 3 s | 15 min |

Storage and email cost a round-trip to a third party, so they are sampled below
the cycle rate — a bar built from 96 honest samples beats one that gets the SMTP
account rate-limited. When a component is not due, the previous result stands and
**no row is written**. Fewer samples is honest; inventing a sample we did not
take is not.

Every probe is wrapped in a **10s timeout**, so one dead socket cannot stall the
others. `EmailService.verify()` was added for this and is shared with the admin
"send test email" button.

### The prober does not run under tests

`onModuleInit` returns early when `NODE_ENV === 'test'`. The e2e suite boots the
whole `AppModule`; left alone the prober would open a real SMTP connection to the
configured mail host and write rows into the test database on every boot. A test
suite has no business reaching a third party. Anything testing the prober calls
`runCycle()` directly.

---

## 6. Reading the bars

One tick per UTC day, aggregated in Postgres (`COUNT(*) FILTER (WHERE …)` grouped
by day) — at full history this is ~130k rows per component, and shipping them to
Node to count would be absurd.

| Tick | Meaning |
| --- | --- |
| Grey | No probes that day. Not an outage, not uptime — no data. |
| Green | Every probe OK. |
| Amber | Any degraded, or some failures with ≥95% still OK. |
| Red | Failures, and OK ratio below 95%. |

Uptime percentages are **truncated, not rounded**: 99.996% must read as `99.99%`,
never `100.00%`. A day with a real outage must not round up into a clean sheet.

The banner: any `DOWN` → *Partial outage*, or *Major outage* if everything live
is down; else any `DEGRADED` → *Degraded performance*; else *All systems
operational*. Before the first cycle lands it reads *Checking systems*, not
*operational* — we do not claim health we have not measured.

---

## 7. The page

Server-rendered from `health.page.ts`. Two guards keep a public HTML route from
becoming a cheap way to make the database work:

1. **Rate limiting.** `/api/health` is exempt from the global throttle so
   Railway's probe never fails a deploy — but the exemption now applies **only
   when the response is JSON**. The HTML page sits inside the normal 300/min
   bucket, which no human clicking refresh can reach.
   (`isHealthCheck()` in `common/throttler.ts`.)
2. **Cache + single-flight.** The render is reused for 60s, and concurrent misses
   share one render rather than starting N rollups.

The live half of the page (banner, states, latencies) is refreshed by a small
poller against the cheap JSON branch every 30s and on `visibilitychange`. The
bars are not repainted — they only move at a day boundary.

### Design

Every colour and font stack is **lifted from `frontend/src/styles/console.css`**.
The API cannot import that stylesheet, so the tokens are duplicated in
`health.page.ts`; if the console's palette moves, move these. Numbers are mono
and tabular throughout, following the house rule already stated in that file:
*"Money and IDs are always set in mono, like a ledger."*

The page reads `localStorage['vfw-theme']` exactly as `frontend/index.html` does.
In production the frontend proxies `/api`, so this is same-origin and a user who
set the console to dark gets a dark status page; in local dev (`:3001` direct) it
falls back to the OS preference. The console's light greens/ambers/reds are tuned
for white cards and go muddy on ink, so the dark theme lifts them — same hues,
higher contrast.

### Latency is only shown for something that answered

A `DOWN` probe has a number — how long it waited before giving up — but printing
`10.00 s` next to *Down* reads as a slow reply rather than no reply, and the
figure is really just the probe timeout. It stays in the JSON, where a monitor
can tell the difference.

---

## 8. Known limitations

**An outage of the API itself shows as grey, not red.** The prober lives inside
the API. If the process is down it writes no rows, so those minutes are simply
absent, and a full day of downtime renders as *no data* rather than a red bar.
The bars therefore **understate** outages of the API itself. Detecting that
honestly needs a prober outside the process — the classic reason status pages are
hosted elsewhere.

**A database outage may not reach the history.** `record()` writes probes to the
same Postgres it is probing. When the database is what is down, the write fails
and is swallowed (by design — failing to record that the database is down must
not also take out the page trying to say so). Live status is correct via the
in-memory snapshot; the bar for that period may show no data.

**`api` is a liveness bar, not a latency bar.** Its probe reaches nothing — the
process is answering by definition — so it only records that the prober ran.

**Multiple replicas each run their own prober.** Every instance writes its own
rows, so sample counts multiply and the ratio reflects a blend of vantage points.
The day rollup still works; the raw counts are not "checks per minute".

**Email bars are coarse.** 15-minute sampling means ~96 points a day; a short SMTP
blip between samples is invisible.

---

## 9. What is verified

`backend/src/health/health.spec.ts` — 14 tests covering the banner verdicts,
`UNCONFIGURED` never counting as an outage, unknown-before-first-probe, one tick
per day, no-data days never rendering as uptime, truncation, error redaction,
latency suppression on `DOWN`, and escaping.

Verified by hand against a running stack:

- Content negotiation direct (`:3001`) and through the frontend proxy (`:5173`):
  browser → HTML, `*/*` → JSON, no `Accept` → JSON.
- Throttle split: JSON exempt (no counter movement); HTML counted (297→296→295).
- Page cache: three requests inside the TTL returned byte-identical renders.
- Theme inheritance through the proxy: saved `dark` → `data-theme="dark"`,
  `light` → `light`.
- Probes accumulating with real recovery observed (email `DOWN` ×3 → `OPERATIONAL`),
  proving the prober does not latch on a failure.
- Prober silent under `NODE_ENV=test`: probe count unchanged across an
  app-booting e2e run.

---

## 10. Applying it

```bash
cd backend
npx prisma migrate deploy   # or: npm run prisma:migrate
npm run dev
```

Then open <http://localhost:3001/api/health> in a browser for the page, or
`curl` it for the JSON.

Nothing needs configuring for the page to work. Components without credentials
report *Not configured* rather than failing — set the `R2_*` vars to bring
document storage into the picture, and the `MAIL_*` vars for outbound email
(see `email-and-otp.md`).

---

## 11. Decisions worth not re-litigating

- **One URL, negotiated** — rather than a separate `/api/status`. The probe
  contract is untouched, and there is one address to remember.
- **`ok` stays process-scoped.** See §3. Changing it trades a database blip for a
  restart loop.
- **`UNCONFIGURED` is not red.** A banner that cries wolf gets ignored.
- **No backfill, ever.** Grey means we were not watching. That is a fact about
  the system, and it is allowed to be visible.
- **Errors never leave the table.** The route is public.
