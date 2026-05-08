# Submission Request Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request-first evidence submission delivery with Gmail sender/reply-to control and keep the review queue limited to submitted work.

**Architecture:** Keep the current BFF token and public upload pipeline. Add Gmail delivery as a BFF service used by submission-link creation and reissue, then add admin UI for creating and tracking pre-review requests.

**Tech Stack:** React, TypeScript, Express BFF, Firebase Admin/Firestore, google-auth-library JWT, Gmail REST API, qrcode.

---

### Task 1: Extend Case Metadata

**Files:**
- Modify: `src/app/platform/payment-evidence.ts`
- Modify: `server/bff/schemas.mjs`
- Modify: `server/bff/routes/payment-evidence.mjs`

- [ ] Add recipient, sender, reply-to, and delivery status fields to `PaymentEvidenceCase`.
- [ ] Accept those fields in payment evidence case upsert payloads.
- [ ] Persist the fields through `sanitizePaymentEvidenceCasePayload`.

### Task 2: Add Gmail Delivery Service

**Files:**
- Create: `server/bff/google-gmail.mjs`
- Modify: `server/bff/app.mjs`
- Modify: `.env.example`

- [ ] Resolve Gmail service-account credentials from `GOOGLE_GMAIL_SERVICE_ACCOUNT_*`, falling back to existing Google Drive service-account env.
- [ ] Use JWT subject impersonation for the selected sender email.
- [ ] Build a multipart MIME email with HTML body and QR PNG attachment.
- [ ] Return `SENT`, `DRY_RUN`, or throw a typed `GoogleGmailServiceError`.

### Task 3: Send Requests From Token APIs

**Files:**
- Modify: `server/bff/schemas.mjs`
- Modify: `server/bff/routes/payment-evidence.mjs`
- Modify: `src/app/lib/platform-bff-client.ts`

- [ ] Extend `submission-link` and `reject-and-reissue` payloads with `sendEmail`, `recipientEmail`, `senderEmail`, `replyToEmail`, `emailSubject`, and `emailMessage`.
- [ ] After token creation, call Gmail delivery when `sendEmail` is true.
- [ ] Update the case with delivery status, message id, timestamps, and safe error details.
- [ ] Return delivery metadata to the frontend.

### Task 4: Add Request-First Admin UI

**Files:**
- Modify: `src/app/components/evidence/PaymentEvidenceVaultPage.tsx`

- [ ] Add a compact request form above the queue.
- [ ] Use the current admin email as the default sender and reply-to.
- [ ] Create/upsert a draft case, then generate/send the submission link in one button action.
- [ ] Show request tracking rows for `draft`, `sent`, and `rejected`.
- [ ] Filter the review queue to `submitted`, `approved`, and `closed`.

### Task 5: Verify

**Commands:**
- `npm test`
- `npx tsc --noEmit`
- `npm run build`

- [ ] Fix any regressions.
- [ ] Commit the completed implementation.
