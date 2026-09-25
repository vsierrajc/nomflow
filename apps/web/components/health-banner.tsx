'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/admin-ui';
import { useAdmin } from '@/lib/admin';

interface Snap {
  overall: 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';
  checks: { key: string; label: string; level: string }[];
}

/** Aviso visible en toda la administración cuando hay alertas de salud del sistema abiertas. */
export function HealthBanner() {
  const { call } = useAdmin();
  const [snap, setSnap] = useState<Snap | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await call<Snap>('/admin/health');
      if (res.status === 200 && res.data) setSnap(res.data);
    })();
  }, [call]);

  if (!snap || (snap.overall !== 'WARN' && snap.overall !== 'CRIT')) return null;
  const bad = snap.checks.filter((c) => c.level === 'WARN' || c.level === 'CRIT');
  return (
    <div data-testid="health-banner">
      <Notice kind={snap.overall === 'CRIT' ? 'error' : 'warn'}>
        {snap.overall === 'CRIT' ? 'Alerta crítica del sistema: ' : 'Aviso del sistema: '}
        {bad.map((c) => c.label).join(', ')}. <Link href="/admin/salud">Ver salud del sistema</Link>
      </Notice>
    </div>
  );
}
