import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { LoginError, login } from './auth.service';
import { SESSION_COOKIE, SessionGuard, type AuthedRequest } from './session.guard';
import { ABSOLUTE_TIMEOUT_MS, csrfTokenFor, revokeSession } from './session.service';

const LoginDto = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ csrfToken: string }> {
    const dto = LoginDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      const s = await login(this.db, dto.data.email, dto.data.password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.cookie(SESSION_COOKIE, s.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: ABSOLUTE_TIMEOUT_MS,
      });
      return { csrfToken: csrfTokenFor(s.sessionId) };
    } catch (e) {
      if (e instanceof LoginError) throw new UnauthorizedException('Credenciales inválidas');
      throw e;
    }
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: AuthedRequest): { accountId: string; csrfToken: string } {
    return { accountId: req.auth.accountId, csrfToken: csrfTokenFor(req.auth.sessionId) };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await revokeSession(this.db, req.auth.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
