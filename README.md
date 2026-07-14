# VFW Console

**Sales runs on a system, not email.**

The internal console for VFW Management Inc. — submissions, accounting review,
QuickBooks hand-off, and sales performance across every VFW Management show:

- **VFW** — Vancouver Fashion Week
- **VKFW** — Vancouver Kids Fashion Week
- **GFC** — Global Fashion Collective (Tokyo · New York · London · Milan · Paris)

A sales rep builds a priced submission from the official rate card, accounting
reviews and approves it, and the approved sale is exported to QuickBooks Online.
Every record is financial evidence: submissions are never deleted, only moved
through their status lifecycle, and every transition is appended to an audit
trail.

---

## What's in the repo

| Path | What it is |
|------|-----------|
| `vfw-console.html` | The complete front-of-house app — a single, self-contained HTML file. Vanilla JS, no framework, no build step. Runs standalone in demo mode, or points at the backend. |
| `backend/` | NestJS + Prisma + PostgreSQL API. The domain schema (`prisma/schema.prisma`) and seed data (`prisma/seed.ts`) are defined; the service layer under `src/` is the work in progress. |
| `docker-compose.yml` | PostgreSQL 16 for local development. |

---

## The product

### Submission lifecycle

Every sale is a submission that walks a fixed path — the app renders it as a
lit "runway track":

```
DRAFT → PENDING → APPROVED → EXPORTED
              ↘ RETURNED (back to sales)
              ↘ REJECTED
```

- **Sales** create and price drafts, then submit for approval.
- **Accounting** reviews the queue: approve, reject with a reason, or return to
  sales for a fix. On approval they set GL account, cost centre, and department.
- Approved submissions are exported to **QuickBooks Online** as invoices.

### Money engine

Pricing is computed as `subtotal → discount → tax → total → balance`. Money is
`NUMERIC(14,2)` end to end and surfaces as a `Decimal` — no float ever touches a
price, tax amount, or commission. Commission is struck on **net revenue
(taxable)**, never on tax. In connected mode the server is the source of truth:
the client sends inputs (package, add-ons, discount) and never sends a total.

The catalog — packages, add-ons, tax profiles, and GL accounts — is transcribed
from the official FW26 sales decks and the GFC Designer Agreement, priced per
city and currency (USD / CAD / GBP / EUR / JPY).

### Roles & access

Invitation-only signup, with an admin approving each account before it can
authenticate (`PENDING → ACTIVE`). Every guarded action routes through a single
permission matrix (`can()` / the `ACL`).

| Role | Can |
|------|-----|
| `SALES` / `INTERN` | Create and edit their own submissions, view the leaderboard |
| `ACCT` | Approve / reject / return, set accounting fields, run QuickBooks export, view reports |
| `MGR` | View all submissions, reports, designer feedback, internal notes |
| `ADMIN` | Everything, plus user administration and settings |

### Navigation

**Work** — Dashboard · New submission · Submissions · Contacts · Approval queue · QuickBooks
**People** — Leaderboard · Designer feedback · Internal notes
**Insight** — Reports · Audit trail
**System** — Administration

The leaderboard ranks reps by a 100-point performance score. Contacts are
auto-created the first time a sale is submitted for a brand not seen before.

---

## Running the frontend

The frontend runs on its own with no backend and no build step — but **it must
be served over `https://` or `localhost`**, not opened from disk.

> The login/signup flow hashes passwords with the Web Crypto API
> (`crypto.subtle`), which browsers only expose in a secure context. Opening the
> file directly via a `file://` path (double-clicking it) or over plain
> `http://` disables it silently and login will fail. The page shows a banner
> when this happens.

Serve the folder locally, for example:

```bash
npx serve .
# then open http://localhost:3000/vfw-console.html
```

In standalone **demo mode**, accounts, sessions, and submissions live in the
browser's sandboxed storage (memory fallback if unavailable). The login screen
lists demo credentials; the shared demo password is `Vfw@2026!`. Use
**Admin → Data** to export a JSON backup.

To switch to **connected mode**, set `API_BASE` near the top of the `<script>`
in `vfw-console.html` to your deployed backend URL. Nothing else in the file
needs to change — sessions and enforcement move server-side automatically.

---

## Running the backend

The backend is a [NestJS](https://nestjs.com/) app using
[Prisma](https://www.prisma.io/) over PostgreSQL.

### 1. Start the database

```bash
docker compose up -d db
```

This runs PostgreSQL 16 on host port **5434**.

### 2. Configure and install

```bash
cd backend
cp .env.example .env   # if present; otherwise create .env (see below)
npm install
```

`.env` needs at least a connection string pointing at the compose database:

```
DATABASE_URL="postgresql://vfw:vfw@localhost:5434/vfw"
```

### 3. Migrate, seed, and run

```bash
npm run prisma:generate   # generate the Prisma client
npm run prisma:migrate    # apply migrations (dev)
npm run seed              # load catalog + demo data
npm run dev               # start with watch mode
```

Other scripts: `npm run build`, `npm run start:prod`, `npm run prisma:deploy`
(migrate deploy for production), and `npm run release` (deploy + start).

### Data model

`backend/prisma/schema.prisma` defines the full domain: `User`, `Invitation`,
`Submission` (the core record) and `SubmissionAddon`, `Payment`, `Document`,
`Contact`, `Event`, `City`, `Package` / `PackagePrice`, `Addon`, `TaxProfile`,
`GlAccount`, `InternalComment`, `DesignerFeedback`, `AuditEntry`, and
`Settings`. Submissions are immutable financial records — status transitions,
not deletes.

---

## Deploying to Railway

The repo is set up to run as **three services in one Railway project**:

| Service | Source | Notes |
|---------|--------|-------|
| **Postgres** | Railway database plugin | Injects `DATABASE_URL` into the backend. |
| **backend** | `backend/` (`Dockerfile` + `railway.json`) | Runs `prisma migrate deploy` then boots the API. Health check: `/api/health`. |
| **frontend** | `frontend/` (`Dockerfile` + `railway.json`) | Builds the Vite bundle and serves it as a static SPA. |

Both services build from a committed `Dockerfile`, so the build is identical on
Railway, in CI, and locally.

### How deploys actually happen: GitHub Actions

**Railway's GitHub integration is deliberately NOT connected.** Neither service
has a repo source, so Railway itself does nothing when you push. All deploys are
driven by `.github/workflows/deploy.yml`:

```
push to main → ci.yml (build · test · type-check)
                  └─ on success → deploy.yml
                         ├─ railway up --service backend   (runs prisma migrate deploy, then boots)
                         ├─ railway up --service frontend
                         └─ poll /api/health until 200
```

Deploys are gated on green CI and run against the exact commit CI validated, so
a failing test never reaches production. Backend goes first: it applies pending
migrations on boot, and if a migration fails the job stops before the frontend
ships against a schema it doesn't match.

**One-time setup** (already done unless the secret was rotated):

1. Railway → **Project → Settings → Tokens** → create a **project token** scoped
   to the `production` environment.
2. From the repo: `gh secret set RAILWAY_TOKEN` (or GitHub → Settings → Secrets
   and variables → Actions).

Without the secret, `deploy.yml` warns and skips rather than failing `main`.

To redeploy current `main` without a code change: **Actions → Deploy to Railway →
Run workflow**.

> If you ever connect the repo inside the Railway dashboard, disable this
> workflow — otherwise every push deploys twice.

### Deploying from the terminal (fallback)

Login is browser-based, so run it yourself:

```
! railway login
```

Because neither service sets a **Root Directory**, `railway up` uploads the
current directory as the build context — it must be run from *inside* each
service folder, not the repo root (from the root Railway finds no `Dockerfile`):

```bash
cd backend  && railway up --service backend --ci    # applies migrations, boots API
cd frontend && railway up --service frontend --ci
railway variables --service backend                 # inspect env vars
```

### Environment variables

**backend**

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Reference the Postgres service: `${{ Postgres.DATABASE_URL }}`. |
| `JWT_SECRET` | A long random string — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `NODE_ENV` | `production` — required so the session cookie is `Secure`. |
| `CORS_ORIGIN` | The frontend's public URL, exactly (e.g. `https://vfw-console.up.railway.app`). |
| `COOKIE_DOMAIN` | Optional but **strongly recommended for production** — see the cookie note below. Set to the shared parent of both custom domains, e.g. `.vfwconsole.com`. |
| `PORT` | Provided by Railway — do not set. |

**frontend**

| Variable | Value |
|----------|-------|
| `VITE_API_BASE` | The backend's public URL (e.g. `https://vfw-api.up.railway.app`). Inlined at **build** time, so a change requires a redeploy. |

### First-run seed

Migrations apply automatically on every backend boot. Load the catalog and demo
data once, after the first deploy:

```bash
railway run --service backend npm run seed
```

> **Cookie note — read this before going live.**
>
> `up.railway.app` is on the Public Suffix List, which means browsers treat
> `vfw-console.up.railway.app` and `vfw-api.up.railway.app` as **different
> sites**. On Railway's default domains the session is therefore a *third-party*
> cookie. It works today (the API issues `SameSite=None; Secure`), but Safari's
> ITP already blocks cookies like this and Chrome is phasing them out — so
> sign-in will start failing in the browser while the API keeps working fine
> under `curl`. Don't ship a login that depends on it.
>
> **The fix is a custom domain.** Point the SPA at `app.example.com` and the API
> at `api.example.com`, then set `COOKIE_DOMAIN=.example.com` on the backend.
> Both services are now the same site, the cookie downgrades to `SameSite=Lax`
> automatically, and nothing is third-party. `backend/src/common/cookie.ts`
> handles the switch — you only set the variable.

---

## Tech stack

- **Frontend** — `frontend/`: React 18 + Vite + TypeScript SPA (React Router,
  TanStack Query), served static. `vfw-console.html` is the original
  single-file vanilla-JS prototype the SPA is being built out from.
  Archivo / IBM Plex Sans / IBM Plex Mono; money and IDs always set in mono.
- **Backend** — NestJS 10, Prisma 5, Argon2 password hashing, JWT sessions
  in an httpOnly cookie.
- **Database** — PostgreSQL 16.

---

VFW Management Inc. · Suite 403 – 938 Howe Street, Vancouver BC
