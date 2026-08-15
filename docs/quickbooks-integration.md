# QuickBooks — connecting for real

## Where things stand

The plumbing is built: OAuth connect/disconnect, token refresh, a mapping
screen, and a live push replacing the old stub. What's **not** done is the
handshake itself — that needs a real Intuit Developer account and a real
QuickBooks company, which is deliberately left for whoever owns that
relationship at VFW Management, not something written from here. Until
someone connects a company, exporting a submission still moves it
`APPROVED → EXPORTED` and allocates an invoice number exactly as before —
nothing is posted anywhere. Connect a company and the same button starts
posting for real.

### What the code does

- **`backend/src/qbo/`** — the whole integration:
  - `qbo-connection.service.ts` — the OAuth 2.0 authorization-code flow
    (authorize URL, code exchange, refresh, revoke-on-disconnect), and
    `ensureFreshToken()`, which every API call goes through so nothing else
    has to know Intuit's tokens are short-lived.
  - `qbo-api.service.ts` — thin authenticated transport to the Accounting API
    (`query`/`create`), token attachment and QBO's error shape only.
  - `qbo-mapping.service.ts` — the local-code → QBO-object-id mappings (tax
    profile, GL account, department), plus `browse()` to pull a connected
    company's live TaxCode/Account/Department lists for the admin picker.
  - `qbo-export.service.ts` — turns an approved `Submission` into a real
    Invoice or Sales Receipt: finds-or-creates the QBO Customer and each line
    Item, resolves tax/department through the mappings, posts it.
- **`SubmissionsService.export()`** (`backend/src/submissions/submissions.service.ts`)
  — three phases: allocate the invoice number (short DB transaction, no
  network calls) → post to QuickBooks if connected (outside any transaction —
  several sequential HTTP calls must never hold a Postgres transaction open)
  → record the result (second short transaction). A failed live push leaves
  the submission `APPROVED`, never `EXPORTED`, with `Submission.qboSyncError`
  set — accounting sees it still needs action instead of the record silently
  drifting from what QuickBooks actually holds. Test-data submissions are
  refused outright against a **production** connection (never against
  sandbox) — see the guard right before the live push.
- **Administration → Configuration → QuickBooks** (frontend) — Client
  ID/secret/environment fields (reusing the same encrypted-config pattern as
  SMTP/R2), a Connect/Disconnect card, and the mapping screen with live QBO
  pickers.
- **`/qbo`** — unchanged in shape, now shows a connected/not-connected banner
  and surfaces `qboSyncError` inline with a **Retry** action.

### What's deliberately NOT automatic

- **Customers and Items are found-or-created automatically.** There are too
  many of them, and new ones appear too often, for a human to map by hand.
- **Tax codes, GL accounts and departments are never guessed.** A small,
  stable set where a wrong mapping means money lands in the wrong QuickBooks
  account — export refuses to post a line whose code has no mapping, with an
  error that says exactly what to go map.

---

## What you still need to do — none of it is code

### 1. Intuit Developer setup

- **Intuit Developer account** (developer.intuit.com), owned by VFW
  Management Inc., not a personal account tied to one engineer.
- **Register an app** in the Intuit Developer Portal to get OAuth 2.0
  credentials — a **Client ID/Secret pair for sandbox** and a **separate pair
  for production**. Never share one pair across both.
- **App assessment.** Intuit requires a short questionnaire about data
  handling/security before issuing production keys, even for a single
  internal company with no public App Store listing. Budget lead time — it's
  not instant.
- **Redirect URI**, registered in the app, exactly matching what the
  Connection card shows (computed from `APP_URL` as
  `{APP_URL}/api/admin/qbo/callback`) — sandbox and production need their own
  if the URLs differ.
- Paste the Client ID/secret into Administration → Configuration →
  QuickBooks, pick the environment, and click **Connect to QuickBooks**. That
  redirects to Intuit's consent screen and back — the rest is automatic.

### 2. The QuickBooks Online company itself

- **Sandbox QBO company** for testing, provisioned from the Developer Portal,
  mirroring the real company's chart of accounts/tax codes/departments so
  testing catches mapping bugs, not just auth bugs.
- **Production QBO subscription** — must be **Plus or Advanced**, not Simple
  Start/Essentials, because the integration posts a `DepartmentRef`
  (QuickBooks' Locations feature, confusingly exposed via a `Department`
  entity) to carry VFW's department field.
- **Multi-currency must be turned on.** VFW prices in 5 currencies; QBO's
  multi-currency setting is **one-way — it cannot be turned off once
  enabled**. Get sign-off from whoever owns the QBO company before flipping
  it, since it changes behaviour for every other user of that company file.
- **Fill in the mappings**, once connected: every `TaxProfile.code` and
  `GlAccount.code` that's actually in use, plus any `department` values
  accounting assigns. The mapping screen's picker reads the connected
  company's live objects, so there's nothing to look up by hand — but nobody
  else can do this before a company is connected.

### 3. Who owns the connection

- The QBO admin user who clicks **Connect** becomes, in effect, the
  integration's identity — decide who that is, not whoever happens to be
  in the console that day.
- **Refresh tokens expire after 100 days of inactivity.** The Connection card
  shows `refreshTokenExpired` and prompts a reconnect, but only if someone is
  looking — this still wants a calendar reminder, not tribal knowledge.
- Decide what happens if that person leaves — the connection needs to be
  re-owned, not orphaned.

### 4. Operational

- **Reconciliation ownership.** Decide who checks, on some cadence, that what
  VFW's ledger believes it posted matches what QuickBooks actually holds —
  this is the entire reason the export ledger (`/qbo`) leads with invoice
  number and posting date rather than sales detail.
- **Rate limits.** Intuit allows roughly 500 requests/minute per company —
  not a practical limit at VFW's volume, but worth knowing before ever
  batch-exporting a large backlog in one sitting.
- **Retries stay synchronous for now** (see `docs/architecture.md` §9): a
  failed push is a visible `qboSyncError` and a manual **Retry**, not an
  automatic queue. Revisit only if that becomes a real operational cost, not
  before.
