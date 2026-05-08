import { describe, expect, it } from 'vitest';
import {
  buildSubmissionQrFileName,
  isPublicSubmissionPath,
  isPublicSubmissionUrl,
} from './submission-access';

describe('submission access helpers', () => {
  it('recognizes one-time public submission links without requiring Google auth', () => {
    expect(isPublicSubmissionPath('/submit/petok_abc.secret')).toBe(true);
    expect(isPublicSubmissionPath('/payment-evidence/submit/petok_abc.secret')).toBe(true);
    expect(isPublicSubmissionPath('/admin')).toBe(false);

    expect(isPublicSubmissionUrl('https://submit-mysc.com/submit/petok_abc.secret')).toBe(true);
    expect(isPublicSubmissionUrl('https://submit-mysc.com/admin')).toBe(false);
  });

  it('creates a stable QR download filename for a case', () => {
    expect(buildSubmissionQrFileName({
      caseId: 'PAY/2026:05 001',
      payeeName: '외부 제출자',
    })).toBe('submit-mysc-PAY_2026_05_001-external-submission-qr.png');
  });
});
