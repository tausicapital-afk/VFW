# VFW Console — Deployment

How the VFW Console is hosted on **Railway**, how it was set up, and how to
operate and redeploy it. Written 2026-07-13, updated 2026-07-14.

**Deploys are manual.** Pushing to GitHub ships nothing — see [CI/CD](#cicd).

---

## Live URLs

| What | URL |
|------|-----|
| **App** (use this) | https://frontend-production-b4a4.up.railway.app |
| API health | https://frontend-production-b4a4.up.railway.app/api/health |
| Backend (direct) | https://backend-production-8dcb.up.railway.app — **being removed**, see [Closing the backend's public door](#closing-the-backends-public-door) |

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
and works everywhere. Because it's first-party, the cookie ships as
`HttpOnly; Secure; SameSite=Lax`. The SPA calls relative `/api` paths
(`VITE_API_BASE` is empty), and nginx forwards them — cookies pass through
untouched in both directions.

Verified: logging in at the frontend origin stores `vfw_session` against
`frontend-production-b4a4.up.railway.app` (`SameSite=Lax`) and a follow-up
`/api/auth/me` authenticates with it.

---

## Closing the backend's public door

The proxy above only *routes* traffic through nginx — it does not *force* it. As
long as the backend service has its own public Railway domain, the API is still
reachable directly at `https://backend-….up.railway.app`, and everything nginx
does for us can simply be skipped.

**Why that matters.** The rate limiter (`common/throttler.ts`) keys on `req.ip`,
which Express derives by counting `TRUST_PROXY_HOPS` entries in from the right of
`X-Forwarded-For`. That header is only trustworthy because *our own* nginx
appended the caller's real address to it. A caller who reaches the backend
directly writes the whole header themselves, rotates a fresh value per request,
and gets an unlimited number of rate-limit buckets — which defeats the `auth`
bucket that stands between an attacker and a password-spraying run.

Closing it takes **three** things, and all three are load-bearing:

1. **The backend listens on `::`** (`backend/src/main.ts`). Railway's private
    network is IPv6-only; an app bound to `0.0.0.0` is not reachable on it at
    all. ✅ *done in code.*
2. **`BACKEND_URL` points at the private domain** (frontend service variable):

    ```bash
    railway variables --service frontend \
      --set 'BACKEND_URL=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}'
    ```

    Note it is `http://`, not `https://` — the private network is inside
    Railway's perimeter and does not terminate TLS.

3. **The backend's public domain is removed** — ⚠️ **manual, in the Railway
    dashboard.** There is no `railway domain --remove`; it cannot be scripted:

    > **Railway → project VFW → `backend` service → Settings → Networking →
    > Public Networking → the `backend-production-8dcb.up.railway.app` entry →
    > *Remove domain* → confirm.**
    >
    > Leave **Private Networking** enabled. Do this *after* step 2 is deployed
    > and verified, or the frontend loses its only route to the API.

**Verify, in this order:**

```bash
# 1. BEFORE removing the public domain — confirm the vulnerability is real.
#    The forged header is echoed back as the client IP the limiter would key on:
curl -s https://backend-production-8dcb.up.railway.app/api/health/ip \
     -H 'X-Forwarded-For: 1.2.3.4'

# 2. AFTER the change, through the front door. `ip` must be YOUR address —
#    not nginx's, and not anything you put in the header:
curl -s https://frontend-production-b4a4.up.railway.app/api/health/ip \
     -H 'X-Forwarded-For: 1.2.3.4'

# 3. AFTER removing the public domain — the direct route must be gone (404 from
#    Railway's edge, not a response from our app):
curl -si https://backend-production-8dcb.up.railway.app/api/health | head -1
```

**`TRUST_PROXY_HOPS` must be re-tuned in the same breath.** Removing a hop from
the chain and leaving the count stale is its own bug: too high and the app starts
believing a forged header again; too low and every user shares nginx's IP and one
bucket. Take the count from step 2 — raise or lower it until `ip` comes back as
your own address — and set it on the backend service. Do not guess it from the
diagram; measure it.

---

## Environment variables

### backend

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres plugin (internal URL). |
| `JWT_SECRET` | 96-hex-char random | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `production` | Makes the session cookie `Secure`. |
| `COOKIE_SAMESITE` | *(unset → `lax`)* | Escape hatch; set `none` only for a cross-site (no-proxy) deployment. |
| `CORS_ORIGIN` | frontend URL | Belt-and-braces; browser calls are now same-origin so CORS isn't exercised. |
| `PORT` | *(injected by Railway)* | Do not set. |

### frontend

| Variable | Value | Notes |
|----------|-------|-------|
| `BACKEND_URL` | `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}` | nginx `proxy_pass` target (no trailing slash). **The private domain, not the public one** — see [Closing the backend's public door](#closing-the-backends-public-door). |
| `PORT` | *(injected by Railway)* | nginx listens on it. |
| ~~`VITE_API_BASE`~~ | *(removed)* | Empty → SPA uses relative `/api`. Set it only if you ever stop proxying. |

### backend, continued

| Variable | Value | Notes |
|----------|-------|-------|
| `TRUST_PROXY_HOPS` | a **number** | How many proxies sit in front of the app. The rate limiter keys on `req.ip`, which is only as good as this count. Tune it with `GET /api/health/ip` — see below. |

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
# The PRIVATE domain — see "Closing the backend's public door" above.
railway variables --set 'BACKEND_URL=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}'
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

> **Pushing to GitHub does not deploy anything.** Deploys are manual, via the
> Railway CLI. Read this section before assuming production is up to date.

### Why deploys are manual

Two mechanisms *could* deploy on push. Neither is active:

1. **Railway's GitHub integration** — never connected. Both services report
   `source.repo = null`; Railway has no idea the repo exists and rebuilds
   nothing when you push.
2. **`.github/workflows/deploy.yml`** — written and wired, but **dormant**. It
   needs a `RAILWAY_TOKEN` repo secret, and Railway only issues project tokens
   on a paid plan. This account is on the free trial, so the token can't be
   created yet. Without it the workflow logs a warning and skips its deploy
   steps — it never fails `main`.

This bit us once: `main` was several commits ahead of production for days
(Messages/Contacts/Leaderboard were merged but not live, and three migrations —
`messaging`, `email_otp`, `activity_logs` — had never been applied), because
everyone assumed a push shipped. **It doesn't. Someone has to run `railway up`.**

### `.github/workflows/ci.yml` (active)

On every push/PR to `main`: builds and type-checks both services, runs the
backend test suite against a throwaway Postgres, and runs `prisma validate`.
This is the quality gate, and it is the only thing a push triggers today.

### Deploying (the actual procedure)

Prerequisite: `railway login` once (browser-based).

**Order matters.** Backend first — its start command is
`prisma migrate deploy && node dist/main.js`, so deploying the backend is also
what applies pending migrations. If a migration fails, stop; do not ship a
frontend against a schema it doesn't match.

**Run from *inside* each service directory.** Neither service sets a **Root
Directory** in Railway, so `railway up` uploads the current directory as the
build context. From the repo root Railway finds no `Dockerfile` and the build
fails.

```bash
cd backend  && railway up --service backend  --ci   # applies migrations, boots API
cd ../frontend && railway up --service frontend --ci
```

Then verify — never trust "Deploy complete" alone:

```bash
# 1. API + DB + proxy all in one call (must be 200)
curl -s -o /dev/null -w '%{http_code}\n' \
  https://frontend-production-b4a4.up.railway.app/api/health

# 2. Migrations actually applied
railway logs --service backend | grep -i migrat

# 3. The shipped bundle really contains your change — this is the check that
#    would have caught the stale-production incident.
bundle=$(curl -s https://frontend-production-b4a4.up.railway.app/ \
  | grep -o 'assets/index-[A-Za-z0-9_-]*\.js')
curl -s "https://frontend-production-b4a4.up.railway.app/$bundle" | grep -c Messages
```

Setting a variable (e.g. `CORS_ORIGIN`) triggers a redeploy automatically unless
you pass `--skip-deploys`.

### Turning on automatic deploys (once the account is paid)

`deploy.yml` is already correct and waiting. It runs only after CI passes on
`main`, checks out the exact commit CI validated, deploys backend → frontend,
then polls `/api/health` until it returns 200. To activate:

1. Railway → **Project → Settings → Tokens** → create a **project token** scoped
   to the `production` environment. *(Requires a paid plan.)*
2. `gh secret set RAILWAY_TOKEN`

That's it — the next push to `main` deploys itself, and **Actions → Deploy to
Railway → Run workflow** redeploys current `main` on demand.

> Do not *also* connect Railway's dashboard GitHub integration. Pick one, or
> every push deploys twice.

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

The trial is also why deploys are still manual: project tokens (needed for the
GitHub Actions deploy) are a paid-plan feature. Adding a payment method unblocks
[automatic deploys](#turning-on-automatic-deploys-once-the-account-is-paid) as
well as keeping the services alive.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| **A merged feature isn't live** | Almost always this: nothing deployed it. Pushing to `main` does **not** deploy — see [CI/CD](#cicd). Run `railway up` from `backend/` then `frontend/`. |
| A new table/column is missing in prod | Migrations only apply when the **backend** is deployed (`prisma migrate deploy` runs on boot). Deploying only the frontend never touches the DB. |
| Login works in `curl` but "logs out" in the browser | Third-party cookie blocking — should be fixed by the single-origin proxy; confirm the SPA calls relative `/api` (no backend host in the JS bundle). |
| `/api/*` returns 502 from the frontend | Backend down or `BACKEND_URL` wrong. Check `railway logs --service backend` and the `BACKEND_URL` frontend variable. |
| Backend boot fails | Usually migrations. Check `DATABASE_URL` and `railway logs --service backend`. |
| Frontend build has stale API base | Redeploy — `VITE_API_BASE` is inlined at build time. |
| `railway up` says "no linked project" | `railway link --project VFW --environment production --service <name>` in that directory. |
