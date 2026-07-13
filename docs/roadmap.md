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
| `contacts` — Contacts list | `/contacts` | ❌ Not built |
| `contact` — Contact detail | `/contacts/:id` | ❌ Not built |
| `qbo` — QuickBooks export | `/qbo` | ❌ Not built |
| `board` — Leaderboard | `/board` | ❌ Not built |
| `feedback` — Designer feedback | `/feedback` | ❌ Not built |
| `internal` — Internal notes | `/internal` | ❌ Not built |
| `reports` — Reports | `/reports` | ❌ Not built |
| `audit` — Audit trail (global) | `/audit` | ❌ Not built |
| `admin` — Administration | `/admin` | ❌ Not built |

**Backend endpoints still unimplemented:** `PATCH /api/submissions/:id`,
`POST /api/submissions/:id/export`, `/api/contacts`, `/api/contacts/:id`,
`/api/reports/summary`, `/api/invitations`, `/api/invitations/:id/revoke`,
`/api/users/pending`, `/api/users/:id/approve`, `/api/users/:id/reject`,
`/api/auth/signup`, `/api/auth/forgot-password`, `/api/auth/reset-password`.

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

### 2.1 Contacts (`VIEWS.contacts`, `VIEWS.contact`)
`Contact` rows are already being auto-created on first submission for a brand.

- `GET /api/contacts` (with `?q=` search), `GET /api/contacts/:id`,
  `POST /api/contacts` (add directly).
- Contact detail shows lifetime value and full submission history.
- Reps see only their own contacts; ACCT/MGR/ADMIN see all — reuse the row-level
  scoping already in `SubmissionsService.scopeFor()`.

### 2.2 Documents
`Document` is modelled with a `storageKey` and nothing uploads to it.

- **Do not store files on a Railway volume** — they do not survive redeploys
  cleanly and do not scale past one instance.
- Use S3-compatible object storage (Cloudflare R2 is cheap). Issue a presigned
  PUT; the file never passes through the API.
- Signed contract, PO and receipt belong on the submission record.

---

## Phase 3 — Insight

All of these are **read-only over data that already exists**, so they are safe to
build in parallel once Phase 1 lands.

### 3.1 Reports (`VIEWS.reports`, `GET /api/reports/summary`)
The mockup defines **ten** report types (`REPORTS`, line 2776): `revenue`,
`event`, `city`, `package`, `retention`, `ar`, `collection`, `rep`, `feedback`,
`internal`.

- Aggregate in **SQL**, not in JavaScript. This is what Postgres window functions
  are for.
- Every consolidated figure converts to **CAD** (the reporting currency) using
  `Settings.fxRates` before being summed. Never add two currencies.

### 3.2 Leaderboard (`VIEWS.board`)
Weighted score (mockup line 1120), weights in `Settings.scoreWeights`:
`revenue 30 · approved 20 · collection 30 · retention 20`.

> The mockup is emphatic about this and the UI says so out loud: internal
> comments and designer feedback are **coaching inputs**. They never touch the
> score, the ranking, or anyone's commission. Do not let them leak in.

### 3.3 Global audit trail (`VIEWS.audit`)
`AuditEntry` is populated and only exposed per-submission today.

- `GET /api/audit` with filters and pagination. Read-only, forever.

---

## Phase 4 — People

### 4.1 Designer feedback (`VIEWS.feedback`)
`DesignerFeedback` is modelled and unused. Star rating + notes per contact.
Permissions: `feedback.record` / `feedback.view`.

### 4.2 Internal department comments (`VIEWS.internal`)
`InternalComment` is modelled and unused. **Confidential** — visible to
ACCT/MGR/ADMIN only, never to the rep the comment is about. Guard on both the
list endpoint and the per-submission tab.

### 4.3 Administration (`VIEWS.admin`)
The largest remaining screen. Guard everything with `admin.manage`.

- **Invitations:** `POST /api/invitations`, `POST /api/invitations/:id/revoke`,
  `GET /api/invitations`. Signup is invite-only by design.
- **User approval:** `GET /api/users/pending`, `POST /api/users/:id/approve`,
  `POST /api/users/:id/reject`. Users land as `PENDING`; the login path already
  refuses them with "awaiting administrator approval".
- **Catalogue editing:** tax profiles, packages, add-ons, FX rates, score
  weights, discount threshold. All modelled; all currently seed-only.

### 4.4 Self-service auth
`POST /api/auth/signup` (redeems an invitation code), `forgot-password`,
`reset-password`. `PasswordReset` and `Invitation` are already modelled.

- Needs an email transport (Resend or Postmark). **Reset tokens must be
  single-use and expiring** — the model has `usedAt` and `expiresAt`; enforce
  both.

---

## Cross-cutting — do not skip

### Tests
There are currently **no automated tests**. The end-to-end flow was verified with
a throwaway Playwright script, which is not the same thing.

Highest value first:
1. **`PricingService` unit tests.** It is pure, it is the heart of the system, and
   every figure the company reports comes out of it. Test discounts, mixed
   currencies, zero-rated tax, sponsored packages, commission-on-net.
2. **ACL integration tests.** One test per role per guarded endpoint. The matrix
   in `common/acl.ts` is a table — the test can be too.
3. **Approval lifecycle.** Illegal transitions must fail (double-approve,
   approving a rejected record).

### Rate limiting
Login has brute-force lockout per email, but the API has **no global rate limit**.
Add `@nestjs/throttler` before this is public.

### Observability
No structured logging and no error tracking. Money moves through this system; when
a total looks wrong at month-end, someone will need to reconstruct why.

### The cookie / custom domain
See §5 of `architecture.md`. **Get a custom domain and set `COOKIE_DOMAIN` before
going live.** On Railway's default domains the session is a third-party cookie
that Safari already blocks and Chrome is phasing out — sign-in will fail in the
browser while the API keeps working under `curl`, which is a confusing way to
discover the problem in production.

---

## Suggested order

1. **Phase 1** — payments, `PATCH`, invoices, QBO export, edit/resubmit.
   Nothing downstream is trustworthy until money can complete its round trip.
2. **`PricingService` tests** — before more code depends on it.
3. **Phase 2** — contacts, documents.
4. **Phase 3** — reports, leaderboard, audit. Parallelisable.
5. **Phase 4** — admin, feedback, internal notes, self-service auth.
6. **Rate limiting + custom domain** — before any real user touches it.
