# Runbook — Shipping the latest build to Railway

Checked 2026-07-15, against the Railway project `VFW`
(`581fa82e-b3fe-4ee0-97f3-b7f09f0442e6`), environment `production`, services
`backend` and `frontend`.

The long-form architecture of the deployment is in `DEPLOYMENT.md`. This is the
short card: *how do I get main into production right now, and how do I know it
worked.*

---

## 1. The finding: pushing to main does not deploy

This was checked, not assumed.

`deploy.yml` runs on every green CI build on main and reports **success** — but
its first step is a guard:

```
RAILWAY_TOKEN is not set — skipping deploy.
```

**There is no `RAILWAY_TOKEN` secret** (`gh secret list` returns nothing), so the
guard short-circuits and the workflow exits green having deployed nothing. Run
`29379710019` "succeeded" in 11 seconds. So did every one before it.

The trap is that the run is **green**, not red. Nothing tells you production is
stale. Treat "Deploy to Railway ✓" as meaningless until §2 is done.

Railway also has **no repo connected** (`source.repo` is null on both services),
so it deploys nothing on its own either.

---

## 2. The fix (two minutes, unlocks §3a)

The token is a *project* token and can only be minted in the dashboard:

> Railway dashboard → project **VFW** → **Settings** → **Tokens** → create a
> token scoped to the **production** environment.

Then:

```bash
gh secret set RAILWAY_TOKEN        # paste the token when prompted
gh secret list                     # confirm it now lists RAILWAY_TOKEN
```

From then on §3a is the whole procedure. Until then, use §3b.

---

## 3a. Normal path — push and let CI ship it

```bash
git push origin main
```

That is it. The pipeline is already correct:

```
push main → CI (build · test · frontend build)
              └─ green → deploy.yml → railway up (backend, then frontend)
                           └─ waits for /api/health to answer 200
```

`deploy.yml` deploys `workflow_run.head_sha` — **the exact commit CI validated**,
not main's tip, which may have moved on. Watch it:

```bash
gh run watch                       # or: gh run list --branch main --limit 3
```

If CI is red, nothing deploys. That is the gate working — go fix the test, do
not reach for §3b.

---

## 3b. Manual path — deploy from this machine

Needs `railway login` once (browser-based; the human must run it).

```bash
# Ship exactly what CI validated: no local edits, in step with origin.
git status --porcelain            # must be empty
git fetch && git status -sb       # must not say "ahead"/"behind"

cd backend  && railway up --service backend  --ci   # migrations run here
cd ../frontend && railway up --service frontend --ci
```

**Backend first, always.** Its start command is
`npm run release` = `prisma migrate deploy && node dist/main.js`, so this is what
applies pending migrations. If one fails the container never becomes healthy and
the deploy fails there — before the frontend is pointed at a database that does
not match it.

**`railway up` uploads the working directory, not a git commit.** Uncommitted
edits go to production silently. Hence the `git status` check above; it is the
whole reason §3a is preferred.

Run each `railway up` from **inside** the service directory — neither service has
a root directory set in Railway, so from the repo root it finds no Dockerfile.

---

## 4. Verify — one call does it

```bash
curl -s https://frontend-production-b4a4.up.railway.app/api/health
```

Hits the frontend's nginx `/api` proxy, so a 200 exercises nginx, the backend and
the database connection behind it in one go. `"ok": true` means the process is
serving; read `checks[]` for per-component state.

Or just open it in a browser — same URL, and you get the status page
(`status-page.md`). Two things there are worth a glance after any deploy:

- **"Uptime measured from …"** in the footer only renders once a `HealthProbe`
  row exists. If it says *"recording starts with the first check"* long after a
  deploy, the prober is not writing.
- **"Not configured"** on a component means that server has no credentials for
  it — not an outage. As of 2026-07-15 production shows this for **Document
  storage (`R2_*`) and Outbound email (`MAIL_*`)**: neither is set on the backend
  service, so uploads and OTP/invite/reset emails cannot work there. Set them via
  the admin System Config screen, or:

  ```bash
  railway variable set --service backend MAIL_HOST=… MAIL_USERNAME=…
  railway variables --service backend        # list what is set (values included)
  ```

Backend directly, bypassing the proxy, if you need to isolate a problem:

```bash
curl -s https://backend-production-8dcb.up.railway.app/api/health
```

---

## 5. Rules worth not re-learning

- **Never deploy on red CI.** The one time it matters, the red will be real. A
  test that only passes on a littered dev database is red on CI for a reason —
  that is exactly how `users.spec.ts` was caught passing by accident.
- **Migrations are additive or they are a rollback problem.** `migrate deploy`
  runs unattended on boot with no human to answer a prompt. Additive columns and
  new tables are safe; a drop or a rename is a two-step deploy, not a one-liner.
- **Rollback is a redeploy of the last good commit**, and only works if the
  migration was additive:
  ```bash
  git checkout <last-good-sha>
  cd backend && railway up --service backend --ci
  ```
  There is no rollback for data. See `runbook-backups.md` — and note its finding
  still stands unless someone has since enabled backups.
- **Deploys do not race.** `deploy.yml` holds a `deploy-production` concurrency
  group and lets an in-flight deploy finish, so a half-applied migration is never
  interrupted. Two people running §3b by hand have no such protection.
