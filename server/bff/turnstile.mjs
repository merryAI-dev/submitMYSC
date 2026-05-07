function createTurnstileError(statusCode, message, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readTurnstileResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function createTurnstileVerifier({
  enabled = process.env.BFF_TURNSTILE_ENABLED !== 'false',
  secretKey = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '',
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async verify({ token, remoteIp } = {}) {
      if (!enabled) return { ok: true, skipped: true };

      const normalizedSecretKey = readOptionalText(secretKey);
      const normalizedToken = readOptionalText(token);
      if (!normalizedSecretKey) {
        throw createTurnstileError(503, 'Cloudflare Turnstile is not configured', 'turnstile_not_configured');
      }
      if (!normalizedToken) {
        throw createTurnstileError(400, 'Cloudflare Turnstile token is required', 'turnstile_token_required');
      }
      if (typeof fetchImpl !== 'function') {
        throw createTurnstileError(503, 'Cloudflare Turnstile fetch is not configured', 'turnstile_fetch_not_configured');
      }

      const body = new URLSearchParams();
      body.set('secret', normalizedSecretKey);
      body.set('response', normalizedToken);
      const normalizedRemoteIp = readOptionalText(remoteIp);
      if (normalizedRemoteIp) body.set('remoteip', normalizedRemoteIp);

      const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await readTurnstileResponse(response);
      if (!response.ok) {
        throw createTurnstileError(
          502,
          'Cloudflare Turnstile verification failed upstream',
          'turnstile_upstream_error',
          data,
        );
      }
      if (!data?.success) {
        throw createTurnstileError(
          403,
          'Cloudflare Turnstile verification failed',
          'turnstile_failed',
          data,
        );
      }

      return {
        ok: true,
        skipped: false,
        action: readOptionalText(data.action),
        hostname: readOptionalText(data.hostname),
      };
    },
  };
}
