import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import {
  clearConfig,
  getActiveFirebaseConfig,
  getDefaultOrgId,
  initFirebase,
  readFirebaseConfigFromEnv,
  saveConfig,
  type FirebaseConfig,
} from './firebase';
import { featureFlags } from '../config/feature-flags';
import { resolveTenantId } from '../platform/tenant';

export type FirebaseConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const TENANT_STORAGE_KEY = 'MYSC_ACTIVE_TENANT';

export interface FirebaseContextValue {
  status: FirebaseConnectionStatus;
  db: Firestore | null;
  auth: Auth | null;
  config: FirebaseConfig | null;
  orgId: string;
  error: string | null;
  connect: (config: FirebaseConfig) => Promise<boolean>;
  disconnect: () => void;
  setOrgId: (nextOrgId: string) => boolean;
  isOnline: boolean;
  isUsingEnvConfig: boolean;
}

function getSavedOrgId(): string {
  try {
    return localStorage.getItem(TENANT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveOrgId(orgId: string): void {
  try {
    localStorage.setItem(TENANT_STORAGE_KEY, orgId);
  } catch {
    // localStorage can be unavailable in private contexts.
  }
}

function resolveEnvScopedOrgId(): string {
  return resolveTenantId({
    envTenantId: getDefaultOrgId(),
    defaultTenantId: 'mysc',
    strict: featureFlags.tenantIsolationStrict,
  });
}

const _g = globalThis as typeof globalThis & {
  __SUBMIT_MYSC_FB_CTX__?: React.Context<FirebaseContextValue | null>;
};

if (!_g.__SUBMIT_MYSC_FB_CTX__) {
  _g.__SUBMIT_MYSC_FB_CTX__ = createContext<FirebaseContextValue | null>(null);
}

const FirebaseContext = _g.__SUBMIT_MYSC_FB_CTX__;

export function FirebaseProvider({ children }: { children: ReactNode }) {
  const envConfig = readFirebaseConfigFromEnv();
  const isUsingEnvConfig = Boolean(envConfig);
  const [status, setStatus] = useState<FirebaseConnectionStatus>('disconnected');
  const [db, setDb] = useState<Firestore | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [config, setConfig] = useState<FirebaseConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualDisconnected, setManualDisconnected] = useState(false);
  const [orgId, setOrgIdState] = useState(() => resolveTenantId({
    savedTenantId: isUsingEnvConfig ? '' : getSavedOrgId(),
    envTenantId: getDefaultOrgId(),
    strict: featureFlags.tenantIsolationStrict,
  }));

  useEffect(() => {
    if (!isUsingEnvConfig) return;
    clearConfig();
    const forcedOrgId = resolveEnvScopedOrgId();
    saveOrgId(forcedOrgId);
    setOrgIdState((prev) => (prev === forcedOrgId ? prev : forcedOrgId));
  }, [isUsingEnvConfig]);

  useEffect(() => {
    function applyTenantFromEvent(rawTenantId: unknown) {
      try {
        const nextTenantId = resolveTenantId({
          savedTenantId: isUsingEnvConfig ? '' : rawTenantId,
          envTenantId: getDefaultOrgId(),
          strict: featureFlags.tenantIsolationStrict,
        });
        setOrgIdState(nextTenantId);
      } catch {
        // Keep the current tenant if another tab writes an invalid value.
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== TENANT_STORAGE_KEY || !event.newValue) return;
      applyTenantFromEvent(event.newValue);
    };
    const onTenantChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ tenantId?: string }>;
      applyTenantFromEvent(customEvent.detail?.tenantId);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('mysc:tenant-changed', onTenantChanged);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mysc:tenant-changed', onTenantChanged);
    };
  }, [isUsingEnvConfig]);

  useEffect(() => {
    if (manualDisconnected) return;

    const active = getActiveFirebaseConfig();
    if (!active) {
      setStatus('disconnected');
      setConfig(null);
      setDb(null);
      setAuth(null);
      setError(null);
      return;
    }

    setStatus('connecting');
    setConfig(active);

    try {
      const result = initFirebase(active);
      if (!result) {
        setStatus('error');
        setError('Firebase 초기화 실패');
        return;
      }

      setDb(result.db);
      setAuth(result.auth);
      setStatus('connected');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Firebase 연결 오류');
      setStatus('error');
    }
  }, [manualDisconnected, orgId]);

  const connect = useCallback(async (cfg: FirebaseConfig): Promise<boolean> => {
    setStatus('connecting');
    setError(null);
    setManualDisconnected(false);

    try {
      const result = initFirebase(cfg);
      if (!result) {
        setError('Firebase 초기화 실패');
        setStatus('error');
        return false;
      }

      saveConfig(cfg);
      setConfig(cfg);
      setDb(result.db);
      setAuth(result.auth);
      setStatus('connected');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Firebase 연결 오류');
      setStatus('error');
      return false;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearConfig();
    setManualDisconnected(true);
    setDb(null);
    setAuth(null);
    setConfig(null);
    setStatus('disconnected');
    setError(null);
  }, []);

  const setOrgId = useCallback((nextOrgId: string): boolean => {
    try {
      const resolved = resolveTenantId({
        savedTenantId: nextOrgId,
        envTenantId: getDefaultOrgId(),
        strict: featureFlags.tenantIsolationStrict,
      });
      setOrgIdState(resolved);
      saveOrgId(resolved);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '잘못된 테넌트 ID');
      return false;
    }
  }, []);

  const value: FirebaseContextValue = {
    status,
    db,
    auth,
    config,
    orgId,
    error,
    connect,
    disconnect,
    setOrgId,
    isOnline: status === 'connected' && Boolean(db),
    isUsingEnvConfig,
  };

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) throw new Error('useFirebase must be used within FirebaseProvider');
  return ctx;
}
