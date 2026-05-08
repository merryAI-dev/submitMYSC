import { describe, expect, it } from 'vitest';
import {
  applyPaymentEvidenceWorkflowAction,
  applyPaymentEvidenceRejectAndReissue,
  applyPaymentEvidenceExternalSubmissionDocument,
  assertPaymentEvidenceUploadPolicy,
  buildPaymentEvidenceDocumentHash,
  buildPaymentEvidenceSheetRows,
  buildPaymentEvidencePublicSubmission,
  createPaymentEvidenceSubmissionToken,
  evaluatePaymentEvidenceCase,
  hashPaymentEvidenceSubmissionToken,
  type PaymentEvidenceCase,
} from './payment-evidence-domain.mjs';

const baseCase: PaymentEvidenceCase = {
  id: 'PAY-202605-0001',
  campaignId: 'camp-industrial-hackathon',
  campaignName: '산업단지 정책 해커톤',
  payeeName: '김민수',
  roleLabel: '퍼실리테이터',
  expectedAmount: 300000,
  expectedIncomeType: '기타소득',
  expectedPayDate: '2026-05-20',
  workflowStatus: 'submitted',
  documents: [
    {
      id: 'doc-payment-1',
      type: 'payment_confirmation',
      fileName: '김민수_비용지급확인서.pdf',
      driveFileId: 'drv-payment-1',
      sha256: 'hash-payment',
      extractedFields: {},
      validatedFields: {
        name: '김민수',
        resident_registration_number: '900101-1******',
        income_type: '기타소득',
        amount: '300,000',
        bank: '신한은행',
        account_number: '110-***-123456',
        account_holder: '김민수',
      },
    },
    {
      id: 'doc-id-1',
      type: 'id_card',
      fileName: '김민수_신분증사본.jpg',
      driveFileId: 'drv-id-1',
      sha256: 'hash-id',
      extractedFields: {},
      validatedFields: {
        id_type: '주민등록증',
        name: '김민수',
        resident_registration_number: '900101-1******',
      },
    },
    {
      id: 'doc-bank-1',
      type: 'bankbook',
      fileName: '김민수_통장사본.png',
      driveFileId: 'drv-bank-1',
      sha256: 'hash-bank',
      extractedFields: {},
      validatedFields: {
        bank: '신한은행',
        account_number: '110-***-123456',
        account_holder: '김민수',
      },
    },
  ],
};

describe('payment evidence BFF domain', () => {
  it('evaluates, approves, closes, and projects an auditable payment row', () => {
    const evaluation = evaluatePaymentEvidenceCase(baseCase);
    expect(evaluation.status).toBe('ready_to_approve');

    const approved = applyPaymentEvidenceWorkflowAction({
      paymentCase: baseCase,
      action: 'approve',
      actorName: '재무팀',
      at: '2026-05-07T01:00:00.000Z',
      note: '검수 완료',
    });
    const closed = applyPaymentEvidenceWorkflowAction({
      paymentCase: approved,
      action: 'close',
      actorName: '재무팀',
      at: '2026-05-07T02:00:00.000Z',
      note: '정본 완료',
    });

    expect(closed.workflowStatus).toBe('closed');
    expect(closed.workflowEvents?.map((event) => event.action)).toEqual(['approve', 'close']);

    const rows = buildPaymentEvidenceSheetRows(closed);
    expect(rows.payments).toHaveLength(1);
    expect(rows.payments[0]).toMatchObject({
      case_id: 'PAY-202605-0001',
      payee_name: '김민수',
      bank: '신한은행',
      account_holder: '김민수',
      workflow_status: 'closed',
    });
    expect(rows.events).toHaveLength(2);
  });

  it('requires a rejection reason before recording a rejected event', () => {
    expect(() => applyPaymentEvidenceWorkflowAction({
      paymentCase: baseCase,
      action: 'reject',
      actorName: '재무팀',
      at: '2026-05-07T01:00:00.000Z',
      note: ' ',
    })).toThrow('반려 사유');
  });

  it('records rejection and returns the case to sent for reissue', () => {
    const result = applyPaymentEvidenceRejectAndReissue({
      paymentCase: baseCase,
      actorName: '재무팀',
      at: '2026-05-07T04:00:00.000Z',
      reason: '신분증 사본이 흐려서 재업로드가 필요합니다.',
    });

    expect(result.workflowStatus).toBe('sent');
    expect(result.rejectedAt).toBe('2026-05-07T04:00:00.000Z');
    expect(result.rejectedReason).toBe('신분증 사본이 흐려서 재업로드가 필요합니다.');
    expect(result.lastRejectedAt).toBe('2026-05-07T04:00:00.000Z');
    expect(result.lastRejectionReason).toBe('신분증 사본이 흐려서 재업로드가 필요합니다.');
    expect(result.requestedAt).toBe('2026-05-07T04:00:00.000Z');
    expect(result.workflowEvents?.map((event) => event.action)).toEqual(['reject', 'send_request']);
  });

  it('issues a hashed submission token without storing the raw token', () => {
    const issued = createPaymentEvidenceSubmissionToken({
      tenantId: 'mysc',
      caseId: baseCase.id,
      tokenId: 'tok_001',
      secret: 'secret-value-001',
      createdBy: 'finance-user',
      createdAt: '2026-05-07T01:00:00.000Z',
      expiresInDays: 14,
    });

    expect(issued.rawToken).toBe('tok_001.secret-value-001');
    expect(issued.tokenRecord).toMatchObject({
      id: 'tok_001',
      tenantId: 'mysc',
      caseId: baseCase.id,
      tokenHash: hashPaymentEvidenceSubmissionToken('tok_001.secret-value-001'),
      createdBy: 'finance-user',
      createdAt: '2026-05-07T01:00:00.000Z',
      expiresAt: '2026-05-21T01:00:00.000Z',
      status: 'active',
    });
    expect(issued.tokenRecord.rawToken).toBeUndefined();
    expect(issued.tokenRecord.secret).toBeUndefined();
  });

  it('builds a public submission payload without exposing document field values', () => {
    const payload = buildPaymentEvidencePublicSubmission({
      paymentCase: baseCase,
      tokenRecord: {
        id: 'tok_001',
        tenantId: 'mysc',
        caseId: baseCase.id,
        tokenHash: hashPaymentEvidenceSubmissionToken('tok_001.secret-value-001'),
        createdAt: '2026-05-07T01:00:00.000Z',
        expiresAt: '2026-05-21T01:00:00.000Z',
        status: 'active',
      },
      now: '2026-05-08T01:00:00.000Z',
    });

    expect(payload.case).toEqual({
      id: baseCase.id,
      campaignName: '산업단지 정책 해커톤',
      payeeName: '김민수',
      roleLabel: '퍼실리테이터',
      expectedAmount: 300000,
      expectedIncomeType: '기타소득',
      expectedPayDate: '2026-05-20',
      workflowStatus: 'submitted',
    });
    expect(JSON.stringify(payload)).not.toContain('900101');
    expect(JSON.stringify(payload)).not.toContain('110-***-123456');
    expect(payload.requiredDocuments).toEqual([
      { type: 'payment_confirmation', label: '비용지급확인서', uploaded: true, fileName: '김민수_비용지급확인서.pdf' },
      { type: 'id_card', label: '신분증 사본', uploaded: true, fileName: '김민수_신분증사본.jpg' },
      { type: 'bankbook', label: '통장사본', uploaded: true, fileName: '김민수_통장사본.png' },
    ]);
  });

  it('auto-marks a sent case as submitted after the last required external document upload', () => {
    const sentCase: PaymentEvidenceCase = {
      ...baseCase,
      workflowStatus: 'sent',
      submittedAt: undefined,
      workflowEvents: [],
      documents: baseCase.documents.filter((document) => document.type !== 'bankbook'),
    };

    const result = applyPaymentEvidenceExternalSubmissionDocument({
      paymentCase: sentCase,
      document: {
        id: 'doc-bank-external',
        type: 'bankbook',
        fileName: '김민수_통장사본_외부.png',
        driveFileId: 'drv-bank-external',
        extractedFields: {},
        validatedFields: {},
      },
      actorName: '김민수',
      at: '2026-05-07T03:00:00.000Z',
    });

    expect(result.autoSubmitted).toBe(true);
    expect(result.paymentCase.workflowStatus).toBe('submitted');
    expect(result.paymentCase.submittedAt).toBe('2026-05-07T03:00:00.000Z');
    expect(result.paymentCase.documents).toHaveLength(3);
    expect(result.paymentCase.documents.find((document) => document.type === 'bankbook')).toMatchObject({
      id: 'doc-bank-external',
      source: 'external_upload',
    });
    expect(result.paymentCase.workflowEvents?.[0]).toMatchObject({
      action: 'mark_submitted',
      actorName: '김민수',
      fromStatus: 'sent',
      toStatus: 'submitted',
    });
  });

  it('computes sha256 for uploaded payment evidence bytes', () => {
    expect(buildPaymentEvidenceDocumentHash('ZmFrZS1wZGY=')).toBe('6d7927010ac13d634fa6db8eb3e6a6b6087a8088b988aa9fe954629810fffbc4');
  });

  it('accepts only allowed payment evidence preview and upload mime types', () => {
    expect(() => assertPaymentEvidenceUploadPolicy({
      fileName: '신분증.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      maxBytes: 12 * 1024 * 1024,
    })).not.toThrow();

    expect(assertPaymentEvidenceUploadPolicy({
      fileName: '신분증.JPG',
      mimeType: 'image/jpg',
      fileSize: 1024,
      contentBase64: '/9j/',
      maxBytes: 12 * 1024 * 1024,
    })).toMatchObject({ extension: 'jpg', mimeType: 'image/jpeg' });

    expect(assertPaymentEvidenceUploadPolicy({
      fileName: '통장사본.png',
      mimeType: 'application/octet-stream',
      fileSize: 1024,
      contentBase64: 'iVBORw0KGgo=',
      maxBytes: 12 * 1024 * 1024,
    })).toMatchObject({ extension: 'png', mimeType: 'image/png' });

    expect(() => assertPaymentEvidenceUploadPolicy({
      fileName: 'malware.html',
      mimeType: 'text/html',
      fileSize: 1024,
      maxBytes: 12 * 1024 * 1024,
    })).toThrow('허용되지 않는 파일');

    expect(() => assertPaymentEvidenceUploadPolicy({
      fileName: '신분증.jpg',
      mimeType: 'application/octet-stream',
      fileSize: 1024,
      contentBase64: 'PGh0bWw+',
      maxBytes: 12 * 1024 * 1024,
    })).toThrow('일치하지 않습니다');
  });

  it('blocks oversized payment evidence uploads', () => {
    expect(() => assertPaymentEvidenceUploadPolicy({
      fileName: 'large.pdf',
      mimeType: 'application/pdf',
      fileSize: 13 * 1024 * 1024,
      maxBytes: 12 * 1024 * 1024,
    })).toThrow('파일 크기');
  });
});
