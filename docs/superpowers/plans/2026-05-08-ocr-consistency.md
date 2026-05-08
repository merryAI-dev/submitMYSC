# OCR Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VLLM OCR extraction and visible match probability to the payment evidence review queue.

**Architecture:** Add a focused TriDoc OCR BFF service that normalizes the FastAPI response into document fields and metadata. All production OCR egress passes a fail-closed security gate before file bytes leave the BFF. Reuse the existing payment-evidence domain evaluation for cross-document consistency, and add a small case-level score object for “일치 확률”.

**Tech Stack:** Express BFF, Firebase Admin/Firestore, Google Drive API, Vitest, React/TypeScript.

---

### Task 1: OCR Adapter

**Files:**
- Create: `server/bff/tridoc-ocr.mjs`
- Test: `server/bff/tridoc-ocr.test.ts`

- [ ] Write failing tests for disabled mode, production security blocking, image extraction, PDF skip, response normalization, and consistency scoring.
- [ ] Implement `createTriDocOcrService`, `normalizeTriDocExtractResponse`, `computePaymentEvidenceOcrConsistency`, and `applyOcrResultToPaymentEvidenceDocument`.
- [ ] Verify `npx vitest run server/bff/tridoc-ocr.test.ts`.

### Task 2: BFF Route Wiring

**Files:**
- Modify: `server/bff/app.mjs`
- Modify: `server/bff/routes/payment-evidence.mjs`
- Test: `server/bff/payment-evidence-domain.test.ts`

- [ ] Inject the OCR service into payment-evidence routes.
- [ ] Run OCR after public and internal Drive uploads.
- [ ] Add admin route `POST /api/v1/payment-evidence/cases/:caseId/ocr/reprocess`.
- [ ] Persist `case.ocrConsistency` and document OCR metadata.
- [ ] Make production OCR fail closed unless HTTPS, bearer auth, host allowlist, and non-ephemeral tunnel checks pass.

### Task 3: Client API and UI

**Files:**
- Modify: `src/app/platform/payment-evidence.ts`
- Modify: `src/app/lib/platform-bff-client.ts`
- Modify: `src/app/components/evidence/PaymentEvidenceVaultPage.tsx`

- [ ] Add types for document OCR metadata and case-level OCR consistency.
- [ ] Add BFF client helper for OCR reprocess.
- [ ] Show OCR status/confidence on document cards and case-level 일치 확률 in the detail panel.

### Task 4: Verification and Deploy

**Files:**
- Modify env only through Vercel CLI.

- [ ] Run `npm test`, `npx tsc --noEmit`, and `npm run build`.
- [ ] Add production env for OCR endpoint/auth/enabled.
- [ ] Deploy production and alias `submit-mysc.com`.
- [ ] Verify BFF health and OCR service health.
