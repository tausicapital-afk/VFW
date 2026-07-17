# VFW — DevOps Roadmap & Gap Analysis

A running checklist of what DevOps/infra work is **done**, **not done**, and
**deliberately deferred** on VFW. Written 2026-07-16. This is the tracker — tick
items here as they land, across sessions.

VFW's real stack (so we measure against *this*, not a generic AWS/K8s app):

- **Backend**: NestJS + Prisma, Postgres. Migrations apply on boot (`prisma migrate deploy`).
- **Frontend**: React + Vite, built to static, served by **nginx** which also
  reverse-proxies `/api/*` → backend (single-origin, so the session cookie is
  first-party). See `architecture.md` §5 and `DEPLOYMENT.md`.
- **Host**: Railway. One **prod** project (VFW, `production` env, 3/3 services:
  frontend/backend/Postgres). A **staging** project exists but is empty (0/1
  online). Account is on a **trial** (~27 days / a few $ of credit left).
- **Object storage**: Cloudflare R2 (direct-to-R2 document uploads).
- **Mail**: PHP mail relay in `ops/mail-relay/` (sends from an allowed box).

---

## Status at a glance

| # | Item | Status | Owner |
|---|------|--------|-------|
| — | Docker build (committed Dockerfiles, identical local/CI/prod) | ✅ done | — |
| — | CI: build + type-check both services, backend tests, `prisma validate` | ✅ done | — |
| — | Health checks (`/api/health`, `/api/health/ip`, status page) | ✅ done | — |
| — | Migrations as code (Prisma) | ✅ done | — |
| — | Secrets hygiene (`.env` + `*.local.*` gitignored, seed default guard) | ✅ done | — |
| — | Rate limiting (`throttler.ts`) | ✅ done | — |
| — | Object storage (R2 direct uploads, stateless app) | ✅ done | — |
| — | Reverse proxy + TLS (nginx single-origin, Railway TLS) | ✅ done | — |
| — | Railway config-as-code (`backend/railway.json`, `frontend/railway.json`) | ✅ done | — |
| — | Docs (architecture, deployment, deploy runbook, backups runbook) | ✅ done | — |
| 1 | **Database backups** | 🔴 not done | acct owner + code |
| 2 | **Staging environment** (finish the empty project) | 🟠 code/config done; provisioning pending | code ✅ + dashboard |
| 3 | **Automatic deploys** (unblock `RAILWAY_TOKEN`) + rotate live password | 🔴 not done | acct owner |
| 4 | **Monitoring / alerting / centralized logs** | 🟠 not done | acct owner + code |
| 5 | **Close the backend's public door** | 🟠 not done | dashboard |
| 6 | **Branch protection** on `main` | 🟡 not done | acct owner |
| 7 | Config-as-code for Railway | ✅ done (`railway.json` + `railway-variables.md`) | — |
| 8 | **Local dev parity** (full-stack `docker compose up`) | 🟢 code done; run once to verify | code |
| 9 | **Security scanning in CI** (Dependabot, `npm audit`) | 🟡 not done | code |

Legend: 🔴 high risk / do first · 🟠 important · 🟡 nice-to-have · 🟢 largely done.

---

## 🔴 1. Database backups — there are none

**Risk:** if Postgres dies now, every invoice/payment/audit entry is gone
**permanently.** Confirmed, not assumed: Railway reports zero backup schedules and
zero backups for the volume (`docs/runbook-backups.md` §1).

Two independent parts, both needed:

- **(a) Railway snapshots** — enable Daily (+ Weekly/Monthly) in the dashboard.
  The CLI token gets `Not Authorized`, so **only the account owner can do this**:
  *Railway → VFW → Postgres → Backups → enable Daily.* Confirm the first backup
  appears within a day.
- **(b) Off-platform logical dump** — a scheduled `pg_dump` (custom format) copied
  to R2. Snapshots are all-or-nothing, destructive, and don't survive losing the
  Railway account; a logical dump restores into a *scratch* DB so you can pull
  three rows instead of rolling the whole company back a day. **Fully automatable
  now via GitHub Actions cron — does NOT need the Railway paid plan.**
  → See `.github/workflows/backup.yml` (added this session) and
  `docs/runbook-backups.md` §4–6 for restore + verify steps. Requires repo
  secrets `DATABASE_PUBLIC_URL`, `R2_*` (see the workflow header).

**Definition of done:** Railway daily snapshots enabled AND the backup workflow
has produced at least one dump in R2 AND a test restore into a scratch DB has been
timed once (that number is the honest RPO/RTO answer).

---

## 🟠 2. Staging environment — provisioned but empty

The second Railway project shows **0/1 services online** — staging exists in name
only. To actually have a staging tier:

- Deploy backend + frontend + Postgres into the staging project.
- Give it its own env vars — a **separate** `JWT_SECRET`, `SEED_PASSWORD`,
  `CONFIG_ENC_KEY`, `CORS_ORIGIN` (never share prod's secrets with staging).
- Seed it with demo data (safe to use the seed default password here).
- Establish the rule: **migrations and risky changes go to staging first.** This
  is where `prisma migrate deploy` gets rehearsed before prod.

**Code/config half — done this session:**
- `docs/runbook-staging.md` — the full bring-up (provision, variables, seed,
  verify) and the standing "migrations to staging first" rule.
- `backend/.env.staging.example` — the staging variable checklist, with the
  distinct-secrets rule baked in.
- `docs/railway-variables.md` — prod and staging variables side by side.
- `railway.json` (both services) is reused by staging unchanged — see #7.

**Still manual (owner + dashboard):** the CLI token is `Not Authorized` to
provision services, so creating the three staging services, setting the distinct
secrets, seeding, and verifying login + a migration dry-run must be done from the
dashboard. Follow `docs/runbook-staging.md` §3–6.

**Definition of done:** staging URL serves the app, login works, and a migration
has been dry-run there before a prod deploy at least once. *(Not yet met — the
manual provisioning above is outstanding.)*

---

## 🔴 3. Automatic deploys + rotate the live password

- **Auto-deploy is dormant.** `.github/workflows/deploy.yml` is written and
  correct but no-ops without the `RAILWAY_TOKEN` secret, which needs a **paid
  plan** (project tokens are paid-only). Today every deploy is a manual
  `railway up` from `backend/` then `frontend/` — this already bit us once (main
  was days ahead of prod). Adding a payment method unblocks this **and** stops the
  trial from killing prod in ~27 days. One action, two gaps.
  → After paying: create a project token, `gh secret set RAILWAY_TOKEN`. Do **not**
  also connect Railway's dashboard GitHub integration (would deploy twice).
- **Rotate the live admin password.** The published seed default is `Vfw@2026!`.
  The new guard stops *future* seeds using it on a remote DB but does not undo a
  past seed. Confirm prod is not still on the default; rotate if unsure.

**Definition of done:** a push to `main` deploys itself and passes the health
gate; live admin password confirmed ≠ seed default.

---

## 🟠 4. Monitoring / alerting / centralized logs

We have health *endpoints* but nothing *watching* them — prod going down would be
learned from a user. Right-sized for VFW (do **not** stand up Prometheus+Grafana+Loki):

- **Uptime alert** on `/api/health` (UptimeRobot / BetterStack free tier) → email/SMS.
- **Error capture**: Sentry (or similar) on the NestJS backend for unhandled errors.
- **Logs/metrics**: Railway's built-in log + metric views are enough at this scale;
  add structured (JSON) logging on the backend if not already.

**Definition of done:** an outage or error spike pages a human without a user
reporting it first.

---

## 🟠 5. Close the backend's public door

Documented in `DEPLOYMENT.md` but the final **manual dashboard step is pending**:
remove the `backend-production-8dcb…` public domain so the API is only reachable
through nginx. Until then the rate limiter is bypassable via a forged
`X-Forwarded-For` (a real password-spraying hole). **Re-tune `TRUST_PROXY_HOPS`
in the same change** using `GET /api/health/ip`. Follow the verify-in-order steps
in `DEPLOYMENT.md` → *Closing the backend's public door*.

---

## 🟡 6. Branch protection on `main`

Commits currently land straight on `main`, which triggers CI and (once live)
auto-deploy — so an unreviewed push ships to prod. Add a branch-protection rule:
require a PR + green CI before merge to `main`. A `develop` integration branch is
optional at solo scale; the protection rule is the part that matters. *(Account
owner, in GitHub repo settings.)*

---

## ✅ 7. Config-as-code for Railway — done

`backend/railway.json` and `frontend/railway.json` pin builder, health-check, and
restart policy, and carry no per-environment content — so **staging reuses them
unchanged** (see #2 and `docs/runbook-staging.md` §3). The remaining polish is
now landed: `docs/railway-variables.md` captures every non-secret service
variable for **both** production and staging in one reproducible reference, names
the secret ones without valuing them, and gives the `railway variables --set`
recipe to rebuild a service from it.

---

## 🟢 8. Local dev parity — full-stack `docker compose up`

**Done this session (code):** `docker-compose.yml` now carries `backend` and
`frontend` services behind a `full` profile:

- `docker compose --profile full up --build` brings up Postgres + backend
  (applies migrations, seeds the catalog + demo users on boot) + nginx serving
  the built SPA and proxying `/api` — the whole stack in one command, built from
  the same Dockerfiles CI/prod use. App at http://localhost:8080.
- A plain `docker compose up` still starts **only** Postgres, so the fast inner
  loop (DB in Docker, backend/frontend on the host with hot reload) is untouched.
- Validated with `docker compose config` (default → `db`; `full` → all three).
- Documented in `README.md` → *The whole stack in one command (Docker)*.

**Outstanding:** the daemon was unavailable where this was written, so run
`docker compose --profile full up --build` once on a machine with Docker running,
confirm http://localhost:8080 serves the app and login works, then flip this to
✅ done.

---

## 🟡 9. Security scanning in CI

- **Dependabot** — `.github/dependabot.yml` (added this session) watches
  `backend/`, `frontend/`, and GitHub Actions for vulnerable/outdated deps.
- **`npm audit`** — non-blocking audit step added to `ci.yml` for both services
  (reports without failing the build; tighten to blocking later if desired).
- **GitHub secret scanning** — enable in repo settings (account owner).

---

## Deliberately NOT doing (yet)

These are maturity steps that don't fit a single-instance Railway app and would be
busywork now: **blue/green & rolling deploys** (one replica per service — Railway's
redeploy is the rollback), **DB read replicas**, **Kubernetes**, **distributed
tracing / full observability stack**, a **separate CDN** (nginx/Railway already
cache static assets fine at this scale). Revisit if/when traffic or team size grows.

---

## The 3 moves that matter first

1. **Backups** (#1) — enable Railway snapshots (owner) + let the backup workflow
   run (code, done this session). Highest risk on the board.
2. **Add a payment method** (#3) — unblocks auto-deploy *and* keeps prod alive.
3. **Finish staging** (#2) — somewhere to rehearse migrations before prod.
