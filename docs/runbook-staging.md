# Runbook — Staging environment

Written 2026-07-17. Tracks roadmap #2 (`docs/devops-roadmap.md`). Companion
files: `docs/railway-variables.md` (the variable reference this consumes) and
`backend/.env.staging.example` (the secret checklist).

---

## 1. Where staging stands

A second Railway project exists but is **empty — 0/1 services online**. Staging
exists in name only: there is no backend, no frontend, and no Postgres deployed
into it yet. This runbook is what turns that empty project into a working tier.

**Why bother:** every migration and every risky change currently meets its first
real Postgres in production. `prisma migrate deploy` runs on backend boot
(`backend/Dockerfile`), so a bad migration takes prod down on deploy with no
rehearsal. Staging is the place that migration gets run **first**, against a DB
shaped like prod but holding only demo data.

## 2. Division of labour (read this first)

Provisioning services and setting secrets is a **dashboard / account-owner** job:
the CLI project token returns `Not Authorized` for these operations (same wall as
the backups and auto-deploy items). So this runbook is split:

- **Already done in the repo (code/config):** `railway.json` for both services is
  reused as-is by staging; `backend/.env.staging.example` enumerates the
  variables; `docs/railway-variables.md` gives prod and staging side by side.
  Nothing about staging needs new application code — it is the same images.
- **Still manual (owner, in the dashboard/CLI):** create the three services, set
  the distinct secrets, seed demo data, and verify. Steps 3–6 below.

Until the manual half is done, staging is **not** complete — do not tick #2's
"definition of done" on the strength of this file alone.

## 3. Provision the three services

In the staging project (owner):

```bash
railway link --project <staging-project>            # link the CLI to staging
railway add --database postgres                     # staging's OWN Postgres

# backend — reuses backend/railway.json for build/deploy config
railway add --service backend
railway link --project <staging-project> --environment production --service backend
cd backend && railway up --ci && railway domain

# frontend — reuses frontend/railway.json
cd ../frontend
railway add --service frontend
railway link --project <staging-project> --environment production --service frontend
railway up --ci && railway domain
```

## 4. Set the variables — DISTINCT secrets

Work from `docs/railway-variables.md` (staging column) and
`backend/.env.staging.example`. The non-negotiables:

- `JWT_SECRET`, `CONFIG_ENC_KEY` — freshly generated, **never** prod's values.
- `DATABASE_URL=${{Postgres.DATABASE_URL}}` — staging's own Postgres, never prod's.
- `CORS_ORIGIN` / `APP_URL` — the staging frontend URL from step 3.
- `BACKEND_URL` (frontend) — the backend's **private** domain, exactly as in prod
  (`http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}`).
- `SEED_PASSWORD` — set it; the seed refuses a non-localhost DB otherwise.

## 5. Seed demo data

Migrations apply on boot. Seed the catalog + demo users against staging's
**public** DB URL (Railway → staging Postgres → `DATABASE_PUBLIC_URL`), with a
staging-only password:

```bash
cd backend
SEED_PASSWORD='<staging demo password>' \
DATABASE_URL="postgresql://…@<host>.proxy.rlwy.net:<port>/railway" \
  npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed.ts
```

The seed is idempotent (all upserts). Unlike prod, demo users are fine here —
that is the point of staging.

## 6. Verify — the definition of done

Staging counts as done when all three hold:

1. **It serves the app.** The staging frontend URL loads the console.
2. **Login works.** Sign in with a seeded demo account using the staging
   `SEED_PASSWORD`.
3. **A migration has been dry-run here before prod at least once.** From now on
   the rule is: **migrations and risky changes go to staging first**, and only
   reach prod after a clean `migrate deploy` on staging.

Then tune `TRUST_PROXY_HOPS` for staging by measuring, not guessing:
`GET /api/health/ip` through the staging front door — see `DEPLOYMENT.md`.

## 7. The standing rule

Once staging exists, it earns its keep only if it is used: rehearse every
migration and every risky change on staging before prod. A staging tier nobody
deploys to first is just a second bill.
