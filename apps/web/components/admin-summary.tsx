'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Notice, PageHeader } from '@/components/admin-ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Summary {
  accounts: { active: number; pending: number; blocked: number };
  employees: { active: number; cancelled: number };
  pendingImports: Record<string, number>;
  publishedPayrollVersions: number;
  activeConcepts: number;
  activeCompanies: number;
}

export function AdminSummary() {
  const { call } = useAdmin();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await call<Summary>('/admin/summary');
      if (res.status === 200 && res.data) setData(res.data);
      else setError(NETWORK_ERROR);
    })();
  }, [call]);

  return (
    <>
      <PageHeader title="Resumen administrativo" />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="cards">
            <div className="stat">
              <strong>{data.accounts.active}</strong>Cuentas activas
            </div>
            <div className="stat">
              <strong>{data.accounts.pending}</strong>Cuentas pendientes de activar
            </div>
            <div className="stat">
              <strong>{data.accounts.blocked}</strong>Cuentas bloqueadas
            </div>
            <div className="stat">
              <strong>{data.employees.active}</strong>Empleados vigentes
            </div>
            <div className="stat">
              <strong>{data.employees.cancelled}</strong>Empleados cancelados
            </div>
            <div className="stat">
              <strong>{data.publishedPayrollVersions}</strong>Liquidaciones publicadas
            </div>
            <div className="stat">
              <strong>{data.activeConcepts}</strong>Conceptos de nómina activos
            </div>
            <div className="stat">
              <strong>{data.activeCompanies}</strong>Empresas activas
            </div>
          </div>
          <h2>Importaciones por revisar</h2>
          <p>
            Listas para aplicar: <strong>{data.pendingImports.LISTO ?? 0}</strong> - Con
            observaciones: <strong>{data.pendingImports.OBSERVADO ?? 0}</strong>.{' '}
            <Link href="/admin/importaciones">Ver importaciones</Link>
          </p>
        </>
      ) : error ? null : (
        <p className="muted">Cargando…</p>
      )}
    </>
  );
}
