# Add-on features — ideas, not commitments

A shortlist of features the console doesn't have yet, grounded by checking the
code rather than guessing — each entry below was confirmed absent (grep'd for
an existing implementation first) or is a known, already-written-down gap.
Nothing here is scheduled; it's a menu to pick from.

---

## Money & sales

- **Online payment collection.** The Installments card (`docs/modules&tabs.md`
  → Submissions) only records a payment after the fact — someone marks it paid
  once a wire lands. A "Pay now" link on the invoice email, backed by Stripe or
  similar, would let a contact pay a deposit or instalment directly and write
  the same `Payment` ledger entry instantly instead of waiting on a bank
  confirmation. No payment-gateway code exists in the repo today.
- **E-signature on contracts.** The Documents card already accepts contract
  uploads (`frontend/src/pages/DocumentsCard.tsx`). Wiring DocuSign/HelloSign
  would close the loop from "upload a blank contract" to "have it signed"
  without leaving the console.
- **Multi-level approval for large discounts.** Today approval is a single
  maker/checker step, same for every sale regardless of size. A configurable
  threshold (e.g. discounts over X% need a second sign-off, mirroring the
  existing custom-package sign-off pattern in the Approval queue) would
  tighten control on the biggest deviations without slowing down normal ones.
- **Commission tiers / bonus rules.** Commission is one flat percentage per
  rep, stamped onto each sale at creation. Tiered rates (accelerating past a
  monthly revenue threshold) are a common ask for sales orgs; this would mean
  the rate becomes a computed rule rather than a stored scalar, so it's a
  bigger change than most items here.
- **FX rate history.** Administration → Settings holds one *live* FX snapshot
  that every report converts through right now. A rate-per-month history would
  make a March report defensible even if nobody touched Settings between March
  and September — right now an old report silently re-prices itself if the
  rate has since moved.

## Search & navigation

- **Global search (Cmd/Ctrl-K).** There's no cross-entity search today — a rep
  hunting a submission by ref, a contact by name, or an invoice number has to
  already know which screen to search from. Confirmed no command-palette code
  exists in `frontend/src/`.
- **Saved report filters / a personal dashboard.** Reports resets to its
  defaults on every visit. Letting ACCT/MGR pin a filter set (e.g. "this
  quarter, Vancouver only") would save re-entering the same setup daily.

## Insight

- **Dashboard charts.** `docs/roadmap.md` already flags this — the Dashboard
  KPI strip never got the charts the original mockup called for; confirmed
  still true (`frontend/src/pages/Dashboard.tsx` has no charting library).
  Cheapest visible win here, since the reports data it would chart already
  exists.
- **Custom / ad hoc report builder.** The 10 canned report types
  (`docs/modules&tabs.md` → Reports) cover the obvious cuts. A pivot-style
  builder — pick dimensions and measures — would serve requests that don't fit
  any of the ten without adding an eleventh, twelfth, thirteenth fixed report.
- **Approval-queue SLA flag.** Nothing currently flags a submission that's
  been sitting in the queue too long. A simple "pending > N days" highlight on
  the Approval queue would surface a stuck deal before a rep has to chase it.

## Communication

- **Message search, edit/delete, reactions.** `docs/roadmap.md`'s Messaging
  section lists these as known follow-ups from the original build; still true
  today — none of the three exist in `frontend/src/pages/Messages.tsx`.
- **Push notifications.** Same roadmap note. Today, the Approval queue and
  Messages badges (`frontend/src/shell/Shell.tsx`) only update while the
  console tab is open in a browser; nothing reaches a phone or a closed tab.
- **Payment / renewal reminder emails.** No automated dunning for an overdue
  balance, and no "your usual season is coming up again" nudge for a lapsed
  contact. Both would lean on data the Outstanding receivables and Customer
  retention reports already compute — the aggregation exists, the notification
  trigger doesn't.

## Access & security

- **SSO (Google / Microsoft).** Staff sign in with email + password only
  today — no OAuth code found in `backend/src/auth/`. Removes one more
  password to manage, and fits naturally if VFW runs a company Google
  Workspace or Microsoft 365 tenant.
- **Two-factor authentication on login.** OTP exists today only once, at
  signup verification (`docs/email-and-otp.md`) — there's no ongoing 2FA
  challenge at every login. Worth adding once the account list is large enough
  that credential-stuffing is a real risk rather than a theoretical one.
- **A finer-grained permission editor.** Roles are five fixed, hardcoded
  buckets in `backend/src/common/acl.ts`. A screen to adjust individual
  permissions per role (or per user) would be a genuinely bigger change to the
  ACL model — listed here as the one "big swing" in this section, not a quick
  add.

## Data

- **CSV import for contacts / catalogue.** Contacts and catalogue rows
  (packages, add-ons, shows) can only be created one at a time through the
  console today. A bulk importer would help onboarding a new season's shows or
  migrating an existing contact list, rather than hand-entering each row.
- **A client-facing portal.** Contacts currently only ever receive a PDF
  invoice by email (`docs/modules&tabs.md` → Submissions → Send invoice). A
  lightweight portal — view an invoice, see payment status, download past
  invoices without asking someone at VFW to resend them — would cut down on
  that back-and-forth.

## Mobile

- **A real mobile client.** Commit `5b908da` ("Mobile setup") already laid the
  CORS/auth groundwork (`docs/architecture.md`) for something to consume the
  API from a phone, but no client — PWA or native — exists yet. Worth deciding
  which (an installable PWA wrapper around the existing SPA is far cheaper
  than a native app) before investing further here.

---

## How to use this list

Nothing above is prioritized or scoped — it's a menu, not a backlog. Pick one
(or a few) and I'll dig into the exact code paths the way the last batch
(package `listValue`/`cap`, the three export gaps) got scoped, before writing
or dispatching anything.
