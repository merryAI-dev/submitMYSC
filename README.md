# submitMYSC

Independent MYSC payment evidence submission app.

This project owns the public submitter page and the admin vault for payment evidence:

- `/submit/:token` public evidence upload link
- `/admin` MYSC admin evidence vault
- `/api/public/payment-evidence/*` public BFF endpoints
- `/api/v1/payment-evidence/*` admin BFF endpoints

It is intentionally not coupled to `inner-platform`.

## Local Development

Install dependencies, then run the frontend and BFF separately:

```bash
npm install
npm run dev:local
npm run bff:dev
```

Copy `.env.example` to the active environment provider and fill Firebase, Google Drive, and Cloudflare Turnstile values before using the real pipeline.

## Firebase Isolation

submitMYSC must use its own Firebase project:

- project ID: `submit-mysc-20260507`
- project number: `391150252419`
- Web app ID: `1:391150252419:web:9580f04037d7e9460e06b6`

Do not point this app at `mysc-bmp-14173451` or any `inner-platform-*` Firebase project. Those are separate production data stores.

Current project setup:

- Firestore `(default)` database: `asia-northeast3`, delete protection enabled
- Firestore rules: deny all client reads/writes; BFF uses Admin SDK
- BFF service account: `submit-mysc-bff@submit-mysc-20260507.iam.gserviceaccount.com`
- local service account key path: `/Users/boram/.codex/secrets/submitMYSC/submit-mysc-bff-service-account.json`

## Google Drive

submitMYSC Drive uploads use the same isolated BFF service account.

- Service account: `submit-mysc-bff@submit-mysc-20260507.iam.gserviceaccount.com`
- Shared Drive ID: `0AKK1hZvoh4gCUk9PVA`
- Evidence root folder ID: `1ojv7OSbG-Or3W6vdwvd7-f4ab6qkwOMt`
- Evidence root URL: `https://drive.google.com/drive/folders/1ojv7OSbG-Or3W6vdwvd7-f4ab6qkwOMt`
- Evidence ledger spreadsheet ID: `1JLfW7Mc3NssrS6iv7agk4KtatmuvXX-0M6PRpMRJvNo`
- Evidence ledger URL: `https://docs.google.com/spreadsheets/d/1JLfW7Mc3NssrS6iv7agk4KtatmuvXX-0M6PRpMRJvNo/edit`

For production uploads, add the service account to the target MYSC Shared Drive as a Content manager, create/select a folder inside that Shared Drive, then set both `GOOGLE_DRIVE_SHARED_DRIVE_ID` and `GOOGLE_DRIVE_EVIDENCE_ROOT_FOLDER_ID`. A regular My Drive folder shared with the service account is not enough: service accounts do not have usable My Drive storage quota for uploaded evidence files or Sheets.

## Deploy

The Vercel project serves Vite static output and rewrites `/api/*` to `api/bff.js`.

Required production env:

- Firebase Web SDK env vars and `VITE_FIREBASE_AUTH_ENABLED=true`
- `BFF_AUTH_MODE=firebase_required`
- Firebase Admin service account
- Google Drive service account and evidence root/shared drive IDs
- Cloudflare Turnstile site and secret keys
- `VITE_SUBMIT_MYSC_ADMIN_EMAILS` and `BFF_SUBMIT_MYSC_ADMIN_EMAILS`

Enabled APIs:

- `firebase.googleapis.com`
- `firestore.googleapis.com`
- `identitytoolkit.googleapis.com`
- `drive.googleapis.com`
- `sheets.googleapis.com`
