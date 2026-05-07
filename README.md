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

## Deploy

The Vercel project serves Vite static output and rewrites `/api/*` to `api/bff.js`.

Required production env:

- Firebase Web SDK env vars and `VITE_FIREBASE_AUTH_ENABLED=true`
- `BFF_AUTH_MODE=firebase_required`
- Firebase Admin service account
- Google Drive service account and evidence root/shared drive IDs
- Cloudflare Turnstile site and secret keys
- `VITE_SUBMIT_MYSC_ADMIN_EMAILS` and `BFF_SUBMIT_MYSC_ADMIN_EMAILS`

Firestore/Auth API activation is still required for the new project. If `gcloud services enable` returns permission denied, ask a Google Cloud org admin to enable:

- `firestore.googleapis.com`
- `identitytoolkit.googleapis.com`
- `firebase.googleapis.com`
