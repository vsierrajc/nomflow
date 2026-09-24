'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';

export interface Role {
  role: string;
  cEmp: string | null;
  areaCode: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface Profile {
  accountId: string;
  email: string;
  name: string | null;
  roles: Role[];
  csrfToken: string;
}

export type ProfileState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'error' }
  | { status: 'ready'; profile: Profile };

interface ProfileContextValue {
  state: ProfileState;
  reload: () => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProfileState>({ status: 'loading' });

  const load = useCallback(async () => {
    const res = await api<Profile>('/auth/me');
    if (res.status === 200 && res.data) setState({ status: 'ready', profile: res.data });
    else if (res.status === 401) setState({ status: 'anonymous' });
    else setState({ status: 'error' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo(() => ({ state, reload: () => void load() }), [state, load]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile fuera de ProfileProvider');
  return ctx;
}

export function useReadyProfile(): Profile {
  const { state } = useProfile();
  if (state.status !== 'ready')
    throw new Error(
      'Perfil no disponible: la página debe renderizarse dentro del marco autenticado',
    );
  return state.profile;
}
