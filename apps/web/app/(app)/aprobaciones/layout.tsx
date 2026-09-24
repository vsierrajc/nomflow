import type { ReactNode } from 'react';
import { SecureActions } from '@/components/secure-actions';

export const metadata = { title: 'Aprobaciones de vacaciones' };

export default function Layout({ children }: { children: ReactNode }) {
  return <SecureActions>{children}</SecureActions>;
}
