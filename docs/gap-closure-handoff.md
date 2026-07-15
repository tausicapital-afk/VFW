# Gap-closure pass — handoff

Written 2026-07-14, at the end of a session that had **no database and no Railway
access**. The code for all three gaps is written and committed; what is left is
the verification that genuinely requires a live Postgres and the Railway
dashboard. This file is the checklist for whoever has both.

**Read this alongside** `architecture.md` §3.2 (discount sign-off), §5 + §10.1
(the public backend domain) and §11.6 (socket flooding), which now describe the
intended end state.

---

## What was done, and what it rests on

| Phase | Code | Still needs a human |
|---|---|---|
| 1 — enforce `discountApprovalPct` | done | run the DB-backed spec |
| 2 — close the backend's public domain | done (the code half only) | **two Railway steps, below** |
| 3 — rate-limit socket events | done | drive two live sockets (optional) |

### Files changed

**Phase 1**
- `backend/src/pricing/pricing.service.ts` — new `discountApproval(subtotal,
  discountAmount, thresholdPct)`. Pure, derived, never stored.
- `backend/src/submissions/dto.ts` — `ApproveDto.acknowledgeDiscountOverride`.
- `backend/src/submissions/submissions.service.ts` — `approve()` refuses a
  discount over the threshold without the acknowledgment, and writes the override
  (threshold + actual discount) into the `AuditEntry` in the same transaction.
- `backend/src/pricing/pricing.service.spec.ts` — 5 pure cases (incl. the AMT and
  boundary ones).
- `backend/src/submissions/discount-approval.spec.ts` — **new**, 5 integration
  cases through the real guard.

**Phase 2**
- `backend/src/main.ts` — listens on `::` instead of `0.0.0.0`.
- `frontend/nginx.conf.template` — comments only; `BACKEND_URL` was already the
  substituted variable, so there was nothing structural to change.
- `docs/DEPLOYMENT.md` — new *Closing the backend's public door* section.
- `backend/.env.example` — `TRUST_PROXY_HOPS` must be re-measured, not reasoned.

**Phase 3**
- `backend/src/messaging/socket-throttle.ts` — **new**, the limiter.
- `backend/src/messaging/socket-throttle.spec.ts` — **new**, 8 pure cases.
- `backend/src/messaging/messaging.gateway.ts` — charges `typing` / `read` /
  `delivered` against it; emits `rate_limited` on a breach.

Nothing else was touched. In particular: the 100% discount cap, the rest of
`calc()`, the `ACL` matrix, the HTTP throttler, `assertMember()`, the receipt
cursors, and `common/cookie.ts` are all exactly as they were.

---

## 1. Run the full suite (needs Postgres)

The baseline to beat is **98 passing**. This pass adds **18** specs, so a clean
run should be **116 passing**.

```bash
docker compose up -d          # Postgres on :5434
cd backend
npm test
```

In the session that wrote this, only the 59 DB-free specs could run (`receipts`,
`score`, `pricing.service`, `socket-throttle`) — **59/59 passed**, and
`npx nest build` was clean. Everything that boots the Nest app (`acl.spec.ts`,
`lifecycle.spec.ts`, `messaging.service.spec.ts`, `catalog.spec.ts`, and the new
`discount-approval.spec.ts`) was **never executed**. Treat the 116 as a
prediction, not a result, until you have run it.

> If `npm test` reports type errors about `tokenVersion` or `nextSubmissionSeq`,
> the generated Prisma client is stale — `npx prisma generate`. That was already
> true before this pass; it is not something this change introduced.

---

## 2. Phase 1 — prove the threshold by hand

`Settings.discountApprovalPct` seeds at **15**. Sign in as Accounting
(`accounting@vanfashionweek.com`, local seed default `Vfw@2026!`) and, as a rep, create a submission
discounted **25%** (`VFW-FW26` / `VFW-BRONZE`, `discountType: "PCT"`,
`discountValue: 25`).

```bash
# a) over the threshold, unacknowledged  -> 400
curl -si -X POST "$APP/api/submissions/$ID/approve" -b "$ACCT_COOKIE" \
     -H 'content-type: application/json' -d '{}'
# expect: 400, "This sale is discounted 25.00%, above the 15.00% that needs
#               accounting sign-off. Re-send with acknowledgeDiscountOverride: true…"

# b) the same one, acknowledged          -> 201
curl -si -X POST "$APP/api/submissions/$ID/approve" -b "$ACCT_COOKIE" \
     -H 'content-type: application/json' \
     -d '{"glAccount":"4050","acknowledgeDiscountOverride":true}'

# c) the audit row must say WHY sign-off was needed
curl -s "$APP/api/submissions/$ID/audit" -b "$ACCT_COOKIE" | jq '.[0]'
```

(c) should show `action: "APPROVED"`, a `detail` reading
`Posted to GL 4050 — discount override: 25.00% exceeds the 15.00% approval
threshold, signed off by <name>`, and a `payload.discountOverride` of
`{thresholdPct: "15.00", discountPct: "25.00", discountAmount, discountType,
subtotal, currency}`.

Then: `UPDATE "Settings" SET "discountApprovalPct" = 30 WHERE id = 1;` and approve
another 25% submission with **no** acknowledgment — it should now pass, with no
migration and no backfill. Put it back to 15 afterwards.

**Paste the actual status codes and the audit JSON into the final report.** "The
spec passes" is not the same claim.

---

## 3. Phase 2 — the two Railway steps (⚠️ the only manual work in this pass)

Full detail in `docs/DEPLOYMENT.md` → *Closing the backend's public door*. In
short, and **in this order**:

**Step A — baseline the vulnerability first, while the public domain still
exists.** This is the evidence that the change was worth making:

```bash
curl -s https://backend-production-8dcb.up.railway.app/api/health/ip \
     -H 'X-Forwarded-For: 1.2.3.4'
```

Whatever comes back as `ip` is what the rate limiter keys on. If a header you
invented can move it, an attacker rotating that header gets unlimited buckets.

**Step B — point the proxy at the private domain** (frontend service variable):

```bash
railway variables --service frontend \
  --set 'BACKEND_URL=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}'
```

`http://`, not `https://`. This only works because the backend now listens on
`::` — Railway's private network is IPv6-only. Redeploy the frontend, then
confirm the app still signs in, and:

```bash
curl -s https://frontend-production-b4a4.up.railway.app/api/health/ip \
     -H 'X-Forwarded-For: 1.2.3.4'
```

`ip` must be **your real address** — not nginx's, and not `1.2.3.4`. If it is
nginx's, `TRUST_PROXY_HOPS` is too low; if it is `1.2.3.4`, it is too high.
**Measure the right number here and set it on the backend service.** The hop count
that was correct before this change is not the one that is correct after it — a
hop has been removed from the chain.

**Step C — remove the backend's public domain. This cannot be scripted; there is
no `railway domain --remove`:**

> Railway → project **VFW** → **backend** service → **Settings** → **Networking**
> → **Public Networking** → the `backend-production-8dcb.up.railway.app` entry →
> **Remove domain** → confirm.
>
> Leave **Private Networking** on. Do this only after Step B is deployed and
> verified — it is the frontend's only remaining route to the API.

Then confirm the door is shut (Railway's edge should 404, rather than our app
answering):

```bash
curl -si https://backend-production-8dcb.up.railway.app/api/health | head -1
```

Finally re-check that legitimate traffic through the proxy is unchanged: the
`auth` bucket still gives 10/min then 429s for 15 minutes, and `global` still
allows 300/min.

---

## 4. Phase 3 — assumptions worth confirming

The limiter is in and unit-tested, but two calls were made without you:

1. **The limits.** `typing` 60/min, `events` (everything) 240/min, each blocking
   for 1 minute on breach. Set so a human cannot reach them and a script cannot
   miss them — but they are a guess at your traffic, and they live in one table
   (`socketBuckets`) precisely so they are cheap to change.
2. **The breach UX.** The socket gets a typed
   `rate_limited { event, bucket, retryAfterMs }` event; it is not silently
   dropped and not disconnected. **Nothing in the frontend listens for
   `rate_limited` yet** — the event is emitted into the void until someone wires
   it into `Messages.tsx`. That was deliberate (this pass was backend-only), but
   it means a throttled user currently sees their typing indicator stop working
   with no explanation.

A live two-client check (flood `typing` from user A, confirm user B in the same
conversation is unaffected) is the one thing the unit tests cannot prove, since
they stub the clock and never open a socket.

---

## 5. The thing this pass found that the brief did not expect

**The gateway has no message-send handler.** Messages are persisted over REST
(`POST /api/messaging/conversations/:id/messages`) and only *fanned out* over the
socket, so "WebSocket message flooding" is really "inbound socket **event**
flooding" — `typing`, `read`, `delivered`. Those are what the new limiter covers.

The REST send path is still only protected by the HTTP throttler's `global`
bucket, which is **IP-keyed, 300/min** — so one user on a shared office IP can
still consume the whole office's message-send budget. Closing that means a
per-user limit on the REST send route, which would mean touching the HTTP
throttler, which this pass was explicitly told not to do. **Flagging it, not
fixing it.**
