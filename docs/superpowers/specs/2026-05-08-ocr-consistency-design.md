# OCR Consistency Design

submitMYSC should run each externally uploaded payment-evidence document through the Gemma4 TriDoc VLLM extraction service, store the extracted fields on the case document, and compute a visible match probability for the review queue.

The VLLM service is called from the BFF, not the browser. The BFF posts `multipart/form-data` to `/extract` with `file`, `doc_type`, and `max_new_tokens`. The current service returns `pred_json.document_type`, `pred_json.fields`, and timing metadata, but it does not return calibrated model probabilities. submitMYSC therefore stores model extraction output separately from a deterministic `0..1` consistency score computed from field completeness, document-type match, and cross-document comparisons.

Security posture is fail-closed for production data. OCR egress is blocked unless all of these are true:

- OCR is explicitly enabled.
- The endpoint is HTTPS.
- The request uses a server-side bearer authorization header.
- The endpoint hostname is in `PAYMENT_EVIDENCE_OCR_ALLOWED_HOSTS`.
- Ephemeral `trycloudflare.com` quick tunnels are not used unless explicitly allowed for a temporary test window.

When the security gate blocks OCR, the original upload is still stored in Drive, but the document receives `ocrStatus=BLOCKED` and no file bytes are sent to the model service.

External upload flow:

1. Public submitter uploads `payment_confirmation`, `id_card`, or `bankbook`.
2. BFF stores the original file in Google Drive.
3. BFF calls the TriDoc extraction service only if OCR is enabled, security policy passes, and the upload is an image.
4. BFF stores `extractedFields`, `parserConfidence`, and OCR metadata on the uploaded document.
5. BFF recomputes case-level `ocrConsistency` from the updated case.
6. Existing review evaluation uses extracted fields to surface missing-field, mismatch, and approval-blocking issues.

The admin review queue shows both document-level OCR status and case-level match probability. Existing submitted cases can be reprocessed with an admin-only OCR action that downloads Drive files and runs the same extraction path.

Operational constraints:

- PDF uploads are accepted by the submission pipeline, but this VLLM endpoint currently opens images via PIL. The first production-safe integration skips PDF OCR and leaves the document in `SKIPPED` status for manual review unless the model service adds safe PDF rendering.
- The quick Cloudflare tunnel URL and bearer token are runtime configuration, not source code. Quick tunnels are test-only and blocked by default in production.
- Scores are deterministic confidence scores, not statistically calibrated model probabilities.
