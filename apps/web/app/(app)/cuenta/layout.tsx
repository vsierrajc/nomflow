import type { ReactNode } from 'react';
import { AccountTabs } from '@/components/account-tabs';
import { SecureActions } from '@/components/secure-actions';

export const metadata = { title: 'Mi cuenta' };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <SecureActions>
      <AccountTabs />
      {children}
    </SecureActions>
  );
}
