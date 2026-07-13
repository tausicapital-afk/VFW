import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { Response } from 'express';
import { AuthUser, CurrentUser, Public, SESSION_COOKIE } from '../common/auth.guard';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

const isProd = process.env.NODE_ENV === 'production';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(dto.email, dto.password);

    // httpOnly so a script on the page can never read the session; the SPA
    // sends it automatically via credentials:"include". In production the SPA
    // and API sit on different Railway subdomains, which requires
    // SameSite=None — and SameSite=None is only honoured when Secure is set.
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: (dto.remember ? 30 : 1) * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return { user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
    });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return { user: await this.auth.me(user.id) };
  }
}
