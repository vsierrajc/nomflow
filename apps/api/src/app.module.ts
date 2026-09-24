import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AdminAccountsController } from './accounts/admin-accounts.controller';
import { AuthController } from './auth/auth.controller';
import { RecentAuthGuard, RolesGuard } from './auth/guards';
import { SessionGuard } from './auth/session.guard';
import { DbModule } from './db/db.module';
import { RequestAuditMiddleware } from './audit/request-audit.middleware';
import { RequestAuditService } from './audit/request-audit.service';
import { AdminSupportController } from './admin/admin-support.controller';
import { EmployeesController } from './employees/employees.controller';
import { CatalogsController } from './imports/catalogs.controller';
import { CompaniesController } from './imports/companies.controller';
import { ImportsController } from './imports/imports.controller';
import { OrgController } from './org/org.controller';
import { ConceptsController } from './payroll/concepts.controller';
import { MePayrollController } from './payroll/me-payroll.controller';
import { MailModule } from './mail/mail.module';
import { AdminTaxController, MeTaxController } from './tax/tax.controller';
import {
  AdminHolidaysController,
  AdminProgVacController,
  FinalVacationsController,
  ManagerVacationsController,
  MeVacationsController,
} from './leave/leave.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, MailModule],
  controllers: [
    HealthController,
    AuthController,
    AdminAccountsController,
    ImportsController,
    CompaniesController,
    OrgController,
    MePayrollController,
    ConceptsController,
    CatalogsController,
    EmployeesController,
    AdminSupportController,
    MeTaxController,
    AdminTaxController,
    AdminHolidaysController,
    AdminProgVacController,
    MeVacationsController,
    ManagerVacationsController,
    FinalVacationsController,
  ],
  providers: [SessionGuard, RolesGuard, RecentAuthGuard, RequestAuditService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestAuditMiddleware).forRoutes('*');
  }
}
