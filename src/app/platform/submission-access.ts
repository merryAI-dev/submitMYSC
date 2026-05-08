const PUBLIC_SUBMISSION_PATHS = [
  /^\/submit\/[^/?#]+(?:[?#].*)?$/,
  /^\/payment-evidence\/submit\/[^/?#]+(?:[?#].*)?$/,
];

function normalizeText(value: string | undefined): string {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function sanitizeFileSegment(value: string, fallback: string): string {
  const cleaned = normalizeText(value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

export function isPublicSubmissionPath(pathname: string): boolean {
  const normalized = normalizeText(pathname);
  return PUBLIC_SUBMISSION_PATHS.some((pattern) => pattern.test(normalized));
}

export function isPublicSubmissionUrl(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return isPublicSubmissionPath(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return isPublicSubmissionPath(normalized);
  }
}

export function buildSubmissionQrFileName({
  caseId,
}: {
  caseId: string;
  payeeName?: string;
}): string {
  return `submit-mysc-${sanitizeFileSegment(caseId, 'submission')}-external-submission-qr.png`;
}
