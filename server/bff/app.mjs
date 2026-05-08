import express from 'express';
import { createAuditChainService } from './audit-chain.mjs';
import {
  createFirebaseTokenVerifier,
  extractRoleFromClaims,
  resolveAuthMode,
  resolveRequestIdentity,
} from './auth.mjs';
import { createFirestoreDb, resolveProjectId } from './firestore.mjs';
import { createGoogleDriveService } from './google-drive.mjs';
import { createGoogleGmailService } from './google-gmail.mjs';
import { createGoogleSheetsService } from './google-sheets.mjs';
import { createIdempotencyService } from './idempotency.mjs';
import { createPiiProtector } from './pii-protection.mjs';
import { createTriDocOcrService } from './tridoc-ocr.mjs';
import { createTurnstileVerifier } from './turnstile.mjs';
import { createRequestId } from './utils.mjs';
import { mountPaymentEvidenceRoutes } from './routes/payment-evidence.mjs';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'https://submit-mysc.com',
  'https://www.submit-mysc.com',
  'https://submit-mysc.vercel.app',
];

const INTERNAL_PATH_PREFIX = '/api/v1';

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeRole(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowedOrigins(value) {
  const configured = parseCsv(value);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function parseAdminEmails(env = process.env) {
  return Array.from(new Set([
    ...parseCsv(env.BFF_SUBMIT_MYSC_ADMIN_EMAILS),
    ...parseCsv(env.BFF_BOOTSTRAP_ADMIN_EMAILS),
    ...parseCsv(env.VITE_SUBMIT_MYSC_ADMIN_EMAILS),
    ...parseCsv(env.VITE_BOOTSTRAP_ADMIN_EMAILS),
  ].map(normalizeEmail).filter(Boolean)));
}

function isKnownSubmitMyscVercelOrigin(origin) {
  const normalized = readOptionalText(origin);
  if (!normalized) return false;
  return /^https:\/\/submit-mysc(?:-[a-z0-9-]+)?(?:-merryai-devs-projects)?\.vercel\.app$/i.test(normalized)
    || /^https:\/\/submitmysc(?:-[a-z0-9-]+)?(?:-merryai-devs-projects)?\.vercel\.app$/i.test(normalized);
}

function isAllowedOrigin(origin, allowedOrigins) {
  const normalized = readOptionalText(origin).replace(/\/+$/g, '');
  if (!normalized) return true;
  return allowedOrigins.includes(normalized) || isKnownSubmitMyscVercelOrigin(normalized);
}

function createCorsMiddleware({ allowedOrigins }) {
  return (req, res, next) => {
    const origin = readOptionalText(req.headers.origin).replace(/\/+$/g, '');
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
      res.status(403).json({ error: 'origin_not_allowed', message: 'Origin is not allowed' });
      return;
    }

    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization,content-type,idempotency-key,x-actor-email,x-actor-id,x-actor-role,x-request-id,x-tenant-id',
    );
    res.setHeader('access-control-expose-headers', 'x-request-id,x-idempotency-replayed');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

async function resolveRoleFromMemberDoc({ db, tenantId, actorId }) {
  const snap = await db.doc(`orgs/${tenantId}/members/${actorId}`).get();
  if (!snap.exists) return '';
  return normalizeRole(snap.data()?.role);
}

async function hardenFirebaseIdentity({ db, identity, env = process.env }) {
  if (identity.source !== 'firebase') return identity;

  const claimRole = normalizeRole(extractRoleFromClaims(identity.tokenClaims));
  if (claimRole) {
    return { ...identity, actorRole: claimRole };
  }

  const memberRole = await resolveRoleFromMemberDoc({
    db,
    tenantId: identity.tenantId,
    actorId: identity.actorId,
  });
  if (memberRole) {
    return { ...identity, actorRole: memberRole };
  }

  const bootstrapAdmins = parseAdminEmails(env);
  const actorEmail = normalizeEmail(identity.actorEmail);
  return {
    ...identity,
    actorRole: bootstrapAdmins.includes(actorEmail) ? 'admin' : undefined,
  };
}

function createAuthContextMiddleware({ db, projectId, env = process.env }) {
  const authMode = resolveAuthMode(env);
  const verifyToken = authMode === 'headers'
    ? null
    : createFirebaseTokenVerifier({ projectId });

  return async (req, res, next) => {
    try {
      const identity = await resolveRequestIdentity({
        authMode,
        verifyToken,
        readHeaderValue: (name) => req.header(name),
      });
      const hardened = await hardenFirebaseIdentity({ db, identity, env });
      req.context = {
        tenantId: hardened.tenantId,
        actorId: hardened.actorId,
        actorRole: hardened.actorRole,
        actorEmail: hardened.actorEmail,
        requestId: req.requestId,
        idempotencyKey: readOptionalText(req.header('idempotency-key')) || `idem_${req.requestId}`,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

function createErrorHandler() {
  return (error, req, res, _next) => {
    const statusCode = Number.isInteger(error?.statusCode)
      ? Math.min(Math.max(error.statusCode, 400), 599)
      : 500;
    const code = readOptionalText(error?.code) || (statusCode === 500 ? 'internal_error' : 'request_error');
    const message = statusCode >= 500
      ? 'Internal server error'
      : readOptionalText(error?.message) || 'Request failed';

    if (statusCode >= 500) {
      console.error('[submitMYSC BFF]', {
        requestId: req.requestId,
        error,
      });
    }

    res.status(statusCode).json({
      error: code,
      message,
      requestId: req.requestId,
    });
  };
}

export function createBffApp(options = {}) {
  const env = options.env || process.env;
  const projectId = options.projectId || resolveProjectId(env);
  const db = options.db || createFirestoreDb({ projectId });
  const now = options.now || (() => new Date().toISOString());
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(createCorsMiddleware({ allowedOrigins: parseAllowedOrigins(env.BFF_ALLOWED_ORIGINS) }));
  app.use((req, res, next) => {
    req.requestId = readOptionalText(req.header('x-request-id')) || createRequestId('bff');
    res.setHeader('x-request-id', req.requestId);
    next();
  });
  app.use(express.json({ limit: env.BFF_JSON_LIMIT || '18mb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'submitMYSC BFF',
      projectId,
    });
  });

  app.use(INTERNAL_PATH_PREFIX, createAuthContextMiddleware({ db, projectId, env }));

  mountPaymentEvidenceRoutes(app, {
    db,
    now,
    idempotencyService: options.idempotencyService || createIdempotencyService(db),
    auditChainService: options.auditChainService || createAuditChainService(db, { now }),
    piiProtector: options.piiProtector || createPiiProtector(env),
    driveService: options.driveService || createGoogleDriveService({ env }),
    gmailService: options.gmailService || createGoogleGmailService({ env }),
    googleSheetsService: options.googleSheetsService || createGoogleSheetsService({ env }),
    ocrService: options.ocrService || createTriDocOcrService({ env }),
    turnstileVerifier: options.turnstileVerifier || createTurnstileVerifier(),
  });

  app.use(createErrorHandler());
  return app;
}
