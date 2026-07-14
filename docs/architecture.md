# VFW Console — Architecture

How this system is put together, and why. Written for whoever picks it up next.

---

## 1. Where this came from

The whole system descends from a single file: `vfw-console.html`, a working
client-side prototype of the console. It is not a wireframe — it is a
specification. It already contains:

- a **permission matrix** (`ACL`, line 481) covering five roles,
- a **submission lifecycle** (Draft → Pending → Returned/Approved/Rejected → Exported),
- a **priced catalogue** transcribed from the real sales decks — 7 events across
  6 cities, 14 packages priced per-city in 5 currencies, 11 add-ons, 6 tax
  profiles, 8 GL accounts,
- a **pricing engine** (`calc()`, line 1069) that every screen calls,
- and a **REST client** (`API_BASE`, line 518) that already calls the exact
  endpoints it expects a backend to serve.

So the job was never "design an ERP". It was "build the backend that file already
assumes, and port the UI onto it". The mockup remains in the repo root as the
reference for anything not yet built — **when in doubt, read the mockup.**

---

## 2. Shape of the system

```
┌─────────────────┐        ┌──────────────────┐        ┌────────────┐
│  frontend/      │ /api   │  backend/        │        │ PostgreSQL │
│  React + Vite   │───────▶│  NestJS + Prisma │───────▶│            │
│  (static SPA)   │ cookie │  (REST API)      │        │            │
└─────────────────┘        └──────────────────┘        └────────────┘
   Railway service            Railway service           Railway plugin
```

Two deployables plus a managed database. The SPA is a static bundle; it holds no
secrets and enforces no rules. All authority lives in the API.

### Why this stack

**PostgreSQL** — This is accounting software. It computes tax and commission in
five currencies, generates invoices, and keeps an audit trail the UI advertises
as permanent. That needs transactions, foreign keys, and exact decimal money. A
document store would have been actively wrong. Postgres also covers the softer
needs: JSONB for audit payloads, window functions for the leaderboard and
revenue-by-city reports, full-text search for contact lookup.

**NestJS + Prisma** — An ERP is module- and permission-shaped, which is what Nest
is good at. The mockup's `ACL` matrix becomes one guard instead of role checks
scattered through controllers. Prisma gives a migration history, which matters
the first time an accountant asks why a number changed.

**React + Vite** — The mockup is already a hash-routed SPA with role-filtered
navigation, so the port is close to mechanical. **The stylesheet was kept
verbatim** (`frontend/src/styles/console.css`, extracted from the mockup) rather
than rewritten in Tailwind — the design system is good, and rewriting it would
have cost a week and lost fidelity.

---

## 3. The rules that hold this together

Four invariants. Everything else is detail.

### 3.1 Money is never a float

Postgres `NUMERIC(14,2)` → Prisma `Decimal` → serialized to the browser as a
**string**, not a number (`backend/src/main.ts` overrides `Decimal.prototype.toJSON`).
The frontend parses only at the edge, to format for display, and never does
arithmetic on a total.

`decimal.js` is used server-side, so `0.1 + 0.2` is `0.3` and a tax line cannot
drift by a cent. Rounding is 2dp half-up — the convention an accountant expects.

### 3.2 The server prices the sale, not the client

`POST /api/submissions` accepts *what was sold* — event, package, add-on IDs,
discount, deposit. It does **not** accept a price, a subtotal, a tax amount, or a
total. Those are computed server-side from the catalogue by `PricingService`.

The DTO whitelist enforces this literally: a client that sends `total` gets a 400
telling it that property should not exist. It is not possible to talk this API
into a price it did not calculate itself.

`PricingService` (`backend/src/pricing/pricing.service.ts`) is a direct port of
the mockup's `calc()`. The one rule worth stating aloud:

> **Commission is struck on net revenue, never on tax.** The company merely
> collects tax on behalf of a government; nobody earns commission on it.

**Deep discounts need sign-off, at approval.** A rep may still propose any
discount up to 100% — that is sales discretion, and `create`/`update` are
unchanged. But a discount deeper than `Settings.discountApprovalPct` (default
15%) cannot be *approved* silently: `POST /api/submissions/:id/approve` returns
400 unless the approver explicitly sends `acknowledgeDiscountOverride: true`,
in the same named-and-explicit spirit as the "client sends `total` → 400" rule.
The audit entry then records the threshold that was in force and the discount
that beat it, so the trail says *why* sign-off was required rather than just
`APPROVED`.

The check (`PricingService.discountApproval`) is **derived, never stored**: it is
computed from the submission's own money at the moment it is asked, so Accounting
moving the threshold re-judges the next approval with no migration and no
backfill. It compares the discount's *share of the subtotal*, so an `AMT` discount
is measured against the same percentage threshold a `PCT` one is — otherwise a
flat amount would be a way around the rule.

### 3.3 Authorization is server-side; the frontend copy is cosmetic

The matrix exists twice, on purpose:

| File | Purpose |
|---|---|
| `backend/src/common/acl.ts` | Decides what is **allowed**. The security boundary. |
| `frontend/src/lib/acl.ts` | Decides what is **rendered**. Hides buttons. Not a boundary. |

If they ever disagree, the server wins — an API call made without permission
fails there regardless of what the client believed. The guard
(`common/auth.guard.ts`) is registered **globally**, so an endpoint is locked
down unless it explicitly opts out with `@Public()`. A new route cannot leak by
someone forgetting to protect it.

Row-level scoping is separate from the permission check: a sales rep sees only
their own customers. Asking for another rep's submission returns **404, not 403**
— the same answer as a record that does not exist, so a rep cannot probe for the
existence of other people's deals.

### 3.4 The audit trail is append-only

`AuditService` deliberately exposes no `update()` and no `delete()`. Every state
change writes an entry **inside the same transaction** as the change it
describes — an approval that commits without its audit row, or an audit row
without its approval, is worse than either failing outright.

---

## 4. Data model

`backend/prisma/schema.prisma`. Grouped by concern:

**People & access** — `User` (5 roles, `PENDING` until an admin approves),
`Invitation` (signup is invite-only), `LoginAttempt` (brute-force lockout, keyed
by attempted email so a failed login cannot reveal which addresses are
registered), `PasswordReset`.

**Catalogue** (admin-editable reference data) — `TaxProfile`, `City`, `Event`,
`Package`, `PackagePrice`, `Addon`, `GlAccount`.

> `PackagePrice` is a separate table because a package has a **different price
> and currency in every city** it is sold in. GFC Gold is $33,100 in New York and
> €30,600 in Milan. Price cannot live on `Package`.

**Customers** — `Contact`, unique per brand. The mockup auto-creates a contact
the first time a sale is submitted for a brand nobody has sold to before; the API
does the same via `upsert`.

**The core record** — `Submission`, plus `SubmissionAddon`, `Payment`,
`Document`, `InternalComment`, `DesignerFeedback`, `AuditEntry`, `Settings`.

> `SubmissionAddon` copies the add-on's price onto the line at submission time.
> If Accounting later edits the catalogue price, historical submissions must not
> move.

`Settings` is a single pinned row (`id = 1`) holding the fiscal year, invoice
sequence, discount-approval threshold, FX rates to CAD (the reporting currency),
and leaderboard score weights — held in the database so Accounting can change
them without a deploy.

---

## 5. Sessions

The session is a JWT in an **httpOnly cookie**. There is no token in
`localStorage` and nothing for a script on the page to steal; the SPA sends it
automatically with `credentials: "include"`.

Cookie attributes are centralized in `backend/src/common/cookie.ts`.

### The cookie is first-party, because there is only one origin

The browser never talks to the API's domain. The frontend service serves the SPA
*and* reverse-proxies `/api/*` to the backend (`frontend/nginx.conf.template`),
so every request — assets and API alike — goes to the frontend origin. The
session cookie is therefore **first-party**, and `SameSite=Lax` is correct.

Verified in a real Chromium against production (2026-07-13), signing in as
`marielle@vanfashionweek.com`. `POST /api/auth/login` → `201` returned:

```
Set-Cookie: vfw_session=<JWT>; Max-Age=86400; Path=/; Expires=Tue, 14 Jul 2026 08:00:59 GMT;
            HttpOnly; Secure; SameSite=Lax
```

The browser stored it host-only on `frontend-production-b4a4.up.railway.app`
(there is no `Domain=` attribute, because `COOKIE_DOMAIN` is unset and should
stay that way). `GET /api/auth/me` then returned `200`, and `document.cookie`
read back empty — `HttpOnly` is doing its job.

> **This section used to say the opposite.** It described the session as a
> third-party cookie on `SameSite=None`, doomed by Safari's ITP and Chrome's
> third-party phase-out, and prescribed a custom domain as the fix. That was true
> of an earlier two-origin deployment. The nginx proxy removed the second origin,
> which removed the problem. **A custom domain is now a nice-to-have (branding),
> not a prerequisite for shipping.** Do not "fix" the cookie again.

`COOKIE_SAMESITE=none` remains as an escape hatch for a genuinely cross-site
deployment (SPA and API on different sites, no proxy). It forces `Secure`,
because browsers ignore `SameSite=None` without it. Nothing sets it today.

**The one thing still worth doing** *(in progress — the code half is done, the
dashboard half is not)*: the backend also has its own public Railway domain
(`backend-production-8dcb.up.railway.app`), so the API is reachable *without*
going through the nginx proxy. Nothing depends on that path — it is only an extra
front door — but it is the one that makes the rate limiter's client IP forgeable
(see §10.1).

Closing it is three things:

1. the backend now listens on `::` rather than `0.0.0.0` (`main.ts`), because
   Railway's private network is **IPv6-only** and an app bound to `0.0.0.0`
   cannot be reached on it at all — **done**;
2. `BACKEND_URL` on the frontend service points at
   `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}` rather than the
   public URL — **a Railway variable, not a file in this repo**;
3. the backend's public domain is removed in the Railway dashboard — **manual;
   it cannot be scripted.** Exact steps in `docs/DEPLOYMENT.md` → *Closing the
   backend's public door*.

`TRUST_PROXY_HOPS` must be re-measured with `GET /api/health/ip` when (2) lands:
the change removes a hop from the chain, and a stale count is its own bug.

---

## 6. Layout

```
├── vfw-console.html        the original prototype — still the spec for unbuilt screens
├── docker-compose.yml      local Postgres (port 5434)
├── docs/
│   ├── architecture.md     this file
│   └── roadmap.md          what is left to build
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma   the domain
│   │   └── seed.ts         catalogue, transcribed from the decks. Idempotent.
│   └── src/
│       ├── common/         acl.ts · auth.guard.ts · cookie.ts
│       │                   throttler.ts · logging.ts · sentry.ts   (§10)
│       ├── pricing/        the single pricing engine
│       ├── audit/          append-only log
│       ├── auth/           login, lockout, sessions
│       ├── catalog/        reference data for the submission form
│       └── submissions/    create · approve · reject · return
└── frontend/
    ├── src/styles/
    │   ├── console.css     the mockup's stylesheet, VERBATIM. Do not rewrite.
    │   └── additions.css   the only additions: .note.good / .bad / .warn
    ├── src/lib/            api client · types · acl (render-only) · formatters
    ├── src/auth/           session context
    ├── src/shell/          rail, role-filtered nav, page chrome
    └── src/pages/          Login · Dashboard · NewSubmission · Submissions
                            · SubmissionDetail · Queue
```

**On the CSS:** `console.css` is the mockup's stylesheet, unmodified. Build
against the classes it already defines — `.split`, `.fields`, `.checks`/`.chk`,
`.totals > .r`, `.log > .e`, `.modal > .box`, `.btn.primary`, `.kpi`,
`.pill.{STATUS}`, `.tag.{BRAND}`. Inventing new class names was tried and
produced a broken layout; don't repeat it.

---

## 7. Local development

```bash
docker compose up -d                 # Postgres on :5434

cd backend
cp .env.example .env                 # then set a real JWT_SECRET
npm install
npx prisma migrate dev
npx prisma db seed                   # catalogue + demo users
npm run dev                          # :3001

cd ../frontend
npm install
npm run dev                          # :5173, proxies /api → :3001
```

Demo accounts, password `Vfw@2026!`:

| Email | Role |
|---|---|
| `marielle@vanfashionweek.com` | Sales |
| `accounting@vanfashionweek.com` | Accounting |
| `sales.director@vanfashionweek.com` | Manager |
| `it@vanfashionweek.com` | Admin |

In dev, Vite proxies `/api` to the backend so the browser sees a single origin —
no CORS, and the session cookie stays same-site.

---

## 8. What is verified

The approval flow was driven end-to-end in a real browser (Playwright), not just
unit-tested:

1. Sales rep signs in — approval queue is **absent** from their navigation.
2. Builds a GFC Milan submission: Gold €30,600 + rights €760, less 5%.
   Server computes €29,792 net → 8% GFC tax €2,383.36 → **€32,175.36** total.
3. Accounting signs in — navigation now shows the queue, with a badge.
4. Approves it to GL 4050.
5. Audit trail shows `SUBMITTED` (Marielle) and `APPROVED` (Hannah).

Boundaries probed directly against the API:

| Attempt | Result |
|---|---|
| No session → `GET /api/submissions` | 401 |
| Sales rep → `POST /approve` | 403 |
| Sales rep → `GET /queue` | 403 |
| Rep A → `GET` rep B's submission | **404** (not 403) |
| Client sends its own `total` | 400 — "property total should not exist" |
| VFW package at a GFC show | 400 — brand mismatch |
| VKFW add-on on a GFC package | 400 — not sold for that brand |
| USD add-on on a EUR sale | 400 — mixed currency has no correct total |
| 120% discount | 400 |
| Approving an already-approved record | 400 |
| Approving a 25% discount against a 15% threshold, unacknowledged | 400 |
| …the same one with `acknowledgeDiscountOverride: true` | 201 + audit records the override |

---

## 9. Decisions worth not re-litigating

- **Postgres, not Mongo.** Money, transactions, audit.
- **Server-side pricing.** The client sends inputs, never figures.
- **Kept the mockup's CSS.** Fidelity beats a framework rewrite.
- **Global auth guard, opt-out.** Endpoints cannot leak by omission.
- **404, not 403, on another rep's record.** Prevents existence probing.
- **Documents belong in object storage** (Cloudflare R2 / S3), not a Railway
  volume — volumes do not survive redeploys cleanly and do not scale past one
  instance. The `Document` model stores a `storageKey`, not a file.
- **QuickBooks export starts synchronous.** Add Redis and a job queue when it
  actually needs retries, not before.
- **The cookie is settled.** It is first-party `SameSite=Lax` behind the nginx
  proxy. Do not re-fix it; see §5.

---

## 10. Hardening

### 10.1 Rate limiting

`backend/src/common/throttler.ts`. Two buckets, both keyed by client IP; a
request must satisfy every bucket that applies to it.

| Bucket | Applies to | Limit | On breach |
|---|---|---|---|
| `auth` | `POST /api/auth/*` | 10 / min | **429 for 15 min** |
| `global` | everything else | 300 / min | 429 until the window rolls |

`GET /api/health` is exempt — Railway probes it every few seconds and throttling
it would fail the deploy.

The limits live in one table rather than in `@Throttle()` decorators on each
controller, so a new endpoint cannot be born unlimited by someone forgetting to
decorate it. The throttler guard is registered **before** the auth guard, so a
flood is turned away before it costs a JWT verification, a database round-trip or
an argon2 hash.

This **layers with**, and does not replace, the per-email lockout in
`AuthService`. They stop different attacks, and you can watch both fire:

```
# same email, wrong password, 14 times
attempts 1–5    401 Email or password is incorrect
attempts 6–10   401 Too many attempts. Try again in 15 minute(s).   <- per-email lockout
attempts 11+    429 Too many requests.                              <- IP throttle

# attacker rotates the email each time, dodging the per-email lockout entirely
victim1–10      401 Email or password is incorrect   (lockout never fires)
victim11+       429 Too many requests.               <- only the IP throttle stops this
```

> **`TRUST_PROXY_HOPS` is the load-bearing setting here.** The limiter keys on
> `req.ip`, and behind a proxy that value is only as good as the hop count.
> Set it too low and every user shares the proxy's IP — one bucket for the whole
> company, and real people start getting 429s. Set it to `true`/too high and the
> app believes a caller-supplied `X-Forwarded-For`, which an attacker simply
> rotates to get unlimited buckets. It is a **number**, counted from the right of
> the header, past the hops our own infrastructure appended.
>
> `GET /api/health/ip` exists to tune it: call it through the real front door and
> confirm the `ip` it returns is your own address.

> **Known gap, half-closed.** The backend still has its own public Railway
> domain, so an attacker can skip nginx, hit the API directly, and forge
> `X-Forwarded-For`. The code side is now done — the app listens on `::` so the
> private network can reach it (§5) — but the two remaining steps are **Railway
> configuration, not code**: point `BACKEND_URL` at `RAILWAY_PRIVATE_DOMAIN`, then
> remove the backend's public domain in the dashboard. Until both are done, this
> gap is still open. Steps and verification: `docs/DEPLOYMENT.md` → *Closing the
> backend's public door*.

### 10.2 Logging and error tracking

`common/logging.ts` (pino) and `common/sentry.ts`. One rule governs both:

> **A secret must never reach a log line or an error report.** Logs get shipped,
> tailed and pasted into tickets; Sentry is read by more people than are allowed
> to sign in to an ERP. A session cookie in either is a session anyone holding it
> can replay.

So, in both sinks: no `cookie` / `set-cookie` header, no `authorization` header,
and **no request body at all** — a body is where a password lives, and there is
no redaction rule to get wrong if it is never serialized. Sentry additionally
runs with `sendDefaultPii: false`; the user is attached as `{id, role}`, never an
email. Its default integrations would happily send all of the above, so the
scrubbing in `beforeSend` is not belt-and-braces — it is the whole belt.

Every request carries a `request_id`, logged by pino and set as a Sentry tag, so
one incident joins up across the two.

Sentry is **optional**: with no `SENTRY_DSN`, `initSentry()` returns false and the
app runs normally. An observability vendor being unconfigured must never stop the
API from booting.

Verified by taking Postgres down under a live authenticated request. The
resulting `PrismaClientKnownRequestError` arrived with
`transaction: GET /api/submissions`, `user: {id, role}` and the request id — and
with `request.headers` containing only `host`, `user-agent` and `accept`, even
though the request that produced it carried the session cookie.

### 10.3 Secrets

`JWT_SECRET` in Railway was checked on 2026-07-13: 96 hex characters, uniformly
distributed — a real `randomBytes(48)` value, not the `.env.example` placeholder.
It was **not** rotated, and should not be casually: **rotating `JWT_SECRET`
invalidates every session and signs everyone out**, because it is the key the
session JWTs are verified with. Rotate it deliberately (on suspected compromise,
or on staff departure), not as routine hygiene.

### 10.4 Backups

See `docs/runbook-backups.md`.

---

## 11. Messaging

Team chat inside the console — DMs and groups, WhatsApp-Web style: real-time
delivery, typing indicators, online/last-seen presence, sent/delivered/read
ticks, and image/media attachments. `backend/src/messaging/`,
`frontend/src/pages/Messages.tsx`. It is **additive** — new tables only, nothing
in the money loop changed — and deliberately **not** part of `AuditEntry`, which
is financial evidence, not a chat log.

### 11.1 Transport — the first WebSocket surface

Everything else in this system is REST. Messaging adds a socket.io gateway
(`messaging.gateway.ts`) mounted at **`/api/socket.io`**, so it rides the same
nginx front door as the API and the session cookie stays first-party. The plain
`/api/` proxy block does not pass the HTTP/1.1 `Upgrade` handshake, so
`nginx.conf.template` has a dedicated `location /api/socket.io/` block (and Vite
proxies it with `ws: true` in dev).

The global HTTP `AuthGuard` cannot see a WebSocket handshake, so the gateway
authenticates it directly with the **same** `vfw_session` cookie via the shared
`verifySession()` helper — one definition of "who is this token", used by both
the guard and the gateway. Conversely, the global guards now no-op on non-HTTP
contexts (`ctx.getType() !== 'http'`), so a global guard does not wrongly gate a
socket message handler.

The durable side (history, sending, media) is REST; the live side (typing,
presence, receipts) is the socket. A message is **persisted over REST**, then
fanned out over the socket — so validation, the ACL and the membership check run
once, in one place.

### 11.2 Receipts are cursors, not rows

Rather than a row per message per recipient, each `ConversationParticipant`
carries two ordinals — `lastReadSeq` and `lastDeliveredSeq` — against
`Message.seq`, a global autoincrement. A tick is then a comparison
(`messaging/receipts.ts`, pure and unit-tested like `score.ts`): **delivered**
when every *other* participant's delivered-cursor has reached the message,
**read** when every other read-cursor has. In a group that means the *minimum*
across everyone, so ✓✓-blue only lands once the last person has read it. Cursors
only ever move forward (`GREATEST` in SQL), so an out-of-order client can't
rewind a receipt.

### 11.3 Boundary and access

`messaging.use` is held by every role — anyone may message anyone. The real
boundary is **membership**: `assertMember()` gates every read and write, and a
non-member gets **404, not 403** (the same existence-hiding answer the rest of
the system gives for another rep's record). A DM is idempotent — the two userIds
are sorted into a unique `dmKey`, so opening the same DM twice reuses the one
thread. Group rename / add / remove require `isAdmin`; anyone can leave; a DM
cannot be left.

### 11.4 Media

Reuses the R2 `StorageService` and the presigned-PUT/GET model exactly as
documents do — the bytes never pass through the API, and with `R2_*` unset the
presign returns a **loud 503**, never a silent local-disk fallback. Images get
an `inline` content-disposition so they render in the bubble; other files
download.

### 11.5 Presence and scale

Presence is an **in-memory map** in the gateway (userId → set of live sockets),
so "online" and "last seen" are correct for **one backend instance**. Scaling
past one needs the socket.io **Redis adapter** and a shared presence store — a
documented follow-up, consistent with keeping Redis out until it is actually
needed (see QBO, §Decisions).

### 11.6 Socket flooding

The HTTP throttler (§10.1) is a Nest guard over an Express request and cannot see
a socket event, so inbound socket events carry their own limiter:
`messaging/socket-throttle.ts`. It is the same *shape* as the HTTP one — one
table of buckets, each with a limit and a block duration, and an event must
satisfy every bucket that applies to it — so there is one style of rate limiting
here, not two.

| Bucket | Applies to | Limit | On breach |
|---|---|---|---|
| `typing` | `typing` | 60 / min | blocked 1 min |
| `events` | every socket event | 240 / min | blocked 1 min |

Two things differ from the HTTP side, both on purpose:

- **Keyed by userId, not IP.** The socket is already authenticated on its
  handshake, so the real actor is known. IP-keying would put a whole NAT'd office
  in one bucket and let one person's flood throttle their colleagues.
- **The counter survives a disconnect.** Clearing a user's window when their last
  socket closes would hand every flooder a reset button — disconnect, reconnect,
  carry on. Windows expire on time and only on time.

On a breach the socket gets a typed `{ event, bucket, retryAfterMs }` on a
`rate_limited` event, rather than being silently dropped (a client that cannot
distinguish "throttled" from "lost" retries, making it worse) or hard-
disconnected (which would kill a legitimate user's other tabs over one runaway
one). Unit-tested pure, like `receipts.ts`, with the clock injected.

> Note **what is not in this table: sending a message.** Messages are persisted
> over REST and only *fanned out* over the socket (§11.1), so the send path is
> already covered by the HTTP throttler's `global` bucket — though that one is
> IP-keyed, not per-user.

**Verified live** (2026-07-13) with two cookie-authenticated socket clients:
a DM message delivered to the recipient in real time and turned the sender's
tick ✓ → ✓✓ → blue ✓✓ as it was delivered then read; a typing indicator crossed;
an outsider got 404 on the thread; a 3-person group fanned a message to both
others; presign 503'd without R2; and a disconnect produced an offline+last-seen
presence event. `backend/` tests: **98 passing**, including
`messaging/receipts.spec.ts` and `messaging/messaging.service.spec.ts`.
