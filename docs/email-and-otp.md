# VFW Console — Transactional Email & OTP Signup

The system's outbound email — welcome, verification, password reset — and the
email-OTP signup flow that replaced administrator approval. Written 2026-07-14.

---

## What this covers

1. One **global email template** every message shares.
2. An **SMTP transport** (cPanel / nodemailer).
3. **Email-OTP signup**: create account → welcome email with a 6-digit code →
   verify → straight to the dashboard.

The two product decisions behind it:

- **OTP verification activates the account and logs the user in.** Entering the
  correct code flips the account to `ACTIVE`, issues a session cookie, and lands
  the user on the dashboard. This **replaces** the old administrator-approval
  gate with email verification.
- **Signup stays invitation-only.** Role and department still come from the
  invitation; the OTP step is layered on top.

> ⚠️ **Not a regression.** Signup used to create a `PENDING` account an admin had
> to approve. That gate is gone by design. `PENDING` now means *"email not yet
> verified."* Don't "restore" admin approval thinking it was lost.

---

## The signup flow

```
                  ┌──────────────────────────────────────────────────────┐
  Invitation  →   │ 1. POST /api/auth/signup                             │
  code            │    • role/dept taken from the invitation             │
                  │    • account created as PENDING                       │
                  │    • 6-digit OTP minted (argon2-hashed), welcome mail │
                  │    • returns { email, otpRequired:true }  (no cookie) │
                  └──────────────────────────────────────────────────────┘
                                        │  SPA navigates to /verify
                                        ▼
                  ┌──────────────────────────────────────────────────────┐
  6-digit code →  │ 2. POST /api/auth/verify-otp                         │
                  │    • correct code → account ACTIVE                    │
                  │    • session cookie issued (1 day)                    │
                  │    • returns { user }                                 │
                  └──────────────────────────────────────────────────────┘
                                        │  ['me'] populated → App swaps tree
                                        ▼
                                  3. Dashboard
```

Resend and recovery: `POST /api/auth/resend-otp` mints a fresh code (retiring the
previous one) and re-emails it.

---

## Endpoints

| Method / path | Auth | Body | Returns | Notes |
|---|---|---|---|---|
| `POST /api/auth/signup` | public | `code, name, email, password, phone?, department?` | `{ email, otpRequired:true, devOtp? }` | Creates a `PENDING` account, sends the welcome email. **No session issued here.** Fails `503` if email is unconfigured (nothing could ever deliver the code). |
| `POST /api/auth/verify-otp` | public | `email, code` (6 digits) | `{ user }` + `Set-Cookie` session | Correct code → `ACTIVE` + session. Uniform error for unknown email / wrong / expired / too many attempts. |
| `POST /api/auth/resend-otp` | public | `email` | `{ message, devOtp? }` | Uniform reply whether or not the address maps to a pending account (no enumeration). |
| `POST /api/auth/forgot-password` | public | `email` | `{ message, devResetToken? }` | Unchanged behaviour; now sends the restyled reset email. |
| `POST /api/auth/reset-password` | public | `token, password` | `{ ok:true }` | On success also sends a **"password changed"** confirmation email (best-effort). |

`devOtp` / `devResetToken` appear **only** when no SMTP is configured *and*
`DEV_ECHO_LINKS=true` *and* `NODE_ENV != production` — see [Local dev](#local-development).

---

## Security properties

These are deliberate; preserve them if you touch this code.

- **Codes are stored hashed.** Only the argon2 hash of the OTP is persisted
  (`EmailOtp.codeHash`), exactly like a password. The plaintext lives only in the
  email. A leaked table row does not hand anyone a working code.
- **Brute force is capped.** `MAX_OTP_ATTEMPTS = 5` wrong guesses burns the code;
  a six-digit space cannot be walked.
- **Single-use, short-lived.** `OTP_TTL_MINUTES = 10`. A consumed or expired code
  is rejected. Issuing a new code retires any earlier unconsumed one, so only the
  newest email works.
- **No account enumeration.** `verify-otp` returns one uniform error for every
  failure mode; `resend-otp` returns one uniform message regardless of whether the
  address exists. Neither reveals who is registered.
- **Email is required for signup.** If the transport is unconfigured the endpoint
  refuses up front (`503`) rather than stranding a `PENDING` account nobody can
  ever verify.
- **Lockout is cleared on verification.** Whoever proves control of the inbox does
  not inherit a brute-force lockout left by someone guessing at the password.

---

## The global email template

Every message flows through one shell in `backend/src/common/email.ts`
(`layout()`): a table-based, inline-CSS, ~600px responsive layout with a preheader
line, a branded header bar, a body slot, and a footer. Email clients don't support
external CSS or modern layout, so everything is inline and table-based on purpose.

Change the shell once and **all** emails move together — that is what makes it a
template rather than five hand-rolled strings drifting apart.

Shared building blocks: `button()` (bulletproof CTA), `codeBlock()` (the spaced
6-digit code), and `esc()` (escapes anything user-derived before it reaches HTML).

### The five emails

| Builder | Subject | Sent when |
|---|---|---|
| `welcome(to, name, code, minutes)` | *Welcome to {brand} — verify your email* | account created (code inline) |
| `otp(to, name, code, minutes)` | *{brand} verification code: {code}* | on resend |
| `passwordReset(to, token, minutes)` | *Reset your {brand} password* | forgot-password flow |
| `passwordChanged(to)` | *Your {brand} password was changed* | after a successful reset |
| `invitation(to, code, roleLabel)` | *Your invitation to {brand}* | invite issued |

Each returns a full `Mail` with **both** an HTML and a plain-text body.

**Preview:** run the app, or regenerate the rendered previews (see
[Previewing templates](#previewing-templates)).

---

## Configuration

SMTP can be set **two ways**, and the app resolves them in this order:

1. **In-app** — *Administration → Configuration → Email (SMTP)*. An administrator
   sets host/port/username/password/from-address from the console; values are
   saved to the database (the `ConfigSetting` table, the password **encrypted at
   rest**) and take effect immediately, no redeploy. A **Send test email** button
   proves it works. This is how a non-technical operator turns email on. See
   `backend/src/config/`.
2. **Environment variables** — the `MAIL_*` vars below. Real credentials live only
   in gitignored `backend/.env`; `backend/.env.example` carries placeholders.

**Resolution is database value → environment variable → built-in default**, per
key. So env vars still fully configure a fresh install, and the in-app screen
overrides them per deployment. `EmailService` reads through `ConfigService`
rather than `process.env` directly, and rebuilds its SMTP transport whenever a
value changes.

> **Common gotcha (this is what "email not configured on the server" means in
> production).** The `MAIL_*` vars live in local `backend/.env`, which is
> gitignored and **never ships to Railway** — so a fresh Railway backend has no
> email config and every invite/OTP shows *"Email is not configured on this
> server."* Fix it by either setting the `MAIL_*` vars on the Railway **backend**
> service, or (once this build is deployed) filling them in under
> *Administration → Configuration*.

The `MAIL_*` variables:

| Variable | Example | Purpose |
|---|---|---|
| `MAIL_HOST` | `mail.veeb.co.ke` | SMTP server |
| `MAIL_PORT` | `465` | `465` = implicit TLS (ssl); `587` = STARTTLS |
| `MAIL_USERNAME` | `patriotic@veeb.co.ke` | SMTP auth user |
| `MAIL_PASSWORD` | `••••••••` | SMTP auth password |
| `MAIL_ENCRYPTION` | `ssl` | `ssl` \| `tls` \| `none` (auto-derives from port if unset) |
| `MAIL_FROM_ADDRESS` | `patriotic@veeb.co.ke` | envelope From address |
| `MAIL_FROM_NAME` | `Patriotic Payroll` | From name **and the brand name shown in every email** |
| `MAIL_BRAND_COLOUR` | `#0C7A4D` | accent for header + buttons (optional) |
| `MAIL_SUPPORT_ADDRESS` | `patriotic@veeb.co.ke` | shown in the footer (optional; defaults to From) |
| `APP_URL` | `https://app.example.com` | base for emailed links (reset, invite) |

The transport is considered **configured** only when host, username, password and
from-address are all present. `EmailService.send()` throws `503` otherwise — it
never silently falls back to logging codes.

> **Brand-name note.** The brand shown inside every email is `MAIL_FROM_NAME`. It
> is currently *"Patriotic Payroll"* (the shared SMTP mailbox), not *"VFW Console"*.
> If emails should read "VFW Console" while still sending from the patriotic@
> mailbox, split the display brand from the From name (add a dedicated brand env
> var) rather than changing `MAIL_FROM_NAME`.

### Production (Railway)

Set the `MAIL_*` vars on the **API** service. `DEV_ECHO_LINKS` is ignored when
`NODE_ENV=production`, so codes are never echoed in a response there. See
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Local development

Without any `MAIL_*` set and with `DEV_ECHO_LINKS=true` (and a non-production
`NODE_ENV`), signup and resend return the OTP in the response as `devOtp`, and
forgot-password returns `devResetToken`. This lets you exercise the whole flow
without a mail account. The `/verify` screen pre-fills the echoed code and shows a
clearly-labelled dev banner. **This path is refused outright in production.**

With `MAIL_*` set, real mail is sent and the echo is ignored, even locally.

### Previewing templates

The rendered previews are produced from the actual `EmailService` (not a copy),
so what you review is what ships. Build the backend, then instantiate the service
with the desired `MAIL_*` env and call the builders — each returns `{ subject,
html, text }`. A convenience approach:

```bash
cd backend && npm run build
# then a small node script that sets MAIL_* env, requires ./dist/common/email.js,
# and writes builder .html output to a file — see git history for the generator.
```

---

## Data model

New in migration `20260714080852_email_otp`:

```prisma
enum OtpPurpose { SIGNUP }

model EmailOtp {
  id         String     @id @default(cuid())
  userId     String
  user       User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  purpose    OtpPurpose
  codeHash   String     // argon2 hash of the 6-digit code — never the plaintext
  expiresAt  DateTime
  attempts   Int        @default(0)  // wrong guesses; burns at MAX_OTP_ATTEMPTS
  consumedAt DateTime?
  createdAt  DateTime   @default(now())

  @@index([userId, purpose])
}
```

`User` gained the back-relation `emailOtps EmailOtp[]`. No enum change to
`UserStatus` — the flow reuses `PENDING` (unverified) → `ACTIVE` (verified).

---

## Files touched

**Backend**
- `src/common/email.ts` — nodemailer SMTP transport + global template + 5 builders
- `src/auth/auth.service.ts` — `signup` issues OTP, new `verifyOtp` / `resendOtp` /
  `issueOtp`, `reset` sends the confirmation email, PENDING login message updated
- `src/auth/auth.controller.ts` — `verify-otp` (sets the cookie) + `resend-otp`
- `src/auth/dto.ts` — `VerifyOtpDto`, `ResendOtpDto`
- `prisma/schema.prisma` + migration `20260714080852_email_otp`
- `.env` / `.env.example` — `MAIL_*` configuration
- dependency: `nodemailer` (+ `@types/nodemailer`)

**Frontend**
- `src/pages/VerifyOtp.tsx` — the 6-digit verification screen (paste, auto-advance,
  resend with cooldown)
- `src/pages/Signup.tsx` — navigates to `/verify` on success (old "awaiting
  approval" screen removed)
- `src/App.tsx` — `/verify` route
- `src/auth/AuthContext.tsx` — `verifyOtp()` action

---

## Verification performed (2026-07-14)

- SMTP authenticated against `mail.veeb.co.ke:465` (`transporter.verify()`).
- A real welcome email delivered through the actual `EmailService`.
- Full HTTP flow: signup → `PENDING` → verify → `ACTIVE` + session cookie.
- Wrong code rejected without activating; consumed code rejected on reuse.
- `resend-otp` returns a uniform reply for both known and unknown addresses.
- Backend build clean, all 98 tests pass; frontend build clean.

---

## Extending it

- **More OTP purposes** (e.g. step-up for sensitive actions): add a value to
  `OtpPurpose` and reuse `issueOtp` / the verify pattern.
- **New email types:** add a builder in `email.ts` that returns via `layout()` —
  it inherits the header, footer and theming for free.
- **Rebranding:** change `MAIL_FROM_NAME` (and optionally `MAIL_BRAND_COLOUR` /
  `MAIL_SUPPORT_ADDRESS`); every email updates together.
