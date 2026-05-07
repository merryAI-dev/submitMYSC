import { z } from 'zod';

const NON_EMPTY_STRING = z.string().trim().min(1);
const RECORD_UNKNOWN = z.record(z.string(), z.unknown());

export const projectUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  name: NON_EMPTY_STRING,
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const ledgerUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  projectId: NON_EMPTY_STRING,
  name: NON_EMPTY_STRING,
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const transactionUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  projectId: NON_EMPTY_STRING,
  ledgerId: NON_EMPTY_STRING,
  counterparty: NON_EMPTY_STRING,
  state: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const transactionStateSchema = z.object({
  newState: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']),
  reason: z.string().trim().optional(),
  expectedVersion: z.number().int().positive(),
}).strict();

export const commentCreateSchema = z.object({
  id: NON_EMPTY_STRING.optional(),
  content: NON_EMPTY_STRING,
  authorName: NON_EMPTY_STRING.optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const evidenceCreateSchema = z.object({
  id: NON_EMPTY_STRING.optional(),
  fileName: NON_EMPTY_STRING,
  fileType: NON_EMPTY_STRING,
  fileSize: z.number().int().nonnegative(),
  category: NON_EMPTY_STRING,
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional(),
  source: z.enum(['MANUAL', 'PLATFORM_UPLOAD', 'DRIVE_SYNC']).optional(),
  driveFileId: NON_EMPTY_STRING.optional(),
  driveFolderId: NON_EMPTY_STRING.optional(),
  driveFolderName: NON_EMPTY_STRING.optional(),
  webViewLink: NON_EMPTY_STRING.optional(),
  mimeType: NON_EMPTY_STRING.optional(),
  parserCategory: NON_EMPTY_STRING.optional(),
  parserConfidence: z.number().min(0).max(1).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const projectDriveRootLinkSchema = z.object({
  value: NON_EMPTY_STRING,
}).strict();

export const googleSheetImportPreviewSchema = z.object({
  value: NON_EMPTY_STRING,
  sheetName: NON_EMPTY_STRING.optional(),
}).strict();

export const googleSheetImportAnalyzeSchema = z.object({
  spreadsheetTitle: z.string().trim().optional(),
  selectedSheetName: NON_EMPTY_STRING,
  matrix: z.array(z.array(z.string())).min(1),
}).strict();

export const projectSheetSourceUploadSchema = z.object({
  sourceType: z.enum(['usage', 'budget', 'evidence_rules', 'cashflow', 'bank_statement']),
  sheetName: NON_EMPTY_STRING.max(200),
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  matchedColumns: z.array(z.string().trim().max(300)).max(80).optional(),
  unmatchedColumns: z.array(z.string().trim().max(300)).max(80).optional(),
  previewMatrix: z.array(z.array(z.string().max(1000)).max(24)).max(60).optional(),
  applyTarget: z.string().trim().max(120).optional(),
}).strict();

export const clientErrorIngestSchema = z.object({
  eventType: z.enum(['exception', 'message']).optional(),
  message: NON_EMPTY_STRING.max(4000),
  name: z.string().trim().max(200).optional(),
  stack: z.string().max(16000).optional(),
  level: z.enum(['info', 'warning', 'error', 'fatal']).optional(),
  source: NON_EMPTY_STRING.max(120),
  route: z.string().trim().max(500).optional(),
  href: z.string().trim().max(2000).optional(),
  clientRequestId: z.string().trim().max(200).optional(),
  fingerprint: z.array(z.string().trim().max(200)).max(8).optional(),
  tags: RECORD_UNKNOWN.optional(),
  extra: RECORD_UNKNOWN.optional(),
  occurredAt: z.string().trim().max(100).optional(),
}).strict();

export const projectRequestContractAnalyzeSchema = z.object({
  fileName: NON_EMPTY_STRING.max(300),
  documentText: z.string().max(200000).optional(),
}).strict();

export const projectRequestContractUploadSchema = z.object({
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
}).strict();

export const claudeSdkHelpAskSchema = z.object({
  question: NON_EMPTY_STRING.max(2000),
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: NON_EMPTY_STRING.max(4000),
    }).strict(),
  ).max(12).optional(),
}).strict();

export const evidenceDriveUploadSchema = z.object({
  fileName: NON_EMPTY_STRING,
  originalFileName: NON_EMPTY_STRING.optional(),
  mimeType: NON_EMPTY_STRING,
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
  category: NON_EMPTY_STRING.optional(),
}).strict();

export const evidenceDriveOverrideSchema = z.object({
  items: z.array(
    z.object({
      driveFileId: NON_EMPTY_STRING,
      category: NON_EMPTY_STRING,
    }).strict(),
  ).min(1),
}).strict();

const PAYMENT_EVIDENCE_DOCUMENT_TYPE = z.enum(['payment_confirmation', 'id_card', 'bankbook']);
const PAYMENT_EVIDENCE_WORKFLOW_ACTION = z.enum(['send_request', 'mark_submitted', 'approve', 'reject', 'close']);
const PAYMENT_EVIDENCE_FIELD_MAP = z.record(z.string().trim().min(1).max(120), z.string().max(4000));

export const paymentEvidenceDocumentSchema = z.object({
  id: NON_EMPTY_STRING.optional(),
  type: PAYMENT_EVIDENCE_DOCUMENT_TYPE,
  fileName: NON_EMPTY_STRING.max(300),
  driveFileId: z.string().trim().max(200).optional(),
  webViewLink: z.string().trim().max(2000).optional(),
  sha256: z.string().trim().max(128).optional(),
  extractedFields: PAYMENT_EVIDENCE_FIELD_MAP.optional(),
  validatedFields: PAYMENT_EVIDENCE_FIELD_MAP.optional(),
  parserConfidence: z.number().min(0).max(1).optional(),
}).strict();

export const paymentEvidenceCaseUpsertSchema = z.object({
  id: NON_EMPTY_STRING.max(120),
  campaignId: NON_EMPTY_STRING.max(160),
  campaignName: NON_EMPTY_STRING.max(300),
  payeeName: NON_EMPTY_STRING.max(200),
  roleLabel: z.string().trim().max(200).optional(),
  expectedAmount: z.number().nonnegative(),
  expectedIncomeType: z.string().trim().max(120).optional(),
  expectedPayDate: z.string().trim().max(40).optional(),
  reviewerName: z.string().trim().max(200).optional(),
  documents: z.array(paymentEvidenceDocumentSchema).max(20).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const paymentEvidenceWorkflowActionSchema = z.object({
  action: PAYMENT_EVIDENCE_WORKFLOW_ACTION,
  note: z.string().trim().max(2000).optional(),
  actorName: z.string().trim().max(200).optional(),
  expectedVersion: z.number().int().positive(),
}).strict();

export const paymentEvidenceDocumentUpsertSchema = paymentEvidenceDocumentSchema.extend({
  expectedVersion: z.number().int().positive(),
}).strict();

export const paymentEvidenceDocumentUploadSchema = paymentEvidenceDocumentSchema.omit({
  driveFileId: true,
  webViewLink: true,
  sha256: true,
}).extend({
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
  expectedVersion: z.number().int().positive(),
}).strict();

export const paymentEvidenceSubmissionLinkSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expiresInDays: z.number().int().min(1).max(60).optional(),
  publicBaseUrl: z.string().trim().max(2000).optional(),
}).strict();

export const paymentEvidenceSubmissionLinkRevokeSchema = z.object({
  tokenId: z.string().trim().max(160).optional(),
}).strict();

export const paymentEvidenceRejectAndReissueSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: NON_EMPTY_STRING.max(2000),
  actorName: z.string().trim().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(60).optional(),
  publicBaseUrl: z.string().trim().max(2000).optional(),
}).strict();

export const paymentEvidencePublicDocumentUploadSchema = z.object({
  type: PAYMENT_EVIDENCE_DOCUMENT_TYPE,
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().positive(),
  contentBase64: NON_EMPTY_STRING,
  turnstileToken: NON_EMPTY_STRING.max(4096),
}).strict();

export const paymentEvidencePublicSubmissionSubmitSchema = z.object({
  turnstileToken: NON_EMPTY_STRING.max(4096),
}).strict();

export const paymentEvidenceGoogleSheetsSyncSchema = z.object({
  spreadsheetId: NON_EMPTY_STRING.max(300),
  sheetNames: z.object({
    cases: NON_EMPTY_STRING.max(100).optional(),
    documents: NON_EMPTY_STRING.max(100).optional(),
    fields: NON_EMPTY_STRING.max(100).optional(),
    payments: NON_EMPTY_STRING.max(100).optional(),
    events: NON_EMPTY_STRING.max(100).optional(),
  }).strict().optional(),
  includeHeader: z.boolean().optional(),
}).strict();

export const memberRoleUpdateSchema = z.object({
  role: z.enum(['admin', 'finance', 'pm', 'viewer', 'auditor', 'tenant_admin', 'support', 'security']),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const genericWriteSchema = z.object({
  entityType: NON_EMPTY_STRING,
  entityId: NON_EMPTY_STRING.optional(),
  patch: RECORD_UNKNOWN,
  expectedVersion: z.number().int().nonnegative().optional(),
  options: z.object({
    sync: z.boolean().optional(),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.patch || Object.keys(value.patch).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['patch'],
      message: 'patch must include at least one field',
    });
  }
});

export function parseWithSchema(schema, body, fallbackMessage = 'Invalid request body') {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  const message = parsed.error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'body';
    return `${path}: ${issue.message}`;
  }).join('; ');

  const error = new Error(message || fallbackMessage);
  error.statusCode = 400;
  throw error;
}
