# The mail relay

A ~200-line PHP endpoint on the cPanel box that lets the app send email from a
host that forbids SMTP.

## Why

Railway silently drops every outbound SMTP port. Measured from inside the
running container:

```
mail.veeb.co.ke:465  -> TIMEOUT (silently dropped)
mail.veeb.co.ke:587  -> TIMEOUT (silently dropped)
smtp.gmail.com:465   -> ETIMEDOUT
api.github.com:443   -> CONNECTED in 73ms
```

The credentials were never wrong — the same ones authenticate against
`mail.veeb.co.ke` in 1.7s from a normal machine. The app simply cannot open the
connection where it is hosted.

But it can make an HTTPS request, and `veeb.co.ke` sends mail perfectly well. So
the app POSTs the message to this file over 443 and this hands it to the local
mail server.

Compared with the alternatives: no third party, no monthly cap, no free tier to
expire, and mail still leaves from `veeb.co.ke` under the domain's own SPF/DKIM.
The cost is that this box is now part of the sending path — if it is down, mail
does not send (the app reports it, loudly, rather than pretending).

## Install

1. **Upload.** cPanel → File Manager → `/home3/veebcoke/public_html/`. Make a
   folder `vfw-relay`, upload `index.php` and `.htaccess` into it. Permissions
   `644` on both — the web server has to read them.

2. **Set the token.** Generate a long random string:

   ```bash
   openssl rand -hex 32
   ```

   Edit `index.php`, replace `CHANGE_ME_TO_A_LONG_RANDOM_STRING` with it. The
   script refuses to send while the placeholder is there, so a half-finished
   install fails closed rather than becoming an open relay.

3. **Check it answers.** Visiting `https://veeb.co.ke/vfw-relay/` in a browser
   should show:

   ```json
   {"ok":false,"error":"POST a JSON message here."}
   ```

   A 404 means the path is wrong. A directory listing means `.htaccess` did not
   upload. Plain PHP source on screen means PHP is not executing for that folder.

4. **Point the app at it.** Administration → Configuration → Mail accounts → Add
   account → **Send using: Relay**, then:

   - Relay URL: `https://veeb.co.ke/vfw-relay/`
   - Relay token: the string from step 2
   - From address: `vfw@veeb.co.ke` (or any address on an allowed domain)
   - Sender name: `VFW Console`

   **Send test** on the row before making it active.

## Security

This endpoint sends email to arbitrary recipients — invitations have to reach
people who do not have accounts yet — so it is guarded:

- **Shared token**, compared with `hash_equals`. A plain `===` leaks the token
  one character at a time to anyone patient enough to measure the difference.
- **From-domain allowlist** (`ALLOWED_FROM_DOMAINS`). A leaked token cannot be
  used to send as someone else's brand, only as `veeb.co.ke`.
- **Rolling hourly cap** (`HOURLY_LIMIT`, default 200). A leaked token cannot
  burn the server's sending reputation overnight before anyone notices. It fails
  *open* if the counter file is unreadable: a relay that stops sending over a
  bookkeeping error is worse than one that briefly overshoots a soft limit.
- **Header-injection rejection.** A newline in `to`/`subject`/`from` would let a
  caller append their own headers (`Bcc: everyone`). Rejected, not stripped — a
  subject containing a newline is not a subject we meant to send.
- **POST + JSON only**, with a body size limit.

The token is the whole perimeter. If it leaks, rotate it here and in the app's
mail account. It is stored encrypted at rest in the app (AES-256-GCM), never
returned to the browser, and never written to a log.

## The API

```
POST https://veeb.co.ke/vfw-relay/
X-Relay-Token: <token>          (or: Authorization: Bearer <token>)
Content-Type: application/json

{
  "to": "someone@example.com",
  "subject": "Your invitation",
  "html": "<p>…</p>",
  "text": "…",
  "fromAddress": "vfw@veeb.co.ke",
  "fromName": "VFW Console"
}
```

`200 {"ok":true}` on success. Otherwise `{"ok":false,"error":"…"}` with a status
that says which problem it is — `401` bad token, `403` From domain not allowed,
`429` hourly cap, `502` the local mail server refused it. They are kept distinct
on purpose: each one sends you to a different place to fix it.
