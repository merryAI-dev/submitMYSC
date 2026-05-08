import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileArchive,
  FileCheck2,
  Filter,
  Folder,
  History,
  Link2,
  Lock,
  Mail,
  MailCheck,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Table2,
  Upload,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { PAYMENT_EVIDENCE_CASES } from '../../data/payment-evidence-data';
import { useAppStore } from '../../data/store';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import {
  createPaymentEvidenceSubmissionLinkViaBff,
  fetchPaymentEvidenceDocumentPreviewViaBff,
  fetchPaymentEvidenceCasesViaBff,
  isPlatformApiEnabled,
  reprocessPaymentEvidenceOcrViaBff,
  rejectAndReissuePaymentEvidenceCaseViaBff,
  revokePaymentEvidenceSubmissionLinkViaBff,
  runPaymentEvidenceWorkflowActionViaBff,
  syncPaymentEvidenceCaseSheetsViaBff,
  upsertPaymentEvidenceCaseViaBff,
  uploadPaymentEvidenceDocumentViaBff,
} from '../../lib/platform-bff-client';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import {
  PAYMENT_EVIDENCE_DOCUMENT_LABELS,
  PAYMENT_EVIDENCE_WORKFLOW_LABELS,
  applyPaymentEvidenceWorkflowAction,
  buildPaymentEvidenceDrivePath,
  buildPaymentEvidenceSheetRows,
  evaluatePaymentEvidenceCase,
  getPaymentEvidenceWorkflowActionSpecs,
  resolvePaymentEvidenceWorkflowStatus,
  type PaymentEvidenceCase,
  type PaymentEvidenceCaseStatus,
  type PaymentEvidenceDocumentType,
  type PaymentEvidenceFieldComparison,
  type PaymentEvidenceRisk,
  type PaymentEvidenceWorkflowAction,
  type PaymentEvidenceWorkflowStatus,
} from '../../platform/payment-evidence';
import { buildSubmissionQrFileName, isPublicSubmissionUrl } from '../../platform/submission-access';

function stripBffEvaluation(paymentCase: PaymentEvidenceCase & { evaluation?: unknown }): PaymentEvidenceCase {
  const { evaluation: _evaluation, ...rest } = paymentCase;
  return rest;
}

function readPaymentEvidenceSpreadsheetId(): string {
  const env = import.meta.env as Record<string, unknown>;
  const value = env.VITE_PAYMENT_EVIDENCE_SPREADSHEET_ID || env.VITE_PAYMENT_EVIDENCE_SHEET_ID;
  return typeof value === 'string' ? value.trim() : '';
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
  const marker = 'base64,';
  const markerIndex = dataUrl.indexOf(marker);
  return markerIndex >= 0 ? dataUrl.slice(markerIndex + marker.length) : dataUrl;
}

async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (!navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(value);
  return true;
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  if (!dataUrl) return;
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function normalizeEmailInput(value: string): string {
  return value.trim().toLowerCase();
}

function buildPaymentEvidenceRequestCaseId(payeeName: string): string {
  const date = new Date();
  const yyyymmdd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  const nameSegment = payeeName
    .normalize('NFC')
    .replace(/[^0-9A-Za-z가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'recipient';
  const nonce = Math.random().toString(36).slice(2, 8);
  return `PAY-${yyyymmdd}-${nameSegment}-${nonce}`;
}

function isPreSubmissionRequest(paymentCase: PaymentEvidenceCase): boolean {
  return ['draft', 'sent', 'rejected'].includes(resolvePaymentEvidenceWorkflowStatus(paymentCase));
}

function isReviewQueueCase(paymentCase: PaymentEvidenceCase): boolean {
  return ['submitted', 'approved', 'closed'].includes(resolvePaymentEvidenceWorkflowStatus(paymentCase));
}

function deliveryLabel(paymentCase: PaymentEvidenceCase): string {
  if (paymentCase.deliveryStatus === 'SENT') return '메일 발송';
  if (paymentCase.deliveryStatus === 'DRY_RUN') return '메일 리허설';
  if (paymentCase.deliveryStatus === 'FAILED') return '발송 실패';
  if (paymentCase.submissionLinkStatus === 'active') return '링크 활성';
  return '대기';
}

interface SubmissionRequestFormState {
  payeeName: string;
  recipientEmail: string;
  campaignId: string;
  campaignName: string;
  roleLabel: string;
  expectedAmount: string;
  expectedIncomeType: string;
  expectedPayDate: string;
  senderEmail: string;
  replyToEmail: string;
  emailSubject: string;
  emailMessage: string;
}

function buildInitialRequestForm(email = ''): SubmissionRequestFormState {
  const senderEmail = normalizeEmailInput(email);
  return {
    payeeName: '',
    recipientEmail: '',
    campaignId: `MYSC-${new Date().getFullYear()}`,
    campaignName: 'MYSC 비용지급 증빙',
    roleLabel: '',
    expectedAmount: '',
    expectedIncomeType: '',
    expectedPayDate: '',
    senderEmail,
    replyToEmail: senderEmail,
    emailSubject: '',
    emailMessage: '',
  };
}

const statusLabels: Record<PaymentEvidenceCaseStatus, string> = {
  blocked: '차단',
  needs_review: '검수 필요',
  ready_to_approve: '승인 가능',
};

const riskLabels: Record<PaymentEvidenceRisk, string> = {
  high: '높음',
  medium: '중간',
  low: '낮음',
};

const statusStyles: Record<PaymentEvidenceCaseStatus, string> = {
  blocked: 'border-rose-200 bg-rose-50 text-rose-700',
  needs_review: 'border-amber-200 bg-amber-50 text-amber-700',
  ready_to_approve: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

const riskStyles: Record<PaymentEvidenceRisk, string> = {
  high: 'bg-rose-100 text-rose-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-emerald-100 text-emerald-700',
};

const workflowStyles: Record<PaymentEvidenceWorkflowStatus, string> = {
  draft: 'border-slate-200 bg-slate-50 text-slate-700',
  sent: 'border-blue-200 bg-blue-50 text-blue-700',
  submitted: 'border-amber-200 bg-amber-50 text-amber-700',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  rejected: 'border-rose-200 bg-rose-50 text-rose-700',
  closed: 'border-teal-200 bg-teal-50 text-teal-700',
};

const requiredDocumentTypes: PaymentEvidenceDocumentType[] = ['payment_confirmation', 'id_card', 'bankbook'];

function formatWon(value: number): string {
  return `${value.toLocaleString()}원`;
}

function formatPercent(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ocrStatusLabel(status?: string): string {
  if (status === 'COMPLETED') return 'OCR 완료';
  if (status === 'FAILED') return 'OCR 실패';
  if (status === 'SKIPPED') return 'OCR 제외';
  if (status === 'BLOCKED') return 'OCR 차단';
  return 'OCR 대기';
}

function ocrStatusClass(status?: string): string {
  if (status === 'COMPLETED') return 'text-emerald-700';
  if (status === 'FAILED') return 'text-rose-700';
  if (status === 'BLOCKED') return 'text-rose-700';
  if (status === 'SKIPPED') return 'text-amber-700';
  return 'text-muted-foreground';
}

function resolveCaseSortScore(paymentCase: PaymentEvidenceCase): number {
  const result = evaluatePaymentEvidenceCase(paymentCase);
  if (result.status === 'blocked') return 0;
  if (result.status === 'needs_review') return 1;
  return 2;
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <Card className="overflow-hidden border-border/50 shadow-sm">
      <CardContent className="p-0">
        <div className="relative p-4">
          <div className="absolute left-0 right-0 top-0 h-[3px]" style={{ backgroundColor: color }} />
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${color}18` }}>
              <Icon className="h-4.5 w-4.5" style={{ color }} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground" style={{ fontWeight: 600 }}>{label}</p>
              <p className="truncate text-[20px]" style={{ fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                {value}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: PaymentEvidenceCaseStatus }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] ${statusStyles[status]}`} style={{ fontWeight: 700 }}>
      {statusLabels[status]}
    </span>
  );
}

function RiskBadge({ risk }: { risk: PaymentEvidenceRisk }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] ${riskStyles[risk]}`} style={{ fontWeight: 700 }}>
      {riskLabels[risk]}
    </span>
  );
}

function WorkflowBadge({ status }: { status: PaymentEvidenceWorkflowStatus }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] ${workflowStyles[status]}`} style={{ fontWeight: 700 }}>
      {PAYMENT_EVIDENCE_WORKFLOW_LABELS[status]}
    </span>
  );
}

function actionButtonClass(action: PaymentEvidenceWorkflowAction): string {
  if (action === 'approve') return 'bg-emerald-600 hover:bg-emerald-700 text-white';
  if (action === 'reject') return 'border-rose-200 text-rose-700 hover:bg-rose-50';
  if (action === 'close') return 'bg-teal-600 hover:bg-teal-700 text-white';
  return 'bg-blue-600 hover:bg-blue-700 text-white';
}

function ActionIcon({ action }: { action: PaymentEvidenceWorkflowAction }) {
  if (action === 'mark_submitted') return <Upload className="h-3.5 w-3.5" />;
  if (action === 'approve') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (action === 'reject') return <XCircle className="h-3.5 w-3.5" />;
  if (action === 'close') return <Lock className="h-3.5 w-3.5" />;
  return <Send className="h-3.5 w-3.5" />;
}

function DocumentChecklist({
  paymentCase,
  onUploadRequest,
  onPreviewRequest,
  uploadDisabled,
  previewDisabled,
}: {
  paymentCase: PaymentEvidenceCase;
  onUploadRequest: (type: PaymentEvidenceDocumentType) => void;
  onPreviewRequest: (documentId: string) => void;
  uploadDisabled?: boolean;
  previewDisabled?: boolean;
}) {
  const documentsByType = new Map(paymentCase.documents.map((document) => [document.type, document]));

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {requiredDocumentTypes.map((type) => {
        const document = documentsByType.get(type);
        return (
          <div key={type} className="rounded-lg border bg-background p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px]" style={{ fontWeight: 700 }}>{PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]}</p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground">
                  {document?.fileName || '파일 없음'}
                </p>
              </div>
              {document ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-rose-600" />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className={`min-w-0 truncate text-[10px] ${ocrStatusClass(document?.ocrStatus)}`}>
                {document
                  ? `${ocrStatusLabel(document.ocrStatus)} · ${formatPercent(document.parserConfidence)}`
                  : '-'}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10px]"
                  disabled={previewDisabled || !document?.driveFileId}
                  onClick={() => document?.id && onPreviewRequest(document.id)}
                >
                  <Eye className="h-3 w-3" />
                  미리보기
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10px]"
                  disabled={uploadDisabled}
                  onClick={() => onUploadRequest(type)}
                >
                  <Upload className="h-3 w-3" />
                  업로드
                </Button>
                {document?.webViewLink && (
                  <a
                    href={document.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-700"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Drive
                  </a>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkflowPanel({
  paymentCase,
  onActionRequest,
}: {
  paymentCase: PaymentEvidenceCase;
  onActionRequest: (paymentCase: PaymentEvidenceCase, action: PaymentEvidenceWorkflowAction) => void;
}) {
  const workflowStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
  const actionSpecs = getPaymentEvidenceWorkflowActionSpecs(paymentCase);
  const events = [...(paymentCase.workflowEvents || [])].reverse();
  const rejectionReason = paymentCase.lastRejectionReason || paymentCase.rejectedReason || '';
  const rejectionAt = paymentCase.lastRejectedAt || paymentCase.rejectedAt;

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-teal-600" />
            <p className="text-[11px]" style={{ fontWeight: 700 }}>진행 루프</p>
            <WorkflowBadge status={workflowStatus} />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            요청 발송부터 제출, 승인, 정본 close까지 케이스 단위로 기록합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {actionSpecs.length === 0 ? (
            <span className="rounded-md border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
              처리 가능한 액션 없음
            </span>
          ) : actionSpecs.map((spec) => (
            <Button
              key={spec.action}
              size="sm"
              variant={spec.action === 'reject' ? 'outline' : 'default'}
              className={`h-7 gap-1.5 px-2 text-[11px] ${actionButtonClass(spec.action)}`}
              disabled={!!spec.disabledReason}
              title={spec.disabledReason}
              onClick={() => onActionRequest(paymentCase, spec.action)}
            >
              <ActionIcon action={spec.action} />
              {spec.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-4">
        <span className="rounded border bg-muted/20 px-2 py-1">요청 {formatDateTime(paymentCase.requestedAt)}</span>
        <span className="rounded border bg-muted/20 px-2 py-1">제출 {formatDateTime(paymentCase.submittedAt)}</span>
        <span className="rounded border bg-muted/20 px-2 py-1">승인 {formatDateTime(paymentCase.approvedAt)}</span>
        <span className="rounded border bg-muted/20 px-2 py-1">close {formatDateTime(paymentCase.closedAt)}</span>
      </div>
      {rejectionReason && (
        <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-800">
          <span style={{ fontWeight: 800 }}>최근 반려 {formatDateTime(rejectionAt)}</span>
          <span className="ml-1">{rejectionReason}</span>
        </div>
      )}

      <div className="mt-3 border-t pt-2">
        <p className="text-[10px]" style={{ fontWeight: 700 }}>감사 이벤트</p>
        <div className="mt-1 max-h-[118px] space-y-1 overflow-y-auto">
          {events.length === 0 ? (
            <p className="rounded bg-muted/20 px-2 py-2 text-[10px] text-muted-foreground">아직 이벤트가 없습니다.</p>
          ) : events.map((event) => (
            <div key={event.id} className="rounded border bg-muted/10 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px]" style={{ fontWeight: 700 }}>
                  {PAYMENT_EVIDENCE_WORKFLOW_LABELS[event.fromStatus]} → {PAYMENT_EVIDENCE_WORKFLOW_LABELS[event.toStatus]}
                </span>
                <span className="text-[9px] text-muted-foreground">{formatDateTime(event.at)}</span>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {event.actorName}{event.note ? ` · ${event.note}` : ''}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SubmissionLinkPanel({
  paymentCase,
  submissionUrl,
  platformApiActive,
  linkBusy,
  onCreateSubmissionLink,
  onCopySubmissionLink,
  onRevokeSubmissionLink,
}: {
  paymentCase: PaymentEvidenceCase;
  submissionUrl?: string;
  platformApiActive: boolean;
  linkBusy: boolean;
  onCreateSubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
  onCopySubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
  onRevokeSubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const linkStatus = paymentCase.submissionLinkStatus || 'none';
  const active = linkStatus === 'active';
  const expired = active && paymentCase.submissionLinkExpiresAt
    ? paymentCase.submissionLinkExpiresAt <= new Date().toISOString()
    : false;
  const canRenderQr = Boolean(submissionUrl && isPublicSubmissionUrl(submissionUrl));
  const canCreate = platformApiActive && !['submitted', 'approved', 'closed'].includes(resolvePaymentEvidenceWorkflowStatus(paymentCase));
  const statusLabel = expired
    ? '만료'
    : active
      ? '활성'
      : linkStatus === 'used'
        ? '제출 완료'
        : linkStatus === 'revoked'
          ? '폐기'
          : '미발급';

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl('');
    setQrError('');
    if (!submissionUrl || !canRenderQr) return;

    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(submissionUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 184,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      }))
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) setQrError('QR을 생성하지 못했습니다.');
      });

    return () => {
      cancelled = true;
    };
  }, [canRenderQr, submissionUrl]);

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-blue-600" />
            <p className="text-[11px]" style={{ fontWeight: 700 }}>외부 제출 링크</p>
            <span className={`rounded-md border px-2 py-0.5 text-[10px] ${
              active && !expired
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 bg-slate-50 text-slate-600'
            }`} style={{ fontWeight: 700 }}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {active
              ? `만료 ${formatDateTime(paymentCase.submissionLinkExpiresAt)}`
              : '비용지급확인서, 신분증 사본, 통장사본 제출용 토큰 링크'}
          </p>
          <div className="mt-2 max-w-full rounded-md border bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground">
            <span className="block truncate">
              {submissionUrl || (active ? '원문 URL은 발급 직후 한 번만 표시됩니다. 필요하면 재발급하세요.' : '-')}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px]"
            disabled={!canCreate || linkBusy}
            onClick={() => onCreateSubmissionLink(paymentCase)}
          >
            {active ? <RefreshCw className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            {active ? '재발급' : '링크 생성'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            disabled={!submissionUrl || linkBusy}
            onClick={() => onCopySubmissionLink(paymentCase)}
          >
            <Copy className="h-3.5 w-3.5" />
            복사
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-rose-200 px-2 text-[11px] text-rose-700 hover:bg-rose-50"
            disabled={!active || linkBusy || !platformApiActive}
            onClick={() => onRevokeSubmissionLink(paymentCase)}
          >
            <XCircle className="h-3.5 w-3.5" />
            폐기
          </Button>
        </div>
      </div>
      {submissionUrl && (
        <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-[156px_minmax(0,1fr)]">
          <div className="flex h-[156px] w-[156px] items-center justify-center rounded-md border bg-white">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`${paymentCase.payeeName} 제출 QR`}
                className="h-[138px] w-[138px]"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-[10px] text-muted-foreground">
                <QrCode className="h-5 w-5" />
                <span>{qrError || 'QR 생성 중'}</span>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col justify-between gap-3">
            <div>
              <p className="text-[11px]" style={{ fontWeight: 800 }}>외부 제출 QR</p>
              <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
                수령자는 Google 로그인 없이 QR을 열어 필수 문서 3종을 제출합니다. QR은 발급된 원문 URL이 보이는 동안에만 다운로드할 수 있습니다.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-fit gap-1.5 px-2 text-[11px]"
              disabled={!qrDataUrl}
              onClick={() => downloadDataUrl(qrDataUrl, buildSubmissionQrFileName({
                caseId: paymentCase.id,
                payeeName: paymentCase.payeeName,
              }))}
            >
              <Download className="h-3.5 w-3.5" />
              QR 다운로드
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OcrConsistencyPanel({
  paymentCase,
  platformApiActive,
  busy,
  onReprocess,
}: {
  paymentCase: PaymentEvidenceCase;
  platformApiActive: boolean;
  busy?: boolean;
  onReprocess: (paymentCase: PaymentEvidenceCase) => void;
}) {
  const consistency = paymentCase.ocrConsistency;
  const probability = consistency?.matchProbability;
  const statusText = consistency?.matched
    ? '일치'
    : consistency?.status === 'mismatch'
      ? '불일치'
      : consistency
        ? '검수 필요'
        : '미처리';

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px]" style={{ fontWeight: 700 }}>OCR 정합성</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            VLLM 추출값 기준 일치 확률 {formatPercent(probability)} · {statusText}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[11px]"
          disabled={!platformApiActive || busy}
          onClick={() => onReprocess(paymentCase)}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          OCR 재검증
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded border bg-muted/20 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">문서 충족</p>
          <p className="text-[12px]" style={{ fontWeight: 800 }}>{formatPercent(consistency?.documentCompleteness)}</p>
        </div>
        <div className="rounded border bg-muted/20 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">필드 충족</p>
          <p className="text-[12px]" style={{ fontWeight: 800 }}>{formatPercent(consistency?.fieldCompleteness)}</p>
        </div>
        <div className="rounded border bg-muted/20 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">교차 일치</p>
          <p className="text-[12px]" style={{ fontWeight: 800 }}>{formatPercent(consistency?.comparisonScore)}</p>
        </div>
      </div>
    </div>
  );
}

function comparisonDisplay(comparison: PaymentEvidenceFieldComparison) {
  if (comparison.status === 'missing') {
    return {
      label: '검수 필요',
      className: 'text-amber-700',
    };
  }
  if (comparison.matched) {
    return {
      label: '일치',
      className: 'text-emerald-700',
    };
  }
  return {
    label: '불일치',
    className: 'text-rose-700',
  };
}

function comparisonValues(comparison: PaymentEvidenceFieldComparison) {
  const counterpartLabel = comparison.idCardValue !== undefined ? '신분증' : '통장';
  const counterpartValue = comparison.idCardValue || comparison.bankbookValue || '-';
  return `확인서 ${comparison.paymentValue || '-'} / ${counterpartLabel} ${counterpartValue}`;
}

function CaseDetail({
  paymentCase,
  onActionRequest,
  onUploadRequest,
  onPreviewRequest,
  onOcrReprocess,
  onCreateSubmissionLink,
  onCopySubmissionLink,
  onRevokeSubmissionLink,
  submissionUrl,
  platformApiActive,
  linkBusy,
  ocrBusy,
  uploadDisabled,
}: {
  paymentCase: PaymentEvidenceCase;
  onActionRequest: (paymentCase: PaymentEvidenceCase, action: PaymentEvidenceWorkflowAction) => void;
  onUploadRequest: (paymentCase: PaymentEvidenceCase, type: PaymentEvidenceDocumentType) => void;
  onPreviewRequest: (paymentCase: PaymentEvidenceCase, documentId: string) => void;
  onOcrReprocess: (paymentCase: PaymentEvidenceCase) => void;
  onCreateSubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
  onCopySubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
  onRevokeSubmissionLink: (paymentCase: PaymentEvidenceCase) => void;
  submissionUrl?: string;
  platformApiActive: boolean;
  linkBusy: boolean;
  ocrBusy?: boolean;
  uploadDisabled?: boolean;
}) {
  const result = evaluatePaymentEvidenceCase(paymentCase);
  const drivePath = buildPaymentEvidenceDrivePath(paymentCase);
  const sheetRows = buildPaymentEvidenceSheetRows(paymentCase);

  return (
    <div className="space-y-3">
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-[15px]">{paymentCase.payeeName}</CardTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {paymentCase.id} · {paymentCase.roleLabel || '역할 미지정'} · {formatWon(paymentCase.expectedAmount)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusBadge status={result.status} />
              <RiskBadge risk={result.risk} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <SubmissionLinkPanel
            paymentCase={paymentCase}
            submissionUrl={submissionUrl}
            platformApiActive={platformApiActive}
            linkBusy={linkBusy}
            onCreateSubmissionLink={onCreateSubmissionLink}
            onCopySubmissionLink={onCopySubmissionLink}
            onRevokeSubmissionLink={onRevokeSubmissionLink}
          />
          <WorkflowPanel paymentCase={paymentCase} onActionRequest={onActionRequest} />
          <OcrConsistencyPanel
            paymentCase={paymentCase}
            platformApiActive={platformApiActive}
            busy={ocrBusy}
            onReprocess={onOcrReprocess}
          />
          <DocumentChecklist
            paymentCase={paymentCase}
            uploadDisabled={uploadDisabled}
            onUploadRequest={(type) => onUploadRequest(paymentCase, type)}
            previewDisabled={!platformApiActive}
            onPreviewRequest={(documentId) => onPreviewRequest(paymentCase, documentId)}
          />

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded-lg border bg-background">
              <div className="border-b px-3 py-2">
                <p className="text-[11px]" style={{ fontWeight: 700 }}>교차검증</p>
              </div>
              <div className="divide-y">
                {result.fieldComparisons.map((comparison) => (
                  (() => {
                    const display = comparisonDisplay(comparison);
                    return (
                      <div key={comparison.key} className="grid gap-2 px-3 py-2 text-[11px] sm:grid-cols-[100px_minmax(0,1fr)_72px]">
                        <span className="text-muted-foreground">{comparison.label}</span>
                        <span className="min-w-0 truncate">{comparisonValues(comparison)}</span>
                        <span className={display.className} style={{ fontWeight: 700 }}>
                          {display.label}
                        </span>
                      </div>
                    );
                  })()
                ))}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <Folder className="h-4 w-4 text-blue-600" />
                <p className="text-[11px]" style={{ fontWeight: 700 }}>Drive 정본 경로</p>
              </div>
              <div className="mt-2 rounded-md border bg-background px-2 py-2 text-[10px] leading-relaxed text-muted-foreground">
                {drivePath.join(' / ')}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Table2 className="h-4 w-4 text-emerald-600" />
                <p className="text-[11px]" style={{ fontWeight: 700 }}>Sheets 반영</p>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
                <span className="rounded border bg-background px-2 py-1">cases {sheetRows.cases.length}</span>
                <span className="rounded border bg-background px-2 py-1">documents {sheetRows.documents.length}</span>
                <span className="rounded border bg-background px-2 py-1">fields {sheetRows.fields.length}</span>
                <span className="rounded border bg-background px-2 py-1">payments {sheetRows.payments.length}</span>
                <span className="rounded border bg-background px-2 py-1">events {sheetRows.events.length}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-background">
            <div className="border-b px-3 py-2">
              <p className="text-[11px]" style={{ fontWeight: 700 }}>검수 이슈</p>
            </div>
            <div className="divide-y">
              {result.issues.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-emerald-700">
                  <ShieldCheck className="h-4 w-4" />
                  확정값 기준 차단 이슈가 없습니다.
                </div>
              ) : result.issues.map((issue) => (
                <div key={issue.code} className="flex items-start gap-2 px-3 py-2">
                  {issue.severity === 'blocker' ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                  ) : (
                    <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  )}
                  <div className="min-w-0">
                    <p className="text-[11px]" style={{ fontWeight: 700 }}>{issue.label}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{issue.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PaymentEvidenceVaultPage() {
  const { orgId } = useFirebase();
  const { currentUser } = useAppStore();
  const { user: authUser } = useAuth();
  const platformApiActive = isPlatformApiEnabled();
  const paymentEvidenceSpreadsheetId = readPaymentEvidenceSpreadsheetId();
  const [cases, setCases] = useState<PaymentEvidenceCase[]>(PAYMENT_EVIDENCE_CASES);
  const [statusFilter, setStatusFilter] = useState<'ALL' | PaymentEvidenceCaseStatus>('ALL');
  const [riskFilter, setRiskFilter] = useState<'ALL' | PaymentEvidenceRisk>('ALL');
  const [workflowFilter, setWorkflowFilter] = useState<'ALL' | PaymentEvidenceWorkflowStatus>('ALL');
  const [query, setQuery] = useState('');
  const [selectedCaseId, setSelectedCaseId] = useState(PAYMENT_EVIDENCE_CASES[0]?.id || '');
  const [loadingCases, setLoadingCases] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestForm, setRequestForm] = useState<SubmissionRequestFormState>(() => buildInitialRequestForm(currentUser.email));
  const [ocrBusy, setOcrBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [submissionLinks, setSubmissionLinks] = useState<Record<string, string>>({});
  const [uploadTarget, setUploadTarget] = useState<{
    caseId: string;
    type: PaymentEvidenceDocumentType;
  } | null>(null);
  const [actionDialog, setActionDialog] = useState<{
    caseId: string;
    action: PaymentEvidenceWorkflowAction;
  } | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [previewDialog, setPreviewDialog] = useState<{
    caseId: string;
    documentId: string;
    fileName: string;
    mimeType: string;
    contentBase64: string;
    webViewLink?: string | null;
    loading: boolean;
    error?: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const bffActor = useMemo(() => ({
    uid: currentUser.uid,
    email: currentUser.email,
    role: currentUser.role,
    idToken: authUser?.idToken,
  }), [authUser?.idToken, currentUser.email, currentUser.role, currentUser.uid]);

  useEffect(() => {
    const nextEmail = normalizeEmailInput(currentUser.email);
    if (!nextEmail) return;
    setRequestForm((previous) => ({
      ...previous,
      senderEmail: previous.senderEmail || nextEmail,
      replyToEmail: previous.replyToEmail || previous.senderEmail || nextEmail,
    }));
  }, [currentUser.email]);

  const reloadPaymentEvidenceCases = useCallback(async () => {
    if (!platformApiActive) {
      setCases(PAYMENT_EVIDENCE_CASES);
      setLoadError('');
      return;
    }

    setLoadingCases(true);
    setLoadError('');
    try {
      const result = await fetchPaymentEvidenceCasesViaBff({
        tenantId: orgId,
        actor: bffActor,
        limit: 200,
      });
      const nextCases = result.items.map(stripBffEvaluation);
      setCases(nextCases);
      setSelectedCaseId((previousId) => (
        nextCases.some((paymentCase) => paymentCase.id === previousId && isReviewQueueCase(paymentCase))
          ? previousId
          : nextCases.find(isReviewQueueCase)?.id || ''
      ));
    } catch (error) {
      const message = resolveApiErrorMessage(error, '지급증빙 케이스를 불러오지 못했습니다.');
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoadingCases(false);
    }
  }, [bffActor, orgId, platformApiActive]);

  useEffect(() => {
    void reloadPaymentEvidenceCases();
  }, [reloadPaymentEvidenceCases]);

  const decoratedCases = useMemo(() => {
    return cases
      .map((paymentCase) => ({
        paymentCase,
        result: evaluatePaymentEvidenceCase(paymentCase),
      }))
      .sort((a, b) => resolveCaseSortScore(a.paymentCase) - resolveCaseSortScore(b.paymentCase));
  }, [cases]);

  const filteredCases = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return decoratedCases.filter(({ paymentCase, result }) => {
      if (!isReviewQueueCase(paymentCase)) return false;
      if (statusFilter !== 'ALL' && result.status !== statusFilter) return false;
      if (riskFilter !== 'ALL' && result.risk !== riskFilter) return false;
      if (workflowFilter !== 'ALL' && resolvePaymentEvidenceWorkflowStatus(paymentCase) !== workflowFilter) return false;
      if (!normalizedQuery) return true;
      return [
        paymentCase.id,
        paymentCase.campaignName,
        paymentCase.payeeName,
        paymentCase.recipientEmail || '',
        paymentCase.roleLabel || '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [decoratedCases, query, riskFilter, statusFilter, workflowFilter]);

  const requestCases = useMemo(() => {
    return decoratedCases
      .filter(({ paymentCase }) => isPreSubmissionRequest(paymentCase))
      .slice(0, 20);
  }, [decoratedCases]);

  const selectedCase = useMemo(() => {
    const selected = cases.find((paymentCase) => paymentCase.id === selectedCaseId && isReviewQueueCase(paymentCase));
    return selected
      || filteredCases[0]?.paymentCase
      || cases.find(isReviewQueueCase);
  }, [cases, filteredCases, selectedCaseId]);

  const stats = useMemo(() => {
    const reviewDecorated = decoratedCases.filter(({ paymentCase }) => isReviewQueueCase(paymentCase));
    const evaluations = reviewDecorated.map(({ result }) => result);
    const workflowStatuses = reviewDecorated.map(({ paymentCase }) => resolvePaymentEvidenceWorkflowStatus(paymentCase));
    return {
      total: evaluations.length,
      pendingRequests: cases.filter(isPreSubmissionRequest).length,
      blocked: evaluations.filter((result) => result.status === 'blocked').length,
      needsReview: evaluations.filter((result) => result.status === 'needs_review').length,
      ready: evaluations.filter((result) => result.status === 'ready_to_approve').length,
      submitted: workflowStatuses.filter((status) => status === 'submitted').length,
      approved: workflowStatuses.filter((status) => status === 'approved').length,
      closed: workflowStatuses.filter((status) => status === 'closed').length,
    };
  }, [cases, decoratedCases]);

  const actionTarget = actionDialog
    ? cases.find((paymentCase) => paymentCase.id === actionDialog.caseId)
    : undefined;
  const actionSpec = actionTarget && actionDialog
    ? getPaymentEvidenceWorkflowActionSpecs(actionTarget).find((spec) => spec.action === actionDialog.action)
    : undefined;
  const actionConfirmLabel = actionDialog?.action === 'reject' && platformApiActive
    ? '반려 및 재요청'
    : actionSpec?.label || '처리';

  function openActionDialog(paymentCase: PaymentEvidenceCase, action: PaymentEvidenceWorkflowAction) {
    setActionDialog({ caseId: paymentCase.id, action });
    setActionNote('');
  }

  function openUploadDialog(paymentCase: PaymentEvidenceCase, type: PaymentEvidenceDocumentType) {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 Drive 업로드를 사용할 수 있습니다.');
      return;
    }
    setUploadTarget({ caseId: paymentCase.id, type });
    fileInputRef.current?.click();
  }

  function updateRequestForm<K extends keyof SubmissionRequestFormState>(
    key: K,
    value: SubmissionRequestFormState[K],
  ) {
    setRequestForm((previous) => ({ ...previous, [key]: value }));
  }

  async function sendSubmissionRequestForCase(paymentCase: PaymentEvidenceCase, options: {
    recipientEmail?: string;
    senderEmail?: string;
    replyToEmail?: string;
    emailSubject?: string;
    emailMessage?: string;
  } = {}) {
    const result = await createPaymentEvidenceSubmissionLinkViaBff({
      tenantId: orgId,
      actor: bffActor,
      caseId: paymentCase.id,
      expectedVersion: paymentCase.version || 1,
      publicBaseUrl: window.location.origin,
      sendEmail: true,
      recipientEmail: options.recipientEmail || paymentCase.recipientEmail,
      senderEmail: options.senderEmail || paymentCase.requestSenderEmail || currentUser.email,
      replyToEmail: options.replyToEmail || paymentCase.requestReplyToEmail || paymentCase.requestSenderEmail || currentUser.email,
      emailSubject: options.emailSubject,
      emailMessage: options.emailMessage,
    });
    if (result.case) {
      const nextCase = result.case;
      setCases((prev) => {
        const exists = prev.some((candidate) => candidate.id === nextCase.id);
        return exists
          ? prev.map((candidate) => (candidate.id === nextCase.id ? nextCase : candidate))
          : [nextCase, ...prev];
      });
    }
    setSubmissionLinks((prev) => ({
      ...prev,
      [paymentCase.id]: result.submissionUrl,
    }));
    await copyText(result.submissionUrl);
    return result;
  }

  async function handleCreateAndSendRequest() {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 요청 발송을 사용할 수 있습니다.');
      return;
    }

    const payeeName = requestForm.payeeName.trim();
    const recipientEmail = normalizeEmailInput(requestForm.recipientEmail);
    const senderEmail = normalizeEmailInput(requestForm.senderEmail);
    const replyToEmail = normalizeEmailInput(requestForm.replyToEmail || requestForm.senderEmail);
    const expectedAmount = Number(requestForm.expectedAmount.replace(/[^\d.]/g, ''));

    if (!payeeName || !recipientEmail || !senderEmail || !requestForm.campaignName.trim()) {
      toast.error('수령자, 이메일, 발신자, 요청명을 입력해 주세요.');
      return;
    }
    if (!Number.isFinite(expectedAmount) || expectedAmount < 0) {
      toast.error('지급 예정 금액을 숫자로 입력해 주세요.');
      return;
    }

    try {
      setRequestBusy(true);
      const caseId = buildPaymentEvidenceRequestCaseId(payeeName);
      const upsertResult = await upsertPaymentEvidenceCaseViaBff({
        tenantId: orgId,
        actor: bffActor,
        payload: {
          id: caseId,
          campaignId: requestForm.campaignId.trim() || `MYSC-${new Date().getFullYear()}`,
          campaignName: requestForm.campaignName.trim(),
          payeeName,
          recipientEmail,
          requestSenderEmail: senderEmail,
          requestReplyToEmail: replyToEmail,
          roleLabel: requestForm.roleLabel.trim() || undefined,
          expectedAmount,
          expectedIncomeType: requestForm.expectedIncomeType.trim() || undefined,
          expectedPayDate: requestForm.expectedPayDate.trim() || undefined,
          reviewerName: currentUser.name || undefined,
          documents: [],
        },
      });
      const linkResult = await sendSubmissionRequestForCase(upsertResult.case, {
        recipientEmail,
        senderEmail,
        replyToEmail,
        emailSubject: requestForm.emailSubject.trim() || undefined,
        emailMessage: requestForm.emailMessage.trim() || undefined,
      });

      const status = linkResult.delivery?.status;
      if (status === 'SENT' || status === 'DRY_RUN') {
        toast.success(status === 'DRY_RUN' ? '요청 생성 및 메일 리허설 완료' : '요청 생성 및 메일 발송 완료');
      } else if (status === 'FAILED') {
        toast.warning('요청 링크는 생성됐지만 메일 발송은 실패했습니다. 링크는 클립보드에 복사했습니다.');
      } else {
        toast.success('요청 링크 생성 완료');
      }

      setRequestForm((previous) => ({
        ...buildInitialRequestForm(senderEmail),
        campaignId: previous.campaignId,
        campaignName: previous.campaignName,
        expectedIncomeType: previous.expectedIncomeType,
        expectedPayDate: previous.expectedPayDate,
        senderEmail,
        replyToEmail,
      }));
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '제출 요청을 발송하지 못했습니다.'));
    } finally {
      setRequestBusy(false);
    }
  }

  async function handleResendSubmissionRequest(paymentCase: PaymentEvidenceCase) {
    try {
      setRequestBusy(true);
      const result = await sendSubmissionRequestForCase(paymentCase);
      if (result.delivery?.status === 'FAILED') {
        toast.warning('새 링크는 생성됐지만 메일 재발송은 실패했습니다. 링크는 클립보드에 복사했습니다.');
      } else {
        toast.success('새 제출 링크 및 QR 메일 재발송 완료');
      }
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '요청 메일을 재발송하지 못했습니다.'));
    } finally {
      setRequestBusy(false);
    }
  }

  async function openPreviewDialog(paymentCase: PaymentEvidenceCase, documentId: string) {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 문서 미리보기를 사용할 수 있습니다.');
      return;
    }
    const document = paymentCase.documents.find((candidate) => candidate.id === documentId);
    if (!document) {
      toast.error('미리보기할 문서를 찾지 못했습니다.');
      return;
    }

    setPreviewDialog({
      caseId: paymentCase.id,
      documentId,
      fileName: document.fileName,
      mimeType: document.mimeType || 'application/octet-stream',
      contentBase64: '',
      webViewLink: document.webViewLink || null,
      loading: true,
    });

    try {
      const result = await fetchPaymentEvidenceDocumentPreviewViaBff({
        tenantId: orgId,
        actor: bffActor,
        caseId: paymentCase.id,
        documentId,
      });
      setPreviewDialog({
        caseId: result.caseId,
        documentId: result.documentId,
        fileName: result.fileName,
        mimeType: result.mimeType,
        contentBase64: result.contentBase64,
        webViewLink: result.webViewLink,
        loading: false,
      });
    } catch (error) {
      const message = resolveApiErrorMessage(error, '문서 미리보기를 불러오지 못했습니다.');
      setPreviewDialog((previous) => (previous
        ? { ...previous, loading: false, error: message }
        : null));
      toast.error(message);
    }
  }

  async function handleCreateSubmissionLink(paymentCase: PaymentEvidenceCase, options: { suppressToast?: boolean } = {}) {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 제출 링크를 생성할 수 있습니다.');
      return null;
    }

    try {
      setLinkBusy(true);
      const result = await createPaymentEvidenceSubmissionLinkViaBff({
        tenantId: orgId,
        actor: bffActor,
        caseId: paymentCase.id,
        expectedVersion: paymentCase.version || 1,
        publicBaseUrl: window.location.origin,
      });
      if (result.case) {
        setCases((prev) => prev.map((candidate) => (
          candidate.id === result.case?.id ? result.case : candidate
        )));
      }
      setSubmissionLinks((prev) => ({
        ...prev,
        [paymentCase.id]: result.submissionUrl,
      }));
      if (!options.suppressToast) {
        if (await copyText(result.submissionUrl)) {
          toast.success('제출 링크 생성 및 복사 완료');
        } else {
          toast.success('제출 링크 생성 완료');
        }
      } else {
        await copyText(result.submissionUrl);
      }
      return result;
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '제출 링크를 생성하지 못했습니다.'));
      return null;
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleCopySubmissionLink(paymentCase: PaymentEvidenceCase) {
    const submissionUrl = submissionLinks[paymentCase.id];
    if (!submissionUrl) {
      toast.error('복사할 원문 링크가 없습니다. 보안을 위해 링크는 발급 직후 한 번만 표시됩니다.');
      return;
    }
    try {
      if (await copyText(submissionUrl)) {
        toast.success('제출 링크 복사 완료');
      } else {
        toast.error('브라우저에서 클립보드를 사용할 수 없습니다.');
      }
    } catch {
      toast.error('제출 링크를 복사하지 못했습니다.');
    }
  }

  async function handleRevokeSubmissionLink(paymentCase: PaymentEvidenceCase) {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 제출 링크를 폐기할 수 있습니다.');
      return;
    }
    try {
      setLinkBusy(true);
      const result = await revokePaymentEvidenceSubmissionLinkViaBff({
        tenantId: orgId,
        actor: bffActor,
        caseId: paymentCase.id,
        tokenId: paymentCase.submissionTokenId,
      });
      setCases((prev) => prev.map((candidate) => (
        candidate.id === paymentCase.id
          ? {
            ...candidate,
            submissionLinkStatus: 'revoked',
            version: result.version || candidate.version,
            updatedAt: result.revokedAt,
          }
          : candidate
      )));
      setSubmissionLinks((prev) => {
        const next = { ...prev };
        delete next[paymentCase.id];
        return next;
      });
      toast.success('제출 링크 폐기 완료');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '제출 링크를 폐기하지 못했습니다.'));
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleUploadFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !uploadTarget) return;

    const targetCase = cases.find((paymentCase) => paymentCase.id === uploadTarget.caseId);
    if (!targetCase) {
      toast.error('업로드할 케이스를 찾지 못했습니다.');
      return;
    }

    try {
      setUploadBusy(true);
      const contentBase64 = await fileToBase64(file);
      const result = await uploadPaymentEvidenceDocumentViaBff({
        tenantId: orgId,
        actor: bffActor,
        caseId: targetCase.id,
        upload: {
          type: uploadTarget.type,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          contentBase64,
          expectedVersion: targetCase.version || 1,
          extractedFields: {},
          validatedFields: {},
        },
      });
      setCases((prev) => prev.map((paymentCase) => (
        paymentCase.id === result.case.id ? result.case : paymentCase
      )));
      toast.success(`${PAYMENT_EVIDENCE_DOCUMENT_LABELS[uploadTarget.type]} 업로드 완료`);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '문서를 업로드하지 못했습니다.'));
    } finally {
      setUploadBusy(false);
      setUploadTarget(null);
    }
  }

  async function handleOcrReprocess(paymentCase: PaymentEvidenceCase) {
    if (!platformApiActive) {
      toast.error('BFF 저장 모드에서만 OCR 재검증을 사용할 수 있습니다.');
      return;
    }
    try {
      setOcrBusy(true);
      const result = await reprocessPaymentEvidenceOcrViaBff({
        tenantId: orgId,
        actor: bffActor,
        caseId: paymentCase.id,
        expectedVersion: paymentCase.version || 1,
      });
      setCases((prev) => prev.map((candidate) => (
        candidate.id === result.case.id ? result.case : candidate
      )));
      toast.success(`OCR 재검증 완료 · 일치 확률 ${formatPercent(result.case.ocrConsistency?.matchProbability)}`);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, 'OCR 재검증을 완료하지 못했습니다.'));
    } finally {
      setOcrBusy(false);
    }
  }

  async function handleWorkflowAction() {
    if (!actionDialog || !actionTarget) return;
    if (actionDialog.action === 'reject' && !actionNote.trim()) return;

    try {
      setActionBusy(true);
      const actorName = actionDialog.action === 'mark_submitted'
        ? actionTarget.payeeName
        : currentUser.name || '재무팀';
      let nextCase: PaymentEvidenceCase;

      if (platformApiActive) {
        if (actionDialog.action === 'send_request') {
          const linkResult = await handleCreateSubmissionLink(actionTarget, { suppressToast: true });
          if (!linkResult?.case) return;
          nextCase = linkResult.case;
        } else if (actionDialog.action === 'reject') {
          const rejectResult = await rejectAndReissuePaymentEvidenceCaseViaBff({
            tenantId: orgId,
            actor: bffActor,
            caseId: actionTarget.id,
            expectedVersion: actionTarget.version || 1,
            reason: actionNote,
            actorName,
            publicBaseUrl: window.location.origin,
            sendEmail: Boolean(actionTarget.recipientEmail && (actionTarget.requestSenderEmail || currentUser.email)),
            recipientEmail: actionTarget.recipientEmail,
            senderEmail: actionTarget.requestSenderEmail || currentUser.email,
            replyToEmail: actionTarget.requestReplyToEmail || actionTarget.requestSenderEmail || currentUser.email,
            emailMessage: actionNote,
          });
          if (!rejectResult.case) return;
          nextCase = rejectResult.case;
          setSubmissionLinks((prev) => ({
            ...prev,
            [actionTarget.id]: rejectResult.submissionUrl,
          }));
          await copyText(rejectResult.submissionUrl);
        } else {
          const actionResult = await runPaymentEvidenceWorkflowActionViaBff({
            tenantId: orgId,
            actor: bffActor,
            caseId: actionTarget.id,
            action: actionDialog.action,
            actorName,
            expectedVersion: actionTarget.version || 1,
            note: actionNote,
          });
          nextCase = actionResult.case;
        }

        if (actionDialog.action === 'close' && paymentEvidenceSpreadsheetId) {
          const syncResult = await syncPaymentEvidenceCaseSheetsViaBff({
            tenantId: orgId,
            actor: bffActor,
            caseId: actionTarget.id,
            spreadsheetId: paymentEvidenceSpreadsheetId,
          });
          nextCase = {
            ...nextCase,
            version: syncResult.version || nextCase.version,
            sheetSpreadsheetId: paymentEvidenceSpreadsheetId,
            sheetSyncStatus: 'SYNCED',
            sheetLastSyncedAt: syncResult.syncedAt,
          };
        }
      } else {
        nextCase = applyPaymentEvidenceWorkflowAction(
          actionTarget,
          actionDialog.action,
          actorName,
          new Date().toISOString(),
          actionNote,
        );
      }

      setCases((prev) => prev.map((paymentCase) => (
        paymentCase.id === nextCase.id ? nextCase : paymentCase
      )));
      toast.success(
        actionDialog.action === 'reject' && platformApiActive
          ? '반려 및 재요청 링크 생성 완료'
          : actionDialog.action === 'close' && platformApiActive && paymentEvidenceSpreadsheetId
          ? `${actionSpec?.label || '처리'} 및 Sheets 누적 완료`
          : `${actionSpec?.label || '처리'} 완료`,
      );
      setActionDialog(null);
      setActionNote('');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '처리하지 못했습니다.'));
    } finally {
      setActionBusy(false);
    }
  }

  const previewSource = previewDialog?.contentBase64
    ? `data:${previewDialog.mimeType};base64,${previewDialog.contentBase64}`
    : '';
  const previewIsPdf = previewDialog?.mimeType === 'application/pdf';
  const previewIsImage = Boolean(previewDialog?.mimeType.startsWith('image/'));

  return (
    <div className="space-y-5">
      <PageHeader
        icon={FileArchive}
        iconGradient="linear-gradient(135deg, #0f766e, #2563eb)"
        title="지급증빙 정본화"
        description="비용지급확인서 · 신분증 사본 · 통장사본 검수"
        badge={`${stats.blocked + stats.needsReview}건 확인`}
        badgeVariant={stats.blocked > 0 ? 'default' : 'secondary'}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard icon={Mail} label="제출 요청" value={stats.pendingRequests} color="#2563eb" />
        <StatCard icon={AlertTriangle} label="차단" value={stats.blocked} color="#e11d48" />
        <StatCard icon={ShieldCheck} label="승인 가능" value={stats.ready} color="#059669" />
        <StatCard icon={Upload} label="제출 완료" value={stats.submitted} color="#d97706" />
        <StatCard icon={CheckCircle2} label="승인" value={stats.approved} color="#16a34a" />
        <StatCard icon={Lock} label="close" value={stats.closed} color="#0f766e" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-[14px]">
            <MailCheck className="h-4 w-4 text-teal-600" />
            제출 요청 발송
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-4">
            <Input
              className="h-8 text-[11px]"
              value={requestForm.payeeName}
              onChange={(event) => updateRequestForm('payeeName', event.target.value)}
              placeholder="수령자 이름"
            />
            <Input
              className="h-8 text-[11px]"
              type="email"
              value={requestForm.recipientEmail}
              onChange={(event) => updateRequestForm('recipientEmail', event.target.value)}
              placeholder="수령자 이메일"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.expectedAmount}
              onChange={(event) => updateRequestForm('expectedAmount', event.target.value)}
              placeholder="지급 예정 금액"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.roleLabel}
              onChange={(event) => updateRequestForm('roleLabel', event.target.value)}
              placeholder="역할/메모"
            />
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <Input
              className="h-8 text-[11px]"
              value={requestForm.campaignName}
              onChange={(event) => updateRequestForm('campaignName', event.target.value)}
              placeholder="요청명/캠페인"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.campaignId}
              onChange={(event) => updateRequestForm('campaignId', event.target.value)}
              placeholder="캠페인 ID"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.expectedIncomeType}
              onChange={(event) => updateRequestForm('expectedIncomeType', event.target.value)}
              placeholder="소득구분"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.expectedPayDate}
              onChange={(event) => updateRequestForm('expectedPayDate', event.target.value)}
              placeholder="지급 예정일"
            />
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <Input
              className="h-8 text-[11px]"
              type="email"
              value={requestForm.senderEmail}
              onChange={(event) => updateRequestForm('senderEmail', event.target.value)}
              placeholder="보내는 사람 이메일"
            />
            <Input
              className="h-8 text-[11px]"
              type="email"
              value={requestForm.replyToEmail}
              onChange={(event) => updateRequestForm('replyToEmail', event.target.value)}
              placeholder="회신 받을 이메일"
            />
            <Input
              className="h-8 text-[11px]"
              value={requestForm.emailSubject}
              onChange={(event) => updateRequestForm('emailSubject', event.target.value)}
              placeholder="메일 제목 자동 생성"
            />
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Textarea
              className="min-h-[74px] text-[11px]"
              value={requestForm.emailMessage}
              onChange={(event) => updateRequestForm('emailMessage', event.target.value)}
              placeholder="메일 본문 추가 메시지"
            />
            <Button
              type="button"
              className="h-full min-h-[74px] gap-2 px-5"
              disabled={requestBusy || !platformApiActive}
              onClick={() => void handleCreateAndSendRequest()}
            >
              <Plus className="h-4 w-4" />
              요청 발송
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-[14px]">제출 요청 현황</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px]">요청</TableHead>
                  <TableHead className="text-[10px]">수령자</TableHead>
                  <TableHead className="text-[10px]">발신/회신</TableHead>
                  <TableHead className="text-[10px]">진행</TableHead>
                  <TableHead className="text-[10px]">발송</TableHead>
                  <TableHead className="text-right text-[10px]">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requestCases.map(({ paymentCase }) => (
                  <TableRow key={paymentCase.id} className="h-10">
                    <TableCell className="py-1">
                      <p className="text-[11px]" style={{ fontWeight: 700 }}>{paymentCase.payeeName}</p>
                      <p className="text-[10px] text-muted-foreground">{paymentCase.campaignName}</p>
                    </TableCell>
                    <TableCell className="py-1 text-[11px]">
                      <p>{paymentCase.recipientEmail || '-'}</p>
                      <p className="text-[10px] text-muted-foreground">{paymentCase.roleLabel || paymentCase.id}</p>
                    </TableCell>
                    <TableCell className="py-1 text-[10px] text-muted-foreground">
                      <p>{paymentCase.requestSenderEmail || '-'}</p>
                      <p>{paymentCase.requestReplyToEmail || '-'}</p>
                    </TableCell>
                    <TableCell className="py-1">
                      <WorkflowBadge status={resolvePaymentEvidenceWorkflowStatus(paymentCase)} />
                    </TableCell>
                    <TableCell className="py-1">
                      <span className={`rounded-md border px-2 py-1 text-[10px] ${
                        paymentCase.deliveryStatus === 'FAILED'
                          ? 'border-rose-200 bg-rose-50 text-rose-700'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      }`}>
                        {deliveryLabel(paymentCase)}
                      </span>
                      {paymentCase.deliveryError && (
                        <p className="mt-1 max-w-[220px] truncate text-[10px] text-rose-600">{paymentCase.deliveryError}</p>
                      )}
                    </TableCell>
                    <TableCell className="py-1 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        disabled={requestBusy || !platformApiActive}
                        onClick={() => void handleResendSubmissionRequest(paymentCase)}
                      >
                        <Send className="h-3.5 w-3.5" />
                        재발송
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!requestCases.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center text-[11px] text-muted-foreground">
                      제출 대기 중인 요청이 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-border/50 bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Filter className="h-3.5 w-3.5" />
            <span style={{ fontWeight: 600 }}>필터</span>
          </div>
          <span className={`rounded-full border px-2 py-1 text-[10px] ${
            platformApiActive
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-slate-50 text-slate-600'
          }`}>
            {platformApiActive ? (loadingCases ? 'BFF 동기화 중' : 'BFF 저장') : '로컬 샘플'}
          </span>
          {loadError && (
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
              {loadError}
            </span>
          )}
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
            <SelectTrigger className="h-8 w-[140px] text-[11px]">
              <SelectValue placeholder="상태" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">전체 상태</SelectItem>
              <SelectItem value="blocked">차단</SelectItem>
              <SelectItem value="needs_review">검수 필요</SelectItem>
              <SelectItem value="ready_to_approve">승인 가능</SelectItem>
            </SelectContent>
          </Select>
          <Select value={riskFilter} onValueChange={(value) => setRiskFilter(value as typeof riskFilter)}>
            <SelectTrigger className="h-8 w-[120px] text-[11px]">
              <SelectValue placeholder="리스크" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">전체 리스크</SelectItem>
              <SelectItem value="high">높음</SelectItem>
              <SelectItem value="medium">중간</SelectItem>
              <SelectItem value="low">낮음</SelectItem>
            </SelectContent>
          </Select>
          <Select value={workflowFilter} onValueChange={(value) => setWorkflowFilter(value as typeof workflowFilter)}>
            <SelectTrigger className="h-8 w-[130px] text-[11px]">
              <SelectValue placeholder="진행" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">전체 진행</SelectItem>
              <SelectItem value="submitted">제출 완료</SelectItem>
              <SelectItem value="approved">승인</SelectItem>
              <SelectItem value="closed">정본 완료</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              className="h-8 pl-8 text-[11px]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="케이스, 이름, 차수 검색"
            />
          </div>
          {(statusFilter !== 'ALL' || riskFilter !== 'ALL' || workflowFilter !== 'ALL' || query) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-[11px]"
              onClick={() => {
                setStatusFilter('ALL');
                setRiskFilter('ALL');
                setWorkflowFilter('ALL');
                setQuery('');
              }}
            >
              초기화
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-[14px]">검수 큐</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px]">케이스</TableHead>
                    <TableHead className="text-[10px]">수령자</TableHead>
                    <TableHead className="text-right text-[10px]">금액</TableHead>
                    <TableHead className="text-[10px]">문서</TableHead>
                    <TableHead className="text-[10px]">진행</TableHead>
                    <TableHead className="text-[10px]">상태</TableHead>
                    <TableHead className="text-[10px]">OCR</TableHead>
                    <TableHead className="text-[10px]">이슈</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCases.map(({ paymentCase, result }) => {
                    const active = selectedCase?.id === paymentCase.id;
                    const workflowStatus = resolvePaymentEvidenceWorkflowStatus(paymentCase);
                    return (
                      <TableRow
                        key={paymentCase.id}
                        className={`h-10 cursor-pointer transition-colors ${active ? 'bg-teal-50/70 hover:bg-teal-50/80' : 'hover:bg-muted/50'}`}
                        onClick={() => setSelectedCaseId(paymentCase.id)}
                      >
                        <TableCell className="py-1">
                          <p className="text-[11px]" style={{ fontWeight: 700 }}>{paymentCase.id}</p>
                          <p className="text-[10px] text-muted-foreground">{paymentCase.roleLabel || '-'}</p>
                        </TableCell>
                        <TableCell className="py-1 text-[11px]">{paymentCase.payeeName}</TableCell>
                        <TableCell className="py-1 text-right text-[11px]" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                          {formatWon(paymentCase.expectedAmount)}
                        </TableCell>
                        <TableCell className="py-1">
                          <div className="flex gap-1">
                            {requiredDocumentTypes.map((type) => {
                              const present = paymentCase.documents.some((document) => document.type === type);
                              return (
                                <span
                                  key={type}
                                  className={`h-2 w-2 rounded-full ${present ? 'bg-emerald-500' : 'bg-rose-500'}`}
                                  title={PAYMENT_EVIDENCE_DOCUMENT_LABELS[type]}
                                />
                              );
                            })}
                          </div>
                        </TableCell>
                        <TableCell className="py-1">
                          <WorkflowBadge status={workflowStatus} />
                        </TableCell>
                        <TableCell className="py-1">
                          <StatusBadge status={result.status} />
                        </TableCell>
                        <TableCell className="py-1 text-[11px]" style={{ fontWeight: 700 }}>
                          {formatPercent(paymentCase.ocrConsistency?.matchProbability)}
                        </TableCell>
                        <TableCell className="py-1">
                          <div className="flex items-center gap-1.5">
                            <RiskBadge risk={result.risk} />
                            <span className="text-[10px] text-muted-foreground">{result.issues.length}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {selectedCase ? (
          <CaseDetail
            paymentCase={selectedCase}
            onActionRequest={openActionDialog}
            onUploadRequest={openUploadDialog}
            onPreviewRequest={openPreviewDialog}
            onOcrReprocess={handleOcrReprocess}
            onCreateSubmissionLink={handleCreateSubmissionLink}
            onCopySubmissionLink={handleCopySubmissionLink}
            onRevokeSubmissionLink={handleRevokeSubmissionLink}
            submissionUrl={submissionLinks[selectedCase.id]}
            platformApiActive={platformApiActive}
            linkBusy={linkBusy}
            ocrBusy={ocrBusy}
            uploadDisabled={uploadBusy || !platformApiActive}
          />
        ) : (
          <Card className="border-border/50 shadow-sm">
            <CardContent className="py-12 text-center text-[12px] text-muted-foreground">
              선택된 케이스가 없습니다.
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardContent className="grid gap-3 p-4 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4 text-blue-600" />
              <p className="text-[12px]" style={{ fontWeight: 700 }}>Drive</p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">원본, 정규화본, 최종본, 감사 JSON</p>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Table2 className="h-4 w-4 text-emerald-600" />
              <p className="text-[12px]" style={{ fontWeight: 700 }}>Sheets</p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">cases, documents, fields, payments</p>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-teal-600" />
              <p className="text-[12px]" style={{ fontWeight: 700 }}>Audit</p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">append-only events와 SHA-256 해시</p>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && setActionDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[14px]">
              {actionConfirmLabel} 확인
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              {actionTarget
                ? `${actionTarget.payeeName} · ${actionTarget.id}`
                : '선택된 케이스가 없습니다.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {actionDialog?.action === 'approve' && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-800">
                승인하면 Google Sheets 지급 row 생성 대상이 됩니다.
              </div>
            )}
            {actionDialog?.action === 'close' && (
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-[11px] text-teal-800">
                close하면 Drive 정본 경로와 감사 이벤트 기준으로 완료 처리합니다.
              </div>
            )}
            {actionDialog?.action === 'send_request' && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-[11px] text-blue-800">
                제출 링크를 생성하고 수령자에게 요청 발송 상태로 전환합니다. 링크 원문은 생성 직후 한 번만 복사할 수 있습니다.
              </div>
            )}
            {actionDialog?.action === 'mark_submitted' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                외부 수령자의 제출 완료를 기록하고 내부 검수 단계로 넘깁니다.
              </div>
            )}
            {actionDialog?.action === 'reject' && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-800">
                반려 사유를 기록하고 기존 제출 링크를 폐기한 뒤 새 제출 링크를 즉시 발급합니다.
              </div>
            )}

            <Textarea
              value={actionNote}
              onChange={(event) => setActionNote(event.target.value)}
              rows={3}
              placeholder={actionDialog?.action === 'reject' ? '반려 사유를 입력하세요' : '메모 (선택)'}
              className="text-[12px]"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setActionDialog(null)}>취소</Button>
            <Button
              size="sm"
              disabled={actionBusy || (actionDialog?.action === 'reject' && !actionNote.trim())}
              className={actionDialog ? actionButtonClass(actionDialog.action) : undefined}
              onClick={handleWorkflowAction}
            >
              {actionBusy ? '처리 중' : actionConfirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewDialog} onOpenChange={(open) => !open && setPreviewDialog(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="truncate text-[14px]">
              {previewDialog?.fileName || '문서 미리보기'}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              앱 내부 프록시로 Drive 파일을 불러옵니다. 원본 권한은 외부에 노출하지 않습니다.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-[420px] rounded-lg border bg-slate-50">
            {previewDialog?.loading ? (
              <div className="flex min-h-[420px] items-center justify-center text-[12px] text-muted-foreground">
                문서 불러오는 중
              </div>
            ) : previewDialog?.error ? (
              <div className="flex min-h-[420px] items-center justify-center px-6 text-center text-[12px] text-rose-700">
                {previewDialog.error}
              </div>
            ) : previewSource && previewIsPdf ? (
              <iframe
                title={previewDialog?.fileName || 'payment evidence preview'}
                src={previewSource}
                className="h-[70vh] min-h-[420px] w-full rounded-lg"
              />
            ) : previewSource && previewIsImage ? (
              <div className="flex max-h-[70vh] min-h-[420px] items-center justify-center overflow-auto p-3">
                <img
                  src={previewSource}
                  alt={previewDialog?.fileName || 'payment evidence preview'}
                  className="max-h-full max-w-full rounded-md border bg-white object-contain"
                />
              </div>
            ) : (
              <div className="flex min-h-[420px] items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
                이 파일 형식은 앱 내 미리보기를 지원하지 않습니다.
              </div>
            )}
          </div>

          <DialogFooter>
            {previewDialog?.webViewLink && (
              <Button variant="outline" size="sm" asChild>
                <a href={previewDialog.webViewLink} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Drive 열기
                </a>
              </Button>
            )}
            <Button size="sm" onClick={() => setPreviewDialog(null)}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="application/pdf,.pdf,image/jpeg,image/jpg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/heic,.heic,image/heif,.heif"
        onChange={handleUploadFileChange}
      />
    </div>
  );
}
