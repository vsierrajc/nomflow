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
import {
  ActivationError,
  activateAccount,
  resendVerificationCode,
} from '../accounts/verification.service';
import { MAILER, type Mailer } from '../mail/mailer';
import {
  ChangePasswordError,
  LoginError,
  changePassword,
  login,
  reauthenticate,
} from './auth.service';
import { SESSION_COOKIE, SessionGuard, type AuthedRequest } from './session.guard';
import { ABSOLUTE_TIMEOUT_MS, csrfTokenFor, revokeSession } from './session.service';

const LoginDto = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

const ActivateDto = z.object({
  email: z.string().trim().email().max(254),
  temporaryPassword: z.string().min(1).max(200),
  code: z.string().min(1).max(32),
  newPassword: z.string().min(1).max(200),
});

const ChangePasswordDto = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

const ReauthDto = z.object({ password: z.string().min(1).max(200) });

const ResendDto = z.object({ email: z.string().trim().email().max(254) });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  @Post('activate')
  @HttpCode(204)
  async activate(@Body() body: unknown): Promise<void> {
    const dto = ActivateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await activateAccount(this.db, dto.data);
    } catch (e) {
      if (e instanceof ActivationError) throw new BadRequestException('Datos inválidos');
      throw e;
    }
  }

  @Post('verify-email/resend')
  @HttpCode(202)
  async resend(@Body() body: unknown): Promise<void> {
    const dto = ResendDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    await resendVerificationCode(this.db, this.mailer, dto.data.email);
  }

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

  @Post('reauth')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async reauth(@Body() body: unknown, @Req() req: AuthedRequest): Promise<void> {
    const dto = ReauthDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await reauthenticate(this.db, req.auth.accountId, req.auth.sessionId, dto.data.password);
    } catch (e) {
      if (e instanceof LoginError) throw new UnauthorizedException('Credenciales inválidas');
      throw e;
    }
  }

  @Post('change-password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async changePassword(@Body() body: unknown, @Req() req: AuthedRequest): Promise<void> {
    const dto = ChangePasswordDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await changePassword(
        this.db,
        req.auth.accountId,
        req.auth.sessionId,
        dto.data.currentPassword,
        dto.data.newPassword,
      );
    } catch (e) {
      if (!(e instanceof ChangePasswordError)) throw e;
      if (e.reason === 'WEAK_PASSWORD') {
        throw new BadRequestException({
          code: 'WEAK_PASSWORD',
          message: 'La clave nueva debe tener al menos 12 caracteres y ser distinta de la actual',
        });
      }
      throw new UnauthorizedException('Credenciales inválidas');
    }
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
