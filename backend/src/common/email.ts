import { Global, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../config/config.service';
import { MailAccountService, SendingAccount } from '../config/mail-account.service';

/**
 * Outbound email — one transport, one global template, and one fallback:
 * **failing loudly**.
 *
 * Transport is SMTP (cPanel / Gmail / any provider) over nodemailer. Every
 * message is poured through the same {@link layout} so the whole system speaks
 * with one voice: change the header, the colours or the footer once and every
 * email — welcome, OTP, password reset — moves together.
 *
 * What this deliberately does NOT do is log the code or link to the console and
 * carry on. A silent local fallback looks like it works right up until the first
 * real user cannot get into their account, and by then the "it worked in dev"
 * evidence is worthless. If the transport is not configured, send() throws and
 * the endpoint returns 503. That is a correct answer; a console.log is not.
 *
 * WHERE THE CREDENTIALS COME FROM, in order:
 *
 *  1. The active row in MailAccount — mailboxes an admin manages from the
 *     Configuration screen. This is the normal path (see mail-account.service).
 *  2. The MAIL_* settings, resolved DB-then-env by ConfigService, used ONLY
 *     while that table is empty, so a deployment that predates it keeps sending
 *     with no intervention:
 *
 *       MAIL_HOST=mail.veeb.co.ke      # a hostname, never an email address
 *       MAIL_PORT=465
 *       MAIL_USERNAME=vfw@veeb.co.ke
 *       MAIL_PASSWORD=********
 *       MAIL_ENCRYPTION=ssl            # ssl | tls | none
 *       MAIL_FROM_ADDRESS=vfw@veeb.co.ke
 *       MAIL_FROM_NAME="VFW Console"
 *
 * APP_URL (used to build every emailed link) stays global config either way — it
 * is a property of the deployment, not of the mailbox.
 */

export class EmailNotConfiguredError extends ServiceUnavailableException {
  constructor() {
    super(
      'Email is not configured on this server, so the message could not be sent. ' +
        'Add a mail account under Administration → Configuration.',
    );
  }
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// The global template
//
// Email clients are stuck in ~2005: no external CSS, patchy flexbox, Outlook
// rendering through Word. So the shell is a centred table with inline styles,
// and everything else is composed from the small kit below. Colours are read
// from BRAND_* env so the same code can wear a different suit per deployment.
// ---------------------------------------------------------------------------

// The template helpers below are module-level (they are called from inside
// `layout()` / `button()`), so they cannot reach the injected services through
// `this`. EmailService sets these references in its constructor, so brand
// name/colour follow whatever the admin has configured.
let cfg: ConfigService | null = null;
let acctSvc: MailAccountService | null = null;

function conf(key: string): string {
  return (cfg?.get(key) ?? process.env[key]?.trim() ?? '').trim();
}

/**
 * The brand shown at the top of every email. The sending mailbox's own "from
 * name" wins, so switching account can switch the brand with it; MAIL_FROM_NAME
 * is the deployment-wide default for accounts that do not set one.
 */
let brandOverride: string | undefined;
function brandName() {
  return (
    brandOverride ||
    acctSvc?.active()?.fromName ||
    conf('MAIL_FROM_NAME') ||
    'VFW Console'
  );
}

/**
 * Render `fn` as though `name` were the brand. Used when testing a mailbox that
 * is not the active one, so the test email wears the brand of the account being
 * tested rather than the one that happens to be live.
 *
 * `fn` must be synchronous — the override is module-level, and an await inside
 * would leak it into whatever else rendered in the gap.
 */
function withBrand<T>(name: string | undefined, fn: () => T): T {
  const previous = brandOverride;
  brandOverride = name;
  try {
    return fn();
  } finally {
    brandOverride = previous;
  }
}

function brandColour() {
  return conf('MAIL_BRAND_COLOUR') || '#0C7A4D';
}
function supportAddress() {
  return (
    conf('MAIL_SUPPORT_ADDRESS') ||
    acctSvc?.active()?.fromAddress ||
    conf('MAIL_FROM_ADDRESS') ||
    ''
  );
}

/** Escape anything interpolated into HTML that came from a person or the DB. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** A primary call-to-action button that survives Outlook (VML-free, bulletproof-ish). */
function button(label: string, href: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">` +
    `<tr><td style="border-radius:8px;background:${brandColour()};">` +
    `<a href="${esc(href)}" target="_blank" ` +
    `style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;` +
    `font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">` +
    `${esc(label)}</a></td></tr></table>`
  );
}

/** The big, spaced-out one-time code. Letter-spacing makes it read digit by digit. */
function codeBlock(code: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0;">` +
    `<tr><td align="center" ` +
    `style="background:#f4f6f5;border:1px solid #e3e8e6;border-radius:12px;padding:22px 12px;">` +
    `<div style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;` +
    `letter-spacing:12px;color:#0e0e11;padding-left:12px;">${esc(code)}</div>` +
    `</td></tr></table>`
  );
}

/**
 * The one shell every message shares. `bodyHtml` is trusted, pre-built HTML from
 * the builders below (never raw user input); anything user-derived must already
 * have been through {@link esc} before it reaches here.
 */
function layout(opts: { title: string; preheader: string; bodyHtml: string }): string {
  const name = esc(brandName());
  const colour = brandColour();
  const support = supportAddress();
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f0;-webkit-font-smoothing:antialiased;">
<!-- preheader: the grey preview line in the inbox, hidden in the body -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f0;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0"
           style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;
                  box-shadow:0 1px 3px rgba(16,24,32,.08);">
      <!-- header -->
      <tr><td style="background:${colour};padding:26px 32px;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;
                     letter-spacing:.4px;color:#ffffff;">${name}</span>
      </td></tr>
      <!-- body -->
      <tr><td style="padding:34px 32px 12px;font-family:Arial,Helvetica,sans-serif;
                     font-size:15px;line-height:1.6;color:#2b3230;">
        ${opts.bodyHtml}
      </td></tr>
      <!-- footer -->
      <tr><td style="padding:22px 32px 30px;border-top:1px solid #eef1f0;
                     font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8a938f;">
        <p style="margin:0 0 4px;">This is an automated message from ${name}.</p>
        ${support ? `<p style="margin:0 0 4px;">Questions? Reach us at <a href="mailto:${esc(support)}" style="color:${colour};">${esc(support)}</a>.</p>` : ''}
        <p style="margin:8px 0 0;">© ${year} ${name}. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Compose a plain-text alternative with a consistent footer. */
function textLayout(lines: string[]): string {
  const support = supportAddress();
  const footer = [
    '',
    '—',
    `This is an automated message from ${brandName()}.`,
    ...(support ? [`Questions? ${support}`] : []),
  ];
  return [...lines, ...footer].join('\n');
}

/** 465 is implicit TLS (secure); 587/25 start plaintext and upgrade via STARTTLS. */
function isSecure(account: SendingAccount): boolean {
  const enc = account.encryption?.toLowerCase();
  if (enc === 'ssl') return true;
  if (enc === 'tls' || enc === 'none') return false;
  return account.port === 465;
}

/**
 * Resend over HTTPS.
 *
 * Why an HTTP provider exists at all: the host decides what is possible. Railway
 * silently drops every outbound SMTP port — measured from inside the container,
 * `mail.veeb.co.ke:465` and `:587` and `smtp.gmail.com:465` all time out while
 * `api.github.com:443` connects in 73ms. No SMTP credential can work there, so
 * "fix the mailbox settings" is the wrong instinct: a 60-second hang is the
 * network, an "invalid login" is the credential.
 *
 * Called through global fetch (Node 20 in the container), so this adds no
 * dependency: it is one POST to a JSON API.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Lift the useful sentence out of Resend's error body; fall back to the status. */
async function resendError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    detail = body.message || body.name || '';
  } catch {
    // Non-JSON body (a proxy error page, say) — the status is all we have.
  }
  // 401 and 403 are different problems and must not be flattened: a bad key
  // needs a new key, an unverified domain needs DNS records. Telling an admin
  // "rejected the API key" when the key is fine sends them to the wrong screen.
  if (res.status === 401) {
    return `Resend rejected the API key${detail ? `: ${detail}` : ''}`;
  }
  if (res.status === 403 || res.status === 422) {
    return `Resend refused the message${detail ? `: ${detail}` : ''} (usually the sending domain is not verified)`;
  }
  return `Resend returned ${res.status}${detail ? `: ${detail}` : ''}`;
}

async function resendSend(account: SendingAccount, mail: Mail, from: string): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(await resendError(res));
}

/**
 * Prove the key works without sending. Resend has no dedicated ping, so this
 * lists domains — the cheapest authenticated GET. A 200 means the key is live;
 * it does NOT prove the from-address's domain is verified, which is why the test
 * button sends a real message rather than stopping here.
 */
async function resendVerify(account: SendingAccount): Promise<void> {
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${account.secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(await resendError(res));
}

/**
 * The relay: our own PHP endpoint on a box that IS allowed to send.
 *
 * Same trick as Resend — leave over 443 — but the far end is `ops/mail-relay`,
 * which hands the message to the local mail server on the cPanel host. So mail
 * still departs from veeb.co.ke under its own SPF/DKIM, with no third party and
 * no monthly cap. `account.host` is the relay URL; `account.secret` is the
 * shared token.
 */
async function relayPost(
  account: SendingAccount,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(account.host, {
      method: 'POST',
      headers: {
        'X-Relay-Token': account.secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Reaching the relay at all is a distinct failure from the relay refusing
    // the message: one means the URL or the box, the other means the payload.
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the relay at ${account.host}: ${why}`);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // A 404 page or a PHP fatal — not JSON. Say so plainly; "unexpected token <"
    // sends nobody anywhere useful.
    throw new Error(
      `The relay at ${account.host} did not return JSON (HTTP ${res.status}). ` +
        `Check the URL points at the relay folder and that PHP is running there.`,
    );
  }

  if (!res.ok || payload.ok !== true) {
    const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    throw new Error(`The relay refused the message: ${detail}`);
  }
  return payload;
}

async function relaySend(account: SendingAccount, mail: Mail): Promise<void> {
  await relayPost(account, {
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    fromAddress: account.fromAddress,
    fromName: account.fromName ?? '',
  });
}

/**
 * Prove the relay is reachable and the token is right, without sending.
 *
 * There is no ping endpoint by design — the relay's only job is to send. So this
 * posts a deliberately invalid message: the token is checked BEFORE the payload,
 * so a bad token still answers 401 while a good one gets as far as "a valid
 * 'to' address is required". Reaching that error is the proof.
 */
async function relayVerify(account: SendingAccount): Promise<void> {
  let res: Response;
  try {
    res = await fetch(account.host, {
      method: 'POST',
      headers: { 'X-Relay-Token': account.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the relay at ${account.host}: ${why}`);
  }

  if (res.status === 401) throw new Error('The relay rejected the token.');
  if (res.status === 404) {
    throw new Error(`No relay at ${account.host} (404) — check the URL.`);
  }
  // 400 is the expected answer to a probe with no recipient: token accepted,
  // payload rejected. Anything else that is not 2xx is a real problem.
  if (res.status !== 400 && !res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* not JSON — the status is all we have */
    }
    throw new Error(`The relay is not usable: ${detail}`);
  }
}

@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private transporter?: Transporter;
  /** Identifies the account+config the memoised transporter was built against. */
  private transporterKey = '';

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: MailAccountService,
  ) {
    // Let the module-level template helpers read live config and the active
    // mailbox too — they have no `this` to reach these through.
    cfg = config;
    acctSvc = accounts;
  }

  /**
   * The mailbox that sends. The active MailAccount row first; the legacy MAIL_*
   * settings only while that table is empty.
   *
   * Note what does NOT happen: if rows exist but the active one's password will
   * not decrypt, this returns undefined rather than quietly falling back to the
   * env vars. Sending from a different mailbox than the one the screen says is
   * active is worse than not sending — the admin gets a 503 and a decrypt error
   * on the row, which points at the real problem.
   */
  private resolve(): SendingAccount | undefined {
    const active = this.accounts.active();
    if (active) return active;
    if (this.accounts.any) return undefined;

    const host = this.config.get('MAIL_HOST') ?? '';
    const username = this.config.get('MAIL_USERNAME') ?? '';
    const password = this.config.get('MAIL_PASSWORD') ?? '';
    const fromAddress = this.config.get('MAIL_FROM_ADDRESS') ?? username;
    if (!host || !username || !password || !fromAddress) return undefined;

    const port = this.config.getNumber('MAIL_PORT') ?? 587;
    return {
      id: 'env',
      label: 'Server environment',
      provider: 'smtp',
      host,
      port,
      encryption: this.config.get('MAIL_ENCRYPTION')?.toLowerCase() ?? (port === 465 ? 'ssl' : 'tls'),
      username,
      secret: password,
      fromAddress,
      fromName: this.config.get('MAIL_FROM_NAME'),
    };
  }

  private fromHeader(account: SendingAccount): string {
    return `${account.fromName || brandName()} <${account.fromAddress}>`;
  }

  /** Where the SPA lives, so an emailed link points at something real. */
  get appUrl() {
    return (this.config.get('APP_URL') ?? 'http://localhost:5173').replace(/\/$/, '');
  }

  /**
   * Whether a message can actually be delivered. Callers check this BEFORE doing
   * any work that depends on the recipient existing — see AuthService.forgot(),
   * where checking afterwards would turn a 503 into an oracle for which email
   * addresses are registered.
   */
  get configured(): boolean {
    return Boolean(this.resolve());
  }

  private buildTransport(account: SendingAccount): Transporter {
    return nodemailer.createTransport({
      host: account.host,
      port: account.port,
      secure: isSecure(account),
      auth: { user: account.username, pass: account.secret },
    });
  }

  private transportFor(account: SendingAccount): Transporter {
    // Rebuild when the admin switches account or edits a credential, so a saved
    // change takes effect on the next send without a restart. Both version
    // counters bump on every write to their store.
    const key = `${account.id}:${this.accounts.version}:${this.config.version}`;
    if (!this.transporter || this.transporterKey !== key) {
      this.transporter = this.buildTransport(account);
      this.transporterKey = key;
    }
    return this.transporter;
  }

  /**
   * The one place a provider is chosen. Everything above this — the template,
   * the builders, the callers — is provider-blind, which is the point: adding
   * Mailgun later is another branch here and nothing else.
   */
  private async deliver(account: SendingAccount, mail: Mail): Promise<void> {
    const from = this.fromHeader(account);
    switch (account.provider) {
      case 'resend':
        return resendSend(account, mail, from);
      case 'relay':
        return relaySend(account, mail);
      default:
        await this.transportFor(account).sendMail({
          from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
    }
  }

  /** Prove the credential without sending. One branch per provider, as above. */
  private async proveCredential(account: SendingAccount): Promise<void> {
    switch (account.provider) {
      case 'resend':
        return resendVerify(account);
      case 'relay':
        return relayVerify(account);
      default:
        await this.buildTransport(account).verify();
    }
  }

  /**
   * Connect and authenticate, without sending anything.
   *
   * Used by the health prober behind the status page. Deliberately lets the
   * SMTP error through rather than flattening it to a 503: the caller is
   * diagnosing, and "invalid login" and "connection refused" are different
   * problems. Callers must not put the result in front of an anonymous user —
   * these messages name hosts and accounts.
   */
  async verify(): Promise<void> {
    const account = this.resolve();
    if (!account) throw new EmailNotConfiguredError();
    await this.proveCredential(account);
  }

  async send(mail: Mail): Promise<void> {
    const account = this.resolve();
    if (!account) throw new EmailNotConfiguredError();

    try {
      await this.deliver(account, mail);
    } catch (err) {
      // The address is not logged: it is a credential-adjacent identifier and
      // this line may end up in a shared log sink.
      this.log.error(`SMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('The email could not be sent');
    }
  }

  /**
   * Send a real message to the signed-in admin to prove a mailbox works.
   *
   * `accountId` targets one specific mailbox, so an admin can prove the Gmail
   * box works before making it the one every sign-up code depends on. Omit it to
   * test whatever is currently sending.
   *
   * Unlike {@link send}, this runs `transporter.verify()` first and lets its
   * error through — the whole point of a test is to surface *why* it failed (bad
   * login, wrong port, unreachable host), not a generic "could not send". The
   * result goes to an admin who is already allowed to see these credentials.
   */
  async sendTest(to: string, name: string, accountId?: string): Promise<{ label: string }> {
    const account = accountId ? this.accounts.byId(accountId) : this.resolve();
    if (!account) throw new EmailNotConfiguredError();

    // Prove the credential before composing anything. SMTP does a handshake,
    // Resend an authenticated GET, the relay a probe POST. Either way the error
    // is allowed through — that is the whole value of a test.
    await this.proveCredential(account);

    const mail = withBrand(account.fromName, () => {
      const first = esc((name || '').split(' ')[0] || 'there');
      const brand = esc(brandName());
      const bodyHtml =
        `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Email is working ✅</h1>` +
        `<p style="margin:0 0 6px;">Hi ${first}, this is a test message from ${brand}, ` +
        `sent through <b>${esc(account.label)}</b> (${esc(account.fromAddress)}). ` +
        `If you're reading it, that mailbox is working — sign-up codes, password resets ` +
        `and invitations sent from it will be delivered.</p>`;
      return {
        to,
        subject: `${brandName()} — test email`,
        html: layout({ title: 'Test email', preheader: 'Your email settings are working', bodyHtml }),
        text: textLayout([
          `This is a test email from ${brandName()}, sent through ${account.label} (${account.fromAddress}).`,
          '',
          `If you're reading it, that mailbox is working.`,
        ]),
      };
    });

    try {
      await this.deliver(account, mail);
    } catch (err) {
      this.log.error(`Test send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'The test email could not be sent',
      );
    }
    return { label: account.label };
  }

  // -------------------------------------------------------------------------
  // The library. Every builder returns a full {@link Mail}, HTML + text, and
  // shares the one {@link layout} — that is what makes this a global template
  // rather than five hand-rolled strings drifting out of sync.
  // -------------------------------------------------------------------------

  /** Sent the moment an account is created: a welcome, with the sign-up code inline. */
  welcome(to: string, name: string, code: string, minutes: number): Mail {
    const first = esc(name.split(' ')[0] || name);
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Welcome, ${first} 👋</h1>` +
      `<p style="margin:0 0 6px;">Your ${esc(brandName())} account has been created. One step is left: ` +
      `confirm this is your email by entering the code below on the verification screen.</p>` +
      codeBlock(code) +
      `<p style="margin:0 0 6px;">This code expires in <b>${minutes} minutes</b>. ` +
      `Once verified, you'll be taken straight to your dashboard.</p>` +
      `<p style="margin:14px 0 0;color:#8a938f;font-size:13px;">` +
      `Didn't create this account? You can safely ignore this email — without the code, nothing happens.</p>`;
    return {
      to,
      subject: `Welcome to ${brandName()} — verify your email`,
      html: layout({ title: 'Welcome', preheader: `Your verification code is ${code}`, bodyHtml }),
      text: textLayout([
        `Welcome, ${name.split(' ')[0] || name}!`,
        '',
        `Your ${brandName()} account has been created. Enter this code on the verification screen:`,
        '',
        `    ${code}`,
        '',
        `It expires in ${minutes} minutes. Once verified, you'll go straight to your dashboard.`,
        `Didn't create this account? Ignore this email — without the code, nothing happens.`,
      ]),
    };
  }

  /** A fresh code, on request, once the welcome one has been used up or has expired. */
  otp(to: string, name: string, code: string, minutes: number): Mail {
    const first = esc(name.split(' ')[0] || name);
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Your verification code</h1>` +
      `<p style="margin:0 0 6px;">Hi ${first}, here is a new code to verify your ${esc(brandName())} account.</p>` +
      codeBlock(code) +
      `<p style="margin:0 0 6px;">This code expires in <b>${minutes} minutes</b> and replaces any earlier one.</p>` +
      `<p style="margin:14px 0 0;color:#8a938f;font-size:13px;">` +
      `If you didn't ask for this, you can ignore it.</p>`;
    return {
      to,
      subject: `${brandName()} verification code: ${code}`,
      html: layout({ title: 'Verification code', preheader: `Your code is ${code}`, bodyHtml }),
      text: textLayout([
        `Hi ${name.split(' ')[0] || name},`,
        '',
        `Your ${brandName()} verification code is:`,
        '',
        `    ${code}`,
        '',
        `It expires in ${minutes} minutes and replaces any earlier one.`,
        `If you didn't ask for this, ignore this email.`,
      ]),
    };
  }

  passwordReset(to: string, token: string, minutes: number): Mail {
    const link = `${this.appUrl}/reset?token=${encodeURIComponent(token)}`;
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Reset your password</h1>` +
      `<p style="margin:0 0 6px;">We received a request to reset the password on your ` +
      `${esc(brandName())} account. Click below to choose a new one.</p>` +
      button('Choose a new password', link) +
      `<p style="margin:0 0 6px;">This link expires in <b>${minutes} minutes</b> and can only be used once.</p>` +
      `<p style="margin:14px 0 0;color:#8a938f;font-size:13px;">` +
      `If you didn't ask for this, ignore this message — nothing has changed. ` +
      `If the button doesn't work, paste this link into your browser:<br>` +
      `<a href="${esc(link)}" style="color:${brandColour()};word-break:break-all;">${esc(link)}</a></p>`;
    return {
      to,
      subject: `Reset your ${brandName()} password`,
      html: layout({ title: 'Reset your password', preheader: 'Choose a new password', bodyHtml }),
      text: textLayout([
        `Use this link to choose a new password:`,
        link,
        '',
        `It expires in ${minutes} minutes and can only be used once.`,
        `If you did not ask for this, ignore this message — nothing has changed.`,
      ]),
    };
  }

  /** Confirmation after a password actually changes — the "was this you?" safety net. */
  passwordChanged(to: string): Mail {
    const link = `${this.appUrl}/forgot`;
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Your password was changed</h1>` +
      `<p style="margin:0 0 6px;">The password on your ${esc(brandName())} account was just changed. ` +
      `If this was you, no further action is needed.</p>` +
      `<p style="margin:0 0 6px;"><b>If this wasn't you</b>, reset your password immediately and contact us.</p>` +
      button('Reset your password', link);
    return {
      to,
      subject: `Your ${brandName()} password was changed`,
      html: layout({ title: 'Password changed', preheader: 'Your password was just changed', bodyHtml }),
      text: textLayout([
        `The password on your ${brandName()} account was just changed.`,
        `If this was you, no action is needed.`,
        '',
        `If this wasn't you, reset your password immediately: ${link}`,
      ]),
    };
  }

  invitation(to: string, code: string, roleLabel: string): Mail {
    const link = `${this.appUrl}/signup/${encodeURIComponent(code)}`;
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">You've been invited</h1>` +
      `<p style="margin:0 0 6px;">You have been invited to ${esc(brandName())} as <b>${esc(roleLabel)}</b>.</p>` +
      `<p style="margin:0 0 6px;">Your invitation code is:</p>` +
      codeBlock(code) +
      button('Create your account', link) +
      `<p style="margin:14px 0 0;color:#8a938f;font-size:13px;">` +
      `If the button doesn't work, paste this link into your browser:<br>` +
      `<a href="${esc(link)}" style="color:${brandColour()};word-break:break-all;">${esc(link)}</a></p>`;
    return {
      to,
      subject: `Your invitation to ${brandName()}`,
      html: layout({ title: 'Your invitation', preheader: `Invitation code: ${code}`, bodyHtml }),
      text: textLayout([
        `You have been invited to ${brandName()} as ${roleLabel}.`,
        '',
        `Invitation code: ${code}`,
        link,
      ]),
    };
  }
}

@Global()
@Module({ providers: [EmailService], exports: [EmailService] })
export class EmailModule {}
