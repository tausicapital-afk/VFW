import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser, Public } from '../common/auth.guard';
import { SESSION_COOKIE, sessionCookie } from '../common/cookie';
import { AuthService } from './auth.service';
import { ForgotDto, LoginDto, ResetDto, SignupDto } from './dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(dto.email, dto.password);

    // httpOnly, so a script on the page can never read the session. The SPA
    // sends it automatically via credentials:"include".
    res.cookie(SESSION_COOKIE, token, sessionCookie((dto.remember ? 30 : 1) * DAY_MS));

    return { user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
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
   * PENDING account that cannot log in until an administrator approves it. No
   * session cookie is issued here.
   */
  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    return { user: await this.auth.signup(dto) };
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
