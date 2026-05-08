import { randomUUID } from 'node:crypto';
import { createOutboxEvent, enqueueOutboxEventInTransaction } from '../outbox.mjs';
import {
  PAYMENT_EVIDENCE_DEFAULT_MAX_UPLOAD_BYTES,
  assertPaymentEvidenceUploadPolicy,
  applyPaymentEvidenceExternalSubmissionDocument,
  applyPaymentEvidenceRejectAndReissue,
  applyPaymentEvidenceWorkflowAction,
  buildPaymentEvidenceDocumentHash,
  buildPaymentEvidencePublicSubmission,
  buildPaymentEvidenceSheetRows,
  createPaymentEvidenceSubmissionToken,
  evaluatePaymentEvidenceCase,
  hashPaymentEvidenceSubmissionToken,
  resolvePaymentEvidenceSubmissionTokenState,
  resolvePaymentEvidenceWorkflowStatus,
} from '../payment-evidence-domain.mjs';
import {
  asyncHandler,
  assertActorRoleAllowed,
  buildListResponse,
  createHttpError,
  createMutatingRoute,
  encryptAuditEmail,
  parseCursor,
  parseLimit,
  readOptionalText,
  ROUTE_ROLES,
  stripUndefinedDeep,
  upsertVersionedDoc,
} from '../bff-utils.mjs';
import {
  parseWithSchema,
  paymentEvidenceCaseUpsertSchema,
  paymentEvidenceDocumentUploadSchema,
  paymentEvidenceDocumentUpsertSchema,
  paymentEvidenceGoogleSheetsSyncSchema,
  paymentEvidenceOcrReprocessSchema,
  paymentEvidencePublicDocumentUploadSchema,
  paymentEvidencePublicSubmissionSubmitSchema,
  paymentEvidenceRejectAndReissueSchema,
  paymentEvidenceSubmissionLinkRevokeSchema,
  paymentEvidenceSubmissionLinkSchema,
  paymentEvidenceWorkflowActionSchema,
} from '../schemas.mjs';
import { GoogleSheetsServiceError } from '../google-sheets.mjs';
import { DriveServiceError } from '../google-drive.mjs';
import { GoogleGmailServiceError } from '../google-gmail.mjs';
import {
  applyOcrResultToPaymentEvidenceDocument,
  computePaymentEvidenceOcrConsistency,
} from '../tridoc-ocr.mjs';

const DEFAULT_PAYMENT_EVIDENCE_SHEET_NAMES = {
  cases: 'payment_evidence_cases',
  documents: 'payment_evidence_documents',
  fields: 'payment_evidence_fields',
  payments: 'payment_evidence_payments',
  events: 'payment_evidence_events',
};

function normalizeDocument(document) {
  const {
    expectedVersion: _expectedVersion,
    contentBase64: _contentBase64,
    turnstileToken: _turnstileToken,
    ...safeDocument
  } = document || {};
  return stripUndefinedDeep({
    ...safeDocument,
    id: readOptionalText(safeDocument.id) || `pedoc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    fileName: readOptionalText(safeDocument.fileName),
    extractedFields: safeDocument.extractedFields || {},
    validatedFields: safeDocument.validatedFields || {},
  });
}

function sanitizePaymentEvidenceCasePayload(parsed) {
  const payload = {
    id: parsed.id.trim(),
    campaignId: parsed.campaignId.trim(),
    campaignName: parsed.campaignName.trim(),
    payeeName: parsed.payeeName.trim(),
    recipientEmail: readOptionalText(parsed.recipientEmail) || undefined,
    requestSenderEmail: readOptionalText(parsed.requestSenderEmail) || undefined,
    requestReplyToEmail: readOptionalText(parsed.requestReplyToEmail) || undefined,
    roleLabel: readOptionalText(parsed.roleLabel) || undefined,
    expectedAmount: parsed.expectedAmount,
    expectedIncomeType: readOptionalText(parsed.expectedIncomeType) || undefined,
    expectedPayDate: readOptionalText(parsed.expectedPayDate) || undefined,
    reviewerName: readOptionalText(parsed.reviewerName) || undefined,
  };
  if (Array.isArray(parsed.documents)) {
    payload.documents = parsed.documents.map(normalizeDocument);
  }
  return stripUndefinedDeep(payload);
}

function currentVersionOf(data) {
  return Number.isInteger(data?.version) && data.version > 0 ? data.version : 1;
}

function mergeSheetNames(value) {
  return {
    ...DEFAULT_PAYMENT_EVIDENCE_SHEET_NAMES,
    ...(value || {}),
  };
}

function objectsToSheetRows(items, includeHeader = false) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const headers = [];
  items.forEach((item) => {
    Object.keys(item || {}).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });
  const rows = items.map((item) => headers.map((key) => item?.[key] ?? ''));
  return includeHeader ? [headers, ...rows] : rows;
}

async function appendProjectionRows({ googleSheetsService, spreadsheetId, sheetNames, sheetRows, includeHeader }) {
  const appended = {};
  for (const key of ['cases', 'documents', 'fields', 'payments', 'events']) {
    const rows = objectsToSheetRows(sheetRows[key], includeHeader);
    if (!rows.length) {
      appended[key] = {
        spreadsheetId,
        tableRange: '',
        updatedRange: '',
        updatedRows: 0,
        updatedColumns: 0,
        updatedCells: 0,
      };
      continue;
    }
    appended[key] = await googleSheetsService.appendRows({
      spreadsheetId,
      sheetName: sheetNames[key],
      rows,
    });
  }
  return appended;
}

function paymentEvidenceCasePath(tenantId, caseId) {
  return `orgs/${tenantId}/payment_evidence_cases/${caseId}`;
}

function paymentEvidenceTokenCollectionPath(tenantId) {
  return `orgs/${tenantId}/payment_evidence_submission_tokens`;
}

function paymentEvidenceTokenPath(tenantId, tokenId) {
  return `${paymentEvidenceTokenCollectionPath(tenantId)}/${tokenId}`;
}

function normalizeBaseUrl(value) {
  const normalized = readOptionalText(value).replace(/\/+$/g, '');
  return normalized;
}

function buildPublicSubmissionPath(rawToken) {
  return `/submit/${encodeURIComponent(rawToken)}`;
}

function resolvePublicBaseUrl(req, explicitBaseUrl) {
  const explicit = normalizeBaseUrl(explicitBaseUrl);
  if (explicit) return explicit;
  const configured = normalizeBaseUrl(process.env.PAYMENT_EVIDENCE_PUBLIC_BASE_URL);
  if (configured) return configured;
  const origin = normalizeBaseUrl(req.header('origin'));
  if (origin) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

function resolveSubmissionEmailParams({ parsed, paymentCase, actorEmail }) {
  const senderEmail = readOptionalText(parsed.senderEmail)
    || readOptionalText(paymentCase.requestSenderEmail)
    || readOptionalText(actorEmail);
  const replyToEmail = readOptionalText(parsed.replyToEmail)
    || readOptionalText(paymentCase.requestReplyToEmail)
    || senderEmail;
  return {
    recipientEmail: readOptionalText(parsed.recipientEmail) || readOptionalText(paymentCase.recipientEmail),
    senderEmail,
    replyToEmail,
    subject: readOptionalText(parsed.emailSubject),
    message: readOptionalText(parsed.emailMessage),
  };
}

function safeDeliveryError(error) {
  if (error instanceof GoogleGmailServiceError) {
    if (error.code === 'google_gmail_api_error') return 'Gmail API가 발송을 거부했습니다. 발신자 위임/권한을 확인해 주세요.';
    return error.message;
  }
  return 'Gmail 발송에 실패했습니다.';
}

async function maybeSendSubmissionRequestEmail({
  gmailService,
  caseRef,
  paymentCase,
  parsed,
  actorEmail,
  actorId,
  timestamp,
  submissionUrl,
  expiresAt,
}) {
  if (!parsed.sendEmail) return { paymentCase, delivery: null };

  const emailParams = resolveSubmissionEmailParams({ parsed, paymentCase, actorEmail });
  const baseUpdates = stripUndefinedDeep({
    recipientEmail: emailParams.recipientEmail || undefined,
    requestSenderEmail: emailParams.senderEmail || undefined,
    requestReplyToEmail: emailParams.replyToEmail || undefined,
    deliverySubject: emailParams.subject || undefined,
    deliveryLastSentAt: timestamp,
    updatedBy: actorId,
    updatedAt: timestamp,
  });

  try {
    if (!gmailService || typeof gmailService.sendPaymentEvidenceSubmissionRequest !== 'function') {
      throw new GoogleGmailServiceError('Gmail send is not configured', {
        statusCode: 503,
        code: 'google_gmail_not_configured',
      });
    }
    const delivery = await gmailService.sendPaymentEvidenceSubmissionRequest({
      paymentCase: { ...paymentCase, ...baseUpdates },
      submissionUrl,
      expiresAt,
      senderEmail: emailParams.senderEmail,
      senderName: 'MYSC',
      recipientEmail: emailParams.recipientEmail,
      replyToEmail: emailParams.replyToEmail,
      subject: emailParams.subject,
      message: emailParams.message,
    });
    const updates = stripUndefinedDeep({
      ...baseUpdates,
      deliveryStatus: delivery.status === 'DRY_RUN' ? 'DRY_RUN' : 'SENT',
      gmailMessageId: delivery.messageId || undefined,
      gmailThreadId: delivery.threadId || undefined,
      deliveryError: null,
      deliverySubject: delivery.subject || baseUpdates.deliverySubject || undefined,
    });
    await caseRef.set(updates, { merge: true });
    return {
      paymentCase: { ...paymentCase, ...updates },
      delivery: {
        status: updates.deliveryStatus,
        messageId: delivery.messageId || null,
        threadId: delivery.threadId || null,
        senderEmail: updates.requestSenderEmail,
        recipientEmail: updates.recipientEmail,
        replyToEmail: updates.requestReplyToEmail,
        subject: updates.deliverySubject || null,
        sentAt: timestamp,
      },
    };
  } catch (error) {
    const updates = stripUndefinedDeep({
      ...baseUpdates,
      deliveryStatus: 'FAILED',
      deliveryError: safeDeliveryError(error),
    });
    await caseRef.set(updates, { merge: true });
    return {
      paymentCase: { ...paymentCase, ...updates },
      delivery: {
        status: 'FAILED',
        error: updates.deliveryError,
        senderEmail: updates.requestSenderEmail,
        recipientEmail: updates.recipientEmail,
        replyToEmail: updates.requestReplyToEmail,
        subject: updates.deliverySubject || null,
        sentAt: timestamp,
      },
    };
  }
}

function currentAttemptCount(tokenRecord) {
  return Number.isInteger(tokenRecord?.attemptCount) && tokenRecord.attemptCount >= 0
    ? tokenRecord.attemptCount
    : 0;
}

function assertSubmissionTokenUsable(tokenRecord, timestamp, { allowUsed = false } = {}) {
  const state = resolvePaymentEvidenceSubmissionTokenState(tokenRecord, timestamp);
  if (state.usable) return state;
  if (allowUsed && state.status === 'used') return state;
  const status = state.status === 'not_found' ? 404 : 410;
  throw createHttpError(status, state.reason || '제출 링크를 사용할 수 없습니다.', `submission_token_${state.status}`);
}

function resolvePublicSubmissionTenantId(env = process.env) {
  return readOptionalText(env.PAYMENT_EVIDENCE_PUBLIC_TENANT_ID)
    || readOptionalText(env.VITE_DEFAULT_ORG_ID)
    || 'mysc';
}

function parseSubmissionTokenId(rawToken) {
  const normalized = readOptionalText(rawToken);
  const separatorIndex = normalized.indexOf('.');
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '';
}

async function lookupSubmissionTokenByRawToken({ db, rawToken, timestamp, allowUsed = false }) {
  const normalizedToken = readOptionalText(rawToken);
  if (!normalizedToken) throw createHttpError(400, 'submission token is required', 'submission_token_required');
  const tokenHash = hashPaymentEvidenceSubmissionToken(normalizedToken);
  const tokenId = parseSubmissionTokenId(normalizedToken);
  const defaultTenantId = resolvePublicSubmissionTenantId();
  if (tokenId && defaultTenantId) {
    const directRef = db.doc(paymentEvidenceTokenPath(defaultTenantId, tokenId));
    const directSnap = await directRef.get();
    if (directSnap.exists) {
      const directRecord = { id: directSnap.id, ...directSnap.data() };
      if (directRecord.tokenHash === tokenHash) {
        const tokenState = assertSubmissionTokenUsable(directRecord, timestamp, { allowUsed });
        return { tokenRef: directRef, tokenRecord: directRecord, tokenState };
      }
    }
  }

  if (typeof db.collectionGroup !== 'function') {
    throw createHttpError(503, 'Submission token lookup is not configured', 'submission_token_lookup_not_configured');
  }

  const snap = await db
    .collectionGroup('payment_evidence_submission_tokens')
    .where('tokenHash', '==', tokenHash)
    .limit(2)
    .get();
  if (snap.empty) throw createHttpError(404, '제출 링크를 찾을 수 없습니다.', 'submission_token_not_found');
  if (snap.docs.length > 1) throw createHttpError(409, '제출 링크 충돌이 감지되었습니다.', 'submission_token_collision');

  const doc = snap.docs[0];
  const tokenRecord = { id: doc.id, ...doc.data() };
  const tokenState = assertSubmissionTokenUsable(tokenRecord, timestamp, { allowUsed });
  return { tokenRef: doc.ref, tokenRecord, tokenState };
}

async function readCaseForToken({ db, tokenRecord }) {
  const snap = await db.doc(paymentEvidenceCasePath(tokenRecord.tenantId, tokenRecord.caseId)).get();
  if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${tokenRecord.caseId}`, 'not_found');
  return { id: snap.id, ...snap.data() };
}

function requireDriveUploadService(driveService) {
  if (
    !driveService
    || typeof driveService.ensurePaymentEvidenceCaseFolder !== 'function'
    || typeof driveService.uploadFileToFolder !== 'function'
  ) {
    throw createHttpError(503, 'Google Drive payment evidence upload is not configured', 'drive_not_configured');
  }
}

function requireDrivePreviewService(driveService) {
  if (!driveService || typeof driveService.downloadFileContent !== 'function') {
    throw createHttpError(503, 'Google Drive payment evidence preview is not configured', 'drive_not_configured');
  }
}

function resolvePaymentEvidenceMaxUploadBytes() {
  const parsed = Number.parseInt(String(process.env.PAYMENT_EVIDENCE_MAX_UPLOAD_BYTES || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PAYMENT_EVIDENCE_DEFAULT_MAX_UPLOAD_BYTES;
}

function assertPaymentEvidenceUploadPolicyOrThrow(parsed) {
  try {
    return assertPaymentEvidenceUploadPolicy({
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      fileSize: parsed.fileSize,
      contentBase64: parsed.contentBase64,
      maxBytes: resolvePaymentEvidenceMaxUploadBytes(),
    });
  } catch (error) {
    throw createHttpError(400, error instanceof Error ? error.message : String(error), 'invalid_upload_file');
  }
}

function withPaymentEvidenceOcrConsistency(paymentCase) {
  return stripUndefinedDeep({
    ...paymentCase,
    ocrConsistency: computePaymentEvidenceOcrConsistency(paymentCase),
  });
}

async function applyOcrToUploadedPaymentEvidenceDocument({
  ocrService,
  document,
  contentBase64,
  mimeType,
}) {
  if (!ocrService || typeof ocrService.extractDocument !== 'function') {
    return document;
  }
  const ocrResult = await ocrService.extractDocument({
    documentType: document.type,
    fileName: document.fileName,
    mimeType,
    contentBase64,
  });
  return stripUndefinedDeep(applyOcrResultToPaymentEvidenceDocument(document, ocrResult));
}

function shouldReprocessDocumentType(document, documentTypes) {
  if (!Array.isArray(documentTypes) || !documentTypes.length) return true;
  return documentTypes.includes(document?.type);
}

async function verifyPaymentEvidenceTurnstileOrThrow({ turnstileVerifier, token, req }) {
  if (!turnstileVerifier || typeof turnstileVerifier.verify !== 'function') {
    throw createHttpError(503, 'Cloudflare Turnstile verification is not configured', 'turnstile_not_configured');
  }
  try {
    return await turnstileVerifier.verify({
      token,
      remoteIp: req.ip,
    });
  } catch (error) {
    throw createHttpError(
      Number.isInteger(error?.statusCode) ? error.statusCode : 403,
      error?.message || 'Cloudflare Turnstile verification failed',
      error?.code || 'turnstile_failed',
    );
  }
}

export function mountPaymentEvidenceRoutes(app, {
  db, now, idempotencyService, auditChainService, piiProtector, googleSheetsService, driveService, gmailService, ocrService, turnstileVerifier,
}) {
  app.get('/api/v1/payment-evidence/cases', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceRead, 'read payment evidence cases');
    const limit = parseLimit(req.query.limit, 50, 200);
    const cursor = parseCursor(req.query.cursor);
    const campaignIdFilter = readOptionalText(req.query.campaignId);
    const workflowFilter = readOptionalText(req.query.workflowStatus);

    let query = db.collection(`orgs/${tenantId}/payment_evidence_cases`);
    if (campaignIdFilter) query = query.where('campaignId', '==', campaignIdFilter);
    if (workflowFilter) query = query.where('workflowStatus', '==', workflowFilter);
    query = query.orderBy('__name__').limit(limit);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    const items = snap.docs.map((doc) => {
      const data = { id: doc.id, ...doc.data() };
      return {
        ...data,
        ocrConsistency: computePaymentEvidenceOcrConsistency(data),
        evaluation: evaluatePaymentEvidenceCase(data),
      };
    });
    res.status(200).json(buildListResponse(items, limit));
  }));

  app.get('/api/v1/payment-evidence/cases/:caseId', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceRead, 'read payment evidence case');
    const { caseId } = req.params;
    const snap = await db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`).get();
    if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
    const paymentCase = { id: snap.id, ...snap.data() };
    res.status(200).json({
      id: paymentCase.id,
      tenantId,
      case: {
        ...paymentCase,
        ocrConsistency: computePaymentEvidenceOcrConsistency(paymentCase),
      },
      evaluation: evaluatePaymentEvidenceCase(paymentCase),
      version: paymentCase.version,
      updatedAt: paymentCase.updatedAt || null,
    });
  }));

  app.post('/api/v1/payment-evidence/cases', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'write payment evidence cases');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceCaseUpsertSchema, req.body, 'Invalid payment evidence case payload');
    const expectedVersion = parsed.expectedVersion;
    const payload = sanitizePaymentEvidenceCasePayload(parsed);

    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.case.upsert',
      entityType: 'payment_evidence_case',
      entityId: payload.id,
      payload: { campaignId: payload.campaignId, expectedVersion: expectedVersion ?? null },
      createdAt: timestamp,
    });

    const result = await upsertVersionedDoc({
      db,
      path: `orgs/${tenantId}/payment_evidence_cases/${payload.id}`,
      payload,
      tenantId,
      actorId,
      now: timestamp,
      expectedVersion,
      outboxEvent,
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: payload.id,
      action: result.created ? 'CREATE' : 'UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 케이스 업데이트: ${payload.payeeName}`,
      metadata: { source: 'bff', version: result.version, outboxId: outboxEvent.id },
      timestamp,
    });

    return {
      status: result.created ? 201 : 200,
      body: {
        id: payload.id,
        tenantId,
        case: result.data,
        evaluation: evaluatePaymentEvidenceCase(result.data),
        version: result.version,
        updatedAt: result.data.updatedAt,
      },
    };
  }));

  app.get('/api/v1/payment-evidence/cases/:caseId/documents/:documentId/preview', asyncHandler(async (req, res) => {
    const { tenantId, actorId, actorRole, requestId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceRead, 'preview payment evidence document');
    const { caseId, documentId } = req.params;
    requireDrivePreviewService(driveService);

    const snap = await db.doc(paymentEvidenceCasePath(tenantId, caseId)).get();
    if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
    const paymentCase = { id: snap.id, ...snap.data() };
    const document = (Array.isArray(paymentCase.documents) ? paymentCase.documents : [])
      .find((candidate) => candidate?.id === documentId);
    if (!document) throw createHttpError(404, `Payment evidence document not found: ${documentId}`, 'not_found');
    if (!document.driveFileId) throw createHttpError(400, 'Drive file is not linked to this document', 'drive_file_missing');

    let downloaded;
    let previewPolicy;
    try {
      downloaded = await driveService.downloadFileContent({
        fileId: document.driveFileId,
        maxBytes: resolvePaymentEvidenceMaxUploadBytes(),
      });
      previewPolicy = assertPaymentEvidenceUploadPolicyOrThrow({
        fileName: downloaded.file?.name || document.fileName,
        mimeType: downloaded.mimeType || document.mimeType,
        fileSize: downloaded.size,
        contentBase64: downloaded.contentBase64,
      });
    } catch (error) {
      if (error instanceof DriveServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'DOCUMENT_PREVIEW',
      actorId,
      actorRole,
      requestId,
      details: `지급증빙 문서 미리보기: ${document.fileName}`,
      metadata: {
        source: 'bff',
        documentId: document.id,
        driveFileId: document.driveFileId,
        mimeType: previewPolicy?.mimeType || downloaded.mimeType || document.mimeType || '',
        fileSize: downloaded.size,
      },
      timestamp: now(),
    });

    res.status(200).json({
      caseId,
      documentId: document.id,
      type: document.type,
      fileName: downloaded.file?.name || document.fileName,
      mimeType: previewPolicy?.mimeType || downloaded.mimeType || document.mimeType || 'application/octet-stream',
      fileSize: downloaded.size,
      sha256: document.sha256 || null,
      webViewLink: document.webViewLink || downloaded.file?.webViewLink || null,
      contentBase64: downloaded.contentBase64,
    });
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/documents', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'write payment evidence documents');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceDocumentUpsertSchema, req.body, 'Invalid payment evidence document payload');
    const document = normalizeDocument(parsed);

    const caseRef = db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`);
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.document.upsert',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: { documentId: document.id, documentType: document.type, fileName: document.fileName },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const current = { id: snap.id, ...snap.data() };
      const currentVersion = currentVersionOf(current);
      if (parsed.expectedVersion !== currentVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
      }

      const documents = Array.isArray(current.documents) ? [...current.documents] : [];
      const existingIndex = documents.findIndex((candidate) => candidate.id === document.id || candidate.type === document.type);
      if (existingIndex >= 0) {
        documents[existingIndex] = { ...documents[existingIndex], ...document };
      } else {
        documents.push(document);
      }

      const nextVersion = currentVersion + 1;
      const nextCase = withPaymentEvidenceOcrConsistency({
        ...current,
        documents,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(caseRef, nextCase, { merge: true });
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'DOCUMENT_UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 문서 업데이트: ${document.fileName}`,
      metadata: { source: 'bff', version: result.nextVersion, documentId: document.id, outboxId: outboxEvent.id },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: caseId,
        tenantId,
        case: result.nextCase,
        evaluation: evaluatePaymentEvidenceCase(result.nextCase),
        version: result.nextVersion,
        updatedAt: result.nextCase.updatedAt,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/documents/upload', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'upload payment evidence documents');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceDocumentUploadSchema, req.body, 'Invalid payment evidence document upload payload');

    const caseRef = db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`);
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
    const currentCase = { id: caseSnap.id, ...caseSnap.data() };
    const currentVersion = currentVersionOf(currentCase);
    if (parsed.expectedVersion !== currentVersion) {
      throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
    }
    if (
      !driveService
      || typeof driveService.ensurePaymentEvidenceCaseFolder !== 'function'
      || typeof driveService.uploadFileToFolder !== 'function'
    ) {
      throw createHttpError(503, 'Google Drive payment evidence upload is not configured', 'drive_not_configured');
    }
    const uploadPolicy = assertPaymentEvidenceUploadPolicyOrThrow(parsed);

    let folderResult;
    let uploadedFile;
    try {
      folderResult = await driveService.ensurePaymentEvidenceCaseFolder({
        tenantId,
        paymentCase: currentCase,
        existingFolderId: currentCase.evidenceDriveFolderId,
      });
      uploadedFile = await driveService.uploadFileToFolder({
        folderId: folderResult.folder.id,
        fileName: parsed.fileName,
        mimeType: uploadPolicy.mimeType,
        contentBase64: parsed.contentBase64,
        appProperties: {
          managedBy: 'mysc-platform',
          tenantId,
          paymentEvidenceCaseId: caseId,
          paymentEvidenceDocumentType: parsed.type,
        },
      });
    } catch (error) {
      if (error instanceof DriveServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    const baseDocument = normalizeDocument({
      ...parsed,
      mimeType: uploadPolicy.mimeType,
      driveFileId: uploadedFile.id,
      webViewLink: uploadedFile.webViewLink || undefined,
    });
    const document = await applyOcrToUploadedPaymentEvidenceDocument({
      ocrService,
      document: baseDocument,
      contentBase64: parsed.contentBase64,
      mimeType: uploadPolicy.mimeType,
    });

    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.document.uploaded',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: {
        documentId: document.id,
        documentType: document.type,
        fileName: document.fileName,
        driveFileId: uploadedFile.id,
        driveFolderId: folderResult.folder.id,
      },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const latest = { id: snap.id, ...snap.data() };
      const latestVersion = currentVersionOf(latest);
      if (parsed.expectedVersion !== latestVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${latestVersion}`, 'version_conflict');
      }

      const documents = Array.isArray(latest.documents) ? [...latest.documents] : [];
      const existingIndex = documents.findIndex((candidate) => candidate.id === document.id || candidate.type === document.type);
      if (existingIndex >= 0) {
        documents[existingIndex] = { ...documents[existingIndex], ...document };
      } else {
        documents.push(document);
      }

      const nextVersion = latestVersion + 1;
      const nextCase = withPaymentEvidenceOcrConsistency({
        ...latest,
        documents,
        evidenceDriveSharedDriveId: folderResult.folder.driveId || latest.evidenceDriveSharedDriveId || undefined,
        evidenceDriveFolderId: folderResult.folder.id,
        evidenceDriveFolderName: folderResult.folder.name,
        evidenceDriveLink: folderResult.folder.webViewLink || latest.evidenceDriveLink || undefined,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(caseRef, nextCase, { merge: true });
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'DOCUMENT_UPLOAD',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 Drive 업로드: ${document.fileName}`,
      metadata: {
        source: 'bff',
        version: result.nextVersion,
        documentId: document.id,
        driveFileId: uploadedFile.id,
        driveFolderId: folderResult.folder.id,
        outboxId: outboxEvent.id,
      },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: caseId,
        tenantId,
        case: result.nextCase,
        document,
        driveFile: {
          id: uploadedFile.id,
          name: uploadedFile.name,
          webViewLink: uploadedFile.webViewLink || null,
          mimeType: uploadedFile.mimeType || uploadPolicy.mimeType,
        },
        evaluation: evaluatePaymentEvidenceCase(result.nextCase),
        version: result.nextVersion,
        updatedAt: result.nextCase.updatedAt,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/ocr/reprocess', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'reprocess payment evidence OCR');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceOcrReprocessSchema, req.body || {}, 'Invalid payment evidence OCR reprocess payload');
    requireDrivePreviewService(driveService);

    const caseRef = db.doc(paymentEvidenceCasePath(tenantId, caseId));
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
    const currentCase = { id: caseSnap.id, ...caseSnap.data() };
    const currentVersion = currentVersionOf(currentCase);
    if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== currentVersion) {
      throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
    }

    const selectedTypes = Array.isArray(parsed.documentTypes) ? Array.from(new Set(parsed.documentTypes)) : [];
    const reprocessedDocuments = [];
    for (const existingDocument of currentCase.documents || []) {
      if (!shouldReprocessDocumentType(existingDocument, selectedTypes)) {
        reprocessedDocuments.push(existingDocument);
        continue;
      }
      if (!existingDocument.driveFileId) {
        reprocessedDocuments.push(stripUndefinedDeep(applyOcrResultToPaymentEvidenceDocument(existingDocument, {
          status: 'SKIPPED',
          reason: 'drive_file_missing',
          extractedFields: {},
          parserConfidence: 0,
          extractedAt: timestamp,
        })));
        continue;
      }

      let downloaded;
      try {
        downloaded = await driveService.downloadFileContent({
          fileId: existingDocument.driveFileId,
          maxBytes: resolvePaymentEvidenceMaxUploadBytes(),
        });
      } catch (error) {
        reprocessedDocuments.push(stripUndefinedDeep(applyOcrResultToPaymentEvidenceDocument(existingDocument, {
          status: 'FAILED',
          reason: error instanceof DriveServiceError ? error.code : 'drive_download_failed',
          error: error instanceof DriveServiceError ? error.code : 'drive_download_failed',
          extractedFields: {},
          parserConfidence: 0,
          extractedAt: timestamp,
        })));
        continue;
      }

      reprocessedDocuments.push(await applyOcrToUploadedPaymentEvidenceDocument({
        ocrService,
        document: existingDocument,
        contentBase64: downloaded.contentBase64,
        mimeType: downloaded.mimeType || existingDocument.mimeType || downloaded.file?.mimeType || '',
      }));
    }

    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.ocr.reprocessed',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: {
        documentTypes: selectedTypes.length ? selectedTypes : ['all'],
      },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const latest = { id: snap.id, ...snap.data() };
      const latestVersion = currentVersionOf(latest);
      if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== latestVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${latestVersion}`, 'version_conflict');
      }
      if (parsed.expectedVersion === undefined && latestVersion !== currentVersion) {
        throw createHttpError(409, `Version mismatch: expected ${currentVersion}, actual ${latestVersion}`, 'version_conflict');
      }

      const nextVersion = latestVersion + 1;
      const nextCase = withPaymentEvidenceOcrConsistency({
        ...latest,
        documents: reprocessedDocuments,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(caseRef, nextCase, { merge: true });
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'OCR_REPROCESS',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 OCR 재검증: ${caseId}`,
      metadata: { source: 'bff', version: result.nextVersion, outboxId: outboxEvent.id },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: caseId,
        tenantId,
        case: result.nextCase,
        evaluation: evaluatePaymentEvidenceCase(result.nextCase),
        ocrConsistency: result.nextCase.ocrConsistency,
        version: result.nextVersion,
        updatedAt: result.nextCase.updatedAt,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/submission-link', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'create payment evidence submission link');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceSubmissionLinkSchema, req.body, 'Invalid payment evidence submission link payload');
    const publicBaseUrl = resolvePublicBaseUrl(req, parsed.publicBaseUrl);

    const issued = createPaymentEvidenceSubmissionToken({
      tenantId,
      caseId,
      createdBy: actorId,
      createdAt: timestamp,
      expiresInDays: parsed.expiresInDays,
    });
    const tokenRef = db.doc(paymentEvidenceTokenPath(tenantId, issued.tokenRecord.id));
    const caseRef = db.doc(paymentEvidenceCasePath(tenantId, caseId));
    const tokenCollection = db.collection(paymentEvidenceTokenCollectionPath(tenantId));
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.submission_link.created',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: { tokenId: issued.tokenRecord.id, expiresAt: issued.tokenRecord.expiresAt },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const current = { id: snap.id, ...snap.data() };
      const currentVersion = currentVersionOf(current);
      if (parsed.expectedVersion !== currentVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
      }

      const workflowStatus = resolvePaymentEvidenceWorkflowStatus(current);
      if (!['draft', 'sent', 'rejected'].includes(workflowStatus)) {
        throw createHttpError(400, `${workflowStatus} 상태에서는 제출 링크를 생성할 수 없습니다.`, 'invalid_workflow_state');
      }

      const activeTokenSnap = await tx.get(tokenCollection
        .where('caseId', '==', caseId)
        .where('status', '==', 'active'));
      activeTokenSnap.docs.forEach((tokenDoc) => {
        tx.set(tokenDoc.ref, {
          status: 'revoked',
          revokedAt: timestamp,
          revokedBy: actorId,
          revokeReason: 'regenerated',
          updatedAt: timestamp,
        }, { merge: true });
      });

      const shouldApplySendRequest = ['draft', 'rejected'].includes(workflowStatus);
      const nextCaseRaw = shouldApplySendRequest
        ? applyPaymentEvidenceWorkflowAction({
          paymentCase: current,
          action: 'send_request',
          actorName: actorId,
          at: timestamp,
          note: '제출 링크 생성',
        })
        : current;
      const nextVersion = currentVersion + 1;
      const nextCase = stripUndefinedDeep({
        ...nextCaseRaw,
        submissionTokenId: issued.tokenRecord.id,
        submissionLinkStatus: 'active',
        submissionLinkCreatedAt: timestamp,
        submissionLinkExpiresAt: issued.tokenRecord.expiresAt,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(tokenRef, stripUndefinedDeep({
        ...issued.tokenRecord,
        updatedAt: timestamp,
      }), { merge: false });
      tx.set(caseRef, nextCase, { merge: true });
      const event = nextCase.workflowEvents?.[nextCase.workflowEvents.length - 1];
      if (shouldApplySendRequest && event?.action === 'send_request') {
        tx.create(db.doc(`orgs/${tenantId}/payment_evidence_events/${event.id}`), stripUndefinedDeep({
          ...event,
          tenantId,
          caseId,
          actorId,
          requestId,
          createdAt: timestamp,
        }));
      }
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'SUBMISSION_LINK_CREATE',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 제출 링크 생성: ${caseId}`,
      metadata: { source: 'bff', version: result.nextVersion, tokenId: issued.tokenRecord.id, outboxId: outboxEvent.id },
      timestamp,
    });

    const submissionPath = buildPublicSubmissionPath(issued.rawToken);
    const submissionUrl = `${publicBaseUrl}${submissionPath}`;
    const deliveryResult = await maybeSendSubmissionRequestEmail({
      gmailService,
      caseRef,
      paymentCase: result.nextCase,
      parsed,
      actorEmail,
      actorId,
      timestamp,
      submissionUrl,
      expiresAt: issued.tokenRecord.expiresAt,
    });
    const responseCase = deliveryResult.paymentCase;
    return {
      status: 200,
      body: {
        caseId,
        tenantId,
        tokenId: issued.tokenRecord.id,
        submissionPath,
        submissionUrl,
        expiresAt: issued.tokenRecord.expiresAt,
        delivery: deliveryResult.delivery,
        case: responseCase,
        evaluation: evaluatePaymentEvidenceCase(responseCase),
        version: result.nextVersion,
        updatedAt: responseCase.updatedAt,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/submission-link/revoke', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'revoke payment evidence submission link');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceSubmissionLinkRevokeSchema, req.body, 'Invalid payment evidence submission link revoke payload');
    const tokenCollection = db.collection(paymentEvidenceTokenCollectionPath(tenantId));
    const caseRef = db.doc(paymentEvidenceCasePath(tenantId, caseId));

    const result = await db.runTransaction(async (tx) => {
      const caseSnap = await tx.get(caseRef);
      if (!caseSnap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const current = { id: caseSnap.id, ...caseSnap.data() };
      let docs;
      if (parsed.tokenId) {
        const tokenSnap = await tx.get(db.doc(paymentEvidenceTokenPath(tenantId, parsed.tokenId)));
        docs = tokenSnap.exists ? [tokenSnap] : [];
      } else {
        const tokenSnap = await tx.get(tokenCollection
          .where('caseId', '==', caseId)
          .where('status', '==', 'active'));
        docs = tokenSnap.docs;
      }
      docs = docs.filter((doc) => (doc.data() || {}).caseId === caseId);
      if (!docs.length) throw createHttpError(404, 'Active submission link not found', 'submission_token_not_found');
      docs.forEach((doc) => {
        tx.set(doc.ref, {
          status: 'revoked',
          revokedAt: timestamp,
          revokedBy: actorId,
          revokeReason: 'manual',
          updatedAt: timestamp,
        }, { merge: true });
      });

      const nextVersion = currentVersionOf(current) + 1;
      tx.set(caseRef, {
        submissionLinkStatus: 'revoked',
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      }, { merge: true });
      return { tokenId: docs[0].id, nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'SUBMISSION_LINK_REVOKE',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 제출 링크 폐기: ${caseId}`,
      metadata: { source: 'bff', version: result.nextVersion, tokenId: result.tokenId },
      timestamp,
    });

    return {
      status: 200,
      body: {
        caseId,
        tenantId,
        tokenId: result.tokenId,
        revokedAt: timestamp,
        version: result.nextVersion,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/reject-and-reissue', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'reject and reissue payment evidence request');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceRejectAndReissueSchema, req.body, 'Invalid payment evidence reject-and-reissue payload');
    const actorName = readOptionalText(parsed.actorName) || actorId;
    const publicBaseUrl = resolvePublicBaseUrl(req, parsed.publicBaseUrl);
    const issued = createPaymentEvidenceSubmissionToken({
      tenantId,
      caseId,
      createdBy: actorId,
      createdAt: timestamp,
      expiresInDays: parsed.expiresInDays,
    });
    const caseRef = db.doc(paymentEvidenceCasePath(tenantId, caseId));
    const tokenRef = db.doc(paymentEvidenceTokenPath(tenantId, issued.tokenRecord.id));
    const tokenCollection = db.collection(paymentEvidenceTokenCollectionPath(tenantId));
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.reject_and_reissue',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: {
        tokenId: issued.tokenRecord.id,
        expiresAt: issued.tokenRecord.expiresAt,
        reason: parsed.reason,
        expectedVersion: parsed.expectedVersion,
      },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const current = { id: snap.id, ...snap.data() };
      const currentVersion = currentVersionOf(current);
      if (parsed.expectedVersion !== currentVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
      }

      const activeTokenSnap = await tx.get(tokenCollection
        .where('caseId', '==', caseId)
        .where('status', '==', 'active'));
      activeTokenSnap.docs.forEach((tokenDoc) => {
        tx.set(tokenDoc.ref, {
          status: 'revoked',
          revokedAt: timestamp,
          revokedBy: actorId,
          revokeReason: 'reject_and_reissue',
          updatedAt: timestamp,
        }, { merge: true });
      });

      const nextCaseRaw = applyPaymentEvidenceRejectAndReissue({
        paymentCase: current,
        actorName,
        at: timestamp,
        reason: parsed.reason,
      });
      const nextVersion = currentVersion + 1;
      const nextCase = stripUndefinedDeep({
        ...nextCaseRaw,
        submissionTokenId: issued.tokenRecord.id,
        submissionLinkStatus: 'active',
        submissionLinkCreatedAt: timestamp,
        submissionLinkExpiresAt: issued.tokenRecord.expiresAt,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(tokenRef, stripUndefinedDeep({
        ...issued.tokenRecord,
        updatedAt: timestamp,
      }), { merge: false });
      tx.set(caseRef, nextCase, { merge: true });

      const previousEventCount = Array.isArray(current.workflowEvents) ? current.workflowEvents.length : 0;
      const newEvents = Array.isArray(nextCase.workflowEvents)
        ? nextCase.workflowEvents.slice(previousEventCount)
        : [];
      newEvents.forEach((event) => {
        tx.create(db.doc(`orgs/${tenantId}/payment_evidence_events/${event.id}`), stripUndefinedDeep({
          ...event,
          tenantId,
          caseId,
          actorId,
          requestId,
          createdAt: timestamp,
        }));
      });
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion, revokedCount: activeTokenSnap.docs.length };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'REJECT_AND_REISSUE',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 반려 및 재요청: ${caseId}`,
      metadata: {
        source: 'bff',
        version: result.nextVersion,
        tokenId: issued.tokenRecord.id,
        revokedCount: result.revokedCount,
        outboxId: outboxEvent.id,
      },
      timestamp,
    });

    const submissionPath = buildPublicSubmissionPath(issued.rawToken);
    const submissionUrl = `${publicBaseUrl}${submissionPath}`;
    const deliveryResult = await maybeSendSubmissionRequestEmail({
      gmailService,
      caseRef,
      paymentCase: result.nextCase,
      parsed,
      actorEmail,
      actorId,
      timestamp,
      submissionUrl,
      expiresAt: issued.tokenRecord.expiresAt,
    });
    const responseCase = deliveryResult.paymentCase;
    return {
      status: 200,
      body: {
        caseId,
        tenantId,
        tokenId: issued.tokenRecord.id,
        submissionPath,
        submissionUrl,
        expiresAt: issued.tokenRecord.expiresAt,
        rejectedAt: timestamp,
        rejectionReason: parsed.reason,
        delivery: deliveryResult.delivery,
        case: responseCase,
        evaluation: evaluatePaymentEvidenceCase(responseCase),
        version: result.nextVersion,
        updatedAt: responseCase.updatedAt,
      },
    };
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/actions', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'run payment evidence workflow action');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceWorkflowActionSchema, req.body, 'Invalid payment evidence workflow payload');
    const actorName = readOptionalText(parsed.actorName) || actorId;

    const caseRef = db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`);
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'payment_evidence.workflow.action',
      entityType: 'payment_evidence_case',
      entityId: caseId,
      payload: { action: parsed.action, note: parsed.note || null, expectedVersion: parsed.expectedVersion },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const current = { id: snap.id, ...snap.data() };
      const currentVersion = currentVersionOf(current);
      if (parsed.expectedVersion !== currentVersion) {
        throw createHttpError(409, `Version mismatch: expected ${parsed.expectedVersion}, actual ${currentVersion}`, 'version_conflict');
      }

      const nextCaseRaw = applyPaymentEvidenceWorkflowAction({
        paymentCase: current,
        action: parsed.action,
        actorName,
        at: timestamp,
        note: parsed.note,
      });
      const nextVersion = currentVersion + 1;
      const nextCase = stripUndefinedDeep({
        ...nextCaseRaw,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      const event = nextCase.workflowEvents[nextCase.workflowEvents.length - 1];
      tx.set(caseRef, nextCase, { merge: true });
      tx.create(db.doc(`orgs/${tenantId}/payment_evidence_events/${event.id}`), stripUndefinedDeep({
        ...event,
        tenantId,
        caseId,
        actorId,
        requestId,
        createdAt: timestamp,
      }));
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { nextCase, nextVersion, event };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: `WORKFLOW:${parsed.action}`,
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 워크플로 처리: ${parsed.action}`,
      metadata: {
        source: 'bff',
        version: result.nextVersion,
        fromStatus: result.event.fromStatus,
        toStatus: result.event.toStatus,
        outboxId: outboxEvent.id,
      },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: caseId,
        tenantId,
        case: result.nextCase,
        evaluation: evaluatePaymentEvidenceCase(result.nextCase),
        sheetRows: buildPaymentEvidenceSheetRows(result.nextCase),
        version: result.nextVersion,
        updatedAt: result.nextCase.updatedAt,
      },
    };
  }));

  app.get('/api/public/payment-evidence/submissions/:token', asyncHandler(async (req, res) => {
    const timestamp = now();
    const { tokenRef, tokenRecord } = await lookupSubmissionTokenByRawToken({
      db,
      rawToken: req.params.token,
      timestamp,
      allowUsed: true,
    });
    const paymentCase = await readCaseForToken({ db, tokenRecord });
    await tokenRef.set({
      lastAccessedAt: timestamp,
      attemptCount: currentAttemptCount(tokenRecord) + 1,
      updatedAt: timestamp,
    }, { merge: true });
    await auditChainService.append({
      tenantId: tokenRecord.tenantId,
      entityType: 'payment_evidence_case',
      entityId: tokenRecord.caseId,
      action: 'PUBLIC_SUBMISSION_VIEW',
      actorId: 'external_submitter',
      actorRole: 'external',
      requestId: req.requestId,
      details: `지급증빙 제출 링크 조회: ${tokenRecord.caseId}`,
      metadata: { source: 'public_submission', tokenId: tokenRecord.id },
      timestamp,
    });

    res.status(200).json(buildPaymentEvidencePublicSubmission({
      paymentCase,
      tokenRecord: { ...tokenRecord, lastAccessedAt: timestamp },
      now: timestamp,
    }));
  }));

  app.post('/api/public/payment-evidence/submissions/:token/documents/upload', asyncHandler(async (req, res) => {
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidencePublicDocumentUploadSchema, req.body, 'Invalid public payment evidence upload payload');
    const uploadPolicy = assertPaymentEvidenceUploadPolicyOrThrow(parsed);
    await verifyPaymentEvidenceTurnstileOrThrow({ turnstileVerifier, token: parsed.turnstileToken, req });
    const sha256 = buildPaymentEvidenceDocumentHash(parsed.contentBase64);
    const { tokenRef, tokenRecord } = await lookupSubmissionTokenByRawToken({
      db,
      rawToken: req.params.token,
      timestamp,
      allowUsed: false,
    });
    const currentCase = await readCaseForToken({ db, tokenRecord });
    requireDriveUploadService(driveService);

    let folderResult;
    let uploadedFile;
    try {
      folderResult = await driveService.ensurePaymentEvidenceCaseFolder({
        tenantId: tokenRecord.tenantId,
        paymentCase: currentCase,
        existingFolderId: currentCase.evidenceDriveFolderId,
      });
      uploadedFile = await driveService.uploadFileToFolder({
        folderId: folderResult.folder.id,
        fileName: parsed.fileName,
        mimeType: uploadPolicy.mimeType,
        contentBase64: parsed.contentBase64,
        appProperties: {
          managedBy: 'mysc-platform',
          tenantId: tokenRecord.tenantId,
          paymentEvidenceCaseId: tokenRecord.caseId,
          paymentEvidenceDocumentType: parsed.type,
          paymentEvidenceUploadSource: 'external_submission',
        },
      });
    } catch (error) {
      if (error instanceof DriveServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    const baseDocument = normalizeDocument({
      ...parsed,
      mimeType: uploadPolicy.mimeType,
      sha256,
      driveFileId: uploadedFile.id,
      webViewLink: uploadedFile.webViewLink || undefined,
      source: 'external_upload',
    });
    const document = await applyOcrToUploadedPaymentEvidenceDocument({
      ocrService,
      document: baseDocument,
      contentBase64: parsed.contentBase64,
      mimeType: uploadPolicy.mimeType,
    });
    const outboxEvent = createOutboxEvent({
      tenantId: tokenRecord.tenantId,
      requestId: req.requestId,
      eventType: 'payment_evidence.public_submission.document_uploaded',
      entityType: 'payment_evidence_case',
      entityId: tokenRecord.caseId,
      payload: {
        tokenId: tokenRecord.id,
        documentId: document.id,
        documentType: document.type,
        driveFileId: uploadedFile.id,
        fileSize: parsed.fileSize,
        mimeType: uploadPolicy.mimeType,
        sha256,
      },
      createdAt: timestamp,
    });

    const result = await db.runTransaction(async (tx) => {
      const caseRef = db.doc(paymentEvidenceCasePath(tokenRecord.tenantId, tokenRecord.caseId));
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${tokenRecord.caseId}`, 'not_found');
      const latest = { id: snap.id, ...snap.data() };
      const latestVersion = currentVersionOf(latest);
      const applied = applyPaymentEvidenceExternalSubmissionDocument({
        paymentCase: latest,
        document,
        actorName: latest.payeeName || 'external_submitter',
        at: timestamp,
      });
      const nextVersion = latestVersion + 1;
      const nextCase = withPaymentEvidenceOcrConsistency({
        ...applied.paymentCase,
        evidenceDriveSharedDriveId: folderResult.folder.driveId || latest.evidenceDriveSharedDriveId || undefined,
        evidenceDriveFolderId: folderResult.folder.id,
        evidenceDriveFolderName: folderResult.folder.name,
        evidenceDriveLink: folderResult.folder.webViewLink || latest.evidenceDriveLink || undefined,
        submissionLinkStatus: applied.autoSubmitted ? 'used' : latest.submissionLinkStatus || 'active',
        tenantId: tokenRecord.tenantId,
        version: nextVersion,
        updatedBy: 'external_submitter',
        updatedAt: timestamp,
      });
      tx.set(caseRef, nextCase, { merge: true });
      const nextToken = stripUndefinedDeep({
        lastAccessedAt: timestamp,
        attemptCount: currentAttemptCount(tokenRecord) + 1,
        updatedAt: timestamp,
        ...(applied.autoSubmitted ? { status: 'used', usedAt: timestamp } : {}),
      });
      tx.set(tokenRef, nextToken, { merge: true });
      const event = nextCase.workflowEvents?.[nextCase.workflowEvents.length - 1];
      if (applied.autoSubmitted && event?.action === 'mark_submitted') {
        tx.create(db.doc(`orgs/${tokenRecord.tenantId}/payment_evidence_events/${event.id}`), stripUndefinedDeep({
          ...event,
          tenantId: tokenRecord.tenantId,
          caseId: tokenRecord.caseId,
          actorId: 'external_submitter',
          requestId: req.requestId,
          createdAt: timestamp,
        }));
      }
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return {
        nextCase,
        nextVersion,
        autoSubmitted: applied.autoSubmitted,
        nextTokenRecord: { ...tokenRecord, ...nextToken },
      };
    });

    await auditChainService.append({
      tenantId: tokenRecord.tenantId,
      entityType: 'payment_evidence_case',
      entityId: tokenRecord.caseId,
      action: result.autoSubmitted ? 'PUBLIC_SUBMISSION_UPLOAD_AND_SUBMIT' : 'PUBLIC_SUBMISSION_UPLOAD',
      actorId: 'external_submitter',
      actorRole: 'external',
      requestId: req.requestId,
      details: `지급증빙 외부 문서 업로드: ${document.fileName}`,
      metadata: {
        source: 'public_submission',
        tokenId: tokenRecord.id,
        version: result.nextVersion,
        documentId: document.id,
        driveFileId: uploadedFile.id,
        fileSize: parsed.fileSize,
        mimeType: uploadPolicy.mimeType,
        sha256,
        autoSubmitted: result.autoSubmitted,
        outboxId: outboxEvent.id,
      },
      timestamp,
    });

    res.status(200).json({
      autoSubmitted: result.autoSubmitted,
      ...buildPaymentEvidencePublicSubmission({
        paymentCase: result.nextCase,
        tokenRecord: result.nextTokenRecord,
        now: timestamp,
      }),
    });
  }));

  app.post('/api/public/payment-evidence/submissions/:token/submit', asyncHandler(async (req, res) => {
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidencePublicSubmissionSubmitSchema, req.body || {}, 'Invalid public payment evidence submit payload');
    await verifyPaymentEvidenceTurnstileOrThrow({ turnstileVerifier, token: parsed.turnstileToken, req });
    const { tokenRef, tokenRecord } = await lookupSubmissionTokenByRawToken({
      db,
      rawToken: req.params.token,
      timestamp,
      allowUsed: true,
    });
    const tokenState = resolvePaymentEvidenceSubmissionTokenState(tokenRecord, timestamp);
    if (tokenState.status === 'used') {
      const paymentCase = await readCaseForToken({ db, tokenRecord });
      res.status(200).json(buildPaymentEvidencePublicSubmission({ paymentCase, tokenRecord, now: timestamp }));
      return;
    }

    const outboxEvent = createOutboxEvent({
      tenantId: tokenRecord.tenantId,
      requestId: req.requestId,
      eventType: 'payment_evidence.public_submission.submitted',
      entityType: 'payment_evidence_case',
      entityId: tokenRecord.caseId,
      payload: { tokenId: tokenRecord.id },
      createdAt: timestamp,
    });
    const result = await db.runTransaction(async (tx) => {
      const caseRef = db.doc(paymentEvidenceCasePath(tokenRecord.tenantId, tokenRecord.caseId));
      const snap = await tx.get(caseRef);
      if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${tokenRecord.caseId}`, 'not_found');
      const latest = { id: snap.id, ...snap.data() };
      const publicPayload = buildPaymentEvidencePublicSubmission({ paymentCase: latest, tokenRecord, now: timestamp });
      if (!publicPayload.complete) {
        throw createHttpError(400, '필수 문서 3종을 모두 업로드해야 제출할 수 있습니다.', 'required_documents_missing');
      }

      const workflowStatus = resolvePaymentEvidenceWorkflowStatus(latest);
      let nextCaseRaw = latest;
      if (workflowStatus === 'sent') {
        nextCaseRaw = applyPaymentEvidenceWorkflowAction({
          paymentCase: latest,
          action: 'mark_submitted',
          actorName: latest.payeeName || 'external_submitter',
          at: timestamp,
          note: '외부 제출 링크로 제출 완료',
        });
      } else if (!['submitted', 'approved', 'closed'].includes(workflowStatus)) {
        throw createHttpError(400, `${workflowStatus} 상태에서는 제출할 수 없습니다.`, 'invalid_workflow_state');
      }

      const nextVersion = currentVersionOf(latest) + 1;
      const nextCase = stripUndefinedDeep({
        ...nextCaseRaw,
        submissionLinkStatus: 'used',
        tenantId: tokenRecord.tenantId,
        version: nextVersion,
        updatedBy: 'external_submitter',
        updatedAt: timestamp,
      });
      tx.set(caseRef, nextCase, { merge: true });
      tx.set(tokenRef, {
        status: 'used',
        usedAt: timestamp,
        lastAccessedAt: timestamp,
        attemptCount: currentAttemptCount(tokenRecord) + 1,
        updatedAt: timestamp,
      }, { merge: true });
      const event = nextCase.workflowEvents?.[nextCase.workflowEvents.length - 1];
      if (event?.action === 'mark_submitted') {
        tx.create(db.doc(`orgs/${tokenRecord.tenantId}/payment_evidence_events/${event.id}`), stripUndefinedDeep({
          ...event,
          tenantId: tokenRecord.tenantId,
          caseId: tokenRecord.caseId,
          actorId: 'external_submitter',
          requestId: req.requestId,
          createdAt: timestamp,
        }));
      }
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return {
        nextCase,
        nextVersion,
        nextTokenRecord: { ...tokenRecord, status: 'used', usedAt: timestamp, lastAccessedAt: timestamp },
      };
    });

    await auditChainService.append({
      tenantId: tokenRecord.tenantId,
      entityType: 'payment_evidence_case',
      entityId: tokenRecord.caseId,
      action: 'PUBLIC_SUBMISSION_SUBMIT',
      actorId: 'external_submitter',
      actorRole: 'external',
      requestId: req.requestId,
      details: `지급증빙 외부 제출 완료: ${tokenRecord.caseId}`,
      metadata: { source: 'public_submission', tokenId: tokenRecord.id, version: result.nextVersion, outboxId: outboxEvent.id },
      timestamp,
    });

    res.status(200).json(buildPaymentEvidencePublicSubmission({
      paymentCase: result.nextCase,
      tokenRecord: result.nextTokenRecord,
      now: timestamp,
    }));
  }));

  app.post('/api/v1/payment-evidence/cases/:caseId/google-sheets/sync', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.paymentEvidenceWrite, 'sync payment evidence case to google sheets');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { caseId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(paymentEvidenceGoogleSheetsSyncSchema, req.body, 'Invalid payment evidence sheets sync payload');

    const snap = await db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`).get();
    if (!snap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
    const paymentCase = { id: snap.id, ...snap.data() };
    const sheetRows = buildPaymentEvidenceSheetRows(paymentCase);
    const sheetNames = mergeSheetNames(parsed.sheetNames);
    if (!googleSheetsService || typeof googleSheetsService.appendRows !== 'function') {
      throw createHttpError(503, 'Google Sheets append is not configured', 'google_sheets_not_configured');
    }

    let appended;
    try {
      appended = await appendProjectionRows({
        googleSheetsService,
        spreadsheetId: parsed.spreadsheetId,
        sheetNames,
        sheetRows,
        includeHeader: parsed.includeHeader === true,
      });
    } catch (error) {
      if (error instanceof GoogleSheetsServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    const updateResult = await db.runTransaction(async (tx) => {
      const ref = db.doc(`orgs/${tenantId}/payment_evidence_cases/${caseId}`);
      const latestSnap = await tx.get(ref);
      if (!latestSnap.exists) throw createHttpError(404, `Payment evidence case not found: ${caseId}`, 'not_found');
      const latest = { id: latestSnap.id, ...latestSnap.data() };
      const nextVersion = currentVersionOf(latest) + 1;
      const patch = stripUndefinedDeep({
        sheetSpreadsheetId: parsed.spreadsheetId,
        sheetNames,
        sheetSyncStatus: 'SYNCED',
        sheetLastSyncedAt: timestamp,
        sheetSyncAppendResults: appended,
        tenantId,
        version: nextVersion,
        updatedBy: actorId,
        updatedAt: timestamp,
      });
      tx.set(ref, patch, { merge: true });
      return { nextVersion };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'payment_evidence_case',
      entityId: caseId,
      action: 'SHEETS_SYNC',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `지급증빙 Google Sheets 누적: ${caseId}`,
      metadata: { source: 'bff', version: updateResult.nextVersion, spreadsheetId: parsed.spreadsheetId, sheetNames },
      timestamp,
    });

    return {
      status: 200,
      body: {
        caseId,
        tenantId,
        spreadsheetId: parsed.spreadsheetId,
        sheetNames,
        appended,
        syncedAt: timestamp,
        version: updateResult.nextVersion,
      },
    };
  }));
}
