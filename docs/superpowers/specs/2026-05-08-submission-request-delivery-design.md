# Submission Request Delivery Design

## Goal

submitMYSC should start from a request delivery workflow: an admin creates a payment evidence request, sends the recipient a one-time upload link and QR code by email, and the item enters the review queue only after the recipient uploads the required three documents.

## Product Flow

Admins use `/admin` to create a request with recipient details, payment metadata, and the responsible sender email. The sender email is used as the Gmail sender and reply-to address so recipient replies go to the responsible manager. After sending, the case is stored with `workflowStatus: sent`, but it is not shown in the review queue. It appears in a request tracking list instead.

Recipients open the emailed link or QR without Google login, upload the payment confirmation, ID copy, and bankbook copy, and complete Turnstile. When all required documents exist, the public submission pipeline automatically moves the case to `submitted`. Only `submitted`, `approved`, and `closed` cases appear in the review queue.

## Delivery Model

The BFF owns email delivery. It creates/reissues the one-time token, builds the public submission URL, generates a QR PNG, and sends a Gmail API message with the QR attached. The Gmail sender is the admin-entered `requestSenderEmail`; the `Reply-To` defaults to the same address and can be overridden.

Gmail API sending requires Workspace domain-wide delegation or an equivalent Gmail credential that can send as the selected sender. If Gmail is not configured or rejects the sender, the request and link are still created, and the case records `deliveryStatus: FAILED` with a safe error message so the admin can copy the link manually.

## Data Fields

`PaymentEvidenceCase` gains request/delivery fields:

- `recipientEmail`
- `requestSenderEmail`
- `requestReplyToEmail`
- `deliveryStatus`
- `deliveryLastSentAt`
- `deliverySubject`
- `gmailMessageId`
- `deliveryError`

## Architecture

The existing case/token/public-upload pipeline remains intact. The changes add:

- a Gmail delivery service in `server/bff/google-gmail.mjs`
- email delivery options on the existing `submission-link` and `reject-and-reissue` APIs
- a request creation form in `PaymentEvidenceVaultPage`
- a request tracking table for `draft`, `sent`, and `rejected` cases
- a review queue filter that hides pre-submission requests

## DocuSeal Reference

DocuSeal keeps request delivery attached to the submitter and lets `reply_to` come from submitter preferences, template config, or the creating user. submitMYSC follows the same operational idea: the responsible sender is explicit per request, and recipient replies go to that person rather than to a generic no-reply mailbox.
