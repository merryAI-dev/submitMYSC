import {
  PAYMENT_EVIDENCE_DOCUMENT_TYPES,
  evaluatePaymentEvidenceCase,
} from './payment-evidence-domain.mjs';

const OCR_PROVIDER = 'tridoc-vllm';
const DEFAULT_MAX_NEW_TOKENS = 384;
const DEFAULT_TIMEOUT_MS = 45000;
const IMAGE_MIME_PREFIX = 'image/';

const PAYMENT_EVIDENCE_FIELD_KEYS = new Set([
  'name',
  'affiliation',
  'resident_registration_number',
  'income_type',
  'amount',
  'bank',
  'account_number',
  'account_holder',
  'id_type',
  'signature_present',
  'signed_date',
]);

const REQUIRED_FIELDS_BY_DOCUMENT = {
  payment_confirmation: ['name', 'resident_registration_number', 'amount', 'bank', 'account_number', 'account_holder'],
  id_card: ['id_type', 'name', 'resident_registration_number'],
  bankbook: ['bank', 'account_number', 'account_holder'],
};

export class TriDocOcrServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TriDocOcrServiceError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'tridoc_ocr_error';
    this.details = options.details;
  }
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalBool(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

function roundProbability(value) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function normalizeDocType(value) {
  const normalized = readOptionalText(value).toLowerCase();
  return PAYMENT_EVIDENCE_DOCUMENT_TYPES.includes(normalized) ? normalized : normalized || 'unknown';
}

function normalizeEndpointUrl(value) {
  return readOptionalText(value).replace(/\/+$/g, '');
}

function resolveExtractUrl(endpointUrl) {
  const normalized = normalizeEndpointUrl(endpointUrl);
  return normalized ? `${normalized}/extract` : '';
}

function resolveEndpointHost(endpointUrl) {
  try {
    const url = new URL(endpointUrl);
    return {
      ok: true,
      protocol: url.protocol,
      host: url.hostname.toLowerCase(),
    };
  } catch {
    return {
      ok: false,
      protocol: '',
      host: '',
    };
  }
}

function isEphemeralCloudflareTunnel(host) {
  return readOptionalText(host).toLowerCase().endsWith('.trycloudflare.com');
}

function isImageMimeType(mimeType) {
  return readOptionalText(mimeType).toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

function safeOcrUploadFileName(documentType, mimeType) {
  const normalizedType = normalizeDocType(documentType);
  const normalizedMime = readOptionalText(mimeType).toLowerCase();
  const extensionByMime = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  const extension = extensionByMime[normalizedMime] || 'img';
  return `${normalizedType}.${extension}`;
}

function normalizeFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function normalizeExtractedFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const normalized = {};
  Object.entries(fields).forEach(([key, value]) => {
    const normalizedKey = readOptionalText(key);
    if (!PAYMENT_EVIDENCE_FIELD_KEYS.has(normalizedKey)) return;
    const normalizedValue = normalizeFieldValue(value);
    if (!normalizedValue) return;
    normalized[normalizedKey] = normalizedValue;
  });
  return normalized;
}

function computeDocumentExtractionConfidence({ documentType, predictedDocumentType, extractedFields }) {
  const requiredFields = REQUIRED_FIELDS_BY_DOCUMENT[documentType] || [];
  const requiredScore = requiredFields.length
    ? requiredFields.filter((field) => readOptionalText(extractedFields[field])).length / requiredFields.length
    : 0;
  const typeScore = !predictedDocumentType || predictedDocumentType === documentType ? 1 : 0.35;
  const fieldBreadthScore = Math.min(1, Object.keys(extractedFields || {}).length / Math.max(requiredFields.length, 1));
  return roundProbability((requiredScore * 0.72) + (typeScore * 0.18) + (fieldBreadthScore * 0.1));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildSkippedResult(reason, now) {
  return {
    status: 'SKIPPED',
    reason,
    extractedFields: {},
    parserConfidence: 0,
    extractedAt: now,
  };
}

function buildBlockedResult(reason, now) {
  return {
    status: 'BLOCKED',
    reason,
    extractedFields: {},
    parserConfidence: 0,
    extractedAt: now,
  };
}

function buildFailedResult(error, now) {
  return {
    status: 'FAILED',
    reason: 'extract_failed',
    extractedFields: {},
    parserConfidence: 0,
    extractedAt: now,
    error: error instanceof TriDocOcrServiceError ? error.code : 'OCR extraction failed',
  };
}

function resolveSecurityBlock({
  production,
  endpointUrl,
  authorizationHeader,
  allowedHosts,
  allowEphemeralTunnel,
}) {
  if (!production) return '';

  const endpoint = resolveEndpointHost(endpointUrl);
  if (!endpoint.ok) return 'endpoint_invalid';
  if (endpoint.protocol !== 'https:') return 'https_required';
  if (!authorizationHeader) return 'authorization_required';
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) return 'endpoint_host_allowlist_required';
  if (!allowedHosts.includes(endpoint.host)) return 'endpoint_host_not_allowlisted';
  if (isEphemeralCloudflareTunnel(endpoint.host) && !allowEphemeralTunnel) return 'ephemeral_tunnel_not_allowed';
  return '';
}

export function normalizeTriDocExtractResponse(raw, options = {}) {
  const documentType = normalizeDocType(options.documentType);
  const predJson = raw?.pred_json && typeof raw.pred_json === 'object' ? raw.pred_json : {};
  const predictedDocumentType = normalizeDocType(predJson.document_type || raw?.document_type);
  const extractedFields = normalizeExtractedFields(predJson.fields);
  const extractedAt = readOptionalText(options.now) || new Date().toISOString();
  const elapsedSec = Number(raw?.elapsed_sec);

  return {
    status: 'COMPLETED',
    documentTypeHint: normalizeDocType(raw?.document_type_hint || documentType),
    predictedDocumentType,
    extractedFields,
    parserConfidence: computeDocumentExtractionConfidence({
      documentType,
      predictedDocumentType,
      extractedFields,
    }),
    elapsedSec: Number.isFinite(elapsedSec) ? elapsedSec : undefined,
    extractedAt,
  };
}

export function applyOcrResultToPaymentEvidenceDocument(document, ocrResult = {}) {
  const status = readOptionalText(ocrResult.status) || 'SKIPPED';
  const base = {
    ...document,
    ocrStatus: status,
    ocrProvider: OCR_PROVIDER,
    ocrExtractedAt: readOptionalText(ocrResult.extractedAt) || undefined,
    ocrDocumentTypeHint: readOptionalText(ocrResult.documentTypeHint) || undefined,
    ocrPredictedDocumentType: readOptionalText(ocrResult.predictedDocumentType) || undefined,
    ocrElapsedSec: Number.isFinite(Number(ocrResult.elapsedSec)) ? Number(ocrResult.elapsedSec) : undefined,
    ocrError: readOptionalText(ocrResult.error || ocrResult.reason) || null,
  };

  if (status !== 'COMPLETED') {
    return base;
  }

  return {
    ...base,
    extractedFields: {
      ...(document?.extractedFields || {}),
      ...(ocrResult.extractedFields || {}),
    },
    parserConfidence: roundProbability(ocrResult.parserConfidence),
    ocrError: null,
  };
}

function countPresentRequiredFields(paymentCase) {
  const documents = Array.isArray(paymentCase?.documents) ? paymentCase.documents : [];
  let total = 0;
  let present = 0;

  documents.forEach((document) => {
    const required = REQUIRED_FIELDS_BY_DOCUMENT[document.type] || [];
    required.forEach((field) => {
      total += 1;
      const value = readOptionalText(document.validatedFields?.[field] || document.extractedFields?.[field]);
      if (value) present += 1;
    });
  });

  return { total, present };
}

function countComparableMatches(fieldComparisons = []) {
  const comparable = fieldComparisons.filter((comparison) => (
    ['matched', 'mismatched', 'missing'].includes(readOptionalText(comparison.status))
      || readOptionalText(comparison.paymentValue)
      || readOptionalText(comparison.idCardValue)
      || readOptionalText(comparison.bankbookValue)
  ));
  if (!comparable.length) return { total: 0, matched: 0 };
  return {
    total: comparable.length,
    matched: comparable.filter((comparison) => comparison.status === 'matched' || comparison.matched === true).length,
  };
}

function capMatchProbabilityByIssues(probability, issueCodes = []) {
  let cap = 1;
  if (issueCodes.includes('identity_mismatch')) cap = Math.min(cap, 0.2);
  if (issueCodes.some((code) => code.startsWith('document_type_mismatch:'))) cap = Math.min(cap, 0.4);
  return roundProbability(Math.min(probability, cap));
}

function hasLowConfidenceIssue(issueCodes = []) {
  return issueCodes.includes('identity_mismatch')
    || issueCodes.some((code) => code.startsWith('document_type_mismatch:'));
}

export function computePaymentEvidenceOcrConsistency(paymentCase) {
  const documents = Array.isArray(paymentCase?.documents) ? paymentCase.documents : [];
  const presentDocumentTypes = new Set(documents.map((document) => document.type));
  const documentCompleteness = PAYMENT_EVIDENCE_DOCUMENT_TYPES
    .filter((type) => presentDocumentTypes.has(type)).length / PAYMENT_EVIDENCE_DOCUMENT_TYPES.length;
  const fieldCounts = countPresentRequiredFields(paymentCase);
  const fieldCompleteness = fieldCounts.total ? fieldCounts.present / fieldCounts.total : 0;
  const evaluation = evaluatePaymentEvidenceCase(paymentCase);
  const comparisonCounts = countComparableMatches(evaluation.fieldComparisons);
  const comparisonScore = comparisonCounts.total ? comparisonCounts.matched / comparisonCounts.total : 0;
  const blockerPenalty = Math.min(0.45, evaluation.blockerCount * 0.15);
  const rawProbability = (
    documentCompleteness * 0.35
    + fieldCompleteness * 0.35
    + comparisonScore * 0.3
    - blockerPenalty
  );
  const issueCodes = evaluation.issues.map((issue) => issue.code);
  const matchProbability = capMatchProbabilityByIssues(roundProbability(rawProbability), issueCodes);
  const matched = evaluation.blockerCount === 0
    && evaluation.missingDocumentTypes.length === 0
    && matchProbability >= 0.85;

  return {
    status: matched
      ? 'match'
      : evaluation.blockerCount > 0
        ? 'mismatch'
        : hasLowConfidenceIssue(issueCodes)
          ? 'low_confidence'
          : 'needs_review',
    matched,
    matchProbability,
    documentCompleteness: roundProbability(documentCompleteness),
    fieldCompleteness: roundProbability(fieldCompleteness),
    comparisonScore: roundProbability(comparisonScore),
    blockerCount: evaluation.blockerCount,
    warningCount: evaluation.warningCount,
    issueCodes,
    computedAt: new Date().toISOString(),
  };
}

export function createTriDocOcrService(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => new Date().toISOString());
  const enabled = options.enabled ?? readOptionalBool(env.PAYMENT_EVIDENCE_OCR_ENABLED || env.TRIDOC_OCR_ENABLED, false);
  const endpointUrl = normalizeEndpointUrl(
    options.endpointUrl
      || env.PAYMENT_EVIDENCE_OCR_ENDPOINT_URL
      || env.TRIDOC_OCR_ENDPOINT_URL,
  );
  const authorizationHeader = readOptionalText(
    options.authorizationHeader
      || env.PAYMENT_EVIDENCE_OCR_AUTHORIZATION
      || env.TRIDOC_OCR_AUTHORIZATION
      || (env.PAYMENT_EVIDENCE_OCR_BEARER_TOKEN ? `Bearer ${env.PAYMENT_EVIDENCE_OCR_BEARER_TOKEN}` : '')
      || (env.TRIDOC_OCR_BEARER_TOKEN ? `Bearer ${env.TRIDOC_OCR_BEARER_TOKEN}` : ''),
  );
  const maxNewTokens = readPositiveInt(options.maxNewTokens ?? env.PAYMENT_EVIDENCE_OCR_MAX_NEW_TOKENS, DEFAULT_MAX_NEW_TOKENS);
  const timeoutMs = readPositiveInt(options.timeoutMs ?? env.PAYMENT_EVIDENCE_OCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const production = options.production ?? (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production');
  const allowedHosts = Array.isArray(options.allowedHosts)
    ? options.allowedHosts.map((host) => readOptionalText(host).toLowerCase()).filter(Boolean)
    : parseCsv(env.PAYMENT_EVIDENCE_OCR_ALLOWED_HOSTS || env.TRIDOC_OCR_ALLOWED_HOSTS);
  const allowEphemeralTunnel = options.allowEphemeralTunnel
    ?? readOptionalBool(env.PAYMENT_EVIDENCE_OCR_ALLOW_EPHEMERAL_TUNNEL || env.TRIDOC_OCR_ALLOW_EPHEMERAL_TUNNEL, false);

  return {
    getConfig() {
      return {
        enabled: Boolean(enabled),
        endpointUrl,
        hasAuthorizationHeader: Boolean(authorizationHeader),
        allowedHosts,
        allowEphemeralTunnel,
        maxNewTokens,
        production,
        timeoutMs,
      };
    },

    async extractDocument({ documentType, fileName, mimeType, contentBase64 }) {
      const timestamp = now();
      if (!enabled) return buildSkippedResult('disabled', timestamp);
      const extractUrl = resolveExtractUrl(endpointUrl);
      if (!extractUrl) return buildSkippedResult('not_configured', timestamp);
      const securityBlock = resolveSecurityBlock({
        production,
        endpointUrl,
        authorizationHeader,
        allowedHosts,
        allowEphemeralTunnel,
      });
      if (securityBlock) return buildBlockedResult(securityBlock, timestamp);
      if (!isImageMimeType(mimeType)) return buildSkippedResult('unsupported_mime_type', timestamp);

      try {
        const bytes = Buffer.from(readOptionalText(contentBase64), 'base64');
        if (!bytes.length) return buildSkippedResult('empty_content', timestamp);

        const body = new FormData();
        body.set('doc_type', normalizeDocType(documentType));
        body.set('max_new_tokens', String(maxNewTokens));
        body.set('return_raw_text', '0');
        body.set('file', new Blob([bytes], { type: readOptionalText(mimeType) || 'application/octet-stream' }), safeOcrUploadFileName(documentType, mimeType));

        const response = await fetchImpl(extractUrl, {
          method: 'POST',
          headers: authorizationHeader ? { authorization: authorizationHeader } : {},
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const details = await readJsonResponse(response);
          throw new TriDocOcrServiceError(`TriDoc OCR request failed (${response.status})`, {
            statusCode: response.status,
            code: 'tridoc_ocr_api_error',
            details,
          });
        }

        const data = await readJsonResponse(response);
        return normalizeTriDocExtractResponse(data, {
          documentType,
          now: timestamp,
        });
      } catch (error) {
        return buildFailedResult(error, timestamp);
      }
    },
  };
}
