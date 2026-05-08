import { describe, expect, it, vi } from 'vitest';
import {
  applyOcrResultToPaymentEvidenceDocument,
  computePaymentEvidenceOcrConsistency,
  createTriDocOcrService,
  normalizeTriDocExtractResponse,
} from './tridoc-ocr.mjs';

describe('tridoc OCR service', () => {
  it('skips OCR when disabled', async () => {
    const service = createTriDocOcrService({
      enabled: false,
      endpointUrl: 'https://ocr.example.com',
      authorizationHeader: 'Bearer token',
    });

    await expect(service.extractDocument({
      documentType: 'bankbook',
      fileName: 'bankbook.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-image').toString('base64'),
    })).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'disabled',
      extractedFields: {},
      parserConfidence: 0,
    });
  });

  it('skips PDFs because the current VLLM endpoint accepts image payloads', async () => {
    const fetchImpl = vi.fn();
    const service = createTriDocOcrService({
      enabled: true,
      endpointUrl: 'https://ocr.example.com',
      authorizationHeader: 'Bearer token',
      fetchImpl,
    });

    await expect(service.extractDocument({
      documentType: 'payment_confirmation',
      fileName: 'payment.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    })).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'unsupported_mime_type',
      extractedFields: {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks production egress to a quick tunnel unless explicitly allowed', async () => {
    const fetchImpl = vi.fn();
    const service = createTriDocOcrService({
      enabled: true,
      endpointUrl: 'https://quick-test.trycloudflare.com',
      authorizationHeader: 'Bearer token',
      allowedHosts: ['quick-test.trycloudflare.com'],
      production: true,
      allowEphemeralTunnel: false,
      fetchImpl,
    });

    await expect(service.extractDocument({
      documentType: 'bankbook',
      fileName: 'bankbook.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-image').toString('base64'),
    })).resolves.toMatchObject({
      status: 'BLOCKED',
      reason: 'ephemeral_tunnel_not_allowed',
      extractedFields: {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks production OCR when the endpoint host is not allowlisted', async () => {
    const fetchImpl = vi.fn();
    const service = createTriDocOcrService({
      enabled: true,
      endpointUrl: 'https://ocr.example.com',
      authorizationHeader: 'Bearer token',
      allowedHosts: ['approved.example.com'],
      production: true,
      fetchImpl,
    });

    await expect(service.extractDocument({
      documentType: 'bankbook',
      fileName: 'bankbook.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-image').toString('base64'),
    })).resolves.toMatchObject({
      status: 'BLOCKED',
      reason: 'endpoint_host_not_allowlisted',
      extractedFields: {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks production OCR without an authorization header', async () => {
    const fetchImpl = vi.fn();
    const service = createTriDocOcrService({
      enabled: true,
      endpointUrl: 'https://ocr.example.com',
      authorizationHeader: '',
      allowedHosts: ['ocr.example.com'],
      production: true,
      fetchImpl,
    });

    await expect(service.extractDocument({
      documentType: 'bankbook',
      fileName: 'bankbook.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-image').toString('base64'),
    })).resolves.toMatchObject({
      status: 'BLOCKED',
      reason: 'authorization_required',
      extractedFields: {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes TriDoc extraction payloads into safe document fields', () => {
    const normalized = normalizeTriDocExtractResponse({
      document_type_hint: 'bankbook',
      pred_json: {
        document_type: 'bankbook',
        fields: {
          bank: '신한은행',
          account_number: '110-123-456789',
          account_holder: '김민수',
          ignored: { nested: true },
        },
      },
      elapsed_sec: 1.234,
    }, {
      documentType: 'bankbook',
      now: '2026-05-08T05:40:00.000Z',
    });

    expect(normalized).toMatchObject({
      status: 'COMPLETED',
      documentTypeHint: 'bankbook',
      predictedDocumentType: 'bankbook',
      extractedFields: {
        bank: '신한은행',
        account_number: '110-123-456789',
        account_holder: '김민수',
      },
      elapsedSec: 1.234,
      extractedAt: '2026-05-08T05:40:00.000Z',
    });
    expect(normalized.parserConfidence).toBeGreaterThanOrEqual(0.95);
  });

  it('posts images to the configured /extract endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      filename: 'bankbook.png',
      document_type_hint: 'bankbook',
      pred_json: {
        document_type: 'bankbook',
        fields: {
          bank: '신한은행',
          account_number: '110-123-456789',
          account_holder: '김민수',
        },
      },
      elapsed_sec: 0.9,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const service = createTriDocOcrService({
      enabled: true,
      endpointUrl: 'https://ocr.example.com/',
      authorizationHeader: 'Bearer token',
      fetchImpl,
      now: () => '2026-05-08T05:40:00.000Z',
    });

    const result = await service.extractDocument({
      documentType: 'bankbook',
      fileName: '김민수_통장사본.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-image').toString('base64'),
    });

    expect(result).toMatchObject({
      status: 'COMPLETED',
      extractedFields: {
        bank: '신한은행',
        account_number: '110-123-456789',
        account_holder: '김민수',
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://ocr.example.com/extract', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer token',
      }),
    }));
    const requestBody = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    expect((requestBody.get('file') as File).name).toBe('bankbook.png');
  });
});

describe('payment evidence OCR consistency', () => {
  const matchingCase = {
    id: 'PAY-202605-0001',
    campaignId: 'camp-1',
    campaignName: '테스트',
    payeeName: '김민수',
    expectedAmount: 300000,
    documents: [
      {
        id: 'doc-payment',
        type: 'payment_confirmation',
        fileName: 'payment.png',
        extractedFields: {
          name: '김민수',
          resident_registration_number: '900101-1******',
          amount: '300,000',
          bank: '신한은행',
          account_number: '110-123-456789',
          account_holder: '김민수',
        },
        validatedFields: {},
      },
      {
        id: 'doc-id',
        type: 'id_card',
        fileName: 'id.png',
        extractedFields: {
          id_type: '주민등록증',
          name: '김민수',
          resident_registration_number: '900101-1******',
        },
        validatedFields: {},
      },
      {
        id: 'doc-bank',
        type: 'bankbook',
        fileName: 'bank.png',
        extractedFields: {
          bank: '신한은행',
          account_number: '110-123-456789',
          account_holder: '김민수',
        },
        validatedFields: {},
      },
    ],
  };

  it('returns a high match probability for a complete matching bundle', () => {
    const consistency = computePaymentEvidenceOcrConsistency(matchingCase);

    expect(consistency.status).toBe('match');
    expect(consistency.matched).toBe(true);
    expect(consistency.matchProbability).toBeGreaterThanOrEqual(0.85);
    expect(consistency.blockerCount).toBe(0);
  });

  it('returns mismatch when extracted fields conflict across documents', () => {
    const consistency = computePaymentEvidenceOcrConsistency({
      ...matchingCase,
      documents: matchingCase.documents.map((document) => (
        document.type === 'bankbook'
          ? {
            ...document,
            extractedFields: {
              ...document.extractedFields,
              account_holder: '박영희',
            },
          }
          : document
      )),
    });

    expect(consistency.status).toBe('mismatch');
    expect(consistency.matched).toBe(false);
    expect(consistency.matchProbability).toBeLessThan(0.85);
    expect(consistency.issueCodes).toContain('account_holder_mismatch');
  });

  it('applies OCR fields and metadata onto a payment evidence document', () => {
    const next = applyOcrResultToPaymentEvidenceDocument({
      id: 'doc-bank',
      type: 'bankbook',
      fileName: 'bank.png',
      extractedFields: {},
      validatedFields: {},
    }, {
      status: 'COMPLETED',
      extractedFields: {
        bank: '신한은행',
        account_number: '110-123-456789',
        account_holder: '김민수',
      },
      parserConfidence: 0.98,
      documentTypeHint: 'bankbook',
      predictedDocumentType: 'bankbook',
      elapsedSec: 0.9,
      extractedAt: '2026-05-08T05:40:00.000Z',
    });

    expect(next).toMatchObject({
      extractedFields: {
        bank: '신한은행',
        account_number: '110-123-456789',
        account_holder: '김민수',
      },
      parserConfidence: 0.98,
      ocrStatus: 'COMPLETED',
      ocrProvider: 'tridoc-vllm',
      ocrPredictedDocumentType: 'bankbook',
      ocrExtractedAt: '2026-05-08T05:40:00.000Z',
    });
  });
});
