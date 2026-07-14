import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser, Public } from '../common/auth.guard';
import { SESSION_COOKIE, sessionCookie } from '../common/cookie';
import { AuthService } from './auth.service';
import { ForgotDto, LoginDto, ResendOtpDto, ResetDto, SignupDto, VerifyOtpDto } from './dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = { ip: req.ip, userAgent: req.headers['user-agent'] };
    const { token, user } = await this.auth.login(dto.email, dto.password, ctx);

    // httpOnly, so a script on the page can never read the session. The SPA
    // sends it automatically via credentials:"include".
    res.cookie(SESSION_COOKIE, token, sessionCookie((dto.remember ? 30 : 1) * DAY_MS));

    return { user };
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
  async verifyOtp(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.verifyOtp(dto);
    // A freshly verified session lasts a day, like a login without "remember me".
    res.cookie(SESSION_COOKIE, token, sessionCookie(DAY_MS));
    return { user };
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
