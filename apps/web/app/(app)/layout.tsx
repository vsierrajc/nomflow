'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell, requestLogout } from '@/components/shells';
import { Alert, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { ProfileProvider, useProfile } from '@/lib/use-profile';

function Frame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { state, reload } = useProfile();

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);

  if (state.status === 'ready') {
    const profile = state.profile;
    return (
      <AppShell
        profile={profile}
        onLogout={() => {
          void requestLogout(profile.csrfToken).then(() => router.replace('/login'));
        }}
      >
        {children}
      </AppShell>
    );
  }

  return (
    <main id="contenido" tabIndex={-1} className="app-main">
      {state.status === 'error' ? (
        <>
          <Alert kind="error">{NETWORK_ERROR}</Alert>
          <button type="button" onClick={reload}>
            Reintentar
          </button>
        </>
      ) : (
        <Loading>Verificando su sesión…</Loading>
      )}
    </main>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ProfileProvider>
      <Frame>{children}</Frame>
    </ProfileProvider>
  );
}
