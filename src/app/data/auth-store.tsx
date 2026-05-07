import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  onIdTokenChanged,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import type { UserRole } from './types';
import { featureFlags } from '../config/feature-flags';
import {
  getAuthInstance,
  getDefaultOrgId,
  getGoogleAuthProvider,
  initFirebase,
} from '../lib/firebase';
import { formatAllowedDomains, getAllowedEmailDomains, isAllowedEmail } from '../platform/email-allowlist';
import { setObservabilityUserContext } from '../platform/observability';

export interface AuthUser {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  source?: 'firebase' | 'local';
  idToken?: string;
  avatarUrl?: string;
  tenantId?: string;
}

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
  isFirebaseAuthEnabled: boolean;
  authError: string | null;
}

interface AuthActions {
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  isAdmin: () => boolean;
  isPortalUser: () => boolean;
}

const ADMIN_EMAIL_ENV_KEYS = [
  'VITE_SUBMIT_MYSC_ADMIN_EMAILS',
  'VITE_BOOTSTRAP_ADMIN_EMAILS',
] as const;

const ALLOWED_EMAIL_DOMAINS = getAllowedEmailDomains(import.meta.env);
const DEFAULT_ORG_ID = getDefaultOrgId();
const LOCAL_ADMIN: AuthUser = {
  uid: 'local_admin',
  name: 'MYSC Admin',
  email: 'submit@mysc.co.kr',
  role: 'admin',
  source: 'local',
  tenantId: DEFAULT_ORG_ID,
};

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseEmailList(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : '';
  return raw
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

function readAdminEmails(env: Record<string, unknown> = import.meta.env): string[] {
  const emails = ADMIN_EMAIL_ENV_KEYS.flatMap((key) => parseEmailList(env[key]));
  return Array.from(new Set(emails));
}

function isSubmitMyscAdminEmail(email: unknown, env: Record<string, unknown> = import.meta.env): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const configuredAdmins = readAdminEmails(env);
  if (configuredAdmins.length === 0) {
    return isAllowedEmail(normalized, ALLOWED_EMAIL_DOMAINS);
  }
  return configuredAdmins.includes(normalized);
}

async function mapFirebaseUser(firebaseUser: FirebaseUser): Promise<AuthUser | null> {
  const email = normalizeEmail(firebaseUser.email);
  if (!email || !isAllowedEmail(email, ALLOWED_EMAIL_DOMAINS)) {
    return null;
  }
  if (!isSubmitMyscAdminEmail(email)) {
    return null;
  }

  const idToken = await firebaseUser.getIdToken().catch(() => undefined);
  return {
    uid: firebaseUser.uid,
    name: firebaseUser.displayName || email.split('@')[0] || 'MYSC Admin',
    email,
    role: 'admin',
    source: 'firebase',
    idToken,
    avatarUrl: firebaseUser.photoURL || undefined,
    tenantId: DEFAULT_ORG_ID,
  };
}

const _g = globalThis as typeof globalThis & {
  __SUBMIT_MYSC_AUTH_CTX__?: React.Context<(AuthState & AuthActions) | null>;
};

if (!_g.__SUBMIT_MYSC_AUTH_CTX__) {
  _g.__SUBMIT_MYSC_AUTH_CTX__ = createContext<(AuthState & AuthActions) | null>(null);
}

const AuthContext = _g.__SUBMIT_MYSC_AUTH_CTX__;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(featureFlags.firebaseAuthEnabled ? null : LOCAL_ADMIN);
  const [isLoading, setIsLoading] = useState(featureFlags.firebaseAuthEnabled);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!featureFlags.firebaseAuthEnabled) {
      setIsLoading(false);
      return undefined;
    }

    const initialized = initFirebase();
    const auth = initialized?.auth || getAuthInstance();
    if (!auth) {
      setAuthError('Firebase 인증 설정이 필요합니다.');
      setIsLoading(false);
      return undefined;
    }

    return onIdTokenChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setAuthError(null);
        setIsLoading(false);
        return;
      }

      const mapped = await mapFirebaseUser(firebaseUser);
      if (!mapped) {
        await signOut(auth).catch(() => {});
        setUser(null);
        setAuthError(
          `관리자 접근 권한이 없습니다. 허용 도메인: ${formatAllowedDomains(ALLOWED_EMAIL_DOMAINS)}`,
        );
        setIsLoading(false);
        return;
      }

      setUser(mapped);
      setAuthError(null);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    setObservabilityUserContext(
      user
        ? {
          id: user.uid,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
        }
        : null,
    );
  }, [user]);

  const loginWithGoogle = useCallback(async () => {
    setAuthError(null);
    const initialized = initFirebase();
    const auth = initialized?.auth || getAuthInstance();
    if (!auth) {
      const message = 'Firebase 인증 설정이 필요합니다.';
      setAuthError(message);
      return { success: false, error: message };
    }

    try {
      const result = await signInWithPopup(auth, getGoogleAuthProvider());
      const mapped = await mapFirebaseUser(result.user);
      if (!mapped) {
        await signOut(auth).catch(() => {});
        const message = 'submitMYSC 관리자 allowlist에 포함된 MYSC 계정만 접근할 수 있습니다.';
        setAuthError(message);
        return { success: false, error: message };
      }
      setUser(mapped);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google 로그인을 완료하지 못했습니다.';
      setAuthError(message);
      return { success: false, error: message };
    }
  }, []);

  const logout = useCallback(async () => {
    const auth = getAuthInstance();
    if (auth) {
      await signOut(auth).catch(() => {});
    }
    setUser(featureFlags.firebaseAuthEnabled ? null : LOCAL_ADMIN);
  }, []);

  const value = useMemo<AuthState & AuthActions>(() => ({
    isAuthenticated: Boolean(user),
    user,
    isLoading,
    isFirebaseAuthEnabled: featureFlags.firebaseAuthEnabled,
    authError,
    loginWithGoogle,
    logout,
    isAdmin: () => Boolean(user && (user.role === 'admin' || user.role === 'finance')),
    isPortalUser: () => Boolean(user),
  }), [authError, isLoading, loginWithGoogle, logout, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState & AuthActions {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
