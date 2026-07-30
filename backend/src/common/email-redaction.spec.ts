import { redactForLog, type Mail } from './email';

/**
 * The Emails log records every outbound message, including the ones whose whole
 * purpose is to carry a secret. This locks the one property that keeps that from
 * being a leak: a sensitive kind is logged as "a code went here", never with the
 * code. If this test goes green while a real OTP or reset link reaches the log,
 * the redaction is broken.
 */
describe('email log redaction', () => {
  const base: Mail = {
    to: 'x@example.com',
    subject: 'Subject line',
    html: '<p>the secret is 123456</p>',
    text: 'the secret is 123456',
  };

  it('drops the body AND the code-bearing subject for OTP', () => {
    const r = redactForLog({ ...base, subject: 'VFW verification code: 123456' }, 'OTP');
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
    expect(r.subject).toBe('Verification code');
    expect(r.subject).not.toContain('123456');
    expect(r.preview).not.toContain('123456');
  });

  it('drops the body but keeps the (secret-free) subject for an invitation', () => {
    const r = redactForLog(base, 'INVITATION');
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
    expect(r.subject).toBe('Subject line');
    expect(r.preview).not.toContain('123456');
  });

  it.each(['WELCOME', 'PASSWORD_RESET'] as const)('redacts the body for %s', (kind) => {
    const r = redactForLog(base, kind);
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
  });

  it('keeps the full body for an invoice — it holds no secret', () => {
    const r = redactForLog(
      { ...base, subject: 'Invoice VFW-1042', text: 'Your invoice is attached', html: '<p>Your invoice</p>' },
      'INVOICE',
    );
    expect(r.bodyText).toBe('Your invoice is attached');
    expect(r.bodyHtml).toBe('<p>Your invoice</p>');
    expect(r.subject).toBe('Invoice VFW-1042');
    expect(r.preview).toContain('invoice');
  });

  it('keeps the body for a password-changed notice — generic, no secret', () => {
    const r = redactForLog({ ...base, text: 'your password changed' }, 'PASSWORD_CHANGED');
    expect(r.bodyText).toBe('your password changed');
  });
});
