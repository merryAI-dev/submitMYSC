export interface ObservabilityUserContext {
  id?: string;
  email?: string;
  role?: string;
  tenantId?: string;
}

export interface ObservabilityCaptureOptions {
  source?: string;
  level?: 'info' | 'warning' | 'error' | 'fatal';
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

let currentUserContext: ObservabilityUserContext | null = null;

export function initObservability() {
  return { enabled: false };
}

export function setObservabilityUserContext(user: ObservabilityUserContext | null) {
  currentUserContext = user;
}

export function captureException(error: unknown, options: ObservabilityCaptureOptions = {}) {
  if (import.meta.env.DEV) {
    console.error('[submitMYSC]', error, {
      ...options,
      user: currentUserContext,
    });
  }
}

export function reportError(error: unknown, options?: ObservabilityCaptureOptions) {
  captureException(error, options);
}

export function installGlobalObservabilityHandlers() {
  return () => {};
}
