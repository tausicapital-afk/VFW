# VFW Console — Logs / Activity Telemetry

How the admin-only **Logs** module records what users do, and why it is built the
way it is. Written for whoever picks it up next.

---

## 1. What this is, and what it is not

The Logs module answers operational questions an administrator asks about people,
not about money: *Has this account ever signed in? When were they last active?
Who is online right now? What screens did they open, and who did they message —
and for how long?*

It is **telemetry**, and it is deliberately kept apart from `AuditEntry`, the
existing audit trail. That distinction is load-bearing:

- **`AuditEntry`** is submission-scoped **financial evidence**. It is append-only,
  the UI advertises that nothing on it is ever deleted, and Accounting reconciles
  against it. Routine sign-in and page-view noise must never land there.
- **`ActivityLog` / `UserSession`** are **operational telemetry**. Additive tables
  that touch nothing in the money loop. Read-only in the UI; nothing writes back
  over a row.

The schema already anticipated this split — the messaging tables carry a comment
that they are *not* financial evidence and are kept out of `AuditEntry`. Activity
telemetry follows the same rule.

---

## 2. Access

The whole screen is gated by the ACL permission **`activity.view`**, held by
**`ADMIN` and `ACCT`** — the same audience as `admin.manage`. User-activity
monitoring is HR/security-sensitive, so it is shared only with Accounting (the
second keyholder role), not with Managers or reps the way Reports and the Audit
trail are.

The permission lives in both copies of the matrix, as every permission does:

- `backend/src/common/acl.ts` — the authority. Every read endpoint declares
  `@Can('activity.view')`.
- `frontend/src/lib/acl.ts` — a mirror, used only to decide what to render. If the
  two disagree, the server wins.

The one exception is the write endpoint (see §4, module views): it carries no
`activity.view` gate because it can only ever record the caller's own screen view,
and so there is nothing to abuse.

---

## 3. Data model

Two new tables plus one new column, in `backend/prisma/schema.prisma`. The
migration is `backend/prisma/migrations/20260714120000_activity_logs/`.

### `User.lastLoginAt` — `DateTime?`

When the user most recently authenticated. **Null means they have never logged
in** — that is the whole of the "never signed in" signal. Stamped on every
successful login.

### `ActivityLog` — discrete events

```
id         cuid
userId     String?     -- null-able; SetNull on delete, so a log line
                          outlives the account it names
action     String      -- LOGIN | LOGOUT | CONNECT | DISCONNECT
                          | MODULE_VIEW | MESSAGE_SENT
detail     String?     -- human one-liner: "Entered Messages", "Messaged Jane Doe"
meta       Json?       -- structured context: { module, conversationId,
                          recipientIds, durationSec } — never message content
ip         String?
userAgent  String?
createdAt  DateTime
```

Indexed on `(userId, createdAt)`, `(action, createdAt)` and `(createdAt)` so the
feed, the per-user rollups and the action filter are all cheap.

### `UserSession` — online periods with durations

```
id           cuid
userId       String
startedAt    DateTime
endedAt      DateTime?   -- null = still online right now
durationSec  Int?        -- filled when the session closes
ip           String?
userAgent    String?
```

**One row spans a whole online period** — first socket connect to last socket
disconnect — not one socket and not one tab. A user with three tabs open has one
open session. `durationSec` is computed once, on close.

---

## 4. Where the data comes from

Every write is **best-effort**: telemetry must never be the reason a login,
a message send, or a socket connection fails. Every call site swallows its own
errors.

| Event | Written by | Notes |
|-------|-----------|-------|
| `LOGIN` + `lastLoginAt` | `AuthService.login` → `ActivityService.recordLogin` | IP/UA taken from the request in `AuthController`. |
| `LOGOUT` | `AuthController.logout` → `AuthService.recordLogout` | |
| `CONNECT` + open `UserSession` | `MessagingGateway.handleConnection` | Only on the offline→online transition. |
| `DISCONNECT` + close `UserSession` | `MessagingGateway.handleDisconnect` | Only when the last socket drops; stamps `durationSec`. |
| `MESSAGE_SENT` | `MessagingController.send` → `ActivityService.recordMessageSent` | **Metadata only.** Records who → whom and the conversation; **never the message body.** |
| `MODULE_VIEW` | `frontend` Shell → `POST /api/activity/track` | The one client-driven event. |

### Reusing presence, not reinventing it

Session tracking rides on infrastructure that already existed. The messaging
gateway (`backend/src/messaging/messaging.gateway.ts`) already maintained an
in-memory presence map (`userId → set of live socket ids`) and already fired on
the offline↔online transitions to broadcast presence and set `lastSeenAt`. The
Logs module hangs one more thing off those exact transitions:

- On **offline→online**, open a `UserSession` and remember its id in a second
  in-memory map (`sessionByUser`).
- On **online→offline** (last socket gone), close that session with its duration.

So "who is online" and "how long were they online" come from the socket lifecycle,
which is the truthful signal for active time — not from HTTP request counting.

### Module views: the only forgeable event

The Shell posts `MODULE_VIEW` on every route change. It is the sole event a client
originates, and it is harmless by construction:

- The endpoint records **`CurrentUser` only** — a client cannot log a view *as*
  someone else.
- The DTO whitelists the action to `MODULE_VIEW`; nothing else can be posted here.
- It is fire-and-forget on the client, wrapped in `.catch()`, so a failed track
  never surfaces to the user.

The Shell derives a friendly label ("Opened Messages") by matching the path
against the longest matching nav route, so `/submissions/:id` still reads as
"Submissions".

### The message label

`MESSAGE_SENT` needs a human label ("Messaged Jane Doe"). `MessagingService`
gained a small `conversationLabel(conversationId, forUserId)` helper — the other
person's name for a DM, the title for a group. It reads participant names only; no
message content is involved. The controller calls it fire-and-forget after the
message is already persisted and dispatched, so it adds nothing to send latency.

---

## 5. Backend module wiring

`backend/src/activity/` — three files, following the shape of the `audit` module:

- `activity.service.ts` — writers (`recordLogin`, `recordLogout`, `openSession`,
  `closeSession`, `trackModuleView`, `recordMessageSent`) and readers
  (`usersOverview`, `feed`, `actions`, `sessions`).
- `activity.controller.ts` — the REST surface **and** the `@Global` module.
- `dto.ts` — validated query/track DTOs.

The module is **`@Global`** and exports `ActivityService`, exactly like
`AuditModule`. That is what lets `AuthService`, the messaging gateway and the
messaging controller inject the logger without importing anything.

**The one subtlety — no dependency cycle.** `ActivityController` needs the live
presence set, which lives on `MessagingGateway`. So:

- `ActivityModule` **imports** `MessagingModule` (which now `exports` its gateway).
- `MessagingModule` does **not** import `ActivityModule` — it reaches
  `ActivityService` through the global provider.

At the provider level the graph is acyclic: `ActivityService` depends on nothing
in messaging, `MessagingGateway` depends on `ActivityService`, and
`ActivityController` depends on `MessagingGateway`. So no `forwardRef` is needed,
and the full `AppModule` DI graph compiles cleanly.

### Endpoints

| Method | Path | Guard | Purpose |
|--------|------|-------|---------|
| `POST` | `/api/activity/track` | auth only | Record the caller's own module view. |
| `GET` | `/api/activity/users` | `activity.view` | Overview rows (identity + derived activity). |
| `GET` | `/api/activity` | `activity.view` | The event feed, filtered and paged. |
| `GET` | `/api/activity/actions` | `activity.view` | Distinct actions, for the filter dropdown. |
| `GET` | `/api/activity/sessions` | `activity.view` | Sessions with durations, filterable by state. |

`usersOverview` computes its per-user rollups (event count, message count, last
activity, session count, total time online) in four grouped queries stitched in
memory — not N round-trips per user. "Online now" is layered on top from the
gateway's authoritative live set.

---

## 6. The screen

`frontend/src/pages/Logs.tsx`, mounted at `/logs` behind
`<Guard permission="activity.view">`, with a nav item under **System**. One page,
three tabs — three views of the same story:

- **Users** — KPIs (total / online now / never signed in) over a table: last login
  (or a "Never" pill), last activity (relative), session count, total time online,
  message count. Auto-refreshes every 30s.
- **Activity** — the raw event feed: searchable (over detail and user name),
  filterable by action, paged. Mirrors the Audit screen's layout so it feels
  familiar.
- **Sessions** — online periods with durations, filterable by all / online / ended.
  An open session shows elapsed-so-far, not a dash.

Two shared formatters were added in `frontend/src/lib/format.ts`: `fmtDuration`
(`"1h 24m"`, `"45s"`) and `fmtAgo` (`"5m ago"`, `"2d ago"`, else a date).

---

## 7. Applying it

The Prisma client is regenerated as part of development. To create the tables in a
database, from `backend/`:

```
npm run prisma:deploy      # applies migration 20260714120000_activity_logs
# or, in dev:
npm run prisma:migrate
```

Existing users show as **"Never signed in"** until their next login — which is
accurate, because there was no login history before this shipped. Sessions and
activity begin accumulating from first use.

---

## 8. Known limitations

- **Single-instance presence.** Sessions are opened and closed by the socket
  gateway's in-memory maps. This is correct for one backend instance — the same
  constraint the gateway already documents. Scaling past one process needs the
  socket.io Redis adapter and a shared presence store, at which point session
  open/close should move there too.
- **Crash recovery is at boot, not instant.** A session's close is written when the
  last socket drops; if the process is killed mid-session that write never happens,
  so the row is left `endedAt = null`. The gateway now sweeps these shut on the next
  boot (`ActivityService.closeOrphanedSessions`), stamping `endedAt` but leaving
  `durationSec` null — we know it started, not how long it ran, so it is recorded as
  unknown rather than invented. The window in which a ghost shows as "Online" on the
  **Sessions** tab is therefore only *between* a crash and the next restart; the
  **Users** tab's "Online now" is never affected (it reads the live gateway set, not
  open rows). Under a multi-instance deployment this sweep would need to move behind
  the shared presence store so one instance's boot does not close another's live
  sessions.
- **Privacy by design.** Message *content* is never recorded — only that a message
  was sent, to whom, and in which conversation. This is intentional and should stay
  that way.

## 9. Hardening applied after first ship

A review pass tightened five things:

- **Module-view flooding.** The Shell posted a `MODULE_VIEW` on every route change —
  every re-mount, every record paged under one module, and (in dev) StrictMode's
  double-invoke. It now dedupes by resolved module within a 5-minute window, so only
  genuine module transitions are recorded.
- **Session open/close race.** `openSession` was fire-and-forget, so a socket that
  dropped before the write resolved orphaned its row. The open is now awaited, and
  `closeSession` falls back to the user's most-recent open session when the
  in-memory id is missing — a session can no longer be orphaned by a timing gap.
- **Real client IP for sockets.** Behind nginx the socket's own address is the
  proxy's. Session/CONNECT rows now read the left-most `x-forwarded-for` hop, the
  same intent as express `trust proxy` on the HTTP side.
- **Orphan sweep on boot** (see §8).
- **Batched delivered fan-out.** `MessagingGateway.dispatchMessage` marked each
  online recipient delivered in a serial per-recipient write (N round-trips per
  message in a large group). It now advances every online recipient's cursor in one
  statement via `MessagingService.markDeliveredForRecipients`, then emits the
  per-recipient receipts.

Covered by `src/activity/activity.service.spec.ts` (duration maths, the race
fallback, idempotency, the boot sweep) and the batched-fan-out cases in
`src/messaging/messaging.service.spec.ts`.

One related concern from the same review — a live socket outliving a role change or
account disable — was already closed independently: `verifySession` re-reads status,
role and `tokenVersion` from the database on the handshake, so a revoked or demoted
account cannot keep a privileged socket.
