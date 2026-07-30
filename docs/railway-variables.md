# VFW — Railway service variables

`railway.json` (in `backend/` and `frontend/`) pins the *build and deploy*
config — builder, health check, restart policy — and Railway reuses it for any
environment that deploys this repo, **production and staging alike**. What it
deliberately does **not** hold is environment **variables**: Railway keeps those
per service/per environment, and secrets must not live in git.

This file is the reproducible capture of those variables — the non-secret ones
in full, the secret ones named but not valued — so a service (especially the new
**staging** project, roadmap #2) can be rebuilt to match by construction instead
of by memory. Secrets are generated fresh per environment and stored in the
password manager, never here.

Legend: **ref** = a Railway template reference, resolved by the platform, safe to
commit. **secret** = generate per environment, keep out of git. **injected** =
Railway sets it; do not set it yourself.

---

## backend

| Variable | Class | Production | Staging | Notes |
|----------|-------|-----------|---------|-------|
| `DATABASE_URL` | ref | `${{Postgres.DATABASE_URL}}` | `${{Postgres.DATABASE_URL}}` | Internal URL of that env's own Postgres. Never point staging at prod's DB. |
| `NODE_ENV` | plain | `production` | `production` | Makes the session cookie `Secure`. Staging is a real deployment, so it's `production` here too. |
| `PORT` | injected | *(unset)* | *(unset)* | Railway injects it; the app reads it. |
| `JWT_SECRET` | **secret** | *(96-hex, prod-only)* | *(96-hex, distinct)* | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. **Must differ from prod** so a staging token is worthless against prod. |
| `CONFIG_ENC_KEY` | **secret** | *(96-hex, prod-only)* | *(96-hex, distinct)* | Encrypts stored in-app secrets (SMTP/R2). Distinct per env; rotating it makes stored secrets unreadable. |
| `CORS_ORIGIN` | plain | prod frontend URL | staging frontend URL | Fallback only (single-origin proxy), but keep it pointed at that env's frontend. |
| `APP_URL` | plain | prod frontend URL | staging frontend URL | So emailed links point at the right tier. |
| `TRUST_PROXY_HOPS` | plain | *measured* | *measured* | A **number**. Measure per env with `GET /api/health/ip` through the real front door — do not copy prod's count blindly. |
| `SEED_PASSWORD` | **secret** | *(if ever seeded)* | *(demo pw)* | Required to seed any non-localhost DB. Staging may use a simple shared demo password; prod should not be seeded with demo users at all. |
| `SENTRY_DSN` | **secret** | *(if using Sentry)* | *(optional)* | Unset = Sentry off. Use a **separate** Sentry project for staging so its noise doesn't page you. |
| `SENTRY_TRACES_SAMPLE_RATE` | plain | `0`–`0.1` | `0` | Fraction of requests traced. |
| `LOG_LEVEL` | plain | `info` | `debug` | Staging can afford louder logs. |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_ENCRYPTION` / `MAIL_FROM_NAME` | plain | mail server, non-secret | same or a test sender | Host/port/from-name are not secret. |
| `MAIL_USERNAME` / `MAIL_PASSWORD` / `MAIL_FROM_ADDRESS` | **secret** | prod mailbox | a **non-prod** mailbox | Never send staging mail from the production sender. |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` / `R2_BUCKET` | plain | prod bucket | a **separate** staging bucket | Bucket identifiers aren't secret; keep staging in its own bucket. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | **secret** | prod keys | staging keys | Scope staging keys to the staging bucket only. |
| `COOKIE_SAMESITE` | plain | *(unset → `lax`)* | *(unset → `lax`)* | Escape hatch; set `none` only for a cross-site (no-proxy) deployment. |
| `DEV_ECHO_LINKS` | plain | **do not set** | **do not set** | Dev-only; ignored when `NODE_ENV=production` anyway. |

> `MAIL_*` and `R2_*` can also be set in-app (Administration → Configuration) and
> stored encrypted in the DB, which overrides the environment. See `backend/.env.example`.

## frontend

| Variable | Class | Production | Staging | Notes |
|----------|-------|-----------|---------|-------|
| `BACKEND_URL` | ref | `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}` | same | nginx `proxy_pass` target. **The private domain, not the public one** — see `DEPLOYMENT.md` → *Closing the backend's public door*. |
| `PORT` | injected | *(unset)* | *(unset)* | nginx listens on it. |
| `VITE_API_BASE` | build arg | *(empty)* | *(empty)* | Empty → SPA uses relative `/api`. Set only if you ever stop proxying. |

---

## Rebuilding a service from this file

`railway.json` is already in the repo, so a new service in either environment
picks up the build/deploy config automatically. All that's left is the variables
above:

```bash
# link the CLI to the target project + environment + service first, then:
railway variables --set "NODE_ENV=production" \
                  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
                  --set "JWT_SECRET=<generated, distinct per env>" \
                  --set "CONFIG_ENC_KEY=<generated, distinct per env>" \
                  --set "CORS_ORIGIN=https://<this-env-frontend>" \
                  --set "APP_URL=https://<this-env-frontend>"
# ...secrets (SEED_PASSWORD, MAIL_*, R2_*, SENTRY_DSN) from the password manager.
```

For the staging bring-up that consumes this, see `docs/runbook-staging.md`.
