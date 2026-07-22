import { EmailService } from './email';

/**
 * The links inside emails.
 *
 * This exists because production shipped a real invitation whose only link was
 * `http://localhost:5173/signup/…`. The send reported success, `emailed: true`,
 * no error anywhere — the recipient just got a dead link. APP_URL was simply
 * never set, and the localhost default swallowed it.
 *
 * A unit spec rather than an integration one: the whole subject is what
 * `appUrl` does with a value that is missing or wrong, and stubs let this flip
 * NODE_ENV without dragging cookie security and the rest of AppModule along.
 */

const accounts = { active: () => undefined, byId: () => undefined, any: false, version: 0 };

/** An EmailService whose only configured value is APP_URL (or nothing). */
function serviceWith(appUrl?: string) {
  const cfg = {
    get: (k: string) => (k === 'APP_URL' ? appUrl : undefined),
    getNumber: () => undefined,
    hasAll: () => false,
    version: 0,
  };
  // These specs only build mail (appUrl / the builders); nothing sends, so the
  // recording path is never reached and a bare prisma stub is enough.
  const prisma = { emailMessage: { create: async () => undefined } };
  return new EmailService(cfg as never, accounts as never, prisma as never);
}

describe('emailed links', () => {
  const realEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = realEnv;
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('refuses to build a link when APP_URL is unset, rather than saying localhost', () => {
      const email = serviceWith(undefined);
      expect(() => email.appUrl).toThrow(/APP_URL/);
    });

    // This is how the value arrives when someone copies .env onto the server.
    it.each([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'https://localhost',
    ])('refuses an explicit local APP_URL (%s)', (url) => {
      const email = serviceWith(url);
      expect(() => email.appUrl).toThrow(/APP_URL/);
    });

    it('uses a real APP_URL, without a trailing slash', () => {
      const email = serviceWith('https://console.example.com/');
      expect(email.appUrl).toBe('https://console.example.com');
    });

    // The bug in full: a dead link that reported success.
    it('does not put localhost in an invitation', () => {
      const email = serviceWith(undefined);
      expect(() => email.invitation('a@b.com', 'VFW-123456', 'ADMIN')).toThrow(/APP_URL/);
    });

    it('does not put localhost in a password reset — there the link IS the email', () => {
      const email = serviceWith(undefined);
      expect(() => email.passwordReset('a@b.com', 'tok', 30)).toThrow(/APP_URL/);
    });

    // These carry a code, not a link, so they must survive an unset APP_URL:
    // losing them would take OTP signup down over a link that is not in them.
    it('still sends the OTP emails, which carry a code and no link', () => {
      const email = serviceWith(undefined);
      expect(() => email.welcome('a@b.com', 'Ada', '123456', 10)).not.toThrow();
      expect(() => email.otp('a@b.com', 'Ada', '123456', 10)).not.toThrow();
    });

    it('builds the real links once APP_URL is set', () => {
      const email = serviceWith('https://console.example.com');
      const mail = email.invitation('a@b.com', 'VFW-123456', 'ADMIN');
      const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

      // Two: the button and the "if the button doesn't work" fallback. Both must
      // be real — the fallback is what someone uses when the button already failed.
      expect(hrefs).toContain('https://console.example.com/signup/VFW-123456');
      expect(hrefs.filter((h) => h.includes('/signup/'))).toHaveLength(2);
      expect(mail.text).toContain('https://console.example.com/signup/VFW-123456');
      expect(mail.html + mail.text).not.toMatch(/localhost/);
    });
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('falls back to localhost, which is correct here', () => {
      expect(serviceWith(undefined).appUrl).toBe('http://localhost:5173');
    });

    it('still prefers a configured APP_URL', () => {
      expect(serviceWith('https://staging.example.com').appUrl).toBe('https://staging.example.com');
    });
  });
});
