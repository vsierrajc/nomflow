'use client';

import type { ReactNode } from 'react';
import { AdminProvider } from '@/lib/admin';
import { useReadyProfile } from '@/lib/use-profile';

/** Pide la clave otra vez cuando una acción de firma lo exige (reautenticación). */
export function SecureActions({ children }: { children: ReactNode }) {
  const profile = useReadyProfile();
  return <AdminProvider profile={profile}>{children}</AdminProvider>;
}
