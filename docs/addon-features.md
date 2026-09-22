# Add-on features — shipped, decided, and still open

Originally a shortlist of features the console didn't have yet, grounded by
checking the code first. As of this pass, the six schema-free items have
shipped, and the schema-changing items have gateway/provider decisions
recorded so the next round of work doesn't stall on picking a vendor.

---

## Shipped

All six landed with no Prisma schema changes, fully tested, merged to `main`.

- **Dashboard charts.** Revenue trend, submission-status breakdown, and top
  packages, all derived client-side from data the Dashboard already fetched —
  no new backend endpoints. Uses `recharts`, themed through the existing CSS
  custom properties so it repaints on the dark/light toggle. Row-scoping is
  inherited for free (`GET /api/submissions` was already scoped). See
  `frontend/src/pages/Dashboard.tsx`.
- **Approval-queue SLA flag.** A row in "Pending accounting approval" past 3
  calendar days shows an amber pill instead of a plain date. Flat constant
  (`APPROVAL_SLA_DAYS` in `frontend/src/pages/Queue.tsx`), not a Settings
  field — deliberately, to stay schema-free this round. A configurable
  threshold (mirroring `discountApprovalPct`) is the natural follow-up once
  schema changes are back on the table.
- **Saved report filters.** Browser-local only (`frontend/src/lib/savedFilters.ts`
  + `frontend/src/pages/Reports.tsx`) — save/apply/delete a named filter
  combination, with a one-line "this browser only" disclosure. No backend
  model; doesn't sync across devices.
- **Global search (Cmd/Ctrl-K).** `backend/src/search/` + `frontend/src/shell/CommandPalette.tsx`.
  Covers Submissions and Contacts for v1 — Emails was left out because it has
  no per-record route to link to yet. Every result goes through the same
  scoped service method the owning screen already uses (`SubmissionsService.scopeFor`,
  `ContactsService.list`'s `contacts.view` check), so a search result can
  never surface something the caller couldn't already open directly —
  specifically tested (a colleague's search for the same ref/brand comes back
  empty).
- **CSV bulk import.** `POST /api/admin/{packages,addons,events}/import` and
  `POST /api/contacts/import` — each loops the real single-row create method,
  so validation and business rules can't drift from the single-create path.
  Per-row error reporting (file row number + real error message), not
  all-or-nothing. Frontend: `frontend/src/shell/ImportCsv.tsx`, wired into
  Admin's three catalogue cards and Contacts.
- **Payment / renewal reminder emails.** `backend/src/emails/reminders.service.ts`
  — daily overdue-payment reminders to the contact, weekly renewal nudges to
  the *rep* (not the contact — a deliberate call against cold-emailing past
  customers with no human in the loop). Reuses `reports.service.ts`'s
  receivables/retention logic (now exposed as public `receivablesRows`/
  `retentionRows` methods) rather than forking it, so the reminder trigger can
  never disagree with what Reports shows on screen. De-duped via existing
  `EmailMessage` rows — no new `EmailKind` enum value yet (`OTHER` is used as
  a placeholder; a dedicated `REMINDER` kind is a natural follow-up once
  schema changes are back on the table).

## Shipped — Batch A (schema-changing)

Three more landed, each on its own isolated Postgres instance during
development to avoid colliding with the other two mid-migration, merged and
fully tested together afterward.

- **FX rate history.** New `FxRateSnapshot` model. Editing `Settings.fxRates`
  now appends a snapshot instead of overwriting history; reports resolve the
  rate in force for the period being reported, falling back to the live rate
  when no snapshot predates it. `GET /api/admin/settings/fx-history`.
- **Multi-level approval on over-threshold discounts.** `Submission` gains
  `discountOverrideRequestedAt`/`discountOverrideRequestedById`. A first
  approve() on an over-threshold sale records the request (200, not an
  error); a second, *different* ACCT/ADMIN completes it; the same user
  cannot confirm their own request (400) — tested explicitly. Along the way,
  fixed a real bug: Queue.tsx's discount-threshold display was a hardcoded
  frontend constant that could silently drift from the real
  `Settings.discountApprovalPct` — it now reads the live value.
- **Commission tiers.** Global `CommissionTier` table, applied progressively
  as a bonus **on top of** the existing flat per-sale commission — the
  per-sale stamped rate itself is never touched, preserving the "never
  rewrites a booked sale" guarantee. Seeded with a placeholder (0% under
  $50k net revenue/month, +2% above); tune the real numbers in the new
  Payroll → Commission tiers tab (`payroll.manageTiers`, ACCT/ADMIN). Frozen
  into `PayrollInvoice.tierBonus` at submit time, same as base/commission.

## Decided, not yet built

Provider/design decisions are made — these are ready to scope and dispatch in
the next batches:

| Feature | Decision |
|---|---|
| Online payment collection | **Stripe** |
| E-signature on contracts | **DocuSign** |
| SSO | **Google Workspace** |
| 2FA | **TOTP authenticator app** |
| Client portal for contacts | **View-only via magic link** (no password account) |

All five still need a Prisma schema change and are held back from full
parallelism for the same reason Batch A's three were run on isolated
Postgres instances.

## Deferred — own session, not a quick add

- **A finer-grained permission editor**, replacing the five hardcoded ACL
  roles (`backend/src/common/acl.ts`). Touches every guarded endpoint in the
  system; explicitly deferred rather than rushed into a batch with everything
  else.
- **A real mobile client** (PWA or native) and **push notifications** — grouped
  together because browser push needs the same service-worker groundwork a
  PWA would need; there's no client to push to yet either way. Commit
  `5b908da` ("Mobile setup") already laid the CORS/auth groundwork.
- **Message search, edit/delete, reactions** on Messages — `docs/roadmap.md`'s
  known follow-ups from the original messaging build. Not yet touched, but
  scoping found `Message.editedAt`/`deletedAt` already exist in the schema
  (half-built — `deletedAt` is even filtered in one query already) with no
  endpoint that ever sets them, so edit/delete needs **no migration**, only
  wiring. Reactions still need a new `MessageReaction` table.
- **Custom / ad hoc report builder** — a pivot-style builder beyond the 10
  canned report types; not yet scoped.

---

## How to use this list

The "Decided, not yet built" table is ready to scope and dispatch in
controlled batches (not all at once — several touch the same auth/submission
files and all need schema migrations against one shared dev database). Say
the word and I'll start the next wave.
