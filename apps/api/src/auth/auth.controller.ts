import {
  Body,
  ConflictException,
  Controller,
  HttpException,
  HttpStatus,
  Get,
  Header,
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
  completeTwoFactorLogin,
  getProfile,
  login,
  reauthenticate,
  type Profile,
} from './auth.service';
import { RecentAuthGuard } from './guards';
import { SESSION_COOKIE, SessionGuard, type AuthedRequest } from './session.guard';
import {
  TwoFactorError,
  confirmEnable,
  disableOwn,
  getState,
  startEnable,
} from './two-factor.service';
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

const VerifyLoginDto = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().min(4).max(12),
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
  ): Promise<{ csrfToken: string } | { twoFactorRequired: true; challengeId: string }> {
    const dto = LoginDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      const r = await login(
        this.db,
        dto.data.email,
        dto.data.password,
        { ip: req.ip, userAgent: req.headers['user-agent'] },
        this.mailer,
      );
      if (r.kind === 'TWO_FACTOR') return { twoFactorRequired: true, challengeId: r.challengeId };
      return this.startSession(res, r);
    } catch (e) {
      if (e instanceof LoginError) throw new UnauthorizedException('Credenciales inválidas');
      throw e;
    }
  }

  /** Segundo paso del ingreso: el código enviado al correo abre la sesión. */
  @Post('login/verify')
  @HttpCode(200)
  async verifyLogin(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ csrfToken: string }> {
    const dto = VerifyLoginDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      const r = await completeTwoFactorLogin(this.db, dto.data.challengeId, dto.data.code, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      if (r.kind !== 'SESSION') throw new UnauthorizedException('Código inválido');
      return this.startSession(res, r);
    } catch (e) {
      if (e instanceof LoginError) throw new UnauthorizedException('Código inválido');
      throw e;
    }
  }

  private startSession(
    res: Response,
    s: { token: string; sessionId: string },
  ): { csrfToken: string } {
    // Falso positivo revisado: es la cookie de sesión (token aleatorio de 256 bits, cuyo hash es lo que se
    // guarda en la base). Enviarla al navegador es el diseño; va HttpOnly, SameSite=Strict y Secure en producción.
    // codeql[js/clear-text-storage-of-sensitive-data]
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: ABSOLUTE_TIMEOUT_MS,
    });
    return { csrfToken: csrfTokenFor(s.sessionId) };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async me(@Req() req: AuthedRequest): Promise<Profile & { csrfToken: string }> {
    const profile = await getProfile(this.db, req.auth.accountId);
    return { ...profile, csrfToken: csrfTokenFor(req.auth.sessionId) };
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

const ConfirmTwoFactorDto = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().min(4).max(12),
});
const DisableTwoFactorDto = z.object({ password: z.string().min(1).max(200) });

function mapTwoFactor(e: unknown): never {
  if (!(e instanceof TwoFactorError)) throw e;
  switch (e.code) {
    case 'RATE_LIMITED':
      throw new HttpException({ code: e.code }, HttpStatus.TOO_MANY_REQUESTS);
    case 'MAIL_FAILED':
      throw new HttpException({ code: e.code }, HttpStatus.BAD_GATEWAY);
    case 'ALREADY_ENABLED':
    case 'NOT_ENABLED':
      throw new ConflictException({ code: e.code });
    case 'INVALID_CREDENTIALS':
      throw new UnauthorizedException('Credenciales inválidas');
    default:
      throw new BadRequestException({ code: 'INVALID_CODE' });
  }
}

/** Verificación en dos pasos de la propia cuenta: opcional, se activa con un código enviado al correo. */
@Controller('me/two-factor')
@UseGuards(SessionGuard)
export class MeTwoFactorController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  state(@Req() req: AuthedRequest) {
    return getState(this.db, req.auth.accountId);
  }

  @Post('start')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async start(@Req() req: AuthedRequest) {
    try {
      return await startEnable(this.db, this.mailer, req.auth.accountId);
    } catch (e) {
      return mapTwoFactor(e);
    }
  }

  @Post('confirm')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async confirm(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = ConfirmTwoFactorDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_CODE' });
    try {
      await confirmEnable(this.db, req.auth.accountId, dto.data.challengeId, dto.data.code);
      return await getState(this.db, req.auth.accountId);
    } catch (e) {
      return mapTwoFactor(e);
    }
  }

  @Post('disable')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async disable(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = DisableTwoFactorDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await disableOwn(this.db, req.auth.accountId, dto.data.password);
      return await getState(this.db, req.auth.accountId);
    } catch (e) {
      return mapTwoFactor(e);
    }
  }
}
