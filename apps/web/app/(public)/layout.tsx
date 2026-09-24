import type { ReactNode } from 'react';
import { AuthFrame } from '@/components/shells';
import { ProfileProvider } from '@/lib/use-profile';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <ProfileProvider>
      <AuthFrame>{children}</AuthFrame>
    </ProfileProvider>
  );
}
