# Phase prompts for Claude Code

Paste-ready prompts, one per phase of `docs/roadmap.md`. Each is **self-contained**
— a new session starts with no memory of this work, so every prompt re-establishes
the context, the rules it must not break, and what "done" means.

Run them **in order**. Phase 1 closes the money loop; the later phases report on
data that Phase 1 makes trustworthy.

**Before pasting any of these**, make sure the app runs locally (see
`docs/architecture.md` §7). A prompt that begins by fighting a broken environment
wastes the session.

---

## Prompt 0 — the preamble (already inside each prompt below)

Every prompt below opens with this block. It is repeated on purpose: it is the
cheapest way to stop a fresh session from violating an invariant it cannot see.

> Read `docs/architecture.md` and `docs/roadmap.md` first, then the relevant part
> of `vfw-console.html` (the original prototype — it is the spec, not a
> wireframe).
>
> Four rules must not be broken:
> 1. **Money is never a float.** Postgres `NUMERIC(14,2)` → Prisma `Decimal` →
>    serialized to the client as a string.
> 2. **The server prices the sale.** Every figure comes from `PricingService`.
>    Controllers and the client never do money arithmetic.
> 3. **The frontend ACL is cosmetic.** `backend/src/common/acl.ts` is the
>    boundary. Guard every new endpoint.
> 4. **The audit trail is append-only,** written in the same transaction as the
>    change it describes.
>
> Reuse the existing design system in `frontend/src/styles/console.css` — it is
> the mockup's stylesheet, kept verbatim. Build against the classes it already
> defines (`.split`, `.fields`, `.checks`/`.chk`, `.totals > .r`, `.log > .e`,
> `.modal > .box`, `.btn.primary`, `.kpi`, `.pill.{STATUS}`, `.tag.{BRAND}`). Do
> not invent new class names — that was tried and produced a broken layout.

---

## Phase 1 — Close the money loop

```
I'm continuing work on the VFW Console (an ERP for a fashion-week company).
Read docs/architecture.md and docs/roadmap.md first, then vfw-console.html —
that file is the original working prototype and it is the spec, not a wireframe.

Four rules must not be broken:
1. Money is never a float. Postgres NUMERIC(14,2) -> Prisma Decimal -> serialized
   to the client as a string.
2. The server prices the sale. Every figure comes from PricingService
   (backend/src/pricing/pricing.service.ts). Controllers and the client never do
   money arithmetic.
3. The frontend ACL is cosmetic. backend/src/common/acl.ts is the security
   boundary. Guard every new endpoint.
4. The audit trail is append-only, written in the same transaction as the change
   it describes.

Reuse the design system in frontend/src/styles/console.css (the mockup's
stylesheet, verbatim). Build against the classes it already defines — do not
invent new ones.

GOAL: close the money loop. A sale can currently be created and approved but
never paid, so balance and payStatus are frozen at whatever the deposit was at
creation. Nothing downstream (AR, collection, leaderboard) is trustworthy until
this lands. The Payment, Document and Settings models already exist and are
migrated — this is API + UI work, no schema change expected.

Build, in this order:

1. PAYMENTS. POST /api/submissions/:id/payments (date, amount, method,
   reference). Recompute paidAmount / balance / payStatus THROUGH PricingService
   — do not compute them in the controller. Append an audit entry. Payments are
   never deletable: reverse with a negative entry, never DELETE. UI: the
   "Payments received" card on the submission detail (mockup line 2341).

2. PATCH /api/submissions/:id — accounting reclassification of GL account, cost
   centre, tax profile, department. Guard with the 'accounting.fields'
   permission. Changing the tax profile RE-PRICES the sale: route it back through
   PricingService and write a before/after payload into AuditEntry. This is the
   most audit-sensitive endpoint in the system.

3. INVOICES. POST /api/submissions/:id/invoice. Allocate Settings.nextInvoiceSeq
   INSIDE a transaction so two concurrent approvals cannot take the same number.
   Invoice numbers are gapless and human-facing; they cannot be random.

4. QUICKBOOKS EXPORT. POST /api/submissions/:id/export plus the qbo screen
   (VIEWS.qbo). Move APPROVED -> EXPORTED, store qbDocNumber, audit it. The
   mockup already builds and previews the payload (line 2591). Keep it
   SYNCHRONOUS — do not add Redis or a job queue yet. Leave the QBO OAuth flow
   out of scope; stub the transport and say so.

5. EDIT AND RESUBMIT (VIEWS.edit). A RETURNED submission is currently a dead end:
   Accounting can send it back but the rep cannot fix it. Let a rep edit their own
   DRAFT/RETURNED submission and resubmit it to PENDING. Re-price server-side on
   every save. Audit the resubmission.

DONE WHEN: I can, in a real browser — create a sale, approve it, record a partial
payment and watch the balance and payStatus change, reclassify its GL account,
generate an invoice number, export it to QuickBooks, and return a different one
to sales and resubmit it. Drive it with Playwright and show me it working; don't
just tell me it compiles. Add unit tests for any new PricingService behaviour.
```

---

## Phase 1.5 — Test the pricing engine

Do this **before** more code comes to depend on it.

```
I'm continuing work on the VFW Console. Read docs/architecture.md and
docs/roadmap.md first.

GOAL: there are currently NO automated tests. PricingService
(backend/src/pricing/pricing.service.ts) is pure, is the heart of the system, and
every figure this company reports comes out of it. Test it first, then the
security boundary.

1. PRICINGSERVICE UNIT TESTS. It is a direct port of calc() in vfw-console.html
   (line 1069) — use the mockup as the oracle. Cover: percentage vs fixed
   discounts; a discount that would push the sale negative (must clamp at zero,
   never invert); zero-rated / exempt tax; sponsored packages (nominal fee, with
   listValue recording the forgone revenue); deposit and part-payment producing
   UNPAID / PARTIAL / PAID; and — critically — that COMMISSION IS STRUCK ON NET
   REVENUE, NEVER ON TAX. Assert exact Decimal values, not floats.

2. ACL INTEGRATION TESTS. The matrix in backend/src/common/acl.ts is a table, so
   the test can be a table too: one case per role per guarded endpoint. Include
   the negative cases that already hold and must keep holding:
     - no session -> 401
     - SALES -> POST /approve -> 403
     - SALES -> GET /queue -> 403
     - rep A -> GET rep B's submission -> 404, NOT 403 (a rep must not be able to
       probe for the existence of another rep's deals)
     - client sends its own "total" -> 400

3. LIFECYCLE TESTS. Illegal transitions must fail: double-approve, approving a
   rejected record, approving something that was never submitted.

Wire the tests into .github/workflows/ci.yml so they actually run.

DONE WHEN: `npm test` passes in backend/, CI runs it, and a deliberately
introduced bug in the commission calculation makes a test go red. Show me that
last part — prove the tests can fail.
```

---

## Phase 2 — Customers

```
I'm continuing work on the VFW Console. Read docs/architecture.md and
docs/roadmap.md first, then the contacts screens in vfw-console.html
(VIEWS.contacts and VIEWS.contact).

Four rules must not be broken: money is never a float; the server prices the sale
via PricingService; backend/src/common/acl.ts is the security boundary (guard
every new endpoint); the audit trail is append-only. Reuse the existing design
system in frontend/src/styles/console.css — build against the classes it already
defines, do not invent new ones.

GOAL: customers. The Contact model already exists and rows are ALREADY being
auto-created on first submission for a new brand — this exposes them.

1. CONTACTS API. GET /api/contacts (with ?q= search over brand, designer,
   company), GET /api/contacts/:id, POST /api/contacts (add one directly).
   Row-level scoping matters: a sales rep sees only their own contacts, while
   ACCT/MGR/ADMIN see all. Reuse the scoping already in
   SubmissionsService.scopeFor() — do not write a second, subtly different
   version of that rule.

2. CONTACTS UI. List (/contacts) and detail (/contacts/:id). The detail shows
   lifetime value and the full submission history for that brand. Follow the
   mockup.

3. DOCUMENTS. The Document model exists with a storageKey and nothing uploads to
   it. DO NOT store files on a Railway volume — they don't survive redeploys
   cleanly and don't scale past one instance. Use S3-compatible object storage
   (Cloudflare R2). Issue a presigned PUT so the file never passes through the
   API. Signed contract, PO and receipt attach to the submission record.
   If I haven't given you R2 credentials, stop and ask rather than inventing a
   local-disk fallback.

DONE WHEN: I can search contacts, open one and see its lifetime value and
submission history, attach a signed contract to a submission and download it
back, and a sales rep cannot see another rep's contacts. Drive it in a real
browser with Playwright and show me.
```

---

## Phase 3 — Insight (reports, leaderboard, audit)

```
I'm continuing work on the VFW Console. Read docs/architecture.md and
docs/roadmap.md first, then the reporting code in vfw-console.html — the REPORTS
object (line 2776) and the leaderboard score (line 1120).

Rules: backend/src/common/acl.ts is the security boundary — guard every endpoint
('reports.view', 'leaderboard.view'). Money is never a float. Reuse the design
system in frontend/src/styles/console.css; build against its existing classes.

GOAL: insight. This is all READ-ONLY over data that already exists, so it should
not need a schema change.

1. REPORTS (VIEWS.reports, GET /api/reports/summary). The mockup defines TEN
   report types in the REPORTS object: revenue, event, city, package, retention,
   ar, collection, rep, feedback, internal. Implement them.
   - Aggregate in SQL, not in JavaScript. This is what Postgres window functions
     are for. Do not pull every submission into Node and reduce().
   - Every consolidated figure converts to CAD (the reporting currency) using
     Settings.fxRates BEFORE being summed. Never add two currencies together.
     The rates live in Settings so Accounting can change them without a deploy —
     read them from there, don't hardcode.

2. LEADERBOARD (VIEWS.board). Weighted score, weights in Settings.scoreWeights
   (revenue 30, approved 20, collection 30, retention 20). Port the scoring from
   the mockup (line 1120).
   IMPORTANT — the mockup is emphatic about this and the UI says so out loud:
   internal department comments and designer feedback are COACHING INPUTS. They
   must never touch the score, the ranking, or anyone's commission. Do not let
   them leak into the calculation.

3. GLOBAL AUDIT TRAIL (VIEWS.audit). AuditEntry is already populated but only
   exposed per-submission. Add GET /api/audit with filtering and pagination.
   Read-only, forever — no update or delete path, not even for an admin.

If any chart work is involved, load the dataviz skill before writing chart code.

DONE WHEN: the reports screen renders all ten report types against seeded data,
the leaderboard ranks reps, and I can demonstrate that adding a scathing internal
comment about a rep does not move their score by a single point. Show me that
last one explicitly.
```

### ✅ Built — 2026-07-13

What actually landed, and the decisions a future session should not re-litigate.
No schema change was needed, as predicted.

**Backend — `backend/src/reports/`**

| File | What it is |
|---|---|
| `reports.service.ts` | The ten reports, plus `repRows()` — the single definition of a rep's numbers |
| `score.ts` | The leaderboard score. **Pure**, so it is testable |
| `score.spec.ts` | 22 tests, including the ones that hold the coaching-inputs line |
| `reports.controller.ts` | `GET /api/reports/{types,summary,leaderboard}` |
| `dto.ts` | Query validation for reports, leaderboard and audit |
| `../audit/audit.controller.ts` | `GET /api/audit`, `GET /api/audit/actions` |

- **Aggregation is in SQL** (`$queryRaw`: `COUNT(*) FILTER`, CTEs, `array_agg`).
  Nothing pulls submissions into Node to `reduce()` them.
- **FX conversion happens inside the `SUM()`.** The rates from `Settings.fxRates`
  are joined in as a `(VALUES …) AS fx(cur, rate)` relation, so each row is
  multiplied by its own currency's rate before anything is added. Two currencies
  are never summed. The rates are read on every request — never hardcoded.
- **Guards:** reports and the audit trail are `reports.view` (ACCT/MGR/ADMIN);
  the leaderboard is `leaderboard.view` (everyone — a rep is meant to see where
  they stand). The audit controller has **no POST, PATCH or DELETE**, for any
  role; all three verbs 404.

**Frontend** — `pages/Reports.tsx` (ten tabs, period/event/city filters, CSV +
JSON + print export), `pages/Board.tsx`, `pages/Audit.tsx`; nav groups
People/Insight in `shell/Shell.tsx`. Only classes `console.css` already defines.

**How the coaching-inputs promise is kept.** `RepStats` — the only input to
`score()` — has **no field** for internal comments or designer feedback, so a
caller has nowhere to put one. The leaderboard query joins only Submission, User
and Contact. `score.spec.ts` also attacks it at runtime: it smuggles
`internalComments` / `feedbackRating` into the stats object and asserts the score,
the parts, the rank and the rating are all byte-identical. Verified live, too — a
scathing Operations comment plus a 1-star review written against the top rep's
deal moved her score by **0** (72 → 72), while both rows showed up in the
`internal` and `feedback` reports, proving the data really was there.

**Decisions worth keeping**

- **Receivables age from `approvedAt` + 30 days.** `Submission` has no `dueDate`
  column and the mockup's AR report wants one. Net 30 from approval is the
  assumption, isolated in `NET_TERMS_DAYS` — that constant is the only line to
  change if terms ever become per-deal.
- **Money columns are tagged `money: true`** and always render to 2dp. An
  accountant reading `21,459` where the figure is `21,459.00` is a bug. Counts,
  scores and day-counts stay whole.
- **No charts.** The mockup's reports are tables; fidelity beat decoration, so
  the dataviz skill was not needed.
- **`feedback` and `internal` reports read Phase 4's tables.** They are correct
  and guarded, and render empty until Phase 4 builds the write paths.

**Known follow-up:** `frontend/src/pages/Dashboard.tsx` still hardcodes FX rates
and sums money in the client — its own comment says it should read them from the
server "once /api/reports lands". It has landed.

---

## Phase 4 — People and administration

```
I'm continuing work on the VFW Console. Read docs/architecture.md and
docs/roadmap.md first, then VIEWS.admin, VIEWS.feedback and VIEWS.internal in
vfw-console.html.

Rules: backend/src/common/acl.ts is the security boundary — guard EVERY endpoint
here, most with 'admin.manage'. The audit trail is append-only. Reuse the design
system in frontend/src/styles/console.css; build against its existing classes.

GOAL: people. Invitation, PasswordReset, InternalComment and DesignerFeedback are
all already modelled and migrated but completely unused.

1. ADMINISTRATION (VIEWS.admin) — the largest remaining screen.
   - Invitations: POST /api/invitations, GET /api/invitations,
     POST /api/invitations/:id/revoke. Signup is invite-only BY DESIGN.
   - User approval: GET /api/users/pending, POST /api/users/:id/approve,
     POST /api/users/:id/reject. New users land as PENDING; the login path
     already refuses them with "awaiting administrator approval" — that half
     works, the admin half doesn't exist.
   - Catalogue editing: tax profiles, packages, add-ons, FX rates, score weights,
     discount threshold. All modelled, all currently seed-only.
     Editing a catalogue price must NOT retroactively change historical
     submissions — SubmissionAddon already copies the price onto the line at
     submission time for exactly this reason. Preserve that property.

2. SELF-SERVICE AUTH. POST /api/auth/signup (redeems an invitation code),
   /api/auth/forgot-password, /api/auth/reset-password.
   Reset tokens must be SINGLE-USE and EXPIRING — the PasswordReset model has
   usedAt and expiresAt; enforce both, don't just store them.
   This needs an email transport (Resend or Postmark). If I haven't given you an
   API key, stop and ask — do not silently log the reset link to the console and
   call it done.

3. DESIGNER FEEDBACK (VIEWS.feedback). Star rating plus notes, per contact.
   Permissions: 'feedback.record' / 'feedback.view'.

4. INTERNAL DEPARTMENT COMMENTS (VIEWS.internal). CONFIDENTIAL: visible to
   ACCT/MGR/ADMIN only, and NEVER to the rep the comment is about. Guard both the
   list endpoint and the per-submission tab. A rep fetching their own submission
   must not receive these in the payload — check the serialized response, not just
   the UI.

DONE WHEN: an admin can issue an invitation, a new user can redeem it and sign up,
the admin approves them and they can log in; a forgotten password can be reset
once and the token then fails on reuse; and a SALES rep fetching their own
submission over the API receives NO internal comments in the JSON. Prove that last
one with an actual API response, not a screenshot of a hidden UI element.
```

### ✅ Built — 2026-07-13

No schema change, as predicted — the four models were already migrated.

**What landed**

| File | What it is |
|---|---|
| `backend/src/admin/admin.service.ts` | Invitations, user approval, catalogue + settings editing |
| `backend/src/admin/admin.controller.ts` | Every route `@Can('admin.manage')`, per handler |
| `backend/src/admin/catalog.spec.ts` | Holds the line that a price edit cannot move history |
| `backend/src/feedback/feedback.controller.ts` | `feedback.record` / `feedback.view` |
| `backend/src/internal/internal.controller.ts` | The confidential comments — see below |
| `backend/src/common/email.ts` | Resend adapter; **throws** when unconfigured |
| `backend/src/auth/{auth.service,auth.controller,dto}.ts` | signup · forgot · reset |
| `frontend/src/pages/Admin.tsx` | Five tabs: invitations · users · packages · tax · settings |
| `frontend/src/pages/{Feedback,Internal}.tsx` | The two People screens + the submission-detail cards |
| `frontend/src/pages/{Signup,ResetPassword}.tsx` | The three signed-out screens (`AuthShell` reuses `#login`) |

| Endpoint | Guard |
|---|---|
| `GET/POST /api/invitations`, `POST /api/invitations/:id/revoke` | `admin.manage` |
| `GET /api/users`, `GET /api/users/pending`, `POST /api/users/:id/{approve,reject}` | `admin.manage` |
| `GET /api/admin/catalogue`, `PATCH /api/admin/{packages,addons,tax}/:id`, `GET/PATCH /api/admin/settings` | `admin.manage` |
| `POST /api/auth/{signup,forgot-password,reset-password}` | `@Public()` |
| `GET /api/feedback` · `POST /api/feedback` | `feedback.view` · `feedback.record` |
| `GET /api/internal-comments`, `GET /api/submissions/:id/comments` | `internal.view` |
| `POST /api/submissions/:id/comments` | `internal.comment` |

Only classes `console.css` already defines: `.tabs`/`.tab.on`, `.modal .box`,
`.log .e`, `.kpi`, `.pill.{STATUS}`, `.stars`, `.note.lock`, `.errbox`, `.req`,
`.pendingIcon`, `.authBack`. Nothing new invented.

**New environment variables** (`backend/.env.example` documents all of them):
`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, `DEV_ECHO_LINKS`.

**The prompt said "stop and ask" about email. It stopped and asked.** No API key
was given, so there is no working mail transport. What exists instead:

- `common/email.ts` — a real Resend adapter (its REST API, no SDK; one POST does
  not need one). Unconfigured, `send()` **throws** and the endpoint answers 503.
- It **never** logs the reset link and calls it done. That fallback looks like it
  works right up until a real user cannot get into their account.
- `DEV_ECHO_LINKS=true` returns the token in the response body instead — off by
  default, ignored outright when `NODE_ENV=production`, named in the response so
  it cannot be mistaken for a working mail setup. The mockup already anticipated
  this flag (line 755). It is how the reset flow is exercised today.
- Invitations still work without email: the code is created regardless, and the
  UI reports `emailed: false` with the reason and shows the code to pass on by
  hand. It does not claim a message went out that did not.

**Decisions worth not re-litigating**

- **Internal comments are not in the submission payload for anyone**, not even
  ACCT — they are served only from their own two guarded routes. A conditional
  include keyed on role would have worked too, and would have been one refactor
  away from leaking. There is no field to forget to strip.
- **"Never the rep it is about" is enforced separately from the ACL**, because
  the ACL is about roles and the rule is not. MGR and ADMIN both hold
  `internal.view` *and* can carry deals. `notAboutMe()` covers that gap.
- **The signup role comes from the invitation.** The form posts one (the mockup's
  does); it is discarded. Otherwise a SALES invite is an ADMIN account.
- **Invitation status is derived, never stored** — a stored one goes stale the
  moment an invitation expires with nobody touching the row.
- **Reset single-use is a conditional `updateMany`, not read-then-write.** The
  window between the check and the write is exactly where a link gets used twice.
- **Feedback attaches to the Contact, not the Submission** — the model says so,
  and a returning brand is the same customer.

**How it was proven** (all against a live API and a real browser, in that order):

| Claim | Evidence |
|---|---|
| Invite → sign up → approve → log in | Playwright, 18 screenshots. Sign-in before approval is refused with "awaiting administrator approval"; after approval it succeeds. |
| Signup cannot escalate | Posted `role: ADMIN` against a SALES invitation → account created as **SALES**. |
| A code is single-use | Second redemption of the same code → 400. |
| Reset works once | `POST /reset-password` → 200; **the same token again → 400**. Old password 401s, new one 201s. |
| Expiry is enforced, not just stored | A row minted unused-but-expired → 400, and it is left unconsumed. |
| No enumeration | `forgot-password` returns the identical body for a real and a fake address; the transport is checked *before* the account lookup. |
| **A SALES rep gets no internal comments** | `GET /api/submissions/:id` as the rep who owns it: 2,099 bytes, 51 top-level keys, **no `comments` key**, no trace of the canary planted in a comment on that exact record. The three comment routes 403 her. Accounting reads the same comment fine. |
| Catalogue edits do not move history | Add-on tripled £760 → £2,391; the sale that bought it kept £760/£760 and its **£32,572.80** total. |

In the browser, the rep's own submission detail renders **no Internal notes card
at all** — the client does not even issue the request, and the server would 403 it
if it did. Accounting, on the same record, sees the card with the comment in it.

`npm test` in `backend/`: **34 passing**, including the new
`admin/catalog.spec.ts`.

**An open question the next session should settle**

A rep cannot read internal comments — but her **audit trail** shows
`INTERNAL_COMMENT — Confidential Production comment added (excluded from
scoring)`, with the author and the timestamp. The *content* never leaks; the
*existence* does. So Marielle can tell that Hannah filed a confidential note about
her deal at 11:22.

This is faithful to the mockup, which logs exactly that string (line 2410) to an
audit tab the rep can see, and it follows from the audit trail being append-only
and complete. But it is arguably a disclosure about a person, and it was left as
the mockup has it rather than changed unilaterally — **suppressing it means
filtering an audit trail the system advertises as complete**, which is a bigger
decision than it looks. If it should go, the change is to omit `INTERNAL_COMMENT`
entries from `GET /api/submissions/:id/audit` when the caller is the rep.

**How to re-run the proof**

The rate limiter added in Phase 5 allows **10 auth POSTs per minute per IP, then
blocks for 15 minutes** — enough to cut a scripted walk-through of this flow in
half. Restart the API between phases (the throttler's buckets are in-memory) and
keep each script under ten sign-ins, or the run will report false failures that
look like bugs in this code and are not.

**Known follow-ups**

1. **Set `RESEND_API_KEY` + `EMAIL_FROM`, then remove `DEV_ECHO_LINKS`.** Until
   then self-service password reset is not usable by a real user. This is the only
   part of Phase 4 that is not finished.
2. Settle the audit-trail question above.
3. `frontend/` now carries `playwright` as a devDependency (for the browser
   proof); `backend/` gained `@nestjs/throttler` + `nestjs-pino` and friends,
   which Phase 5's code imported.

---

## Phase 5 — Harden before real users

```
I'm continuing work on the VFW Console. Read docs/architecture.md and
docs/roadmap.md first.

GOAL: this system handles money and is about to have real users. Harden it.

1. RATE LIMITING. Login has per-email brute-force lockout, but the API has NO
   global rate limit. Add @nestjs/throttler. Be stricter on the auth endpoints
   than on reads.

2. THE COOKIE. WARNING: docs/architecture.md §5 is STALE. backend/src/common/
   cookie.ts has already been rewritten for a single-origin nginx proxy (the
   frontend proxies /api to the API, so the cookie is first-party SameSite=Lax).
   READ THE CODE FIRST, verify in a real browser what Set-Cookie actually comes
   back, then correct §5 to match reality rather than re-fixing a problem that
   may no longer exist.

3. OBSERVABILITY. There is no structured logging and no error tracking. When a
   total looks wrong at month-end, someone will need to reconstruct why. Add
   structured request logging (pino) and error tracking (Sentry). Never log the
   session cookie, a password, or a full JWT.

4. SECRETS. Confirm JWT_SECRET is a real random value in Railway and not the
   dev-only placeholder from .env.example. Rotating it invalidates every session
   — say so before doing it.

5. BACKUPS. Confirm Railway's Postgres backups are on and tell me the restore
   procedure. An append-only audit trail is worthless if the database can vanish.

DONE WHEN: a burst of login attempts is demonstrably rejected, you show me the
actual Set-Cookie header from a real browser, an error reaches Sentry, and you
tell me the backup/restore story in plain terms.

If you need Railway or Sentry credentials I have not given you, STOP AND ASK.
```

### ✅ Built — 2026-07-13

Run alongside Phase 4 in a second session, staying out of `backend/src/{reports,auth}/`
and the admin screens. New files: `backend/src/common/{throttler,logging,sentry}.ts`,
`docs/runbook-backups.md`. Modified: `main.ts`, `app.module.ts`, `.env.example`,
`architecture.md` §5 + new §10.

**The headline finding was not on the list: there were NO database backups.**
Item 5 said "confirm backups are on". They were not on — Railway's API reported
zero backup schedules and zero snapshots on the Postgres volume. If the database
had been lost that day, every submission, payment, invoice and audit entry would
have gone with it. **This was the most serious issue in the pass**, more serious
than any cookie or rate limit, and it was hiding behind the word "confirm".
Enabling it from the CLI token returns `Not Authorized` — the owner has to flip
it in the dashboard. See `docs/runbook-backups.md`.

**§5 was stale, and the prompt was right to say so.** The old §5 described the
session as a doomed third-party cookie needing a custom domain. Verified in a real
Chromium against production instead of trusting the doc — `POST /api/auth/login`
→ 201 returned:

```
Set-Cookie: vfw_session=<JWT>; Max-Age=86400; Path=/; Expires=…;
            HttpOnly; Secure; SameSite=Lax
```

Host-only on the frontend domain, no `Domain` attribute, `/api/auth/me` → 200,
`document.cookie` empty. The nginx proxy had already removed the second origin and
with it the problem. §5 now says so, and says it used to say the opposite. **A
custom domain is cosmetic now, not a prerequisite. Do not re-fix this.**

**Rate limiting** — `common/throttler.ts`. Two IP-keyed buckets: `auth`
(10 writes/min to `POST /api/auth/*`, then a 15-minute block) and `global`
(300/min for everything else). `/api/health` is exempt or Railway's probe would
fail the deploy.

- The limits are **one table, not `@Throttle()` decorators** — so a new endpoint
  cannot be born unlimited because someone forgot to decorate it. It also kept the
  change out of `auth/`, which another session owned.
- The throttler guard is registered **before** the auth guard, so a flood is
  rejected before it costs a JWT verify, a DB round-trip or an argon2 hash.
- It **layers with** the per-email lockout rather than replacing it. The demo that
  matters: an attacker who **rotates the email** dodges the per-email lockout
  entirely (nine straight 401s, lockout never fires) and is stopped at attempt 10
  by the IP limit. Same email → lockout at 6, throttle at 11.

**Observability** — `common/logging.ts` (pino) + `common/sentry.ts`. One rule:
a secret must never reach a log line or an error report. No cookie/`set-cookie`,
no `authorization`, and **no request body at all** — a body is where a password
lives, and there is no redaction rule to get wrong if it is never serialized.
Sentry runs `sendDefaultPii: false` and attaches the user as `{id, role}`, never
an email; it only reports genuine 5xx (a 403 from the ACL guard is the system
*working*, and paging on it teaches everyone to ignore Sentry).

Proven by taking Postgres down under a live authenticated request. The real
`PrismaClientKnownRequestError` was transmitted with `transaction: GET
/api/submissions`, `user: {id, role}` and a `request_id` that also appears in the
pino log — and `request.headers` held only `host`, `user-agent`, `accept`, **even
though that request carried the session cookie**. Scans for the cookie, the
password and any JWT came back clean in both sinks.

**Secrets** — `JWT_SECRET` in Railway is 96 hex chars, uniformly distributed: a
real `randomBytes(48)`, not the placeholder. Checked without printing it. **Not
rotated, and it should not be casually — rotating it signs every user out**, since
it is the key the session JWTs are verified with.

**Decisions worth not re-litigating**

- **`TRUST_PROXY_HOPS` is a NUMBER, not `true`.** It is the load-bearing setting
  behind the whole rate limiter. `true` takes the left-most `X-Forwarded-For`
  entry — whatever the caller typed — so an attacker rotates it and is never
  limited. Too low and every user shares the proxy's IP, one bucket for the
  company, and real people get 429s. `GET /api/health/ip` exists to tune it.
- **Sentry is optional by construction.** No DSN → `initSentry()` returns false
  and the app runs normally. An observability vendor being unconfigured must never
  stop the API from booting.
- **Backups are disk snapshots, not `.sql` files.** Restoring is all-or-nothing
  and destructive. It answers "the database is corrupted"; it answers "someone
  deleted one invoice an hour ago" very badly. Hence the `pg_dump` recommendation
  in the runbook — a dump you have restored is a backup; a snapshot you never have
  is a hope.

**Known follow-ups — Phase 5 is not true in production until these three land:**

1. **Turn on Postgres backups** in the Railway dashboard (owner only). Nothing
   else on this list matters as much.
2. **Set `TRUST_PROXY_HOPS`** on the Railway backend service. It defaults to `0`,
   which is right locally and *wrong* behind the proxy — deploy, call
   `GET /api/health/ip` through the frontend domain, set the count that makes `ip`
   come back as your own address.
3. **Set `SENTRY_DSN`.** No DSN was supplied, so error tracking is inert by
   design. The error above reached a local ingest stand-in the SDK was pointed at,
   **not sentry.io** — the transmit-and-scrub path is proven, the vendor leg is not.

**Found, not fixed:** the backend still has its own public Railway domain, so a
caller can skip nginx, hit the API directly and forge `X-Forwarded-For`, defeating
the IP limiter however the hop count is tuned. Removing that domain and pointing
nginx's `BACKEND_URL` at `RAILWAY_PRIVATE_DOMAIN` closes it. Highest-value change
left; left undone because it changes how the two services talk and could take the
site down unattended.

---

## A note on running these

Each prompt ends with a **definition of done that requires demonstration**, not
assertion — "show me it working in a real browser", "prove the tests can fail",
"show me the actual response body". That phrasing is deliberate. The most common
failure mode is a session that reports success because the code compiles. Keep it
when you adapt these.

The prompts also tell the model to **stop and ask** rather than invent a fallback
when a credential is missing (R2, email transport, Sentry DSN). That is deliberate
too — a silent local-disk fallback for document storage would look like it works
right up until the first redeploy eats a signed contract. It has worked every
time: Phase 2 stopped on R2, Phase 4 stopped on the mail transport, Phase 5
stopped on the Sentry DSN.

Two lessons from Phase 5 worth carrying into future prompts:

- **Point at the code, not at the doc, when the two might disagree.** Phase 5's
  cookie task said *"§5 is STALE — read the code first, verify in a browser, then
  correct the doc"*. That is the only reason the session didn't spend its time
  re-solving a third-party-cookie problem that the nginx proxy had already
  deleted. A stale doc is worse than no doc, because it is confidently wrong.
- **"Confirm X is on" must be allowed to come back "X is off."** Phase 5 asked to
  *confirm* backups were enabled. They were not, and that turned out to be the
  most serious finding in the phase. Word verification tasks so that the
  discovering of a bad answer is a success, not a failure to be worked around.
