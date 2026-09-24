import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  accounts,
  auditLogs,
  companies,
  employeeSnapshots,
  importBatches,
  payrollConcepts,
  payrollVersions,
} from '../db/schema';
import { HTTP_ACTION } from '../audit/request-audit.service';
import { VoucherError, adminDownloadVoucher, adminListVouchers } from '../payroll/voucher.service';

const Paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
};
const AuditQuery = z.object({
  kind: z.enum(['HTTP', 'EVENT']).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  status: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
  route: z.string().trim().max(120).optional(),
  action: z.string().trim().max(60).optional(),
  result: z.string().trim().max(60).optional(),
  actor: z.string().trim().max(100).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  ...Paging,
});
const ImportsQuery = z.object({
  type: z.string().trim().max(30).optional(),
  status: z.string().trim().max(20).optional(),
  ...Paging,
});
const VoucherParams = z.object({
  nIde: z.string().min(3).max(30),
  per: z.string().regex(/^\d{6}$/),
  nLiq: z.enum(['1', '2']).transform(Number),
  contrato: z.string().min(1).max(40),
});
const Reason = z.string().trim().min(10).max(500);
const like = (v: string) => `%${v.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminSupportController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  async summary() {
    const [acc] = await this.db
      .execute(
        sql`select
      count(*) filter (where status = 'ACTIVA')::int as active,
      count(*) filter (where status = 'PENDIENTE_VERIFICACION')::int as pending,
      count(*) filter (where status = 'BLOQUEADA')::int as blocked from accounts`,
      )
      .then((r) => r.rows);
    const [emp] = await this.db
      .execute(
        sql`select
      count(*) filter (where est = 'V')::int as active,
      count(*) filter (where est = 'C')::int as cancelled from employee_snapshots`,
      )
      .then((r) => r.rows);
    const imports = await this.db
      .select({ status: importBatches.status, n: sql<number>`count(*)::int` })
      .from(importBatches)
      .where(sql`${importBatches.status} in ('LISTO', 'OBSERVADO')`)
      .groupBy(importBatches.status);
    const [payroll] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollVersions)
      .where(eq(payrollVersions.status, 'PUBLICADA'));
    const [concepts] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollConcepts)
      .where(eq(payrollConcepts.active, true));
    const [comps] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(companies)
      .where(eq(companies.active, true));
    return {
      accounts: acc,
      employees: emp,
      pendingImports: Object.fromEntries(imports.map((i) => [i.status, Number(i.n)])),
      publishedPayrollVersions: Number(payroll?.n ?? 0),
      activeConcepts: Number(concepts?.n ?? 0),
      activeCompanies: Number(comps?.n ?? 0),
    };
  }

  @Get('imports')
  @Header('Cache-Control', 'no-store')
  async imports(@Query() query: unknown) {
    const q = ImportsQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    const filters: SQL[] = [];
    if (q.data.type) filters.push(eq(importBatches.type, q.data.type));
    if (q.data.status) filters.push(sql`${importBatches.status}::text = ${q.data.status}`);
    const where = filters.length ? and(...filters) : undefined;
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(importBatches)
      .where(where);
    const items = await this.db
      .select({
        id: importBatches.id,
        type: importBatches.type,
        status: importBatches.status,
        rowCount: importBatches.rowCount,
        errorCount: importBatches.errorCount,
        fileName: importBatches.fileName,
        createdAt: importBatches.createdAt,
        appliedAt: importBatches.appliedAt,
        createdBy: accounts.email,
      })
      .from(importBatches)
      .innerJoin(accounts, eq(accounts.id, importBatches.createdBy))
      .where(where)
      .orderBy(desc(importBatches.createdAt))
      .limit(q.data.pageSize)
      .offset((q.data.page - 1) * q.data.pageSize);
    return { total: Number(total), page: q.data.page, pageSize: q.data.pageSize, items };
  }

  @Get('audit')
  @Header('Cache-Control', 'no-store')
  async audit(@Query() query: unknown) {
    const q = AuditQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    const filters: SQL[] = [];
    if (q.data.kind === 'HTTP') filters.push(eq(auditLogs.action, HTTP_ACTION));
    if (q.data.kind === 'EVENT') filters.push(sql`${auditLogs.action} <> ${HTTP_ACTION}`);
    if (q.data.method) filters.push(sql`${auditLogs.context}->>'method' = ${q.data.method}`);
    if (q.data.status) filters.push(eq(auditLogs.result, q.data.status));
    if (q.data.route) filters.push(ilike(auditLogs.resource, like(q.data.route)));
    if (q.data.action) filters.push(ilike(auditLogs.action, like(q.data.action)));
    if (q.data.result) filters.push(ilike(auditLogs.result, like(q.data.result)));
    if (q.data.actor) filters.push(ilike(accounts.email, like(q.data.actor)));
    if (q.data.from) filters.push(gte(auditLogs.at, new Date(`${q.data.from}T00:00:00-05:00`)));
    if (q.data.to) filters.push(lte(auditLogs.at, new Date(`${q.data.to}T23:59:59.999-05:00`)));
    const where = filters.length ? and(...filters) : undefined;
    const base = this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .leftJoin(accounts, eq(accounts.id, auditLogs.actorAccountId));
    const [{ total } = { total: 0 }] = await (where ? base.where(where) : base);
    const items = await this.db
      .select({
        id: auditLogs.id,
        at: auditLogs.at,
        action: auditLogs.action,
        resource: auditLogs.resource,
        resourceId: auditLogs.resourceId,
        result: auditLogs.result,
        context: auditLogs.context,
        actor: accounts.email,
      })
      .from(auditLogs)
      .leftJoin(accounts, eq(accounts.id, auditLogs.actorAccountId))
      .where(where)
      .orderBy(desc(auditLogs.at))
      .limit(q.data.pageSize)
      .offset((q.data.page - 1) * q.data.pageSize);
    return { total: Number(total), page: q.data.page, pageSize: q.data.pageSize, items };
  }

  @Get('payroll/employees/:nIde/vouchers')
  @Header('Cache-Control', 'no-store')
  async vouchers(@Param('nIde') nIde: string, @Req() req: AuthedRequest) {
    const [known] = await this.db
      .select({ id: employeeSnapshots.id })
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.nIde, nIde))
      .limit(1);
    if (!known) throw new NotFoundException();
    return adminListVouchers(this.db, req.auth.accountId, nIde);
  }

  @Get('payroll/employees/:nIde/:per/:nLiq/:contrato/pdf')
  @UseGuards(RecentAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async voucherPdf(
    @Param() raw: unknown,
    @Query('mode') mode: string | undefined,
    @Query('reason') reason: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    const params = VoucherParams.safeParse(raw);
    const why = Reason.safeParse(reason);
    if (!params.success || !why.success) throw new BadRequestException();
    const { nIde, ...voucher } = params.data;
    try {
      const { pdf, fileName } = await adminDownloadVoucher(
        this.db,
        req.auth.accountId,
        nIde,
        voucher,
        mode,
        why.data,
      );
      return new StreamableFile(pdf, {
        type: 'application/pdf',
        disposition: `attachment; filename="${fileName}"`,
      });
    } catch (e) {
      if (e instanceof VoucherError) {
        if (e.code === 'INVALID_MODE') throw new BadRequestException({ code: e.code });
        throw new NotFoundException();
      }
      throw e;
    }
  }
}
