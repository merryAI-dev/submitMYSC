export type PaymentEvidenceDocumentType = 'payment_confirmation' | 'id_card' | 'bankbook';

export type PaymentEvidenceFieldKey =
  | 'name'
  | 'affiliation'
  | 'resident_registration_number'
  | 'income_type'
  | 'amount'
  | 'bank'
  | 'account_number'
  | 'account_holder'
  | 'id_type'
  | 'signature_present'
  | 'signed_date';

export type PaymentEvidenceIssueSeverity = 'blocker' | 'warning' | 'info';
export type PaymentEvidenceCaseStatus = 'blocked' | 'needs_review' | 'ready_to_approve';
export type PaymentEvidenceRisk = 'high' | 'medium' | 'low';
export type PaymentEvidenceWorkflowStatus = 'draft' | 'sent' | 'submitted' | 'approved' | 'rejected' | 'closed';
export type PaymentEvidenceWorkflowAction = 'send_request' | 'mark_submitted' | 'approve' | 'reject' | 'close';

export interface PaymentEvidenceWorkflowEvent {
  id: string;
  action: PaymentEvidenceWorkflowAction;
  fromStatus: PaymentEvidenceWorkflowStatus;
  toStatus: PaymentEvidenceWorkflowStatus;
  actorName: string;
  at: string;
  note?: string;
}

export interface PaymentEvidenceDocument {
  id: string;
  type: PaymentEvidenceDocumentType;
  fileName: string;
  driveFileId?: string;
  webViewLink?: string;
  sha256?: string;
  mimeType?: string;
  fileSize?: number;
  source?: 'manual' | 'internal_upload' | 'external_upload' | string;
  uploadedAt?: string;
  extractedFields: Partial<Record<PaymentEvidenceFieldKey, string>>;
  validatedFields?: Partial<Record<PaymentEvidenceFieldKey, string>>;
  parserConfidence?: number;
}

export interface PaymentEvidenceCase {
  id: string;
  tenantId?: string;
  campaignId: string;
  campaignName: string;
  payeeName: string;
  recipientEmail?: string;
  requestSenderEmail?: string;
  requestReplyToEmail?: string;
  roleLabel?: string;
  expectedAmount: number;
  expectedIncomeType?: string;
  expectedPayDate?: string;
  reviewerName?: string;
  workflowStatus?: PaymentEvidenceWorkflowStatus;
  requestedAt?: string;
  submittedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedReason?: string;
  lastRejectedAt?: string;
  lastRejectionReason?: string;
  reissuedAt?: string;
  reissuedBy?: string;
  closedAt?: string;
  closedBy?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  submissionTokenId?: string;
  submissionLinkStatus?: 'active' | 'revoked' | 'used' | 'expired' | string;
  submissionLinkCreatedAt?: string;
  submissionLinkExpiresAt?: string;
  deliveryStatus?: 'PENDING' | 'SENT' | 'FAILED' | 'DRY_RUN' | string;
  deliveryLastSentAt?: string;
  deliverySubject?: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  deliveryError?: string | null;
  sheetSpreadsheetId?: string;
  sheetSyncStatus?: 'SYNCED' | 'FAILED' | 'PENDING';
  sheetLastSyncedAt?: string;
  workflowEvents?: PaymentEvidenceWorkflowEvent[];
  documents: PaymentEvidenceDocument[];
}

export interface PaymentEvidenceIssue {
  code: string;
  severity: PaymentEvidenceIssueSeverity;
  label: string;
  detail: string;
  documentType?: PaymentEvidenceDocumentType;
  fieldKey?: PaymentEvidenceFieldKey;
}

export interface PaymentEvidenceFieldComparison {
  key: PaymentEvidenceFieldKey;
  label: string;
  paymentValue?: string;
  idCardValue?: string;
  bankbookValue?: string;
  matched: boolean;
}

export interface PaymentEvidenceEvaluation {
  status: PaymentEvidenceCaseStatus;
  risk: PaymentEvidenceRisk;
  issues: PaymentEvidenceIssue[];
  missingDocumentTypes: PaymentEvidenceDocumentType[];
  fieldComparisons: PaymentEvidenceFieldComparison[];
  blockerCount: number;
  warningCount: number;
}

export interface PaymentEvidenceWorkflowActionSpec {
  action: PaymentEvidenceWorkflowAction;
  label: string;
  nextStatus: PaymentEvidenceWorkflowStatus;
  disabledReason?: string;
}

const REQUIRED_DOCUMENT_TYPES: PaymentEvidenceDocumentType[] = ['payment_confirmation', 'id_card', 'bankbook'];

export const PAYMENT_EVIDENCE_DOCUMENT_LABELS: Record<PaymentEvidenceDocumentType, string> = {
  payment_confirmation: '비용지급확인서',
  id_card: '신분증 사본',
  bankbook: '통장사본',
};

export const PAYMENT_EVIDENCE_FIELD_LABELS: Record<PaymentEvidenceFieldKey, string> = {
  name: '성명',
  affiliation: '소속',
  resident_registration_number: '주민등록번호',
  income_type: '소득구분',
  amount: '지급금액',
  bank: '은행',
  account_number: '계좌번호',
  account_holder: '예금주',
  id_type: '신분증 종류',
  signature_present: '서명 여부',
  signed_date: '서명일',
};

export const PAYMENT_EVIDENCE_WORKFLOW_LABELS: Record<PaymentEvidenceWorkflowStatus, string> = {
  draft: '요청 전',
  sent: '요청 발송',
  submitted: '제출 완료',
  approved: '승인',
  rejected: '반려',
  closed: '정본 완료',
};

export const PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS: Record<PaymentEvidenceWorkflowAction, string> = {
  send_request: '요청 발송',
  mark_submitted: '제출 완료 처리',
  approve: '승인',
  reject: '반려',
  close: '정본 close',
};

const REQUIRED_FIELDS_BY_DOCUMENT: Record<PaymentEvidenceDocumentType, PaymentEvidenceFieldKey[]> = {
  payment_confirmation: ['name', 'resident_registration_number', 'amount', 'bank', 'account_number', 'account_holder'],
  id_card: ['id_type', 'name', 'resident_registration_number'],
  bankbook: ['bank', 'account_number', 'account_holder'],
};

function normalizeWhitespace(value: unknown): string {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(value: unknown): string {
  return normalizeWhitespace(value).replace(/\s/g, '').replace(/님$/u, '').toLowerCase();
}

function normalizeDigitsAndMask(value: unknown): string {
  return normalizeWhitespace(value).replace(/[^\d*]/g, '');
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = normalizeWhitespace(value).replace(/[^\d.-]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDriveSegment(value: string, fallback: string): string {
  const cleaned = normalizeWhitespace(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function documentByType(paymentCase: PaymentEvidenceCase, type: PaymentEvidenceDocumentType) {
  return paymentCase.documents.find((document) => document.type === type);
}

function fieldValue(
  document: PaymentEvidenceDocument | undefined,
  fieldKey: PaymentEvidenceFieldKey,
): string {
  if (!document) return '';
  return normalizeWhitespace(document.validatedFields?.[fieldKey] || document.extractedFields[fieldKey] || '');
}

function hasValidatedField(document: PaymentEvidenceDocument, fieldKey: PaymentEvidenceFieldKey): boolean {
  return normalizeWhitespace(document.validatedFields?.[fieldKey] || '').length > 0;
}

function hasDraftField(document: PaymentEvidenceDocument, fieldKey: PaymentEvidenceFieldKey): boolean {
  return normalizeWhitespace(document.extractedFields[fieldKey] || '').length > 0;
}

function addIssue(issues: PaymentEvidenceIssue[], issue: PaymentEvidenceIssue) {
  issues.push(issue);
}

function compareText(valueA: string, valueB: string): boolean {
  if (!valueA || !valueB) return true;
  return normalizeComparableText(valueA) === normalizeComparableText(valueB);
}

function compareMaskedNumber(valueA: string, valueB: string): boolean {
  if (!valueA || !valueB) return true;
  return normalizeDigitsAndMask(valueA) === normalizeDigitsAndMask(valueB);
}

export function evaluatePaymentEvidenceCase(paymentCase: PaymentEvidenceCase): PaymentEvidenceEvaluation {
  const issues: PaymentEvidenceIssue[] = [];
  const presentTypes = new Set(paymentCase.documents.map((document) => document.type));
  const missingDocumentTypes = REQUIRED_DOCUMENT_TYPES.filter((type) => !presentTypes.has(type));

  missingDocumentTypes.forEach((type) => {
    addIssue(issues, {
      code: `missing_document:${type}`,
      severity: 'blocker',
      label: `${PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]} 누락`,
      detail: `${paymentCase.payeeName} 케이스에 ${PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]} 파일이 없습니다.`,
      documentType: type,
    });
  });

  paymentCase.documents.forEach((document) => {
    REQUIRED_FIELDS_BY_DOCUMENT[document.type].forEach((fieldKey) => {
      if (hasValidatedField(document, fieldKey)) return;
      if (hasDraftField(document, fieldKey)) {
        addIssue(issues, {
          code: `field_needs_review:${document.type}:${fieldKey}`,
          severity: 'warning',
          label: `${PAYMENT_EVIDENCE_DOCUMENT_LABELS[document.type]} ${PAYMENT_EVIDENCE_FIELD_LABELS[fieldKey]} 검수 필요`,
          detail: '모델 추출값은 있으나 사람이 확정한 값이 없습니다.',
          documentType: document.type,
          fieldKey,
        });
        return;
      }

      addIssue(issues, {
        code: `missing_field:${document.type}:${fieldKey}`,
        severity: 'warning',
        label: `${PAYMENT_EVIDENCE_DOCUMENT_LABELS[document.type]} ${PAYMENT_EVIDENCE_FIELD_LABELS[fieldKey]} 누락`,
        detail: '필수 필드가 비어 있어 검수자가 원문을 확인해야 합니다.',
        documentType: document.type,
        fieldKey,
      });
    });
  });

  const paymentDocument = documentByType(paymentCase, 'payment_confirmation');
  const idCardDocument = documentByType(paymentCase, 'id_card');
  const bankbookDocument = documentByType(paymentCase, 'bankbook');

  const paymentName = fieldValue(paymentDocument, 'name');
  const idName = fieldValue(idCardDocument, 'name');
  if (!compareText(paymentName, idName)) {
    addIssue(issues, {
      code: 'name_mismatch',
      severity: 'blocker',
      label: '성명 불일치',
      detail: `비용지급확인서 성명(${paymentName})과 신분증 성명(${idName})이 다릅니다.`,
      fieldKey: 'name',
    });
  }

  const paymentRrn = fieldValue(paymentDocument, 'resident_registration_number');
  const idRrn = fieldValue(idCardDocument, 'resident_registration_number');
  if (!compareMaskedNumber(paymentRrn, idRrn)) {
    addIssue(issues, {
      code: 'rrn_mismatch',
      severity: 'blocker',
      label: '주민등록번호 불일치',
      detail: '비용지급확인서와 신분증의 주민등록번호가 일치하지 않습니다.',
      fieldKey: 'resident_registration_number',
    });
  }

  const paymentAccountNumber = fieldValue(paymentDocument, 'account_number');
  const bankbookAccountNumber = fieldValue(bankbookDocument, 'account_number');
  if (!compareMaskedNumber(paymentAccountNumber, bankbookAccountNumber)) {
    addIssue(issues, {
      code: 'account_number_mismatch',
      severity: 'blocker',
      label: '계좌번호 불일치',
      detail: '비용지급확인서 계좌번호와 통장사본 계좌번호가 다릅니다.',
      fieldKey: 'account_number',
    });
  }

  const paymentAccountHolder = fieldValue(paymentDocument, 'account_holder');
  const bankbookAccountHolder = fieldValue(bankbookDocument, 'account_holder');
  if (!compareText(paymentAccountHolder, bankbookAccountHolder)) {
    addIssue(issues, {
      code: 'account_holder_mismatch',
      severity: 'blocker',
      label: '예금주 불일치',
      detail: `비용지급확인서 예금주(${paymentAccountHolder})와 통장사본 예금주(${bankbookAccountHolder})가 다릅니다.`,
      fieldKey: 'account_holder',
    });
  }

  const paymentAmount = parseAmount(fieldValue(paymentDocument, 'amount'));
  if (paymentAmount !== null && paymentAmount !== paymentCase.expectedAmount) {
    addIssue(issues, {
      code: 'amount_mismatch',
      severity: 'blocker',
      label: '지급금액 불일치',
      detail: `예상 지급액 ${paymentCase.expectedAmount.toLocaleString()}원과 확인서 금액 ${paymentAmount.toLocaleString()}원이 다릅니다.`,
      fieldKey: 'amount',
    });
  }

  const blockerCount = issues.filter((issue) => issue.severity === 'blocker').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    status: blockerCount > 0 ? 'blocked' : warningCount > 0 ? 'needs_review' : 'ready_to_approve',
    risk: blockerCount > 0 ? 'high' : warningCount > 0 ? 'medium' : 'low',
    issues,
    missingDocumentTypes,
    fieldComparisons: [
      {
        key: 'name',
        label: PAYMENT_EVIDENCE_FIELD_LABELS.name,
        paymentValue: paymentName,
        idCardValue: idName,
        matched: compareText(paymentName, idName),
      },
      {
        key: 'resident_registration_number',
        label: PAYMENT_EVIDENCE_FIELD_LABELS.resident_registration_number,
        paymentValue: paymentRrn,
        idCardValue: idRrn,
        matched: compareMaskedNumber(paymentRrn, idRrn),
      },
      {
        key: 'account_number',
        label: PAYMENT_EVIDENCE_FIELD_LABELS.account_number,
        paymentValue: paymentAccountNumber,
        bankbookValue: bankbookAccountNumber,
        matched: compareMaskedNumber(paymentAccountNumber, bankbookAccountNumber),
      },
      {
        key: 'account_holder',
        label: PAYMENT_EVIDENCE_FIELD_LABELS.account_holder,
        paymentValue: paymentAccountHolder,
        bankbookValue: bankbookAccountHolder,
        matched: compareText(paymentAccountHolder, bankbookAccountHolder),
      },
    ],
    blockerCount,
    warningCount,
  };
}

export function buildPaymentEvidenceDrivePath(paymentCase: PaymentEvidenceCase): string[] {
  const year = (paymentCase.expectedPayDate || new Date().toISOString()).slice(0, 4);
  return [
    '지급증빙_정본',
    year,
    sanitizeDriveSegment(paymentCase.campaignName, paymentCase.campaignId),
    `${sanitizeDriveSegment(paymentCase.id, 'case')}_${sanitizeDriveSegment(paymentCase.payeeName, 'payee')}`,
  ];
}

export function buildPaymentEvidenceSheetRows(paymentCase: PaymentEvidenceCase) {
  const evaluation = evaluatePaymentEvidenceCase(paymentCase);
  const drivePath = buildPaymentEvidenceDrivePath(paymentCase).join('/');
  const workflowStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);

  const cases = [{
    case_id: paymentCase.id,
    campaign_id: paymentCase.campaignId,
    campaign_name: paymentCase.campaignName,
    payee_name: paymentCase.payeeName,
    role_label: paymentCase.roleLabel || '',
    expected_amount: paymentCase.expectedAmount,
    expected_pay_date: paymentCase.expectedPayDate || '',
    status: evaluation.status,
    risk: evaluation.risk,
    workflow_status: workflowStatus,
    issue_count: evaluation.issues.length,
    blocker_count: evaluation.blockerCount,
    warning_count: evaluation.warningCount,
    requested_at: paymentCase.requestedAt || '',
    submitted_at: paymentCase.submittedAt || '',
    approved_at: paymentCase.approvedAt || '',
    closed_at: paymentCase.closedAt || '',
    drive_path: drivePath,
  }];

  const documents = paymentCase.documents.map((document) => ({
    case_id: paymentCase.id,
    document_id: document.id,
    document_type: document.type,
    document_label: PAYMENT_EVIDENCE_DOCUMENT_LABELS[document.type],
    file_name: document.fileName,
    drive_file_id: document.driveFileId || '',
    sha256: document.sha256 || '',
    parser_confidence: document.parserConfidence ?? '',
  }));

  const fields = paymentCase.documents.flatMap((document) => {
    const keys = Array.from(new Set([
      ...Object.keys(document.extractedFields),
      ...Object.keys(document.validatedFields || {}),
    ])) as PaymentEvidenceFieldKey[];

    return keys.map((key) => ({
      case_id: paymentCase.id,
      document_id: document.id,
      document_type: document.type,
      field_key: key,
      field_label: PAYMENT_EVIDENCE_FIELD_LABELS[key],
      extracted_value: document.extractedFields[key] || '',
      validated_value: document.validatedFields?.[key] || '',
      review_state: document.validatedFields?.[key] ? 'validated' : 'model_draft',
    }));
  });

  const paymentDocument = documentByType(paymentCase, 'payment_confirmation');
  const payments = evaluation.status === 'ready_to_approve'
    && (workflowStatus === 'approved' || workflowStatus === 'closed')
    ? [{
      case_id: paymentCase.id,
      payee_name: paymentCase.payeeName,
      amount: paymentCase.expectedAmount,
      bank: fieldValue(paymentDocument, 'bank'),
      account_number: fieldValue(paymentDocument, 'account_number'),
      account_holder: fieldValue(paymentDocument, 'account_holder'),
      pay_date: paymentCase.expectedPayDate || '',
      workflow_status: workflowStatus,
      source_drive_path: drivePath,
    }]
    : [];

  const events = (paymentCase.workflowEvents || []).map((event) => ({
    case_id: paymentCase.id,
    event_id: event.id,
    action: event.action,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    actor_name: event.actorName,
    at: event.at,
    note: event.note || '',
  }));

  return { cases, documents, fields, payments, events };
}

export function resolvePaymentEvidenceWorkflowStatus(paymentCase: PaymentEvidenceCase): PaymentEvidenceWorkflowStatus {
  return paymentCase.workflowStatus || 'draft';
}

export function getPaymentEvidenceWorkflowActionSpecs(paymentCase: PaymentEvidenceCase): PaymentEvidenceWorkflowActionSpec[] {
  const workflowStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
  const evaluation = evaluatePaymentEvidenceCase(paymentCase);

  if (workflowStatus === 'draft') {
    return [{ action: 'send_request', label: PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS.send_request, nextStatus: 'sent' }];
  }

  if (workflowStatus === 'sent') {
    return [{ action: 'mark_submitted', label: PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS.mark_submitted, nextStatus: 'submitted' }];
  }

  if (workflowStatus === 'submitted') {
    return [
      {
        action: 'approve',
        label: PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS.approve,
        nextStatus: 'approved',
        disabledReason: evaluation.status === 'ready_to_approve'
          ? undefined
          : '차단/검수 이슈가 남아 승인할 수 없습니다.',
      },
      { action: 'reject', label: PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS.reject, nextStatus: 'rejected' },
    ];
  }

  if (workflowStatus === 'approved') {
    return [{
      action: 'close',
      label: PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS.close,
      nextStatus: 'closed',
      disabledReason: evaluation.status === 'ready_to_approve'
        ? undefined
        : '정본 close 전 차단/검수 이슈를 먼저 해소해야 합니다.',
    }];
  }

  if (workflowStatus === 'rejected') {
    return [{ action: 'send_request', label: '재요청 발송', nextStatus: 'sent' }];
  }

  return [];
}

export function applyPaymentEvidenceWorkflowAction(
  paymentCase: PaymentEvidenceCase,
  action: PaymentEvidenceWorkflowAction,
  actorName: string,
  at: string,
  note?: string,
): PaymentEvidenceCase {
  const currentStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
  const spec = getPaymentEvidenceWorkflowActionSpecs(paymentCase).find((candidate) => candidate.action === action);
  if (!spec) {
    throw new Error(`${PAYMENT_EVIDENCE_WORKFLOW_LABELS[currentStatus]} 상태에서는 ${PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS[action]}을 처리할 수 없습니다.`);
  }
  if (spec.disabledReason) {
    throw new Error(spec.disabledReason);
  }

  const event: PaymentEvidenceWorkflowEvent = {
    id: `${paymentCase.id}-${action}-${at}`,
    action,
    fromStatus: currentStatus,
    toStatus: spec.nextStatus,
    actorName,
    at,
    note: normalizeWhitespace(note),
  };

  const updates: Partial<PaymentEvidenceCase> = {
    workflowStatus: spec.nextStatus,
    workflowEvents: [...(paymentCase.workflowEvents || []), event],
  };

  if (action === 'send_request') {
    updates.requestedAt = at;
    updates.rejectedReason = undefined;
    updates.rejectedAt = undefined;
  } else if (action === 'mark_submitted') {
    updates.submittedAt = at;
  } else if (action === 'approve') {
    updates.approvedAt = at;
    updates.approvedBy = actorName;
  } else if (action === 'reject') {
    updates.rejectedAt = at;
    updates.rejectedReason = normalizeWhitespace(note);
  } else if (action === 'close') {
    updates.closedAt = at;
    updates.closedBy = actorName;
  }

  return { ...paymentCase, ...updates };
}
