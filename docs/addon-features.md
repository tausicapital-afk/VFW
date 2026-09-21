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

## Decided, not yet built

Provider/design decisions are made — these are ready to scope and dispatch as
soon as schema-changing work resumes:

| Feature | Decision |
|---|---|
| Online payment collection | **Stripe** |
| E-signature on contracts | **DocuSign** |
| SSO | **Google Workspace** |
| 2FA | **TOTP authenticator app** |
| Commission tiers | Build the engine now with **placeholder tiers**, tune real numbers later in Administration |
| Multi-level approval on over-threshold discounts | **Yes** — a second, different ACCT/ADMIN must sign off, reusing the existing `Settings.discountApprovalPct` trigger |
| Client portal for contacts | **View-only via magic link** (no password account) |

All seven need a Prisma schema change (new columns/tables/enum values) and
were deliberately held back from the schema-free batch above to avoid
concurrent migrations colliding against one shared dev database.

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
  known follow-ups from the original messaging build; not yet touched in this
  round.
- **Custom / ad hoc report builder** — a pivot-style builder beyond the 10
  canned report types; not yet scoped.

---

## How to use this list

The "Decided, not yet built" table is ready to scope and dispatch in
controlled batches (not all at once — several touch the same auth/submission
files and all need schema migrations against one shared dev database). Say
the word and I'll start the next wave.
