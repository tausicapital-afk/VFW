# Add-on features — shipped, decided, and still open

Originally a shortlist of features the console didn't have yet, grounded by
checking the code first. All eleven items that had a scope or a provider
decision — the six schema-free features, Batch A's three schema-changing
ones, and Wave 2's five provider-decided ones — have now shipped. What
remains is the deferred list at the bottom, each held back for its own
reason rather than a lack of a decision.

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

## Shipped — Wave 2

All five items decided in the previous pass have landed, each reviewed
separately for security before merge (two of them — Stripe and DocuSign — sit
behind public, unauthenticated webhooks, so that scrutiny was not optional).

- **Google Workspace SSO + TOTP 2FA.** `backend/src/auth/google-sso.service.ts`
  mirrors `QboConnectionService`'s OAuth shape (state/CSRF, encrypted tokens,
  graceful "not configured"). SSO only ever signs in an *existing* account —
  matched and linked by verified email, never used to provision one; account
  creation stays exclusively the invitation system's job. TOTP
  (`backend/src/auth/totp.ts`) stores the secret encrypted via the same
  `config.crypto` helper already used for SMTP/R2/QBO, and `totpEnabled` only
  flips after a real code is proven once, so enrolling with a secret you never
  saved can't lock you out. A password (or Google) login for a TOTP-enabled
  user does not complete the session — it returns a short-lived, single-purpose
  challenge that can't be replayed as a real session token.
- **Client portal for contacts.** `backend/src/portal/` + `frontend/src/pages/Portal.tsx`
  — a `ContactPortalToken`-gated, unauthenticated view at `/portal/:token`
  (60-day link, not a one-shot credential) showing a contact their own
  submissions: status, balance, invoice PDF, and (once sent) signature status
  and the signed contract. A strict field allowlist, not "everything minus the
  sensitive bits" — no internal notes, GL/cost-centre, rep, discount
  mechanics, or any other contact's data, and a missing vs. expired token
  return byte-identical 404s.
- **Online payment collection (Stripe).** `backend/src/payments/` — from the
  portal, a contact can pay their outstanding balance via a Stripe-hosted
  Checkout page; the card never touches this server. The webhook verifies
  Stripe's signature over the raw request body before any database write,
  posts the `Payment` and recomputes the balance exactly once per Checkout
  Session (an `updateMany` compare-and-set claim absorbs Stripe's retried
  deliveries), and cross-checks Stripe's own confirmed `amount_total` against
  the amount the app expected before trusting it. Webhook-posted payments are
  attributed to a lazily-created, hidden service `User`
  (`stripe@system.internal`) rather than loosening `Payment.recordedById`'s
  required FK — the `.internal` domain is IETF-reserved, which is what keeps
  that row unreachable through the SSO link-by-email flow above.
- **E-signature on contracts (DocuSign).** `backend/src/docusign/` —
  `DocuSignConnectionService` again mirrors QBO's OAuth shape; "Send for
  signature" (`email.send`, ACCT/ADMIN) turns an uploaded `Document` into a
  DocuSign envelope, tracked as a `SignatureRequest`. The `@Public()` Connect
  webhook trusts only the envelope id to look up a `SignatureRequest` this
  console itself created — nothing else in the payload — and claims the
  `completed` transition atomically so a redelivered notification can't
  duplicate the signed `Document`. The signed PDF lands back in R2 and is
  attributed to the same hidden-service-user pattern Stripe uses
  (`docusign@system.internal`). Not yet exercised against a live DocuSign
  account — the envelope JSON shape and OAuth token-endpoint details are
  built from documentation, not a sandbox run, and are flagged in code for
  whoever connects the first real account to double-check.

All five needed a Prisma schema change and were built and merged sequentially
rather than on isolated Postgres instances like Batch A, since — unlike Batch
A's three — several share real integration points (the portal is the surface
both Stripe and DocuSign hang their contact-facing pieces off of) rather than
being independent.

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

Everything that had a provider decision recorded is now shipped. What's left
is the "Deferred" list above, each item deliberately held back for a reason
specific to it (touches every guarded endpoint, needs service-worker
groundwork nothing else has laid, or just isn't scoped yet) rather than a
queue waiting on schema-migration bandwidth. Say the word and I'll scope
whichever one you want to start.
