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

### Option A — connect GitHub (recommended)

Railway watches the repo and redeploys on every push to `main`. This is a
one-time setup in the browser:

1. Create a project at [railway.app](https://railway.app) → **Deploy from GitHub
   repo** → authorize Railway's GitHub app → pick `tausicapital-afk/VFW`.
2. Add a **PostgreSQL** database to the project (**+ New → Database → Postgres**).
3. Add the **backend** service from the repo and set its **Root Directory** to
   `backend`. Add the **frontend** service and set its root to `frontend`.
4. Set the environment variables below.
5. Generate a public domain for each service (**Settings → Networking → Generate
   Domain**), then fill `CORS_ORIGIN` and `VITE_API_BASE` with those URLs.

CD is then automatic — no GitHub Actions secret needed. (`.github/workflows/ci.yml`
still runs to gate builds on every push/PR.)

### Option B — deploy from the terminal

The Railway CLI is the alternative. Because login is browser-based, run it
yourself in this session so the CLI is authenticated for the rest of the work:

```
! railway login
```

Then, from the repo root:

```bash
railway init                       # create/link a project
railway add --database postgres    # provision Postgres
railway up --service backend       # deploy backend/ (run from backend/, or pass --path)
railway up --service frontend      # deploy frontend/
railway variables --set KEY=VALUE  # set env vars per service
```

`.github/workflows/deploy.yml` wraps the same `railway up` calls for CI-driven
deploys; it needs a `RAILWAY_TOKEN` repo secret and is disabled by default so it
doesn't collide with Option A.

### Environment variables

**backend**

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Reference the Postgres service: `${{ Postgres.DATABASE_URL }}`. |
| `JWT_SECRET` | A long random string — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `NODE_ENV` | `production` — required so the session cookie is `Secure` + `SameSite=None`. |
| `CORS_ORIGIN` | The frontend's public URL, exactly (e.g. `https://vfw-console.up.railway.app`). |
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

> **Cookie note.** The API deliberately issues a cross-site session cookie
> (`SameSite=None; Secure`) so the SPA and API can live on separate domains.
> Browsers that block third-party cookies may drop it. If sign-in fails only in
> the browser, the robust fix is to put both services behind one domain (serve
> the SPA and reverse-proxy `/api` to the backend) — ask and I'll wire that up.

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
