import type { ApiResult } from './api';

export interface CatalogOption {
  value: string;
  label: string;
}

interface CatalogPage {
  items: { code: string; name: string }[];
  total: number;
}

type Caller = <T = unknown>(path: string) => Promise<ApiResult<T>>;

/** Trae todas las entradas activas de un catálogo (de 200 en 200) como opciones de lista «código - nombre». */
export async function loadCatalog(
  call: Caller,
  kind: 'AREA' | 'CCOSTO' | 'CARGO' | 'TIPO_CONTRATO',
  cEmp: string,
): Promise<CatalogOption[] | null> {
  const out: CatalogOption[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const qs = new URLSearchParams({ active: 'true', page: String(page), pageSize: '200' });
    if (kind !== 'TIPO_CONTRATO') qs.set('cEmp', cEmp);
    const res = await call<CatalogPage>(`/admin/catalogs/${kind}?${qs.toString()}`);
    if (res.status !== 200 || !res.data) return null;
    out.push(...res.data.items.map((i) => ({ value: i.code, label: `${i.code} - ${i.name}` })));
    if (out.length >= res.data.total) break;
  }
  return out;
}

/** Empresas activas como opciones de lista «código - nombre». */
export async function loadCompanies(call: Caller): Promise<CatalogOption[] | null> {
  const res = await call<{ cEmp: string; nombre: string; active: boolean }[]>('/admin/companies');
  if (res.status !== 200 || !res.data) return null;
  return res.data
    .filter((c) => c.active)
    .map((c) => ({ value: c.cEmp, label: `${c.cEmp} - ${c.nombre}` }));
}
