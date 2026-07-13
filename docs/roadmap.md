# VFW Console — Remaining Work

What is built, what is left, and the order it should be done in.

The scope is defined by `vfw-console.html`: **15 screens** and the API endpoints
its client already calls. **5 screens are built.** The mockup is the spec for
everything below — read it before starting a task.

---

## Status at a glance

| Screen (mockup `VIEWS.*`) | Route | Status |
|---|---|---|
| `dash` — Dashboard | `/` | ✅ Built (KPIs from live data; charts pending) |
| `new` — New submission | `/new` | ✅ Built |
| `subs` — Submissions | `/submissions` | ✅ Built (list; search/filter pending) |
| `sub` — Submission detail | `/submissions/:id` | ✅ Built (money, audit; tabs pending) |
| `queue` — Approval queue | `/queue` | ✅ Built (approve / reject / return) |
| `edit` — Edit / resubmit | `/submissions/:id/edit` | ❌ Not built |
| `contacts` — Contacts list | `/contacts` | ✅ Built (search; row-level scoped) |
| `contact` — Contact detail | `/contacts/:id` | ✅ Built (lifetime value + history) |
| `qbo` — QuickBooks export | `/qbo` | ❌ Not built |
| `board` — Leaderboard | `/board` | ✅ Built |
| `feedback` — Designer feedback | `/feedback` | ✅ Built |
| `internal` — Internal notes | `/internal` | ✅ Built |
| `reports` — Reports | `/reports` | ✅ Built (all ten report types) |
| `audit` — Audit trail (global) | `/audit` | ✅ Built |
| `admin` — Administration | `/admin` | ✅ Built |

**Backend endpoints still unimplemented:** none of Phase 4's. Invitations, user
approval, catalogue editing, self-service auth, designer feedback and internal
comments all landed — see §Phase 4 below.

**One thing is configured, not finished:** `POST /api/auth/forgot-password`
needs an email transport and no API key was supplied. The Resend adapter is
written (`common/email.ts`); without `RESEND_API_KEY` it **throws** and the
endpoint answers 503. It does not log the reset link and pretend to work.
`DEV_ECHO_LINKS=true` returns the token in the response instead (dev only —
ignored outright when `NODE_ENV=production`), which is how the reset flow is
exercised today.

The database schema **already covers all of this** — `Payment`, `Document`,
`InternalComment`, `DesignerFeedback`, `Invitation`, `PasswordReset` and
`Settings` are modelled and migrated. Almost every task below is API + UI only,
with no schema change.

---

## Phase 1 — Close the money loop

Nothing downstream (reports, leaderboard, AR) is trustworthy until a sale can be
paid for and posted. Do this first.

### 1.1 Payments — record a deposit or wire
`Payment` exists but nothing writes to it. Balance and `payStatus` are currently
frozen at whatever the deposit was at creation.

- `POST /api/submissions/:id/payments` — date, amount, method, reference.
- Recompute `paidAmount` / `balance` / `payStatus` through `PricingService`.
  **Do not compute them in the controller.**
- Append an audit entry. Payments must never be deletable — reverse with a
  negative entry, do not `DELETE`.
- UI: "Payments received" card on the submission detail (mockup line 2341).

### 1.2 Accounting field edits — `PATCH /api/submissions/:id`
Accounting can reclassify GL account, cost centre, tax profile, department. Guard
with `accounting.fields`.

- Changing the **tax profile re-prices the sale** — route it back through
  `PricingService` and write a before/after payload into `AuditEntry`. This is
  the single most audit-sensitive endpoint in the system.

### 1.3 Invoice generation
`Settings.nextInvoiceSeq` and `invoicePrefix` exist and are unused.

- `POST /api/submissions/:id/invoice` — allocate the next sequence number
  **inside a transaction** so two concurrent approvals cannot take the same one.
- Invoice numbers are gapless and human-facing; they cannot be random.

### 1.4 QuickBooks export (`VIEWS.qbo`, `POST /api/submissions/:id/export`)
The mockup builds the payload and previews it (line 2591); currently nothing
posts it.

- Move `APPROVED` → `EXPORTED`, store `qbDocNumber`, audit it.
- Start **synchronous**. Add Redis + BullMQ only when retries are actually
  needed.
- The QBO OAuth flow and `qbRealmId` handling is its own piece of work — scope it
  separately from the payload shape.

### 1.5 Edit and resubmit (`VIEWS.edit`)
A `RETURNED` submission is currently a dead end: Accounting can send it back, but
the rep has no way to fix and resubmit it. This closes the loop the queue already
opened.

- Rep edits their own `DRAFT` / `RETURNED` submission → back to `PENDING`.
- Re-price server-side on every save. Audit the resubmission.

---

## Phase 2 — Customers

### 2.1 Contacts (`VIEWS.contacts`, `VIEWS.contact`) ✅
`Contact` rows are already being auto-created on first submission for a brand;
`backend/src/contacts/` now exposes them.

- `GET /api/contacts` (with `?q=` search over brand/designer/company),
  `GET /api/contacts/:id`, `POST /api/contacts` (add directly; duplicate brand
  is rejected).
- Contact detail shows **per-currency** lifetime value (booked = APPROVED/
  EXPORTED; currencies never summed) and the full submission history.
- Reps see only their own contacts; ACCT/MGR/ADMIN see all. Scoping **reuses**
  `SubmissionsService.scopeFor()` (made public + exported) — one definition of
  "whose deals can I see". Another rep's contact returns **404, not 403**.
- UI: `/contacts` (search + New-contact modal) and `/contacts/:id`, nav item ◈.
- Verified end-to-end against the live DB: scoped list, search, LTV after
  approval, cross-rep 404 isolation, and 401 with no session.

### 2.2 Documents ✅ built — ⏳ R2 round-trip pending credentials
`Document` is modelled with a `storageKey`; `backend/src/storage/` +
`backend/src/documents/` now drive uploads.

- Files live in **Cloudflare R2** (S3-compatible), never on a Railway volume.
  The browser gets a **presigned PUT** and uploads straight to R2; download is a
  **presigned GET**. The file never passes through the API.
- **No local-disk fallback**: with `R2_*` unset the endpoints return a loud 503
  rather than pretending to work. Env contract is in `backend/.env.example`
  (`R2_ENDPOINT`/`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`).
- Endpoints (`/api/submissions/:id/documents` — `presign`, create, list,
  `:docId/download`) reuse `submissions.findOne()`, inheriting the 404 boundary;
  attaching is audited (`DOCUMENT_ATTACHED`). UI: a Documents card on the
  submission detail.
- **Remaining:** the live attach→download round-trip is unverified because no
  `R2_*` values are present in `backend/.env`. Set them and re-run to confirm.

---

## Phase 3 — Insight ✅ **Done**

All read-only over data that already existed; no schema change was needed.

### 3.1 Reports (`VIEWS.reports`, `GET /api/reports/summary`) ✅
All ten report types from the mockup's `REPORTS` object (line 2776) —
`revenue`, `event`, `city`, `package`, `retention`, `ar`, `collection`, `rep`,
`feedback`, `internal` — in `backend/src/reports/reports.service.ts`.

- Aggregated in **SQL** (`$queryRaw`, `FILTER`, CTEs), not reduced in Node.
- Consolidated figures convert to **CAD** *inside* the `SUM()`, using the rates
  read from `Settings.fxRates` on every request. Two currencies are never added.
- Guarded with `reports.view` (ACCT/MGR/ADMIN).

> **Receivables age from `approvedAt` + 30 days.** `Submission` has no `dueDate`
> column, so Net 30 from approval is the assumption; `NET_TERMS_DAYS` in
> `reports.service.ts` is the one line to change if terms ever become per-deal.

### 3.2 Leaderboard (`VIEWS.board`) ✅
Weighted score in `backend/src/reports/score.ts`, weights from
`Settings.scoreWeights` (`revenue 30 · approved 20 · collection 30 ·
retention 20`). Guarded with `leaderboard.view` — every role sees it.

> Internal comments and designer feedback are **coaching inputs** and cannot
> reach the score: `RepStats` has no field for them, so a caller has nowhere to
> put one. `score.spec.ts` holds that line, including a test that smuggles the
> fields in at runtime and asserts nothing moves.

### 3.3 Global audit trail (`VIEWS.audit`) ✅
`GET /api/audit` — filter by free text / action / date, paginated.
`GET /api/audit/actions` lists the actions on record. Read-only forever: the
controller has no POST, PATCH or DELETE, for any role.

---

## Phase 4 — People ✅ **Done**

No schema change was needed — the four models were already migrated.

### 4.1 Designer feedback (`VIEWS.feedback`) ✅
`GET /api/feedback` (`feedback.view`), `POST /api/feedback` (`feedback.record`)
in `backend/src/feedback/`. A star rating and notes **against the contact**, not
the submission: a brand that books a second show is the same customer, and their
view of the company does not reset with a new sale. Fills the Phase 3 `feedback`
report, which until now rendered empty.

### 4.2 Internal department comments (`VIEWS.internal`) ✅
`backend/src/internal/`. **Confidential**, and held that way by three separate
things — one would not have been enough:

1. **The ACL.** `GET /api/internal-comments` and
   `GET|POST /api/submissions/:id/comments` are guarded with `internal.view` /
   `internal.comment`. Neither permission includes SALES or INTERN.
2. **Never the rep the comment is about.** Roles are not the whole rule: a MGR
   (and an ADMIN) holds `internal.view` *and* can carry their own deals.
   `InternalService.notAboutMe()` — `{ submission: { repId: { not: user.id } } }` —
   is applied to every read, so nobody at any role reads the coaching notes
   written about their own sale. The per-submission route 403s them outright.
3. **They are not in the submission payload at all.** `DETAIL` in
   `submissions.service.ts` does not include `comments`, for anyone. Comments are
   served only from the two routes above. There is no conditional include to get
   wrong and no field to forget to strip — a rep cannot receive one even in
   principle.

> **Verified against the wire, not the UI.** A SALES rep `GET`s her own
> submission: 2,099 bytes, 51 keys, no `comments` key, and no trace of a canary
> string planted in a comment on that exact record. An ADMIN — who *has*
> `internal.view` — asking for comments on a submission they carry gets **403**.
> Accounting, who is not the rep, reads it fine.

### 4.3 Administration (`VIEWS.admin`) ✅
`backend/src/admin/`, `frontend/src/pages/Admin.tsx`. Every route is
`admin.manage`, spelled out per handler rather than on the class — a class-level
guard is easy to lose in a refactor, and what it protects is user approval and
the rate card.

- **Invitations:** issue, list, revoke. Codes are `VFW-XXXXXX` from an alphabet
  with no `I`, `O`, `0` or `1` — they get read off a screen and typed by hand.
  Status (ACTIVE/USED/REVOKED/EXPIRED) is **derived, never stored**; a stored
  status silently goes stale the moment an invitation expires untouched.
- **User approval:** `GET /api/users/pending`, approve, reject. Rejection is a
  status, not a delete.
- **Catalogue editing:** packages, city prices, add-ons, tax profiles, FX rates,
  score weights, discount threshold. Money is parsed from a **decimal string**
  with `decimal.js` — a price that round-trips through a JS float has already
  lost the argument. Every edit writes a before/after payload to the audit trail.

> **Editing a price does not move history — proven, not asserted.** Nothing in
> `AdminService` writes to `Submission` or `SubmissionAddon`. Live check: an
> add-on's catalogue price was tripled (£760 → £2,391); the submission that sold
> it kept `unitPrice` £760, `amount` £760 and total **£32,572.80**, unchanged.
> `admin/catalog.spec.ts` holds the line, including the inverse test that shows
> what the total *would* have become had the record read the live rate card.

### 4.4 Self-service auth ✅
`POST /api/auth/signup`, `forgot-password`, `reset-password` — all `@Public()`.

- **The role comes from the invitation, never the request.** The signup form
  posts one because the mockup's form has the field; it is discarded. A signup
  that asks for `ADMIN` against a SALES invitation creates a SALES account.
- **The invitation is consumed with a conditional `updateMany` inside the
  transaction**, not a read-then-write. Two people racing the same code cannot
  both get an account.
- **Reset tokens are single-use AND expiring, enforced as one atomic
  compare-and-set:** the `updateMany` matches only a row that is still unused and
  still in date, and stamps `usedAt` in the same statement. Read-check-write
  would leave a window where the same link works twice. Resetting also expires
  every other outstanding link for that account and clears the lockout counter.
- `forgot-password` **checks the transport before it looks the account up** — if
  it checked afterwards, an unconfigured server would answer 503 for a real
  address and 200 for an unknown one, which is precisely the enumeration oracle
  the uniform reply exists to prevent.

> **Email is the one thing not finished** — see the note at the top of this file.
> No API key was supplied, so the Resend adapter throws rather than logging the
> link and calling it done.

---

## Cross-cutting — do not skip

### Tests
`npm test` in `backend/` runs two unit suites:

- ✅ **`pricing.service.spec.ts`** — the pricing engine.
- ✅ **`score.spec.ts`** — the leaderboard score, including the tests that hold
  the coaching-inputs line (a scathing comment and a one-star review must not
  move a score by a point).

Still missing, highest value first:
1. **ACL integration tests.** One test per role per guarded endpoint. The matrix
   in `common/acl.ts` is a table — the test can be too. The boundaries are
   currently only probed by hand against a running API.
2. **Approval lifecycle.** Illegal transitions must fail (double-approve,
   approving a rejected record).
3. **Reports.** The SQL aggregates and the FX consolidation have no test yet;
   they were verified against seeded data in the browser, which is not the same
   thing.

### Rate limiting ✅
`@nestjs/throttler`, configured in `backend/src/common/throttler.ts`:
10 auth writes/min (then a 15-minute block) and 300 requests/min for everything
else, both per IP, layered on top of the existing per-email lockout. See
`architecture.md` §10.1.

> **Not finished until `TRUST_PROXY_HOPS` is set correctly in Railway.** It
> defaults to `0` (no proxy), which is right locally and *wrong* in production —
> with it unset, every user is seen as coming from the proxy's IP and shares one
> bucket, so real people will start getting 429s. Deploy, call
> `GET /api/health/ip` through the frontend domain, and set the hop count that
> makes `ip` come back as your own address.

### Observability ✅
pino request logging (`common/logging.ts`) and Sentry (`common/sentry.ts`). Every
request carries a `request_id` that appears in both. No cookie, password, JWT or
request body reaches either sink. See `architecture.md` §10.2.

> **`SENTRY_DSN` is not set**, so error tracking is currently inert (by design —
> the app runs fine without it). Create a Sentry project and set the DSN on the
> Railway **backend** service to turn it on. Nothing else needs to change.

### The cookie ✅ — resolved, do not re-fix
The single-origin nginx proxy made the session cookie first-party. Verified in a
real browser against production: `HttpOnly; Secure; SameSite=Lax`, host-only, no
`Domain` attribute. **A custom domain is now cosmetic, not a prerequisite.**
`architecture.md` §5 has been corrected — it previously described a third-party
cookie problem that no longer exists.

### Backups ❌ — the most urgent item in this document
**There are no database backups.** Zero schedules, zero snapshots. If Postgres is
lost today, the books are lost with it. This cannot be enabled from the CLI token
— the owner has to switch it on in the Railway dashboard. See
`docs/runbook-backups.md` for that and for the restore procedure.

---

## Suggested order

1. ✅ **Phase 1** — payments, `PATCH`, invoices, QBO export, edit/resubmit.
2. ✅ **`PricingService` tests** — before more code depends on it.
3. ✅ **Phase 2** — contacts (verified); documents built, R2 round-trip pending
   `R2_*` credentials in `backend/.env`.
4. ✅ **Phase 3** — reports, leaderboard, audit.
5. ✅ **Phase 4** — admin, feedback, internal notes, self-service auth.
6. ✅ **Phase 5** — rate limiting, observability, cookie verified, secrets checked.
7. **Turn on backups, set `TRUST_PROXY_HOPS`, `SENTRY_DSN`, `RESEND_API_KEY`,
   and the `R2_*` document-storage keys** — the things standing between "built"
   and it actually being true in production. Without `RESEND_API_KEY`, a user who
   forgets their password cannot recover it; without `R2_*`, document upload and
   download return 503.
