import { Global, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../config/config.service';

/**
 * Outbound email — one transport, one global template, and one fallback:
 * **failing loudly**.
 *
 * Transport is SMTP (cPanel / any provider) over nodemailer. Every message is
 * poured through the same {@link layout} so the whole system speaks with one
 * voice: change the header, the colours or the footer once and every email —
 * welcome, OTP, password reset — moves together.
 *
 * What this deliberately does NOT do is log the code or link to the console and
 * carry on. A silent local fallback looks like it works right up until the first
 * real user cannot get into their account, and by then the "it worked in dev"
 * evidence is worthless. If the transport is not configured, send() throws and
 * the endpoint returns 503. That is a correct answer; a console.log is not.
 *
 * Configure with (cPanel SMTP example):
 *   MAIL_HOST=mail.veeb.co.ke
 *   MAIL_PORT=465
 *   MAIL_USERNAME=patriotic@veeb.co.ke
 *   MAIL_PASSWORD=********
 *   MAIL_ENCRYPTION=ssl            # ssl | tls | none
 *   MAIL_FROM_ADDRESS=patriotic@veeb.co.ke
 *   MAIL_FROM_NAME="Patriotic Payroll"
 *   APP_URL=https://app.yourdomain.com   (used to build the links)
 */

export class EmailNotConfiguredError extends ServiceUnavailableException {
  constructor() {
    super(
      'Email is not configured on this server, so the message could not be sent. ' +
        'Set MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD and MAIL_FROM_ADDRESS.',
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
// `layout()` / `button()`), so they cannot reach the injected ConfigService
// through `this`. EmailService sets this reference in its constructor, so brand
// name/colour follow whatever the admin has configured — DB first, then env.
let cfg: ConfigService | null = null;

function conf(key: string): string {
  return (cfg?.get(key) ?? process.env[key]?.trim() ?? '').trim();
}
function brandName() {
  return conf('MAIL_FROM_NAME') || 'VFW Console';
}
function brandColour() {
  return conf('MAIL_BRAND_COLOUR') || '#0C7A4D';
}
function supportAddress() {
  return conf('MAIL_SUPPORT_ADDRESS') || conf('MAIL_FROM_ADDRESS') || '';
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

@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private transporter?: Transporter;
  /** The config version the memoised transporter was built against. */
  private transporterVersion = -1;

  constructor(private readonly config: ConfigService) {
    // Let the module-level template helpers read live config too.
    cfg = config;
  }

  private get host() {
    return this.config.get('MAIL_HOST') ?? '';
  }
  private get user() {
    return this.config.get('MAIL_USERNAME') ?? '';
  }
  private get pass() {
    return this.config.get('MAIL_PASSWORD') ?? '';
  }
  private get fromAddress() {
    return this.config.get('MAIL_FROM_ADDRESS') ?? this.user;
  }
  private get from() {
    return `${brandName()} <${this.fromAddress}>`;
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
    return Boolean(this.host && this.user && this.pass && this.fromAddress);
  }

  private get port(): number {
    return this.config.getNumber('MAIL_PORT') ?? 587;
  }

  /** 465 is implicit TLS (secure); 587/25 start plaintext and upgrade via STARTTLS. */
  private get secure(): boolean {
    const enc = this.config.get('MAIL_ENCRYPTION')?.toLowerCase();
    if (enc === 'ssl') return true;
    if (enc === 'tls' || enc === 'none') return false;
    return this.port === 465;
  }

  private get transport(): Transporter {
    // Rebuild when the admin changes any credential, so a saved SMTP setting
    // takes effect on the next send without a restart. The version counter on
    // ConfigService bumps on every write.
    if (!this.transporter || this.transporterVersion !== this.config.version) {
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth: { user: this.user, pass: this.pass },
      });
      this.transporterVersion = this.config.version;
    }
    return this.transporter;
  }

  async send(mail: Mail): Promise<void> {
    if (!this.configured) throw new EmailNotConfiguredError();

    try {
      await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (err) {
      // The address is not logged: it is a credential-adjacent identifier and
      // this line may end up in a shared log sink.
      this.log.error(`SMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('The email could not be sent');
    }
  }

  /**
   * Send a real message to the signed-in admin to prove the SMTP settings work.
   * Unlike {@link send}, this first runs `transporter.verify()` and lets its
   * error through — the whole point of a test is to surface *why* it failed
   * (bad login, wrong port, unreachable host), not a generic "could not send".
   */
  async sendTest(to: string, name: string): Promise<void> {
    if (!this.configured) throw new EmailNotConfiguredError();
    await this.transport.verify();

    const first = esc((name || '').split(' ')[0] || 'there');
    const brand = esc(brandName());
    const bodyHtml =
      `<h1 style="margin:0 0 14px;font-size:22px;color:#0e0e11;">Email is working ✅</h1>` +
      `<p style="margin:0 0 6px;">Hi ${first}, this is a test message from ${brand}. ` +
      `If you're reading it, your outgoing email settings are correct — sign-up codes, ` +
      `password resets and invitations will now be delivered.</p>`;
    await this.send({
      to,
      subject: `${brandName()} — test email`,
      html: layout({ title: 'Test email', preheader: 'Your email settings are working', bodyHtml }),
      text: textLayout([
        `This is a test email from ${brandName()}.`,
        '',
        `If you're reading it, your outgoing email settings are correct.`,
      ]),
    });
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
