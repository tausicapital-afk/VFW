import { Global, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';

/**
 * Outbound email — invitations and password-reset links.
 *
 * There is exactly one transport (Resend, over its REST API — no SDK, because a
 * single POST does not need one) and exactly one fallback: **failing loudly**.
 *
 * What this deliberately does NOT do is log the reset link to the console and
 * carry on. A silent local fallback looks like it works right up until the first
 * real user cannot get into their account, and by then the "it worked in dev"
 * evidence is worthless. If the transport is not configured, send() throws and
 * the endpoint returns 503. That is a correct answer; a console.log is not.
 *
 * Configure with:
 *   RESEND_API_KEY=re_...
 *   EMAIL_FROM="VFW Console <console@yourdomain.com>"
 *   APP_URL=https://app.yourdomain.com   (used to build the links)
 */

export class EmailNotConfiguredError extends ServiceUnavailableException {
  constructor() {
    super(
      'Email is not configured on this server, so the message could not be sent. ' +
        'Set RESEND_API_KEY and EMAIL_FROM.',
    );
  }
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);

  private get apiKey() {
    return process.env.RESEND_API_KEY?.trim() || '';
  }

  private get from() {
    return process.env.EMAIL_FROM?.trim() || '';
  }

  /** Where the SPA lives, so an emailed link points at something real. */
  get appUrl() {
    return (process.env.APP_URL?.trim() || 'http://localhost:5173').replace(/\/$/, '');
  }

  /**
   * Whether a message can actually be delivered. Callers check this BEFORE doing
   * any work that depends on the recipient existing — see AuthService.forgot(),
   * where checking afterwards would turn a 503 into an oracle for which email
   * addresses are registered.
   */
  get configured(): boolean {
    return Boolean(this.apiKey && this.from);
  }

  async send(mail: Mail): Promise<void> {
    if (!this.configured) throw new EmailNotConfiguredError();

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // The address is not logged: it is a credential-adjacent identifier and
      // this line may end up in a shared log sink.
      this.log.error(`Resend rejected the message (${res.status}): ${detail}`);
      throw new ServiceUnavailableException('The email could not be sent');
    }
  }

  invitation(to: string, code: string, roleLabel: string): Mail {
    const link = `${this.appUrl}/signup/${encodeURIComponent(code)}`;
    return {
      to,
      subject: 'Your invitation to the VFW Console',
      text:
        `You have been invited to the VFW Console as ${roleLabel}.\n\n` +
        `Invitation code: ${code}\n${link}\n\n` +
        `An administrator still has to approve your account after you sign up.`,
      html:
        `<p>You have been invited to the VFW Console as <b>${roleLabel}</b>.</p>` +
        `<p>Invitation code: <b>${code}</b></p>` +
        `<p><a href="${link}">Create your account</a></p>` +
        `<p>An administrator still has to approve your account after you sign up.</p>`,
    };
  }

  passwordReset(to: string, token: string, minutes: number): Mail {
    const link = `${this.appUrl}/reset?token=${encodeURIComponent(token)}`;
    return {
      to,
      subject: 'Reset your VFW Console password',
      text:
        `Use this link to choose a new password:\n${link}\n\n` +
        `It expires in ${minutes} minutes and can only be used once. ` +
        `If you did not ask for this, ignore this message — nothing has changed.`,
      html:
        `<p><a href="${link}">Choose a new password</a></p>` +
        `<p>This link expires in ${minutes} minutes and can only be used once.</p>` +
        `<p>If you did not ask for this, ignore this message — nothing has changed.</p>`,
    };
  }
}

@Global()
@Module({ providers: [EmailService], exports: [EmailService] })
export class EmailModule {}
