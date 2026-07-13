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

Cookie attributes are centralized in `backend/src/common/cookie.ts`, and there is
a deployment trap encoded there worth understanding:

> `up.railway.app` is on the **Public Suffix List**. Browsers therefore treat
> `vfw-console.up.railway.app` and `vfw-api.up.railway.app` as **different
> sites**, which makes the session a *third-party* cookie. It works today under
> `SameSite=None; Secure`, but Safari's ITP already blocks that shape and Chrome
> is phasing it out — so sign-in would begin failing **in the browser only**,
> while the API kept working fine under `curl`.
>
> **The fix is a custom domain.** Serve the SPA from `app.example.com` and the
> API from `api.example.com`, then set `COOKIE_DOMAIN=.example.com`. Both are now
> the same site, the cookie downgrades to `SameSite=Lax`, and nothing is
> third-party. Get a domain before going live.

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
