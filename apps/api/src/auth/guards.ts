import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { hasActiveRole, type RoleName } from './roles';
import type { AuthedRequest } from './session.guard';
import { REAUTH_WINDOW_MS } from './session.service';

const ROLES_KEY = 'nomflow:roles';
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<RoleName[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (
      !roles ||
      roles.length === 0 ||
      !(await hasActiveRole(this.db, req.auth.accountId, roles))
    ) {
      throw new ForbiddenException();
    }
    return true;
  }
}

/**
 * Reautenticación reciente para acciones sensibles. Por decisión del propietario del sistema está
 * DESACTIVADA por omisión (quien opera la administración ya tiene el privilegio); se vuelve a exigir
 * con REQUIRE_RECENT_AUTH=true (las acciones piden la clave si la sesión tiene más de 10 minutos).
 */
export const recentAuthRequired = () => process.env.REQUIRE_RECENT_AUTH === 'true';

@Injectable()
export class RecentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!recentAuthRequired()) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (Date.now() - req.auth.authenticatedAt.getTime() > REAUTH_WINDOW_MS) {
      throw new ForbiddenException({
        code: 'REAUTH_REQUIRED',
        message: 'Reautenticación requerida',
      });
    }
    return true;
  }
}
