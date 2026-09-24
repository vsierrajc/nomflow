import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  companies,
  employeeSnapshots,
  payrollDownloadAudit,
  payrollLines,
  payrollVersions,
} from '../db/schema';
import { logoForCompanyCode } from '../org/logos.service';
import { conceptUnits } from './concepts.service';
import { ceilToInteger, parseDecimal } from './decimal';
import { renderVoucherPdf, type VoucherData, type VoucherMode } from './voucher.pdf';

export const VOUCHER_MODES = ['SIN_AJUSTE', 'ENTERO_SUPERIOR'] as const;
export type { VoucherMode };

export type VoucherErrorCode = 'INVALID_MODE' | 'NOT_FOUND';

export class VoucherError extends Error {
  constructor(readonly code: VoucherErrorCode) {
    super(code);
  }
}

export interface VoucherListItem {
  per: string;
  nLiq: number;
  contrato: string;
}

export function isVoucherMode(value: unknown): value is VoucherMode {
  return typeof value === 'string' && (VOUCHER_MODES as readonly string[]).includes(value);
}

async function identity(db: Db, accountId: string) {
  const [account] = await db
    .select({ nIde: accounts.nIde })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) throw new VoucherError('NOT_FOUND');
  return account.nIde;
}

export async function listMyVouchers(db: Db, accountId: string) {
  const nIde = await identity(db, accountId);
  const vouchers: VoucherListItem[] = await db
    .selectDistinct({
      per: payrollVersions.per,
      nLiq: payrollVersions.nLiq,
      contrato: payrollLines.contrato,
    })
    .from(payrollLines)
    .innerJoin(payrollVersions, eq(payrollVersions.id, payrollLines.versionId))
    .where(and(eq(payrollLines.nIde, nIde), eq(payrollVersions.status, 'PUBLICADA')))
    .orderBy(desc(payrollVersions.per), desc(payrollVersions.nLiq), payrollLines.contrato);

  const [emp] = await db
    .select({ cEmp: employeeSnapshots.cEmp })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, nIde))
    .orderBy(sql`case when ${employeeSnapshots.est} = 'V' then 0 else 1 end`)
    .limit(1);
  const [company] = emp?.cEmp
    ? await db
        .select({ mode: companies.payrollDefaultMode })
        .from(companies)
        .where(eq(companies.cEmp, emp.cEmp))
    : [];
  const defaultMode: VoucherMode = isVoucherMode(company?.mode) ? company.mode : 'SIN_AJUSTE';
  return { defaultMode, vouchers };
}

async function loadVoucher(
  db: Db,
  nIde: string,
  per: string,
  nLiq: number,
  contrato: string,
): Promise<VoucherData | null> {
  const [version] = await db
    .select()
    .from(payrollVersions)
    .where(
      and(
        eq(payrollVersions.per, per),
        eq(payrollVersions.nLiq, nLiq),
        eq(payrollVersions.status, 'PUBLICADA'),
      ),
    );
  if (!version) return null;
  const lines = await db
    .select()
    .from(payrollLines)
    .where(
      and(
        eq(payrollLines.versionId, version.id),
        eq(payrollLines.nIde, nIde),
        eq(payrollLines.contrato, contrato),
      ),
    )
    .orderBy(payrollLines.rowIndex);
  if (lines.length === 0) return null;

  const [emp] = await db
    .select({ nombre: employeeSnapshots.nombre, cEmp: employeeSnapshots.cEmp })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, nIde))
    .orderBy(sql`case when ${employeeSnapshots.est} = 'V' then 0 else 1 end`)
    .limit(1);
  const [company] = emp?.cEmp
    ? await db.select().from(companies).where(eq(companies.cEmp, emp.cEmp))
    : [];
  const units = await conceptUnits(db, [...new Set(lines.map((l) => l.cCon))]);
  const salary = lines.find((l) => l.slrio !== null)?.slrio ?? null;
  return {
    per,
    nLiq,
    contrato,
    nIde,
    employeeName: emp?.nombre ?? lines.find((l) => l.nombreOrigen)?.nombreOrigen ?? '',
    company: company
      ? { nombre: company.nombre, sigla: company.sigla, direccion: company.direccion }
      : null,
    salary: salary === null ? null : parseDecimal(salary),
    version: version.version,
    contentHash: version.contentHash,
    logo: await logoForCompanyCode(db, emp?.cEmp),
    lines: lines.map((l) => ({
      cCon: l.cCon,
      concepto: l.concepto ?? '',
      unit: units.get(l.cCon) ?? null,
      cant: l.cant === null ? null : parseDecimal(l.cant),
      dev: l.dev === null ? null : parseDecimal(l.dev),
      ded: l.ded === null ? null : parseDecimal(l.ded),
    })),
  };
}

export interface VoucherTotals {
  totalDev: bigint;
  totalDed: bigint;
  net: bigint;
}

export function computeTotals(data: VoucherData, mode: VoucherMode): VoucherTotals {
  const adjust = (v: bigint | null) =>
    v === null ? 0n : mode === 'ENTERO_SUPERIOR' ? ceilToInteger(v) : v;
  let totalDev = 0n;
  let totalDed = 0n;
  for (const l of data.lines) {
    totalDev += adjust(l.dev);
    totalDed += adjust(l.ded);
  }
  return { totalDev, totalDed, net: totalDev - totalDed };
}

export async function downloadVoucher(
  db: Db,
  accountId: string,
  params: { per: string; nLiq: number; contrato: string },
  mode: unknown,
): Promise<{ pdf: Buffer; fileName: string }> {
  const audit = async (result: string, versionId: string | null, m: string) => {
    await db.insert(payrollDownloadAudit).values({
      accountId,
      versionId,
      per: params.per,
      nLiq: params.nLiq,
      contrato: params.contrato,
      mode: m,
      result,
    });
  };
  if (!isVoucherMode(mode)) {
    await audit('INVALID_MODE', null, 'INVALIDO');
    throw new VoucherError('INVALID_MODE');
  }
  const nIde = await identity(db, accountId);
  const data = await loadVoucher(db, nIde, params.per, params.nLiq, params.contrato);
  if (!data) {
    await audit('NOT_FOUND', null, mode);
    throw new VoucherError('NOT_FOUND');
  }
  const pdf = await renderVoucherPdf(data, mode, computeTotals(data, mode), new Date());
  const [version] = await db
    .select({ id: payrollVersions.id })
    .from(payrollVersions)
    .where(
      and(
        eq(payrollVersions.per, params.per),
        eq(payrollVersions.nLiq, params.nLiq),
        eq(payrollVersions.status, 'PUBLICADA'),
      ),
    );
  await audit('SUCCESS', version?.id ?? null, mode);
  return { pdf, fileName: `volante-${params.per}-q${params.nLiq}.pdf` };
}
