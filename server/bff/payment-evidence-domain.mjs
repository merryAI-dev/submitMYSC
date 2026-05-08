import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const PAYMENT_EVIDENCE_DOCUMENT_TYPES = ['payment_confirmation', 'id_card', 'bankbook'];
export const PAYMENT_EVIDENCE_WORKFLOW_STATUSES = ['draft', 'sent', 'submitted', 'approved', 'rejected', 'closed'];
export const PAYMENT_EVIDENCE_WORKFLOW_ACTIONS = ['send_request', 'mark_submitted', 'approve', 'reject', 'close'];
export const PAYMENT_EVIDENCE_SUBMISSION_TOKEN_DEFAULT_EXPIRES_IN_DAYS = 14;
export const PAYMENT_EVIDENCE_DEFAULT_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const PAYMENT_EVIDENCE_ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/octet-stream',
];

export const PAYMENT_EVIDENCE_DOCUMENT_LABELS = {
  payment_confirmation: '비용지급확인서',
  id_card: '신분증 사본',
  bankbook: '통장사본',
};

export const PAYMENT_EVIDENCE_FIELD_LABELS = {
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

export const PAYMENT_EVIDENCE_WORKFLOW_LABELS = {
  draft: '요청 전',
  sent: '요청 발송',
  submitted: '제출 완료',
  approved: '승인',
  rejected: '반려',
  closed: '정본 완료',
};

export const PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS = {
  send_request: '요청 발송',
  mark_submitted: '제출 완료 처리',
  approve: '승인',
  reject: '반려',
  close: '정본 close',
};

const REQUIRED_FIELDS_BY_DOCUMENT = {
  payment_confirmation: ['name', 'resident_registration_number', 'amount', 'bank', 'account_number', 'account_holder'],
  id_card: ['id_type', 'name', 'resident_registration_number'],
  bankbook: ['bank', 'account_number', 'account_holder'],
};

function normalizeWhitespace(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function fileExtension(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  const match = normalized.match(/\.([a-z0-9]{1,12})$/);
  return match ? match[1] : '';
}

const UPLOAD_FILE_TYPES = {
  pdf: {
    mimeType: 'application/pdf',
    mimeAliases: ['application/pdf', 'application/octet-stream'],
    magic: (buffer) => buffer.subarray(0, 4).toString('utf8') === '%PDF',
  },
  jpg: {
    mimeType: 'image/jpeg',
    mimeAliases: ['image/jpeg', 'image/jpg', 'image/pjpeg', 'application/octet-stream'],
    magic: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  jpeg: {
    mimeType: 'image/jpeg',
    mimeAliases: ['image/jpeg', 'image/jpg', 'image/pjpeg', 'application/octet-stream'],
    magic: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  png: {
    mimeType: 'image/png',
    mimeAliases: ['image/png', 'image/x-png', 'application/octet-stream'],
    magic: (buffer) => buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a,
  },
  webp: {
    mimeType: 'image/webp',
    mimeAliases: ['image/webp', 'application/octet-stream'],
    magic: (buffer) => buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  heic: {
    mimeType: 'image/heic',
    mimeAliases: ['image/heic', 'image/heif', 'application/octet-stream'],
    magic: (buffer) => {
      if (buffer.length < 12) return false;
      const box = buffer.subarray(4, 8).toString('ascii');
      const brand = buffer.subarray(8, 12).toString('ascii');
      return box === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    },
  },
  heif: {
    mimeType: 'image/heif',
    mimeAliases: ['image/heif', 'image/heic', 'application/octet-stream'],
    magic: (buffer) => {
      if (buffer.length < 12) return false;
      const box = buffer.subarray(4, 8).toString('ascii');
      const brand = buffer.subarray(8, 12).toString('ascii');
      return box === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    },
  },
};

function decodeBase64Content(contentBase64) {
  const normalized = normalizeWhitespace(contentBase64);
  if (!normalized) return null;
  try {
    const buffer = Buffer.from(normalized, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

export function normalizePaymentEvidenceUploadMimeType({ fileName, mimeType, contentBase64 } = {}) {
  const extension = fileExtension(fileName);
  const spec = UPLOAD_FILE_TYPES[extension];
  const normalizedMimeType = normalizeWhitespace(mimeType).toLowerCase();

  if (!spec) {
    throw new Error('허용되지 않는 파일 확장자입니다. PDF, JPG, PNG, WEBP, HEIC 파일만 업로드할 수 있습니다.');
  }

  if (!spec.mimeAliases.includes(normalizedMimeType)) {
    throw new Error('허용되지 않는 파일 형식입니다. PDF, JPG, PNG, WEBP, HEIC 파일만 업로드할 수 있습니다.');
  }

  const buffer = decodeBase64Content(contentBase64);
  if (buffer && !spec.magic(buffer)) {
    throw new Error('파일 내용과 확장자/MIME 형식이 일치하지 않습니다.');
  }

  if (normalizedMimeType === 'application/octet-stream' && !buffer) {
    throw new Error('파일 형식을 확인할 수 없습니다. PDF, JPG, PNG, WEBP, HEIC 파일만 업로드할 수 있습니다.');
  }

  return {
    extension,
    mimeType: spec.mimeType,
  };
}

function addDaysIso(timestamp, days) {
  const date = new Date(timestamp);
  const safeDays = Number.isInteger(days) && days > 0 ? days : PAYMENT_EVIDENCE_SUBMISSION_TOKEN_DEFAULT_EXPIRES_IN_DAYS;
  return new Date(date.getTime() + (safeDays * 24 * 60 * 60 * 1000)).toISOString();
}

function buildTokenId() {
  return `petok_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
}

function buildTokenSecret() {
  return randomBytes(32).toString('base64url');
}

function normalizeComparableText(value) {
  return normalizeWhitespace(value).replace(/\s/g, '').replace(/님$/u, '').toLowerCase();
}

function normalizeDigitsAndMask(value) {
  return normalizeWhitespace(value).replace(/[^\d*]/g, '');
}

function parseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = normalizeWhitespace(value).replace(/[^\d.-]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDriveSegment(value, fallback) {
  const cleaned = normalizeWhitespace(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function documentByType(paymentCase, type) {
  return Array.isArray(paymentCase?.documents)
    ? paymentCase.documents.find((document) => document?.type === type)
    : undefined;
}

function hasAllRequiredDocuments(paymentCase) {
  const presentTypes = new Set((paymentCase?.documents || []).map((document) => document?.type));
  return PAYMENT_EVIDENCE_DOCUMENT_TYPES.every((type) => presentTypes.has(type));
}

function fieldValue(document, fieldKey) {
  if (!document) return '';
  return normalizeWhitespace(document.validatedFields?.[fieldKey] || document.extractedFields?.[fieldKey] || '');
}

function hasValidatedField(document, fieldKey) {
  return normalizeWhitespace(document?.validatedFields?.[fieldKey] || '').length > 0;
}

function hasDraftField(document, fieldKey) {
  return normalizeWhitespace(document?.extractedFields?.[fieldKey] || '').length > 0;
}

function compareText(valueA, valueB) {
  if (!valueA || !valueB) return true;
  return normalizeComparableText(valueA) === normalizeComparableText(valueB);
}

function compareMaskedNumber(valueA, valueB) {
  if (!valueA || !valueB) return true;
  return normalizeDigitsAndMask(valueA) === normalizeDigitsAndMask(valueB);
}

function addIssue(issues, issue) {
  issues.push(issue);
}

export function evaluatePaymentEvidenceCase(paymentCase) {
  const documents = Array.isArray(paymentCase?.documents) ? paymentCase.documents : [];
  const issues = [];
  const presentTypes = new Set(documents.map((document) => document.type));
  const missingDocumentTypes = PAYMENT_EVIDENCE_DOCUMENT_TYPES.filter((type) => !presentTypes.has(type));

  missingDocumentTypes.forEach((type) => {
    addIssue(issues, {
      code: `missing_document:${type}`,
      severity: 'blocker',
      label: `${PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]} 누락`,
      detail: `${paymentCase.payeeName} 케이스에 ${PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]} 파일이 없습니다.`,
      documentType: type,
    });
  });

  documents.forEach((document) => {
    const requiredFields = REQUIRED_FIELDS_BY_DOCUMENT[document.type] || [];
    requiredFields.forEach((fieldKey) => {
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
      detail: `예상 지급액 ${Number(paymentCase.expectedAmount || 0).toLocaleString()}원과 확인서 금액 ${paymentAmount.toLocaleString()}원이 다릅니다.`,
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

export function hashPaymentEvidenceSubmissionToken(rawToken) {
  const normalized = normalizeWhitespace(rawToken);
  if (!normalized) throw new Error('submission token is required');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function buildPaymentEvidenceDocumentHash(contentBase64) {
  const buffer = Buffer.from(normalizeWhitespace(contentBase64), 'base64');
  if (!buffer.length) throw new Error('파일 내용이 비어 있습니다.');
  return createHash('sha256').update(buffer).digest('hex');
}

export function assertPaymentEvidenceUploadPolicy({
  fileName,
  mimeType,
  fileSize,
  contentBase64,
  maxBytes = PAYMENT_EVIDENCE_DEFAULT_MAX_UPLOAD_BYTES,
}) {
  const normalizedFileName = normalizeWhitespace(fileName);
  const normalizedFileSize = Number(fileSize);
  const normalizedMaxBytes = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes)
    : PAYMENT_EVIDENCE_DEFAULT_MAX_UPLOAD_BYTES;

  if (!normalizedFileName) {
    throw new Error('파일명이 필요합니다.');
  }
  const normalizedUpload = normalizePaymentEvidenceUploadMimeType({
    fileName: normalizedFileName,
    mimeType,
    contentBase64,
  });
  if (!Number.isInteger(normalizedFileSize) || normalizedFileSize <= 0) {
    throw new Error('파일 크기가 올바르지 않습니다.');
  }
  if (normalizedFileSize > normalizedMaxBytes) {
    throw new Error(`파일 크기는 ${Math.floor(normalizedMaxBytes / 1024 / 1024)}MB 이하여야 합니다.`);
  }
  return normalizedUpload;
}

export function createPaymentEvidenceSubmissionToken({
  tenantId,
  caseId,
  tokenId = buildTokenId(),
  secret = buildTokenSecret(),
  createdBy,
  createdAt = new Date().toISOString(),
  expiresInDays = PAYMENT_EVIDENCE_SUBMISSION_TOKEN_DEFAULT_EXPIRES_IN_DAYS,
} = {}) {
  const normalizedTenantId = normalizeWhitespace(tenantId);
  const normalizedCaseId = normalizeWhitespace(caseId);
  const normalizedTokenId = normalizeWhitespace(tokenId);
  const normalizedSecret = normalizeWhitespace(secret);
  if (!normalizedTenantId) throw new Error('tenantId is required');
  if (!normalizedCaseId) throw new Error('caseId is required');
  if (!normalizedTokenId) throw new Error('tokenId is required');
  if (!normalizedSecret) throw new Error('token secret is required');

  const rawToken = `${normalizedTokenId}.${normalizedSecret}`;
  const tokenRecord = {
    id: normalizedTokenId,
    tenantId: normalizedTenantId,
    caseId: normalizedCaseId,
    tokenHash: hashPaymentEvidenceSubmissionToken(rawToken),
    status: 'active',
    createdBy: normalizeWhitespace(createdBy) || undefined,
    createdAt,
    expiresAt: addDaysIso(createdAt, expiresInDays),
    attemptCount: 0,
  };

  return {
    rawToken,
    tokenRecord,
  };
}

export function resolvePaymentEvidenceSubmissionTokenState(tokenRecord, now = new Date().toISOString()) {
  if (!tokenRecord) return { usable: false, status: 'not_found', reason: '제출 링크를 찾을 수 없습니다.' };
  if (tokenRecord.revokedAt || tokenRecord.status === 'revoked') {
    return { usable: false, status: 'revoked', reason: '폐기된 제출 링크입니다.' };
  }
  if (tokenRecord.expiresAt && tokenRecord.expiresAt <= now) {
    return { usable: false, status: 'expired', reason: '만료된 제출 링크입니다.' };
  }
  if (tokenRecord.usedAt || tokenRecord.status === 'used') {
    return { usable: false, status: 'used', reason: '이미 제출 완료된 링크입니다.' };
  }
  return { usable: true, status: 'active', reason: '' };
}

export function buildPaymentEvidencePublicSubmission({
  paymentCase,
  tokenRecord,
  now = new Date().toISOString(),
} = {}) {
  const tokenState = resolvePaymentEvidenceSubmissionTokenState(tokenRecord, now);
  const documentsByType = new Map((paymentCase?.documents || []).map((document) => [document.type, document]));
  const workflowStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
  const requiredDocuments = PAYMENT_EVIDENCE_DOCUMENT_TYPES.map((type) => {
    const document = documentsByType.get(type);
    return {
      type,
      label: PAYMENT_EVIDENCE_DOCUMENT_LABELS[type],
      uploaded: Boolean(document),
      fileName: document?.fileName || '',
    };
  });

  return {
    token: {
      id: tokenRecord?.id || '',
      status: tokenState.status,
      usable: tokenState.usable,
      reason: tokenState.reason,
      expiresAt: tokenRecord?.expiresAt || null,
    },
    case: {
      id: paymentCase.id,
      campaignName: paymentCase.campaignName,
      payeeName: paymentCase.payeeName,
      roleLabel: paymentCase.roleLabel || undefined,
      expectedAmount: paymentCase.expectedAmount,
      expectedIncomeType: paymentCase.expectedIncomeType || undefined,
      expectedPayDate: paymentCase.expectedPayDate || undefined,
      workflowStatus,
    },
    requiredDocuments,
    complete: requiredDocuments.every((document) => document.uploaded),
  };
}

export function buildPaymentEvidenceDrivePath(paymentCase) {
  const year = (paymentCase.expectedPayDate || new Date().toISOString()).slice(0, 4);
  return [
    '지급증빙_정본',
    year,
    sanitizeDriveSegment(paymentCase.campaignName, paymentCase.campaignId),
    `${sanitizeDriveSegment(paymentCase.id, 'case')}_${sanitizeDriveSegment(paymentCase.payeeName, 'payee')}`,
  ];
}

export function resolvePaymentEvidenceWorkflowStatus(paymentCase) {
  return PAYMENT_EVIDENCE_WORKFLOW_STATUSES.includes(paymentCase?.workflowStatus)
    ? paymentCase.workflowStatus
    : 'draft';
}

export function getPaymentEvidenceWorkflowActionSpecs(paymentCase) {
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

export function applyPaymentEvidenceWorkflowAction({
  paymentCase,
  action,
  actorName,
  at,
  note,
}) {
  const currentStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
  const normalizedNote = normalizeWhitespace(note);
  if (action === 'reject' && !normalizedNote) {
    throw new Error('반려 사유를 입력해야 합니다.');
  }

  const spec = getPaymentEvidenceWorkflowActionSpecs(paymentCase)
    .find((candidate) => candidate.action === action);
  if (!spec) {
    throw new Error(`${PAYMENT_EVIDENCE_WORKFLOW_LABELS[currentStatus]} 상태에서는 ${PAYMENT_EVIDENCE_WORKFLOW_ACTION_LABELS[action]}을 처리할 수 없습니다.`);
  }
  if (spec.disabledReason) {
    throw new Error(spec.disabledReason);
  }

  const event = {
    id: `${paymentCase.id}-${action}-${at}`,
    action,
    fromStatus: currentStatus,
    toStatus: spec.nextStatus,
    actorName: normalizeWhitespace(actorName) || 'system',
    at,
    note: normalizedNote,
  };

  const updates = {
    workflowStatus: spec.nextStatus,
    workflowEvents: [...(Array.isArray(paymentCase.workflowEvents) ? paymentCase.workflowEvents : []), event],
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
    updates.rejectedReason = normalizedNote;
  } else if (action === 'close') {
    updates.closedAt = at;
    updates.closedBy = actorName;
  }

  return { ...paymentCase, ...updates };
}

export function applyPaymentEvidenceRejectAndReissue({
  paymentCase,
  actorName,
  at,
  reason,
}) {
  const normalizedReason = normalizeWhitespace(reason);
  if (!normalizedReason) throw new Error('반려 사유를 입력해야 합니다.');

  const rejected = applyPaymentEvidenceWorkflowAction({
    paymentCase,
    action: 'reject',
    actorName,
    at,
    note: normalizedReason,
  });
  const reissued = applyPaymentEvidenceWorkflowAction({
    paymentCase: rejected,
    action: 'send_request',
    actorName,
    at,
    note: '반려 후 재요청',
  });

  return {
    ...reissued,
    rejectedAt: at,
    rejectedReason: normalizedReason,
    lastRejectedAt: at,
    lastRejectionReason: normalizedReason,
    reissuedAt: at,
    reissuedBy: normalizeWhitespace(actorName) || 'system',
  };
}

export function applyPaymentEvidenceExternalSubmissionDocument({
  paymentCase,
  document,
  actorName,
  at,
}) {
  const nextDocument = {
    ...document,
    source: 'external_upload',
    uploadedAt: at,
  };
  const documents = Array.isArray(paymentCase.documents) ? [...paymentCase.documents] : [];
  const existingIndex = documents.findIndex((candidate) => candidate.id === nextDocument.id || candidate.type === nextDocument.type);
  if (existingIndex >= 0) {
    documents[existingIndex] = { ...documents[existingIndex], ...nextDocument };
  } else {
    documents.push(nextDocument);
  }

  const withDocument = {
    ...paymentCase,
    documents,
  };

  if (resolvePaymentEvidenceWorkflowStatus(withDocument) !== 'sent' || !hasAllRequiredDocuments(withDocument)) {
    return {
      paymentCase: withDocument,
      autoSubmitted: false,
    };
  }

  return {
    paymentCase: applyPaymentEvidenceWorkflowAction({
      paymentCase: withDocument,
      action: 'mark_submitted',
      actorName,
      at,
      note: '외부 제출 링크로 필수 문서 3종 업로드 완료',
    }),
    autoSubmitted: true,
  };
}

export function buildPaymentEvidenceSheetRows(paymentCase) {
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

  const documents = (paymentCase.documents || []).map((document) => ({
    case_id: paymentCase.id,
    document_id: document.id,
    document_type: document.type,
    document_label: PAYMENT_EVIDENCE_DOCUMENT_LABELS[document.type],
    file_name: document.fileName,
    drive_file_id: document.driveFileId || '',
    sha256: document.sha256 || '',
    parser_confidence: document.parserConfidence ?? '',
  }));

  const fields = (paymentCase.documents || []).flatMap((document) => {
    const keys = Array.from(new Set([
      ...Object.keys(document.extractedFields || {}),
      ...Object.keys(document.validatedFields || {}),
    ]));

    return keys.map((key) => ({
      case_id: paymentCase.id,
      document_id: document.id,
      document_type: document.type,
      field_key: key,
      field_label: PAYMENT_EVIDENCE_FIELD_LABELS[key] || key,
      extracted_value: document.extractedFields?.[key] || '',
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
