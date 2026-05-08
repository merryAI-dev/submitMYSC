import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Loader2,
  Lock,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { toast } from 'sonner';
import { TurnstileWidget, readTurnstileSiteKey } from '../security/TurnstileWidget';
import {
  fetchPaymentEvidencePublicSubmissionViaBff,
  isPlatformApiEnabled,
  submitPaymentEvidencePublicSubmissionViaBff,
  uploadPaymentEvidencePublicSubmissionDocumentViaBff,
  type PaymentEvidencePublicSubmissionDocumentStatus,
  type PaymentEvidencePublicSubmissionResult,
} from '../../lib/platform-bff-client';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import type { PaymentEvidenceDocumentType } from '../../platform/payment-evidence';

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

function formatWon(value?: number): string {
  return `${Number(value || 0).toLocaleString()}원`;
}

function formatDate(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function DocumentUploadCard({
  document,
  disabled,
  uploading,
  onFileSelected,
}: {
  document: PaymentEvidencePublicSubmissionDocumentStatus;
  disabled: boolean;
  uploading: boolean;
  onFileSelected: (type: PaymentEvidenceDocumentType, file: File) => void;
}) {
  const inputId = `payment-evidence-public-${document.type}`;

  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px]" style={{ fontWeight: 800 }}>{document.label}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {document.fileName || '업로드 대기'}
            </p>
          </div>
          {document.uploaded ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          ) : (
            <XCircle className="h-5 w-5 shrink-0 text-rose-600" />
          )}
        </div>

        <div className="mt-4">
          <Button
            asChild
            type="button"
            size="sm"
            variant={document.uploaded ? 'outline' : 'default'}
            className="h-8 w-full gap-1.5 text-[12px]"
            disabled={disabled || uploading}
          >
            <label htmlFor={inputId}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {document.uploaded ? '교체 업로드' : '파일 업로드'}
            </label>
          </Button>
          <input
            id={inputId}
            type="file"
            className="hidden"
            accept="application/pdf,.pdf,image/jpeg,image/jpg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/heic,.heic,image/heif,.heif"
            disabled={disabled || uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onFileSelected(document.type, file);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function PaymentEvidenceSubmitPage() {
  const { token = '' } = useParams<{ token: string }>();
  const platformApiActive = isPlatformApiEnabled();
  const turnstileSiteKey = readTurnstileSiteKey();
  const [payload, setPayload] = useState<PaymentEvidencePublicSubmissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploadingType, setUploadingType] = useState<PaymentEvidenceDocumentType | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);

  const resetTurnstile = useCallback(() => {
    setTurnstileToken('');
    setTurnstileResetNonce((value) => value + 1);
  }, []);
  const handleTurnstileExpire = useCallback(() => {
    setTurnstileToken('');
  }, []);
  const handleTurnstileError = useCallback(() => {
    setTurnstileToken('');
    toast.error('보안 확인을 완료하지 못했습니다.');
  }, []);

  const loadSubmission = useCallback(async () => {
    if (!platformApiActive) {
      setLoading(false);
      setLoadError('제출 서버 연결이 비활성화되어 있습니다.');
      return;
    }
    if (!token) {
      setLoading(false);
      setLoadError('제출 링크가 올바르지 않습니다.');
      return;
    }

    setLoading(true);
    setLoadError('');
    try {
      const result = await fetchPaymentEvidencePublicSubmissionViaBff({ token });
      setPayload(result);
    } catch (error) {
      setLoadError(resolveApiErrorMessage(error, '제출 링크를 확인하지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [platformApiActive, token]);

  useEffect(() => {
    void loadSubmission();
  }, [loadSubmission]);

  async function handleFileSelected(type: PaymentEvidenceDocumentType, file: File) {
    if (!token || !payload?.token.usable) return;
    if (!turnstileToken) {
      toast.error('보안 확인을 먼저 완료해 주세요.');
      return;
    }
    try {
      setUploadingType(type);
      const contentBase64 = await fileToBase64(file);
      const result = await uploadPaymentEvidencePublicSubmissionDocumentViaBff({
        token,
        upload: {
          type,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          contentBase64,
          turnstileToken,
        },
      });
      setPayload(result);
      toast.success(result.autoSubmitted ? '필수 문서 제출 완료' : '문서 업로드 완료');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '문서를 업로드하지 못했습니다.'));
    } finally {
      setUploadingType('');
      resetTurnstile();
    }
  }

  async function handleSubmit() {
    if (!token || !payload?.complete) return;
    if (!turnstileToken) {
      toast.error('보안 확인을 먼저 완료해 주세요.');
      return;
    }
    try {
      setSubmitting(true);
      const result = await submitPaymentEvidencePublicSubmissionViaBff({ token, turnstileToken });
      setPayload(result);
      toast.success('제출 완료');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '제출을 완료하지 못했습니다.'));
    } finally {
      setSubmitting(false);
      resetTurnstile();
    }
  }

  const turnstileReady = Boolean(turnstileSiteKey && turnstileToken);
  const disabled = !payload?.token.usable || payload.complete || !turnstileReady;
  const complete = Boolean(payload?.complete);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div className="min-w-0">
            <p className="text-[12px] text-slate-500" style={{ fontWeight: 700 }}>MYSC 지급증빙 제출</p>
            <h1 className="mt-1 truncate text-[22px]" style={{ fontWeight: 900, letterSpacing: 0 }}>
              {payload?.case.payeeName || '제출 링크 확인'}
            </h1>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex items-center gap-2 text-[13px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              제출 링크 확인 중
            </div>
          </div>
        ) : loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <Card className="w-full max-w-md border-rose-200 bg-white shadow-sm">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
                  <div>
                    <p className="text-[14px]" style={{ fontWeight: 800 }}>제출 링크를 열 수 없습니다.</p>
                    <p className="mt-1 text-[12px] text-slate-500">{loadError}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : payload ? (
          <div className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="space-y-4">
              <Card className="border-border/60 bg-white shadow-sm">
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] text-slate-500">{payload.case.campaignName}</p>
                      <p className="mt-1 text-[20px]" style={{ fontWeight: 900 }}>{formatWon(payload.case.expectedAmount)}</p>
                      <p className="mt-1 text-[12px] text-slate-500">
                        {payload.case.roleLabel || '역할 미지정'} · 지급 예정일 {formatDate(payload.case.expectedPayDate)}
                      </p>
                    </div>
                    <span className={`rounded-md border px-2 py-1 text-[11px] ${
                      complete
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : payload.token.usable
                          ? 'border-blue-200 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-slate-50 text-slate-600'
                    }`} style={{ fontWeight: 800 }}>
                      {complete ? '제출 완료' : payload.token.usable ? '제출 가능' : payload.token.reason || '사용 불가'}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-3 md:grid-cols-3">
                {payload.requiredDocuments.map((document) => (
                  <DocumentUploadCard
                    key={document.type}
                    document={document}
                    disabled={disabled}
                    uploading={uploadingType === document.type}
                    onFileSelected={handleFileSelected}
                  />
                ))}
              </div>
            </section>

            <aside className="space-y-3">
              <Card className="border-border/60 bg-white shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-teal-600" />
                    <p className="text-[13px]" style={{ fontWeight: 800 }}>보안 처리</p>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    제출 파일은 회사 Google Drive 정본 폴더에 저장되며, 내부 검수자만 접근합니다.
                  </p>
                  <div className="mt-3 rounded-md border bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                    링크 만료 {formatDate(payload.token.expiresAt)}
                  </div>
                  {payload.token.usable && !complete ? (
                    <div className="mt-3">
                      {turnstileSiteKey ? (
                        <TurnstileWidget
                          key={turnstileResetNonce}
                          siteKey={turnstileSiteKey}
                          onVerify={setTurnstileToken}
                          onExpire={handleTurnstileExpire}
                          onError={handleTurnstileError}
                          className="min-h-[65px]"
                        />
                      ) : (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                          Turnstile site key가 설정되지 않아 업로드가 잠겨 있습니다.
                        </div>
                      )}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Button
                type="button"
                className="h-10 w-full gap-2"
                disabled={!payload.complete || !payload.token.usable || !turnstileReady || submitting}
                onClick={handleSubmit}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />}
                제출 완료
              </Button>

              {complete && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    <span style={{ fontWeight: 800 }}>필수 문서 3종이 접수되었습니다.</span>
                  </div>
                </div>
              )}
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}
