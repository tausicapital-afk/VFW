# VFW Console — Messaging

The team-chat subsystem end to end: data model, the REST + WebSocket split, the
exact event vocabulary, and the lifecycle of a message from keypress to blue
ticks. This is the implementer's reference — architecture.md **§11** is the
one-page summary of *why*; this is the *how*, at the level you need to change it.

Cross-refs: `architecture.md` §11 (rationale), `logs-module.md` (how messaging
feeds the activity/session telemetry), `roles-and-permissions.md` (`messaging.use`).

---

## 1. Scope and layout

Team chat inside the console — direct messages and groups, WhatsApp-Web style:
real-time delivery, typing indicators, online/last-seen presence, sent /
delivered / read ticks, and image/document attachments.

It is **additive**: new tables only, nothing in the money loop changed, and it is
deliberately **not** part of `AuditEntry` (that trail is financial evidence, not a
chat log — see `logs-module.md` §1 for the same boundary drawn again).

```
backend/src/messaging/
  messaging.gateway.ts     WebSocket surface: presence, receipts, typing, fan-out
  messaging.controller.ts  REST surface: history, sending, media, group admin
  messaging.service.ts     all persistence + the membership boundary
  messaging.module.ts      wiring (exports the gateway for the Logs module)
  receipts.ts              pure tick logic (unit-tested like score.ts)
  socket-throttle.ts       per-user inbound-event rate limiter
  dto.ts                   validated request bodies
frontend/src/
  pages/Messages.tsx       the screen
  lib/messaging.ts         REST client, query keys, socket→cache glue, tick render
  lib/socket.ts            the one shared socket.io client
```

---

## 2. Data model

Four tables (`backend/prisma/schema.prisma`). The shape is chosen so a receipt is
a *comparison*, not a row per message per recipient.

### `Conversation`
- `kind` — `DM | GROUP`.
- `dmKey` — for a DM, the two userIds **sorted and joined** (`"a:b"`), `@unique`.
  This is what makes opening a DM idempotent (see §6.1). Null for groups.
- `title` — group only.
- `lastMessageAt` — denormalized for ordering the conversation list without a
  join; bumped on every send.

### `ConversationParticipant`
- `(conversationId, userId)` unique — one membership row per person per thread.
- `isAdmin` — group rename / add / remove. Always false in a DM.
- **`lastReadSeq`, `lastDeliveredSeq`** — the receipt cursors. Each is the ordinal
  of the last message read by / delivered to this participant. Ticks are computed
  from these (§4). They only ever move **forward** (`GREATEST` in SQL).
- `mutedUntil` — present in the schema, **not yet wired** (see §12).

### `Message`
- **`seq`** — a global `@default(autoincrement())`. `cuid` is not orderable and
  `createdAt` can tie, so `seq` is the single source of truth for before/after and
  the thing the cursors point at.
- `body` — nullable (a pure-media message has none).
- `editedAt`, `deletedAt` — columns exist; **no edit/delete endpoint yet** (§12).

### `MessageAttachment`
- `storageKey` under `messages/<conversationId>/…`, plus filename, contentType,
  size, and image `width`/`height` (so the bubble reserves space without reflow).
  The bytes live in R2, never on the app disk (§7).

---

## 3. Two surfaces, one boundary

**The durable side is REST; the live side is the socket.** A message is
*persisted over REST*, then *fanned out over the socket*. Validation, the ACL, and
the membership check therefore run **once, in one place** — never duplicated on
the socket path.

- **REST** (`messaging.controller.ts`): history, sending, media, group admin.
- **Socket** (`messaging.gateway.ts`): typing, presence, delivered/read receipts,
  and the server→client push of new messages and conversations.

### 3.1 Transport

The gateway is a socket.io server mounted at **`/api/socket.io`**, so it rides the
same nginx front door as the API and the `vfw_session` cookie stays first-party.
The plain `/api/` proxy block does not pass the HTTP/1.1 `Upgrade` handshake, so
`frontend/nginx.conf.template` has a dedicated `location /api/socket.io/` block
(and Vite proxies it with `ws: true` in dev).

### 3.2 Handshake auth

The global HTTP `AuthGuard` cannot see a WebSocket handshake, so the gateway
authenticates the connection itself, with the **same** cookie, via the shared
`verifySession(jwt, prisma, token)` helper — one definition of "who is this
token", used by both the guard and the gateway. That helper re-reads the user's
status, role and `tokenVersion` from the database on the handshake, so a disabled
or demoted account (or one whose sessions were revoked by a password reset) cannot
open or keep a socket. A handshake without a valid session is disconnected
immediately.

### 3.3 Rooms

Two room namespaces:
- `user:<userId>` — a member's own room; every one of their tabs joins it. Used to
  reach a person wherever they are (presence, new-conversation notices).
- `conv:<conversationId>` — everyone in a thread. Used to fan a message or receipt
  to the whole conversation in one emit.

---

## 4. Receipts are cursors (`receipts.ts`)

The tick state of a message, **as its sender sees it**, is a pure function of the
participant cursors — no per-recipient rows, no network:

```
tickState(messageSeq, senderId, participants):
  others = participants without the sender
  if others is empty                       -> 'sent'   (note-to-self can't advance)
  if every other lastReadSeq      >= seq   -> 'read'   (✓✓ blue)
  if every other lastDeliveredSeq >= seq   -> 'delivered' (✓✓ grey)
  else                                     -> 'sent'   (✓)
```

"Every other participant" is deliberate: in a group the message is only **read**
once the *last* person has read it — the state tracks the **minimum** cursor
across everyone but the sender. The same function is mirrored render-only in
`frontend/src/lib/messaging.ts::tickState` so a bubble shows the right ticks
without a round-trip; the server still owns the cursors.

Cursors move with `GREATEST(...)` in raw SQL, so an out-of-order or stale client
can never rewind a receipt.

---

## 5. Event vocabulary

### 5.1 REST (`/api/messaging`, all `@Can('messaging.use')` + membership)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/users` | Directory: active users other than me, each tagged `online`. |
| `GET` | `/conversations` | My threads, newest first, each with `lastMessage` + `unreadCount` + live `online` per participant. |
| `POST` | `/conversations` | Open/create. DM is idempotent (§6.1). Returns `{ conversation, created }`. |
| `GET` | `/conversations/:id` | One thread (members only → else 404). |
| `GET` | `/conversations/:id/messages?before&limit` | Cursor page (seq `< before`), oldest-first for render. |
| `POST` | `/conversations/:id/messages` | Send. Persists, then fans out. Returns the `Message`. |
| `POST` | `/conversations/:id/attachments/presign` | Presigned PUT to R2 (§7). |
| `GET` | `/attachments/:attachmentId` | Presigned GET (inline for images/pdf). |
| `POST` | `/conversations/:id/read` | REST fallback for the read cursor; also broadcasts a receipt. |
| `PATCH` | `/conversations/:id` | Rename (group admin). |
| `POST` | `/conversations/:id/participants` | Add members (group admin). |
| `DELETE` | `/conversations/:id/participants/:userId` | Remove (admin) or leave (self). |

### 5.2 Socket — client → server (`@SubscribeMessage`)

Each is charged to the sender's rate-limit buckets first (§9); a breach replies
`rate_limited` and drops the event.

| Event | Payload | Effect |
|-------|---------|--------|
| `typing` | `{ conversationId, isTyping }` | Relayed to the rest of the room (never echoed to the sender). |
| `read` | `{ conversationId, seq? }` | Raise my read cursor (to `seq`, or to the latest); broadcast the receipt. |
| `delivered` | `{ conversationId, seq }` | Raise my delivered cursor; broadcast the receipt. |

### 5.3 Socket — server → client (`emit`)

| Event | Payload | When |
|-------|---------|------|
| `message` | `{ conversationId, message }` | A message was persisted and fanned out. |
| `receipt` | `{ conversationId, userId, lastReadSeq, lastDeliveredSeq }` | A cursor moved. |
| `presence` | `{ userId, online, lastSeenAt }` | A user went online/offline. |
| `typing` | `{ conversationId, userId, isTyping }` | Someone is typing. |
| `conversation` | `{ id, … }` | A thread was created / renamed / membership changed. |
| `rate_limited` | `{ event, bucket, retryAfterMs }` | An inbound event was throttled. |

---

## 6. Lifecycles

### 6.1 Opening a conversation

`createConversation` validates that every named user exists and is **active**
(you cannot DM a disabled account or a fabricated id). For a DM it computes
`dmKey = [me, other].sort().join(':')` and:

1. looks it up — if the thread exists, returns it with `created: false`;
2. otherwise creates it; if two requests race, the **unique `dmKey`** makes the
   loser catch `P2002` and return the thread the winner just made.

So opening the same DM twice never forks a second thread. A group is created with
the creator as the first `isAdmin` member and the named others as members. On a
real create the controller fans a `conversation` event to every participant's
`user:` room so their list refreshes.

### 6.2 Sending a message

```
POST /conversations/:id/messages
  service.sendMessage (one transaction):
    assertMember                         -- membership boundary
    reject if no body and no attachments
    validate attachment keys belong to this conversation
    create Message (+ attachment rows)
    bump Conversation.lastMessageAt
    advance the SENDER's own cursors to this seq   -- you've read what you sent
  -> { message, recipientIds }
  gateway.dispatchMessage:
    join sender + recipients to conv: room
    emit 'message' to the room
    mark every ONLINE recipient delivered in ONE statement, emit their receipts
  controller (fire-and-forget): activity.recordMessageSent  -- metadata only
```

The sender's cursors are advanced inside the same transaction as the insert — an
insert without the cursor bump, or vice-versa, would misreport the sender's own
ticks. Attachment keys are checked against this conversation's prefix so a client
cannot attach a blob it presigned for another thread.

### 6.3 Delivered and read

- **On send**, `dispatchMessage` marks delivered for everyone **online right now**
  via `markDeliveredForRecipients(conversationId, userIds, seq)` — a single
  `UPDATE … WHERE userId IN (…)` plus one read-back, rather than one round-trip per
  recipient (a large group otherwise costs N sequential writes per message). It
  then emits each per-recipient `receipt`.
- **On (re)connect**, everything already waiting for the arriving user is now
  delivered: `markAllDelivered(userId)` bumps their delivered cursor to the latest
  message in every one of their conversations and returns the ones that moved, so
  the gateway can emit those receipts to the senders. This is why a sender's ticks
  turn ✓✓ when the recipient comes online, with no message in flight.
- **Read** is client-driven: the open thread emits `read` (socket) — or `POST
  /read` as a fallback — raising the read cursor and broadcasting the receipt.

All three go through `GREATEST`, so cursors never regress.

### 6.4 Presence and sessions

Presence is an **in-memory map** in the gateway: `userId → set of live socket
ids`. Online iff the set is non-empty (a user may have several tabs). On the
transitions:

- **offline → online** (first socket): join the user's rooms; `markAllDelivered`;
  emit `presence{online:true}` to co-participants; and **open a `UserSession`** for
  the Logs screen (awaited, so a fast disconnect can't orphan it — see
  `logs-module.md` §4/§9).
- **online → offline** (last socket): write `lastSeenAt`; emit
  `presence{online:false, lastSeenAt}`; and **close the session** with its
  duration.

`presence` events are targeted: only the user's co-participants (people who share a
thread with them) are notified, computed by `coParticipantIds`.

### 6.5 Typing

`typing` is relayed to the rest of the `conv:` room with `socket.to(...)`, which
excludes the sender — you never see your own indicator. The client self-heals a
lost "stopped typing" with a 5-second timeout (`useMessagingRealtime`), so a
dropped stop-event can't leave someone "typing…" forever.

---

## 7. Attachments

Reuses the R2 `StorageService` and the presigned PUT/GET model exactly as
submission documents do — **the bytes never pass through the API**.

```
uploadAttachment(conversationId, file):        // frontend/lib/messaging.ts
  presign  -> { uploadUrl, storageKey, headers }   // key namespaced to the conv
  PUT file straight to R2
  read image dimensions (so the bubble reserves space)
  return AttachmentInput { storageKey, filename, contentType, size, width, height }
send({ body?, attachments: [AttachmentInput] })   // service re-checks the key prefix
```

`contentType` is a **whitelist** (`ALLOWED_CONTENT_TYPES` in `dto.ts`) — the
presign hands out a capability to write to the bucket, so only types we are
willing to serve back are signable. Size is capped (`MAX_ATTACHMENT_SIZE`, 25 MB).
Images and PDFs get an `inline` content-disposition on download so they render in
the bubble; everything else downloads. With `R2_*` unset the presign returns a
**loud 503**, never a silent local-disk fallback.

> **Orphan note:** a presign is a write capability; if the message is never sent,
> the object sits in R2 unreferenced. An R2 lifecycle rule (or a sweep) over
> `messages/` keys with no DB row is the intended cleanup — a follow-up (§12).

---

## 8. Access boundary

`messaging.use` is held by **every role** — anyone may message anyone. The real
boundary is **membership**: `assertMember()` gates every read and write, and a
non-member gets **404, not 403** — the same existence-hiding answer the rest of
the system gives for another rep's record, so this endpoint can't be used to probe
whether a conversation exists. Group rename / add / remove require `isAdmin`;
anyone can leave; a DM cannot be left (there is nothing to administer).

---

## 9. Rate limiting (`socket-throttle.ts`)

The HTTP throttler is a Nest guard over an Express request and cannot see a socket
event, so inbound socket events carry their own limiter — the same *shape* as the
HTTP one (a table of buckets, each with a limit and a block duration; an event must
satisfy every bucket that applies).

| Bucket | Applies to | Limit | On breach |
|--------|-----------|-------|-----------|
| `typing` | `typing` | 60 / min | blocked 1 min |
| `events` | every socket event | 240 / min | blocked 1 min |

Two deliberate differences from HTTP: it is **keyed by userId, not IP** (the socket
is authenticated, so the real actor is known, and IP-keying would put a whole NAT'd
office in one bucket); and **the counter survives a disconnect** (clearing it on
last-socket-close would hand a flooder a reset button). On a breach the socket gets
a typed `rate_limited` event rather than being silently dropped or hard-
disconnected. **Sending a message is not here** — it is a REST call, already
covered by the HTTP `global` bucket.

---

## 10. Frontend integration

`lib/socket.ts` holds **one** shared socket.io client for the whole app
(`autoConnect: false`, `withCredentials: true`, path `/api/socket.io`).

`useMessagingRealtime()` (mounted **once**, in the Shell) is the single place
socket events touch app state. It connects the socket and wires five handlers into
the react-query cache:

| Socket event | Cache effect |
|--------------|--------------|
| `message` | Append to the open thread's message list; invalidate `conversations` (server owns preview/order/unread). |
| `receipt` | Advance the matching participant's cursors in the `conversations` cache (`Math.max`, never backwards). |
| `presence` | Update a `presence` map keyed by userId. |
| `typing` | Update a `typing` map (conversationId → userIds), with the 5s self-heal. |
| `conversation` | Invalidate `conversations`. |

On unmount (i.e. **sign-out**) it tears the socket down entirely, so the next user
does not inherit the connection. Query keys live in `qk` (`conversations`,
`messages(id)`, `presence`, `typing`, `msg-users`). Because this runs in the Shell,
the nav's unread badge and the Messages screen both react live from any page.

---

## 11. Activity / Logs integration

Messaging is the main source of the admin-only Logs telemetry (see
`logs-module.md`), all **metadata only, never message content**:

- **`MESSAGE_SENT`** — the controller logs "Messaged <name>" after a send, with
  `{ conversationId, recipientIds }`. The label comes from
  `messaging.service.conversationLabel` (the other person for a DM, the title for a
  group) — participant names only.
- **Sessions / presence** — the gateway opens and closes a `UserSession` on the
  presence transitions (§6.4), which powers "online now" and "time online".

None of this touches the money loop, and none of it is in `AuditEntry`.

---

## 12. Known limitations & follow-ups

- **Single-instance presence.** The presence map (and the session open/close, and
  the socket throttle windows) live in one process. Correct for one backend
  instance; scaling past one needs the socket.io **Redis adapter** and a shared
  presence store, at which point presence, sessions, and throttle state move
  behind it. Consistent with the project's "add Redis when it is actually needed"
  stance.
- **Edit / delete not implemented.** `Message.editedAt` and `deletedAt` exist (the
  soft-delete → "this message was deleted" is designed for) but there is **no
  `PATCH`/`DELETE` route**. The schema advertises a feature the API does not yet
  serve — build the endpoints or drop the columns.
- **`mutedUntil` is dead.** Per-participant mute exists in the schema but nothing
  reads it — unread counts and fan-out ignore it. Until it is wired, muting is a
  no-op.
- **Orphaned attachments.** A presign with no follow-up send leaves an unreferenced
  R2 object (§7) — wants a bucket lifecycle rule.
- **CORS is permissive.** The gateway uses `cors: { origin: true, credentials: true }`
  (reflects any origin). `SameSite=Lax` on the cookie mitigates it; pinning to the
  known frontend origin is cheap defense-in-depth.

---

## 13. Where to change what

| I want to… | Touch |
|------------|-------|
| Add a socket event | `messaging.gateway.ts` (+ `socket-throttle.ts` bucket, + `useMessagingRealtime` handler) |
| Change what "delivered/read" means | `receipts.ts` **and** its frontend mirror in `lib/messaging.ts` |
| Add a REST endpoint | `messaging.controller.ts` + `messaging.service.ts` + `dto.ts` + `messagingApi` |
| Change the persistence / boundary | `messaging.service.ts` (`assertMember` is the gate) |
| Change presence / sessions | `messaging.gateway.ts` (+ `ActivityService` for the session rows) |
| Add an attachment type | `ALLOWED_CONTENT_TYPES` in `dto.ts` (and the `inline` set in the service) |
| Change the chat UI | `frontend/src/pages/Messages.tsx`, styles in `styles/messaging.css` |
