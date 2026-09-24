'use client';

import { useCallback, useEffect, useState } from 'react';
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

export function useProfile(): { state: ProfileState; reload: () => void } {
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

  return { state, reload: () => void load() };
}
