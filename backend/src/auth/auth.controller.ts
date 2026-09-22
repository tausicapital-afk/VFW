import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser, Public, isMobileClient } from '../common/auth.guard';
import { SESSION_COOKIE, sessionCookie } from '../common/cookie';
import { AuthService } from './auth.service';
import { GoogleSsoService } from './google-sso.service';
import { ForgotDto, LoginDto, LoginTotpDto, ResendOtpDto, ResetDto, SignupDto, VerifyOtpDto } from './dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly googleSso: GoogleSsoService,
  ) {}

  /**
   * The frontend base to redirect the browser back to, tolerating APP_URL
   * itself being unconfigured. `GoogleSsoService.frontendUrl()` throws in
   * that case — reasonable for a value that must be right when it IS used —
   * but both Google handlers below must always end in a redirect, never a
   * raw exception, since a full-page navigation has no fetch caller to hand
   * a JSON error to. A relative base still lands the browser back on this
   * app's own origin, so nothing here needs APP_URL to have a fallback.
   */
  private frontendBase(): string {
    try {
      return this.googleSso.frontendUrl();
    } catch {
      return '';
    }
  }

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = { ip: req.ip, userAgent: req.headers['user-agent'] };
    const result = await this.auth.login(dto.email, dto.password, ctx);

    // A user with TOTP enrolled does not get a session yet — the SPA shows the
    // code entry step and calls POST /login/totp with this challenge next. No
    // cookie is set here, so there is nothing for the browser to hold onto if
    // the second step is never completed.
    if ('totpRequired' in result) return result;

    // httpOnly, so a script on the page can never read the session. The SPA
    // sends it automatically via credentials:"include". Set unconditionally —
    // harmless for the mobile app too, which never reads cookies.
    res.cookie(SESSION_COOKIE, result.token, sessionCookie((dto.remember ? 30 : 1) * DAY_MS));

    // The mobile app has no cookie jar shared with the API's origin, so it
    // authenticates with this same JWT as a bearer token instead (see
    // AuthGuard.canActivate). Only handed back when asked for — the browser
    // SPA never sends X-Client, so its response shape is unchanged.
    return { user: result.user, ...(isMobileClient(req) ? { token: result.token } : {}) };
  }

  /**
   * Step 2 of a TOTP login (password or Google). `remember` is not offered
   * here — the challenge itself is short-lived and this step follows within
   * minutes of the first, so a session-length cookie (same as a plain login
   * without "remember me") is the reasonable default either way.
   */
  @Public()
  @Post('login/totp')
  async loginTotp(
    @Body() dto: LoginTotpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = { ip: req.ip, userAgent: req.headers['user-agent'] };
    const { token, user } = await this.auth.completeTotpLogin(dto.challenge, dto.code, ctx);
    res.cookie(SESSION_COOKIE, token, sessionCookie(DAY_MS));
    return { user, ...(isMobileClient(req) ? { token } : {}) };
  }

  /**
   * Send the browser to Google. A full-page redirect, not a fetch endpoint —
   * the browser itself navigates here (`<a href>` / `window.location`), which
   * is why this and the callback below answer with a redirect rather than
   * JSON, unlike every other route in this controller.
   */
  @Public()
  @Get('google')
  googleStart(@Res() res: Response) {
    try {
      res.redirect(this.googleSso.authorizeUrl());
    } catch (e) {
      // Unconfigured (no GOOGLE_CLIENT_ID/SECRET or APP_URL) — send the browser
      // back to the login screen with a readable reason rather than a raw JSON
      // error page, since this is a full-page navigation, not a fetch call.
      const message = e instanceof Error ? e.message : 'Google sign-in is not available';
      res.redirect(`${this.frontendBase()}/?ssoError=${encodeURIComponent(message)}`);
    }
  }

  /**
   * Where Google sends the browser back to. Whatever happens here, the answer
   * is a redirect to the frontend — there is no SPA request in flight to
   * return JSON to. Success sets the session cookie (or, with TOTP enrolled,
   * forwards the challenge the same way the password flow does); failure
   * forwards a readable message for the login screen to show.
   */
  @Public()
  @Get('google/callback')
  async googleCallback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = { ip: req.ip, userAgent: req.headers['user-agent'] };
    const frontend = this.frontendBase();
    try {
      const result = await this.auth.loginWithGoogle(query, ctx);
      if ('totpRequired' in result) {
        res.redirect(`${frontend}/?totp=${encodeURIComponent(result.challenge)}`);
        return;
      }
      res.cookie(SESSION_COOKIE, result.token, sessionCookie(DAY_MS));
      res.redirect(frontend + '/');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not sign in with Google';
      res.redirect(`${frontend}/?ssoError=${encodeURIComponent(message)}`);
    }
  }

  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.recordLogout(user, { ip: req.ip, userAgent: req.headers['user-agent'] });
    // Must match the attributes the cookie was set with, or the browser keeps it.
    res.clearCookie(SESSION_COOKIE, sessionCookie());
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return { user: await this.auth.me(user.id) };
  }

  /**
   * Invite-only signup. Public by necessity — the caller has no account yet —
   * but not open: it is guarded by the invitation code, and what it creates is a
   * PENDING account that cannot log in until the emailed code is verified. No
   * session cookie is issued here — that happens at verify-otp.
   */
  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  /**
   * Enter the six-digit code from the welcome email. On success the account is
   * activated AND a session cookie is issued, so the SPA drops the user straight
   * on the dashboard — no separate login step.
   */
  @Public()
  @Post('verify-otp')
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.auth.verifyOtp(dto);
    // A freshly verified session lasts a day, like a login without "remember me".
    res.cookie(SESSION_COOKIE, token, sessionCookie(DAY_MS));
    // See login() above — same additive bearer token for the mobile app.
    return { user, ...(isMobileClient(req) ? { token } : {}) };
  }

  @Public()
  @Post('resend-otp')
  async resendOtp(@Body() dto: ResendOtpDto) {
    return this.auth.resendOtp(dto.email);
  }

  @Public()
  @Post('forgot-password')
  async forgot(@Body() dto: ForgotDto) {
    return this.auth.forgot(dto);
  }

  @Public()
  @Post('reset-password')
  async reset(@Body() dto: ResetDto) {
    return this.auth.reset(dto);
  }
}
