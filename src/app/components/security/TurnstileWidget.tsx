import React, { useEffect, useRef } from 'react';

const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-script';
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileWidgetId = string;

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): TurnstileWidgetId;
  remove(widgetId: TurnstileWidgetId): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function readEnvString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readTurnstileSiteKey(env: Record<string, unknown> = import.meta.env): string {
  return readEnvString(env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY)
    || readEnvString(env.VITE_PAYMENT_EVIDENCE_TURNSTILE_SITE_KEY);
}

function ensureTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Turnstile can only run in a browser.'));
  }
  if (window.turnstile) return Promise.resolve();

  const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile script failed to load.')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile script failed to load.')), { once: true });
    document.head.appendChild(script);
  });
}

export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  onError,
  className,
}: {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<TurnstileWidgetId>('');

  useEffect(() => {
    let cancelled = false;
    if (!siteKey) return undefined;

    void ensureTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: onVerify,
          'expired-callback': () => {
            onVerify('');
            onExpire?.();
          },
          'error-callback': () => {
            onVerify('');
            onError?.();
          },
          theme: 'light',
          size: 'flexible',
        });
      })
      .catch(() => {
        onVerify('');
        onError?.();
      });

    return () => {
      cancelled = true;
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = '';
    };
  }, [onError, onExpire, onVerify, siteKey]);

  return <div ref={containerRef} className={className} />;
}
