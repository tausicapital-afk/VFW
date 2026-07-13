# VFW Console — Deployment

How the VFW Console is hosted on **Railway**, how it was set up, and how to
operate and redeploy it. Written 2026-07-13.

---

## Live URLs

| What | URL |
|------|-----|
| **App** (use this) | https://frontend-production-b4a4.up.railway.app |
| API health | https://frontend-production-b4a4.up.railway.app/api/health |
| Backend (direct) | https://backend-production-8dcb.up.railway.app |

**Sign in:** `it@vanfashionweek.com` / `Vfw@2026!` (System Administrator).
Every seeded account shares that password — see [Seed data](#seed-data).

---

## Architecture

One Railway project (**VFW**, `581fa82e-b3fe-4ee0-97f3-b7f09f0442e6`,
`production` environment) with three services:

```
                    ┌───────────────────────────────────────────┐
   Browser ──HTTPS──▶  frontend  (nginx)                         │
   (one origin)     │    • serves the React SPA (static)         │
                    │    • reverse-proxies /api/* ──────────┐    │
                    └───────────────────────────────────────┼────┘
                                                             │ HTTPS
                                                             ▼
                    ┌───────────────────────────────────────────┐
                    │  backend  (NestJS)                         │
                    │    • /api/*  ·  migrate deploy on boot     │
                    │    • JWT session in an httpOnly cookie ────┼──┐
                    └───────────────────────────────────────────┘  │
                                                             ▲      │ SQL
                                                             └──────┼──┐
                    ┌───────────────────────────────────────────┐  │  │
                    │  Postgres  (Railway plugin)  ◀────────────────┘  │
                    └───────────────────────────────────────────┘◀─────┘
```

The browser only ever talks to **one origin** (the frontend). That is the key
design decision — see [Single-origin proxy](#single-origin-proxy).

### Services

| Service | Source | Build | Runtime |
|---------|--------|-------|---------|
| **frontend** | `frontend/` | `frontend/Dockerfile` (Vite build → nginx) | nginx serves `dist/` + proxies `/api/*` to the backend |
| **backend** | `backend/` | `backend/Dockerfile` (NestJS + Prisma) | `npm run release` = `prisma migrate deploy && node dist/main.js`; health check `/api/health` |
| **Postgres** | Railway plugin | — | `postgres-ssl:18` |

Both app services build from a committed `Dockerfile`, so the build is identical
on Railway, in CI, and locally.

---

## Single-origin proxy

**Problem.** The session lives in a cookie. If the SPA (`frontend-…`) and API
(`backend-…`) are on different domains, that cookie is *cross-site*
(`SameSite=None`), i.e. a third-party cookie — and browsers increasingly block
third-party cookies, which silently breaks sign-in. `up.railway.app` is on the
Public Suffix List, so the two subdomains count as different sites.

**Fix.** The frontend service runs **nginx**, which both serves the SPA and
reverse-proxies `/api/*` to the backend (`frontend/nginx.conf.template`). The
browser only sees the frontend origin, so the session cookie is **first-party**
and works everywhere. The SPA calls relative `/api` paths (`VITE_API_BASE` is
empty), and nginx forwards them — cookies pass through untouched in both
directions.

Verified: logging in at the frontend origin stores `vfw_session` against
`frontend-production-b4a4.up.railway.app` and a follow-up `/api/auth/me`
authenticates with it.

---

## Environment variables

### backend

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres plugin (internal URL). |
| `JWT_SECRET` | 96-hex-char random | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `production` | Makes the session cookie `Secure; SameSite=None`. |
| `CORS_ORIGIN` | frontend URL | Belt-and-braces; browser calls are now same-origin so CORS isn't exercised. |
| `PORT` | *(injected by Railway)* | Do not set. |

### frontend

| Variable | Value | Notes |
|----------|-------|-------|
| `BACKEND_URL` | backend URL | nginx `proxy_pass` target (no trailing slash). Substituted into the config at container start. |
| `PORT` | *(injected by Railway)* | nginx listens on it. |
| ~~`VITE_API_BASE`~~ | *(removed)* | Empty → SPA uses relative `/api`. Set it only if you ever stop proxying. |

---

## How it was set up (Railway CLI)

Prerequisite: `railway login` (browser-based, one time).

```bash
# From the repo root
railway init --name VFW                 # create + link the project
railway add --database postgres         # provision Postgres

# backend
railway add --service backend \
  --variables "NODE_ENV=production" \
  --variables "JWT_SECRET=<generated>" \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
cd backend
railway link --project VFW --environment production --service backend
railway up --ci                         # build + deploy
railway domain                          # generate public domain

# frontend
cd ../frontend
railway add --service frontend          # (created empty)
railway link --project VFW --environment production --service frontend
railway variables --set "BACKEND_URL=https://backend-production-8dcb.up.railway.app"
railway up --ci
railway domain

# wire the backend's CORS to the frontend domain
railway variables --service backend \
  --set "CORS_ORIGIN=https://frontend-production-b4a4.up.railway.app"
```

---

## Seed data

Migrations run automatically on every backend boot. The catalog + demo users are
seeded once. The Postgres internal URL isn't reachable from a laptop, so seed
against the **public** URL (Railway → Postgres → Variables → `DATABASE_PUBLIC_URL`):

```bash
cd backend
DATABASE_URL="postgresql://…@<host>.proxy.rlwy.net:<port>/railway" \
  npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed.ts
```

> Note: run `ts-node` directly as above. `npm run seed` mangles its inline JSON
> argument under Git Bash on Windows.

The seed is idempotent (all upserts). It creates the FW26 catalog (6 taxes,
6 cities, 7 events, 14 packages, 30 prices, 11 add-ons, 8 GL accounts) and
**7 users**, all with password `Vfw@2026!`:

| Role | Email |
|------|-------|
| Admin | `it@vanfashionweek.com` |
| Accounting | `accounting@vanfashionweek.com` |
| Sales Manager | `sales.director@vanfashionweek.com` |
| Sales | `marielle@` · `diego@` · `priya@` · `aiko@` `vanfashionweek.com` |

---

## CI/CD

- **`.github/workflows/ci.yml`** — on every push/PR to `main`, builds and
  type-checks both services (backend also runs `prisma validate`). This is the
  quality gate.
- **`.github/workflows/deploy.yml`** — optional, manual (`workflow_dispatch`).
  Deploys via the Railway CLI using a `RAILWAY_TOKEN` repo secret. Disabled by
  default so it doesn't collide with option B below.

### Redeploying

- **CLI (current setup):** from `backend/` or `frontend/`, run `railway up`.
  Both directories are already linked to their services.
- **GitHub auto-deploy (optional):** in the Railway dashboard, connect each
  service to `tausicapital-afk/VFW` and set the service **Root Directory**
  (`backend` / `frontend`). Railway then redeploys on every push to `main`.
  Pick one mechanism, not both.

Setting a variable (e.g. `CORS_ORIGIN`) triggers a redeploy automatically unless
you pass `--skip-deploys`.

---

## Custom domain

To serve the app from your own domain (e.g. `console.vfwmanagement.com`), add it
to the **frontend** service only:

```bash
cd frontend && railway domain console.vfwmanagement.com
```

Add the CNAME record Railway prints. Nothing else changes — the proxy already
keeps everything single-origin, so the API rides along on the same hostname.
(If you want the cookie flagged for the apex too, that's the moment to revisit
`SameSite`.)

---

## Cost

The account (`tausicapital@gmail.com`) is on a **trial** — three always-on
services will consume the credit within days. Add a payment method in the
Railway dashboard (**Project → Settings**, or account billing) to keep it
running.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Login works in `curl` but "logs out" in the browser | Third-party cookie blocking — should be fixed by the single-origin proxy; confirm the SPA calls relative `/api` (no backend host in the JS bundle). |
| `/api/*` returns 502 from the frontend | Backend down or `BACKEND_URL` wrong. Check `railway logs --service backend` and the `BACKEND_URL` frontend variable. |
| Backend boot fails | Usually migrations. Check `DATABASE_URL` and `railway logs --service backend`. |
| Frontend build has stale API base | Redeploy — `VITE_API_BASE` is inlined at build time. |
| `railway up` says "no linked project" | `railway link --project VFW --environment production --service <name>` in that directory. |
