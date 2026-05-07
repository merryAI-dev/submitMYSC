import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { OrgMember } from './types';
import { useAuth } from './auth-store';

interface AppState {
  currentUser: OrgMember;
}

const FALLBACK_USER: OrgMember = {
  uid: 'local_admin',
  name: 'MYSC Admin',
  email: 'submit@mysc.co.kr',
  role: 'admin',
};

const _g = globalThis as typeof globalThis & {
  __SUBMIT_MYSC_APP_CTX__?: React.Context<AppState | null>;
};

if (!_g.__SUBMIT_MYSC_APP_CTX__) {
  _g.__SUBMIT_MYSC_APP_CTX__ = createContext<AppState | null>(null);
}

const AppContext = _g.__SUBMIT_MYSC_APP_CTX__;

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const currentUser = useMemo<OrgMember>(() => {
    if (!user) return FALLBACK_USER;
    return {
      uid: user.uid,
      name: user.name,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatarUrl,
    };
  }, [user]);

  return (
    <AppContext.Provider value={{ currentUser }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppStore(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}
