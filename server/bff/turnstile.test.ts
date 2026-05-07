import { describe, expect, it, vi } from 'vitest';
import { createTurnstileVerifier } from './turnstile.mjs';

describe('turnstile verifier', () => {
  it('skips verification only when explicitly disabled', async () => {
    const verifier = createTurnstileVerifier({ enabled: false });
    await expect(verifier.verify({ token: '', remoteIp: '127.0.0.1' })).resolves.toEqual({
      ok: true,
      skipped: true,
    });
  });

  it('throws when enabled without a secret', async () => {
    const verifier = createTurnstileVerifier({ enabled: true, secretKey: '' });
    await expect(verifier.verify({ token: 'tok', remoteIp: '127.0.0.1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'turnstile_not_configured',
    });
  });

  it('rejects missing tokens', async () => {
    const verifier = createTurnstileVerifier({ enabled: true, secretKey: 'secret' });
    await expect(verifier.verify({ token: '', remoteIp: '127.0.0.1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'turnstile_token_required',
    });
  });

  it('posts to Cloudflare siteverify and accepts success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const verifier = createTurnstileVerifier({ enabled: true, secretKey: 'secret', fetchImpl });

    await expect(verifier.verify({ token: 'client-token', remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: true,
      skipped: false,
      action: '',
      hostname: '',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://challenges.cloudflare.com/turnstile/v0/siteverify', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('rejects failed Cloudflare verification', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      'error-codes': ['invalid-input-response'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const verifier = createTurnstileVerifier({ enabled: true, secretKey: 'secret', fetchImpl });

    await expect(verifier.verify({ token: 'bad-token', remoteIp: '203.0.113.10' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'turnstile_failed',
    });
  });
});
