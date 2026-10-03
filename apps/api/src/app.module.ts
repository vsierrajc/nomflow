import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AdminAccountsController } from './accounts/admin-accounts.controller';
import { AuthController, MeTwoFactorController } from './auth/auth.controller';
import { RecentAuthGuard, RolesGuard } from './auth/guards';
import { IpRateLimitGuard } from './auth/ip-rate-limit.guard';
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
import { AdminMailController } from './mail/mail.controller';
import { MailModule } from './mail/mail.module';
import { LogsModule } from './registros/logs.module';
import { ArchiveModule } from './storage/archive.module';
import { StorageModule } from './storage/storage.module';
import { AdminTaxController, MeTaxController } from './tax/tax.controller';
import {
  AdminHolidayApiController,
  AdminHolidaysController,
  AdminProgVacController,
  FinalVacationsController,
  ManagerVacationsController,
  MeVacationsController,
} from './leave/leave.controller';
import {
  AdminPermitTypesController,
  ManagerPermitsController,
  MePermitsController,
} from './leave/permit.controller';
import { MeApproverSignatureController } from './leave/approver-signature.controller';
import { AdminVacationsController } from './leave/vacation-admin.controller';
import {
  AdminSubstitutionsController,
  MeSubstitutionsController,
} from './leave/substitutions.controller';
import { AdminShiftsController } from './leave/shift.controller';
import {
  AdminLaborCertController,
  MeCertificateSignerController,
  MeLaborCertController,
} from './certificates/labor-cert.controller';
import { HealthController } from './health.controller';
import { InboxController } from './inbox/inbox.controller';
import { NotificationMonitor } from './inbox/notification-monitor';
import { VacationCycleMonitor } from './leave/vacation-cycle-monitor';
import { AdminNotificationsController } from './inbox/notification.controller';
import { NotificationService } from './inbox/notification.service';
import { SystemHealthModule } from './health/health.module';
import { ExitModule } from './exit/exit.module';

@Module({
  imports: [
    DbModule,
    MailModule,
    StorageModule,
    ArchiveModule,
    LogsModule,
    SystemHealthModule,
    ExitModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    MeTwoFactorController,
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
    AdminHolidayApiController,
    AdminProgVacController,
    MeVacationsController,
    ManagerVacationsController,
    FinalVacationsController,
    AdminPermitTypesController,
    MePermitsController,
    ManagerPermitsController,
    AdminShiftsController,
    MeApproverSignatureController,
    AdminVacationsController,
    MeSubstitutionsController,
    AdminSubstitutionsController,
    AdminMailController,
    InboxController,
    AdminNotificationsController,
    MeLaborCertController,
    MeCertificateSignerController,
    AdminLaborCertController,
  ],
  providers: [
    SessionGuard,
    RolesGuard,
    RecentAuthGuard,
    IpRateLimitGuard,
    RequestAuditService,
    NotificationService,
    NotificationMonitor,
    VacationCycleMonitor,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestAuditMiddleware).forRoutes('*');
  }
}
