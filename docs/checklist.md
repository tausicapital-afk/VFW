# DevOps Checklist Audit — VFW Console

_Audited: 2026-07-17_

**Stack**: NestJS 10 + Prisma 5 + PostgreSQL 16 backend, React 18 + Vite SPA frontend, deployed as two Dockerized services to Railway. No mobile client. Legacy `vfw-console.html` single-file prototype still in the repo alongside the SPA it's being replaced by.

**Summary**: 26 met / 8 partial / 8 missing / 6 n/a (of 48 items). This is an unusually well-documented repo — `docs/` already contains an architecture doc, a deployment guide, a backup runbook, and a gap-closure handoff — and the checklist below leans on that existing work rather than duplicating it.

## 1. Repository & Branching Strategy
- [x] main branch is the deploy trigger, kept deployable — `deploy.yml` fires on green CI on `main`
- [~] Branch protection (PR review + passing CI) — CI gate exists (`ci.yml`); GHE/GitHub branch-protection *rule* enforcing required reviewers can't be confirmed from a filesystem snapshot
- [x] Dependabot active — numerous `dependabot/npm_and_yarn/*` and `dependabot/github_actions/*` branches exist on `origin`, actively raising PRs for both backend and frontend
- [~] `.github/dependabot.yml` — not present in the current `main` tree (was added in commit "Stand up the DevOps groundwork..." but is absent now); Dependabot is clearly running per the branches, so this may be configured via GitHub's UI/API rather than a committed file — worth confirming which
- [ ] Conventional commits — not enforced by tooling (no commitlint config)
- [ ] Semantic versioning for API releases — no version tags/CHANGELOG found; deploys aren't tagged by semver

## 2. Environment Separation
- [~] 3+ environments — local (docker-compose Postgres) + production (Railway) exist; no distinct staging tier, though `docs/` mentions "staging docs" in a past commit message — worth checking if that materialized
- [x] Each environment has its own DB — local uses a docker-compose Postgres on port 5434; production uses Railway's managed Postgres plugin, fully separate
- [x] Config via env vars only — `.env.example` (both backend and frontend) is thorough and env-var-driven; `NODE_ENV` toggles cookie `Secure` flag, no code-path branching
- [n/a] Mobile build flavors — no mobile client
- [ ] Feature flags — none found

## 3. Continuous Integration (CI)
### Backend
- [x] Build → typecheck → test order, fail-fast — `ci.yml` runs `backend` (compile) and `backend-tests` (jest against a real ephemeral Postgres service container) in parallel per push/PR
- [~] Test coverage threshold — 10 spec files exist (unit + integration, e.g. `discount-approval.spec.ts`, `pricing.service.spec.ts`), baseline documented as "98 passing" in `gap-closure-handoff.md`, but no enforced coverage % threshold found
- [x] Dependency vulnerability scanning — Dependabot active (see section 1)
- [ ] Secret scanning — no gitleaks/trufflehog step found in `ci.yml` or `deploy.yml`

### Frontend
- [x] Lint/typecheck + build on every PR — `ci.yml` frontend job runs `npm run build` (Vite build includes tsc typecheck)
- [ ] Bundle size check/budget — not found
- [ ] Accessibility (a11y) lint rules — not found in frontend devDependencies

### Mobile
- [n/a] no mobile client

## 4. Continuous Deployment (CD)
- [x] Build once from committed Dockerfiles, identical across CI/Railway/local — README explicitly calls this out: "Both services build from a committed Dockerfile, so the build is identical on Railway, in CI, and locally"
- [ ] Manual approval gate for production — deploys are currently fully manual (`railway up` run by hand) because Railway's GitHub integration isn't connected and `deploy.yml` is dormant pending a paid-plan `RAILWAY_TOKEN`; once wired up, CI-green-on-main will auto-deploy with no approval gate documented
- [ ] Rolling/blue-green deploy — single Railway service instance, no blue-green strategy evident
- [~] Automatic rollback on failed health check — `deploy.yml`/README document a health-check verification step (`curl .../api/health`) but this is a manual verification step today, not wired to an automatic rollback
- [x] DB migrations as a distinct step — backend start command is `prisma migrate deploy && node dist/main.js`, explicitly documented in README as "deploying the backend is also what applies pending migrations" — reviewable, though it runs at boot rather than as a fully separate pipeline stage
- [n/a] Mobile store submission — no mobile client
- [ ] API versioning (`/api/v1/`) — not found; routes appear unversioned

## 5. Configuration & Secrets Management
- [x] No secrets committed — `.gitignore` present, `.env.example` files (not `.env`) are what's tracked, both thoroughly documented
- [x] `.env.example` documents required keys — exceptionally thorough for both `backend/.env.example` and `frontend/.env.example`, including *why* each variable matters (e.g. `TRUST_PROXY_HOPS` has a full explanation of the security tradeoff)
- [x] Secrets in a managed vault — Railway service variables (`DATABASE_URL` auto-injected by the Postgres plugin, `JWT_SECRET`/`CORS_ORIGIN` etc. set per-service)
- [x] Secrets scoped per environment — local `.env` vs Railway service variables are fully separate
- [ ] Secret rotation documented/tested — not found

## 6. Database Change Management
- [x] Versioned migrations only — Prisma migrations, `prisma migrate deploy` in the production start command
- [x] Migrations reviewed in PR — gated by the same CI as all other code changes
- [~] Expand-contract pattern — no explicit convention/tooling found enforcing this; relies on developer discipline
- [n/a] Cross-client compatibility note — no mobile client with independent release cadence
- [ ] **Automated backups — explicitly confirmed NOT configured.** `docs/runbook-backups.md` documents, dated 2026-07-13, that Railway's backup API was checked directly and returned zero backup schedules and zero backups: *"If the database is lost right now, every submission, payment, invoice and audit entry is lost with it, permanently."*
- [ ] Backup restore tested — cannot be tested; there is nothing to restore from yet
- [ ] Point-in-time recovery — not configured (see above)
- [ ] Migration dry-run against staging snapshot — no staging tier exists
- [~] Connection pooling — not explicitly configured/monitored; Prisma's default pool is in use

## 7. Shared Backend/API Concerns (Web + Mobile Clients)
- [x] Single source of truth API — one NestJS backend serves the SPA; the legacy `vfw-console.html` prototype can also point at it via `API_BASE`
- [ ] API versioning strategy — none found
- [x] Auth strategy — JWT session in an httpOnly cookie (Argon2 password hashing), with a documented first-party-vs-third-party cookie fix (`COOKIE_DOMAIN`) already thought through in the README
- [x] Rate limiting — `backend/src/common/throttler.ts`, with `TRUST_PROXY_HOPS` carefully documented to avoid both under- and over-counting proxy hops
- [n/a] Push notifications — no mobile client
- [n/a] Deep linking — no mobile client
- [~] Shared validation logic — DTOs (`ApproveDto`, etc.) validate on the backend; no shared package with the frontend confirmed, but this is a single-repo monolith-ish setup so duplication risk is lower

## 8. Observability & Monitoring
- [x] Structured (JSON) logging — pino, referenced in `backend/src/common/logging.ts` and `.env.example` (`LOG_LEVEL`), explicitly documented to never log cookies/passwords/JWTs
- [ ] Metrics (RED method) — not found
- [ ] DB metrics (pool saturation, slow query log) — not found
- [n/a] Mobile crash reporting — no mobile client
- [~] Correlation/trace ID — Sentry tracing sample rate is configurable (`SENTRY_TRACES_SAMPLE_RATE`), but explicit request-correlation-ID propagation through logs isn't confirmed
- [ ] Alerting on thresholds — not found
- [x] Granular health check — `/api/health` (and `/api/health/ip`, used specifically to measure `TRUST_PROXY_HOPS`) exists, exercises nginx + API + DB in one call per the README's verification curl

## 9. Security
- [x] HTTPS enforced — Railway serves both services over HTTPS by default; `NODE_ENV=production` sets the session cookie `Secure`
- [x] CORS configured explicitly — `backend/src/main.ts` reads `CORS_ORIGIN` and logs the active allowed origins on boot, not a wildcard
- [n/a] Mobile TLS/cert pinning — no mobile client
- [x] Input validation — NestJS DTOs with class-validator-style guards (e.g. `ApproveDto.acknowledgeDiscountOverride`)
- [~] Dependency + container image vulnerability scanning — Dependabot covers dependency scanning; no container-image scan (Trivy or similar) found in CI
- [n/a] Payment/webhook idempotency — this app doesn't appear to have external payment webhooks (QuickBooks export is outbound, not an inbound webhook) — worth confirming if QuickBooks sends any callbacks
- [x] Least privilege — Railway Postgres plugin injects scoped `DATABASE_URL`; `docs/architecture.md` §10.1 documents closing the backend's public domain specifically to reduce exposure

## 10. Local Development Parity
- [x] One-command local stack — `docker compose up -d db` for Postgres, then `npm run dev` per service
- [x] Seed script — `npm run seed` loads "catalog + demo data"
- [n/a] Mobile pointing to local backend — no mobile client
- [x] Fast onboarding — README's "Running the backend"/"Running the frontend" sections are clear, ordered, copy-pasteable

## 11. Infrastructure as Code
- [ ] Infra in Terraform/Bicep/Pulumi — none found; Railway services are configured via `railway.json` per service plus dashboard settings (Postgres plugin, custom domains), not declarative IaC
- [ ] Infra changes via PR review — `railway.json` files are in the repo and reviewable, but full environment config (env vars, domains, backup schedule) lives in the Railway dashboard, outside git
- [ ] Infra recreatable from code alone — partially: Dockerfiles + `railway.json` get you the services, but Postgres backup schedule, custom domains, and env vars would need to be re-entered manually per `docs/DEPLOYMENT.md`

## 12. Release Management & Disaster Recovery
- [n/a] Mobile staged rollout — no mobile client
- [~] Rollback plan for backend — manual `railway up` redeploy of a prior commit is possible but undocumented as a formal rollback procedure
- [ ] RTO/RPO defined — not documented; `runbook-backups.md` implicitly puts current RPO at "infinite" (no backups exist) until the dashboard setting is turned on
- [x] Runbook for incidents — `docs/runbook-backups.md` is an exceptionally thorough incident runbook for the DB-loss scenario specifically (detection, restore procedure, verification queries, and a call to actually drill it)
- [x] Documentation covers architecture/env vars/deployment — `docs/architecture.md`, `docs/DEPLOYMENT.md`, `docs/roadmap.md`, `docs/gap-closure-handoff.md`, and the README itself are all current and detailed

## Top priority gaps
1. **No database backups exist at all, right now** — confirmed via Railway's API per `docs/runbook-backups.md`, dated 2026-07-13. For an accounting system holding invoices and payments, this is the single highest-risk item in the entire audit; the runbook says exactly what to click, do it before anything else on this list.
2. **No secret scanning in CI** — Dependabot covers known-vulnerable dependencies but nothing scans commits for accidentally-leaked credentials (gitleaks/trufflehog), unlike some sibling repos (e.g. kazipert) that already have this.
3. **Deploys are fully manual today** — Railway's GitHub integration isn't connected and `deploy.yml` is dormant pending a paid-plan token, so every deploy is a human running `railway up` from the right directory. Low risk of automation-induced incidents, but no CI-gate is actually enforced on what ships.
4. **No staging environment / no migration dry-run environment** — changes go from local dev straight to production.
5. **No container image vulnerability scanning** (e.g. Trivy) despite deploying Docker images — dependency scanning alone doesn't catch base-image CVEs.
