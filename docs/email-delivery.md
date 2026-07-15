# How email actually leaves this system

Checked 2026-07-15 against production (Railway project `VFW`, environment
`production`) and the cPanel host `veeb.co.ke`.

`email-and-otp.md` covers *what* the app sends — the OTP flow, the global
template, the five builders. This covers *how a message physically gets out*, why
that turned out to be the hard part, and what to do when it stops.

> **Nothing here contains a password, key or token.** This repository is
> **public**: a secret committed here is world-readable forever, in history, even
> after a later commit removes it. Every secret below lives either in the
> encrypted `MailAccount` table or on the cPanel box. Where you see
> `CHANGE_ME_…`, that is the real file's placeholder, not a redaction.

---

## 1. Current state

Production sends email. It goes out like this:

```
Railway backend         veeb.co.ke                mail.veeb.co.ke        recipient
(SMTP blocked)          (your cPanel box)         (your mail server)
      │                       │                          │                    │
      │──── HTTPS :443 ──────▶│                          │                    │
      │   POST /vfw-relay/    │                          │                    │
      │   X-Relay-Token       │──── SMTP :465 (local) ──▶│                    │
      │                       │   AUTH, MAIL FROM, DATA  │────── delivery ───▶│
```

Proven end to end on 2026-07-15: `POST /api/invitations` with an address
returned `emailed: true, emailError: null` in 2.2s, and the invitation arrived.

Free, permanently: no third-party service, no monthly cap, no trial to expire.
Mail leaves `veeb.co.ke` under the domain's own SPF/DKIM. **The cost is that the
cPanel box is now in the sending path** — if it is down, mail does not send, and
the app reports that rather than pretending.

---

## 2. Why it did not work for so long

Four separate walls, stacked. Each one hid the next, and only the first was
visible from the app. Worth reading before you debug anything here, because the
instinct each time was "the mailbox settings must be wrong", and each time that
was false.

### Wall 1 — nothing was configured

`MAIL_*` lives in gitignored `backend/.env` and never shipped to Railway.
Production had no credentials at all, so every invite showed *"Not emailed. Email
is not configured on this server."* That much was honest.

### Wall 2 — Railway black-holes SMTP

Measured from inside the running container (`railway ssh --service backend`, raw
TCP connect):

```
mail.veeb.co.ke:465  -> TIMEOUT (silently dropped)
mail.veeb.co.ke:587  -> TIMEOUT (silently dropped)
smtp.gmail.com:465   -> ETIMEDOUT
api.github.com:443   -> CONNECTED in 73ms
```

General egress is fine; SMTP ports are dropped without a refusal. This is
Railway's anti-abuse policy on this plan. **No SMTP credential can ever work from
Railway** — the same cPanel credentials authenticate in **1.7 seconds** from a
normal machine.

> ### Read the symptom, not the setting
>
> - **~60s hang, then 504/503** → the **network**. Nothing about the mailbox will
>   fix it.
> - **"Invalid login" / "535 Incorrect authentication data"** → the
>   **credential**. Now you may look at the password.
>
> Hours were spent regenerating passwords over a hang. Don't.

### Wall 3 — cPanel disables PHP `mail()`

Once the relay existed, its first live send returned an empty **500**. The host
disables `mail()` outright, as many cPanel providers do to force authenticated
SMTP. So the relay speaks SMTP itself (§4).

### Wall 4 — two bugs in the relay itself

- **The relay answered an empty 500.** A relay that cannot say why it failed is
  one you debug by guessing. It now converts fatals into JSON, with the detail
  gated behind the token (a PHP fatal names paths and functions — free
  reconnaissance for a stranger).
- **`.htaccess` protected nothing.** `<FilesMatch "^(?!index\.php$).*$">` uses a
  regex lookahead that **LiteSpeed silently ignores**, so the deny matched no
  files. Rewritten as deny-all-then-allow-`index.php`, lookahead-free.

---

## 3. The model: mail accounts

One row per sender in the `MailAccount` table, **exactly one active**. Managed at
*Administration → Configuration → Mail accounts*. No redeploy; a change takes
effect on the next send. Each row has its own **Send test** so a sender can be
proven *before* it is trusted with sign-up codes.

The secret is AES-256-GCM encrypted at rest, never returned to the browser, never
logged. The encryption key is `CONFIG_ENC_KEY`, falling back to `JWT_SECRET` —
**rotating `JWT_SECRET` makes every stored secret undecryptable**, which surfaces
as a decrypt error on the row, not as silent breakage.

### Providers

| Provider | How it sends | Needs | Works on Railway? |
|---|---|---|---|
| `smtp` | Dials the mail server directly | host, port, encryption, username, password | **No** — ports dropped |
| `relay` | HTTPS POST to our own box, which sends it | relay URL (https), relay token | **Yes** |
| `resend` | HTTPS POST to the Resend API | API key, verified domain | **Yes** |

Provider choice is one branch in `EmailService.deliver()`. Everything above it —
the template, the builders, every caller — is provider-blind, so adding Mailgun
later is another branch and nothing else.

The three do not split neatly in two: `relay` speaks HTTPS like `resend` but
needs a `host` (its URL) like `smtp`. Hence three predicates (`usesSmtp`,
`needsHost`, `isHttp`) rather than one `isHttp` flag — collapsing them either
demands an SMTP hostname from Resend or drops the relay's URL on save.

### Resolution order

1. The **active `MailAccount` row**. The normal path.
2. The **`MAIL_*` settings** (DB `ConfigSetting` → env → default) — but **only
   while the table is empty**, so a deployment predating mail accounts keeps
   sending untouched. Adding the first account takes over permanently. This
   fallback is always SMTP, so on Railway it can never deliver.

If rows exist but the active one's secret will not decrypt, `send()` returns 503
rather than falling back to `MAIL_*`. Sending from a different mailbox than the
screen names is worse than not sending.

### Changing a row's provider

The provider decides what its secret and its host **mean**. Blank normally means
"keep the stored secret", but an SMTP password is not an API key, and
`mail.veeb.co.ke` is not `https://veeb.co.ke/vfw-relay/`. So switching provider
**requires both again** — otherwise you get a row that reads as configured and
dies on the first real send.

---

## 4. The relay

Source: `ops/mail-relay/` (`index.php`, `.htaccess`, `README.md`).
Installed at `/home3/veebcoke/public_html/vfw-relay/` → `https://veeb.co.ke/vfw-relay/`.

The app POSTs the composed message over 443 (which Railway allows); the relay
hands it to `mail.veeb.co.ke:465` over authenticated SMTP. **That connection is
local to the cPanel box** and works fine — only Railway is blocked, which is the
whole reason the relay lives on the cPanel side.

Set `SMTP_HOST = ''` in `index.php` to use PHP `mail()` instead, on a host where
`mail()` is not disabled.

### Configuration (server copy only — never in git)

| Constant | Meaning |
|---|---|
| `RELAY_TOKEN` | Shared secret. The relay's entire perimeter. |
| `SMTP_HOST` / `SMTP_PORT` | `mail.veeb.co.ke` / `465`. Empty host = use `mail()`. |
| `SMTP_USER` / `SMTP_PASS` | The mailbox it authenticates as. |
| `ALLOWED_FROM_DOMAINS` | Domains permitted in `From`. Currently `veeb.co.ke`. |
| `HOURLY_LIMIT` | Rolling cap, default 200. |

Both `RELAY_TOKEN` and `SMTP_PASS` ship as `CHANGE_ME_…` placeholders and the
relay **fails closed** on either — an unconfigured relay must never become an
open one. The checks test a substring and a length bar rather than comparing to
the placeholder literal, because installing means find-and-**replace-all**, which
would otherwise rewrite the comparison too and leave
`if (RELAY_TOKEN === '<your real token>')` — always true, so a correctly
installed relay would insist it was unconfigured forever. (This bit us. It is
fixed.)

### Security

It can send to anyone — invitations must reach people without accounts — so:

- **Token** compared with `hash_equals`. A plain `===` leaks it one character at
  a time to anyone patient enough to measure.
- **From-domain allowlist.** A leaked token cannot wear another brand.
- **Rolling hourly cap.** A leaked token cannot burn the domain's reputation
  overnight. It **fails open** if the counter file is unreadable: a relay that
  stops sending over a bookkeeping error is worse than one that briefly
  overshoots a soft limit. The counter lives *outside* the web root.
- **Header-injection rejection.** A newline in `to`/`subject`/`from` would let a
  caller append headers (`Bcc: everyone`). Rejected, not stripped.
- **POST + JSON only**, with a body size limit.

### Its errors, and what each means

| Status | Meaning | Where to look |
|---|---|---|
| 401 | Bad or missing token | Token mismatch between `index.php` and the app row |
| 403 | From domain not allowed | `ALLOWED_FROM_DOMAINS` |
| 429 | Hourly cap hit | `HOURLY_LIMIT`, or something is looping |
| 500 | Not configured, or crashed | Placeholder still set; message says which |
| 501 | `mail()` disabled and no `SMTP_HOST` | Set `SMTP_HOST` |
| 502 | The mail server refused it | The message carries the real SMTP reply |

They are distinct on purpose: each sends you somewhere different.

---

## 5. The accounts

### cPanel — `veeb.co.ke` (the working one)

The relay account currently sending in production:

| Field | Value |
|---|---|
| Provider | `relay` |
| Relay URL | `https://veeb.co.ke/vfw-relay/` |
| Relay token | *(on the box + encrypted in the DB)* |
| From address | `patriotic@veeb.co.ke` |
| Sender name | `VFW Console` |

The same mailboxes as a **direct `smtp`** account — correct for local dev, or any
host that permits SMTP, and **dead on Railway**:

| Field | Value |
|---|---|
| Host | `mail.veeb.co.ke` — a hostname, never an email address |
| Port / encryption | `465` / `ssl` (or `587` / `tls`) |
| Username | the full mailbox address, e.g. `vfw@veeb.co.ke` |
| From address | same as the username |

### Tausi — `Tausicapital@gmail.com`

The second mailbox, kept so the two can be swapped. Also the Railway account
owner (see `DEPLOYMENT.md`).

| Field | Value |
|---|---|
| Provider | `smtp` |
| Host | `smtp.gmail.com` |
| Port / encryption | `465` / `ssl` (or `587` / `tls`) |
| Username | `Tausicapital@gmail.com` |
| From address | `Tausicapital@gmail.com` |
| Password | **a 16-character Google App Password — not the account password** |

Three things about Gmail that are not optional knowledge:

1. **Google switched off plain-password SMTP in 2022.** The account password
   returns `535-5.7.8 Username and Password not accepted` no matter how it is
   stored. Enable 2FA on the account, then Security → App passwords → generate
   one for "Mail", and use that.
2. **Gmail rewrites `From`** to the authenticated address unless the alias is
   verified in Gmail.
3. **Free accounts cap around 500 recipients/day.**

> **This account cannot send from production as-is.** It is an `smtp` account, so
> Railway drops it (§2). The relay will not carry it either — the relay
> authenticates as a `veeb.co.ke` mailbox and its `ALLOWED_FROM_DOMAINS` is
> `veeb.co.ke`, by design, so a leaked token cannot send as anyone else. Gmail is
> usable from **local dev**, or from a host without the SMTP block, or via
> `resend` with the domain verified. It is documented here so switching is a
> click on the day the app moves.

### Resend — the third option, wired but unused

`provider: resend` is implemented and deployed; `api.resend.com` is reachable
from the production container (verified). It needs a Resend account, an API key
and a **verified sending domain** — until the domain's DNS records are in, it
delivers only to the account owner's own address and returns **403** for
anything else. 401 (bad key) and 403 (unverified domain) are deliberately kept
apart: one needs a new key, the other needs DNS.

Not needed while the relay works. Worth having if the cPanel box ever becomes a
liability in the sending path.

---

## 6. Operating it

### Add or switch a sender

*Administration → Configuration → Mail accounts.* Add the account, **Send test**
on its row, and only then make it active. The radio switches sender in one click;
exactly one row is ever active, enforced in a transaction.

Deleting the active account is refused while another exists — activate the other
first. Deleting the *last* one is allowed: that hands sending back to `MAIL_*`,
or turns email off loudly.

### Bootstrap without the UI

```bash
railway run --service backend npm run mail:add -- \
  --provider relay --label "cPanel relay" \
  --host https://veeb.co.ke/vfw-relay/ \
  --from patriotic@veeb.co.ke --from-name "VFW Console" --activate
# the token/password comes from MAIL_ACCOUNT_PASSWORD, to keep it out of shell history
```

Run it through `railway run` so it encrypts with production's key. Plain SQL will
not do: the secret is ciphertext, and an INSERT with a plaintext one produces a
row that fails to decrypt at send time.

### Rotate the relay token or the mailbox password

1. Change it in `public_html/vfw-relay/index.php` on the box.
2. Edit the mail account and paste the new value (blank = keep the old one).

Do it in that order and the only gap is between the two steps. The token is the
relay's whole perimeter; the mailbox password is in plaintext in `index.php`,
which is the right place for it — that file is on your own box and not in git.

### Troubleshooting

| Symptom | Cause |
|---|---|
| ~60s hang → 504/503 | Network. On Railway with `smtp`, this is the block — expected. |
| "invalid login" / 535 | Actually the credential. |
| "did not return JSON (HTTP …)" | The relay URL is wrong, or PHP is not running there. `veeb.co.ke` answers unknown paths with an HTML page and **status 200**, so a typo looks like a success to anything not checking the body. |
| "Email is not configured" | No active account, and no `MAIL_*`. Instant, by design — it hands back a copyable code. |
| Status page says email DOWN | **Check `checkedAt` first.** Samples are 15 minutes apart; a fresh fix reads DOWN until the next one. Not a failure. |

---

## 7. Two traps that will bite again

### The test suite must never send mail

`test/jest.setup.ts` sets `MAIL_*` to `''` — **it must not `delete` them**.
`AppModule`'s `ConfigModule.forRoot()` runs dotenv when the test file imports it,
*after* setup, and refills any key not already `in process.env`. A deleted key
came back from the dev `.env`; an empty string does not. Deleting them looked
fine for months: most specs never send, and the ones that did just took ~23s each
to time out **against the real server**. Fixing it took `invitations.spec` from
106s to 13.6s.

For the same reason **`prisma/seed.ts` must never add a `MailAccount` row** —
`npm test` runs the seed, and an active row beats env entirely, with no variable
left to unset. That is why `scripts/add-mail-account.ts` is separate and manual.
A spec needing an account must point it at an unroutable host (`.invalid`).

### Secrets and this repository

It is **public**. `backend/.env.example` once carried a real Gmail address and
its live password — see the pre-2026-07-15 history of that file. **That account
should be treated as compromised**: removing a secret in a later commit does not
remove it from history, and the placeholder there now changes nothing for the
old one. (The literal is deliberately not repeated here — quoting it would put a
fresh copy in the current tree, which is what code search actually indexes.)

Nothing else has leaked. The cPanel mailbox password and the relay token have
only ever existed on the box and in the encrypted DB column — checked with
`git log -S`, not assumed.

Keep it that way. Placeholders in git; values on the box or in `MailAccount`.
