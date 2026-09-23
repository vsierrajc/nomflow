import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { auditLogs, companies } from '../db/schema';

const Fields = {
  nombre: z.string().trim().min(1).max(200),
  sigla: z.string().trim().min(1).max(30),
  direccion: z.string().trim().min(1).max(300),
};
const CreateDto = z.object({ cEmp: z.string().trim().min(1).max(30), ...Fields });
const UpdateDto = z.object({
  ...Fields,
  active: z.boolean(),
  version: z.number().int().positive(),
});

@Controller('admin/companies')
@UseGuards(SessionGuard, RolesGuard)
@Roles('HR_ADMIN')
export class CompaniesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list() {
    return this.db.select().from(companies).orderBy(companies.cEmp);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const inserted = await this.db
      .insert(companies)
      .values(dto.data)
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (!row) throw new ConflictException();
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'COMPANY_CREATE',
      resource: 'company',
      resourceId: row.id,
      result: 'SUCCESS',
    });
    return row;
  }

  @Put(':id')
  @UseGuards(RecentAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = UpdateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const { version, ...values } = dto.data;
    const updated = await this.db
      .update(companies)
      .set({ ...values, version: sql`${companies.version} + 1`, updatedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.version, version)))
      .returning();
    const row = updated[0];
    if (!row) {
      const [exists] = await this.db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, id));
      if (!exists) throw new NotFoundException();
      throw new ConflictException({ code: 'VERSION_CONFLICT' });
    }
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'COMPANY_UPDATE',
      resource: 'company',
      resourceId: id,
      result: 'SUCCESS',
    });
    return row;
  }
}
