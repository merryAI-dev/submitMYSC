import { describe, expect, it } from 'vitest';
import {
  applyPaymentEvidenceWorkflowAction,
  buildPaymentEvidenceDrivePath,
  buildPaymentEvidenceSheetRows,
  evaluatePaymentEvidenceCase,
  getPaymentEvidenceWorkflowActionSpecs,
  type PaymentEvidenceCase,
} from './payment-evidence';

const baseCase: PaymentEvidenceCase = {
  id: 'PAY-202605-0001',
  campaignId: 'camp-industrial-hackathon',
  campaignName: '산업단지 정책 해커톤',
  payeeName: '김민수',
  roleLabel: '퍼실리테이터',
  expectedAmount: 300000,
  expectedIncomeType: '기타소득',
  expectedPayDate: '2026-05-20',
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

describe('evaluatePaymentEvidenceCase', () => {
  it('marks a complete matching bundle ready to approve', () => {
    const result = evaluatePaymentEvidenceCase(baseCase);

    expect(result.status).toBe('ready_to_approve');
    expect(result.risk).toBe('low');
    expect(result.blockerCount).toBe(0);
    expect(result.missingDocumentTypes).toEqual([]);
  });

  it('blocks cross-document resident number and account mismatches', () => {
    const result = evaluatePaymentEvidenceCase({
      ...baseCase,
      documents: baseCase.documents.map((doc) => {
        if (doc.type === 'id_card') {
          return {
            ...doc,
            validatedFields: {
              ...doc.validatedFields,
              resident_registration_number: '850505-2******',
            },
          };
        }

        if (doc.type === 'bankbook') {
          return {
            ...doc,
            validatedFields: {
              ...doc.validatedFields,
              account_number: '333-***-999999',
            },
          };
        }

        return doc;
      }),
    });

    expect(result.status).toBe('blocked');
    expect(result.risk).toBe('high');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['rrn_mismatch', 'account_number_mismatch']),
    );
  });

  it('blocks a case when a required document is missing', () => {
    const result = evaluatePaymentEvidenceCase({
      ...baseCase,
      documents: baseCase.documents.filter((doc) => doc.type !== 'bankbook'),
    });

    expect(result.status).toBe('blocked');
    expect(result.missingDocumentTypes).toEqual(['bankbook']);
    expect(result.issues.map((issue) => issue.code)).toContain('missing_document:bankbook');
  });

  it('requires human review when fields are model drafts only', () => {
    const result = evaluatePaymentEvidenceCase({
      ...baseCase,
      documents: baseCase.documents.map((doc) => ({
        ...doc,
        extractedFields: doc.validatedFields || {},
        validatedFields: {},
      })),
    });

    expect(result.status).toBe('needs_review');
    expect(result.risk).toBe('medium');
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain('field_needs_review:payment_confirmation:name');
  });
});

describe('buildPaymentEvidenceDrivePath', () => {
  it('creates stable Google Drive folder segments without unsafe characters', () => {
    expect(buildPaymentEvidenceDrivePath({
      ...baseCase,
      campaignName: '산업단지/정책:해커톤',
    })).toEqual([
      '지급증빙_정본',
      '2026',
      '산업단지_정책_해커톤',
      'PAY-202605-0001_김민수',
    ]);
  });
});

describe('buildPaymentEvidenceSheetRows', () => {
  it('projects cases, documents, fields, and workflow rows for Google Sheets', () => {
    const rows = buildPaymentEvidenceSheetRows(baseCase);

    expect(rows.cases[0]).toMatchObject({
      case_id: 'PAY-202605-0001',
      status: 'ready_to_approve',
      risk: 'low',
      workflow_status: 'draft',
      expected_amount: 300000,
    });
    expect(rows.documents).toHaveLength(3);
    expect(rows.fields.some((row) => row.field_key === 'account_number' && row.document_type === 'bankbook')).toBe(true);
    expect(rows.payments).toHaveLength(0);
    expect(rows.events).toHaveLength(0);
  });

  it('projects payment rows only after approval or close', () => {
    const approvedCase = {
      ...baseCase,
      workflowStatus: 'approved' as const,
      approvedAt: '2026-05-07T00:00:00.000Z',
      approvedBy: '재무팀',
    };
    const rows = buildPaymentEvidenceSheetRows(approvedCase);

    expect(rows.payments).toHaveLength(1);
    expect(rows.payments[0]).toMatchObject({
      case_id: 'PAY-202605-0001',
      payee_name: '김민수',
      amount: 300000,
      bank: '신한은행',
    });
  });
});

describe('payment evidence workflow', () => {
  it('runs request, submit, approve, and close transitions with audit events', () => {
    const sent = applyPaymentEvidenceWorkflowAction(baseCase, 'send_request', '재무팀', '2026-05-07T01:00:00.000Z', '요청 발송');
    const submitted = applyPaymentEvidenceWorkflowAction(sent, 'mark_submitted', '수령자', '2026-05-07T02:00:00.000Z');
    const approved = applyPaymentEvidenceWorkflowAction(submitted, 'approve', '재무팀', '2026-05-07T03:00:00.000Z');
    const closed = applyPaymentEvidenceWorkflowAction(approved, 'close', '재무팀', '2026-05-07T04:00:00.000Z');

    expect(closed.workflowStatus).toBe('closed');
    expect(closed.requestedAt).toBe('2026-05-07T01:00:00.000Z');
    expect(closed.submittedAt).toBe('2026-05-07T02:00:00.000Z');
    expect(closed.approvedAt).toBe('2026-05-07T03:00:00.000Z');
    expect(closed.closedAt).toBe('2026-05-07T04:00:00.000Z');
    expect(closed.workflowEvents?.map((event) => event.action)).toEqual([
      'send_request',
      'mark_submitted',
      'approve',
      'close',
    ]);
  });

  it('does not approve blocked submissions', () => {
    const blockedCase: PaymentEvidenceCase = {
      ...baseCase,
      workflowStatus: 'submitted',
      documents: baseCase.documents.filter((doc) => doc.type !== 'bankbook'),
    };

    const approveAction = getPaymentEvidenceWorkflowActionSpecs(blockedCase)
      .find((spec) => spec.action === 'approve');

    expect(approveAction?.disabledReason).toContain('승인할 수 없습니다');
    expect(() => applyPaymentEvidenceWorkflowAction(blockedCase, 'approve', '재무팀', '2026-05-07T01:00:00.000Z')).toThrow('승인할 수 없습니다');
  });
});
