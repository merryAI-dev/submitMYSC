import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
let firestoreSettingsApplied = false;

const SUBMIT_MYSC_FIREBASE_PROJECT_ID = 'submit-mysc-20260507';
const FORBIDDEN_FIREBASE_PROJECT_IDS = new Set([
  'mysc-bmp-14173451',
  'inner-platform-live-20260316',
  'inner-platform-qa-20260310',
]);

function normalizeProjectId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function assertSubmitMyscFirebaseProjectId(projectId, env = process.env) {
  const normalized = normalizeProjectId(projectId);
  if (isFirestoreEmulatorEnabled(env)) return normalized || SUBMIT_MYSC_FIREBASE_PROJECT_ID;
  if (!normalized) {
    throw new Error('submitMYSC Firebase project id is required');
  }
  if (FORBIDDEN_FIREBASE_PROJECT_IDS.has(normalized)) {
    throw new Error(`Refusing to use non-submitMYSC Firebase project: ${normalized}`);
  }
  if (normalized !== SUBMIT_MYSC_FIREBASE_PROJECT_ID) {
    throw new Error(`submitMYSC must use Firebase project ${SUBMIT_MYSC_FIREBASE_PROJECT_ID}, got ${normalized}`);
  }
  return normalized;
}

export function resolveProjectId(env = process.env) {
  const resolved = normalizeProjectId(env.SUBMIT_MYSC_FIREBASE_PROJECT_ID)
    || normalizeProjectId(env.FIREBASE_PROJECT_ID)
    || normalizeProjectId(env.VITE_FIREBASE_PROJECT_ID)
    || normalizeProjectId(env.GCLOUD_PROJECT)
    || SUBMIT_MYSC_FIREBASE_PROJECT_ID;
  return assertSubmitMyscFirebaseProjectId(resolved, env);
}

export function isFirestoreEmulatorEnabled(env = process.env) {
  return !!env.FIRESTORE_EMULATOR_HOST;
}

function normalizeServiceAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const normalized = { ...raw };
  if (typeof normalized.private_key === 'string') {
    normalized.private_key = normalized.private_key.replace(/\\n/g, '\n');
  }
  return normalized;
}

function parseJsonValue(value, sourceName) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${sourceName}: expected valid JSON`);
  }
}

export function resolveServiceAccount(env = process.env) {
  const rawJson = typeof env.FIREBASE_SERVICE_ACCOUNT_JSON === 'string'
    ? env.FIREBASE_SERVICE_ACCOUNT_JSON.trim()
    : '';
  if (rawJson) {
    return normalizeServiceAccount(parseJsonValue(rawJson, 'FIREBASE_SERVICE_ACCOUNT_JSON'));
  }

  const rawBase64 = typeof env.FIREBASE_SERVICE_ACCOUNT_BASE64 === 'string'
    ? env.FIREBASE_SERVICE_ACCOUNT_BASE64.trim()
    : '';
  if (!rawBase64) return null;

  let decoded;
  try {
    decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
  } catch {
    throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_BASE64: expected base64 string');
  }

  return normalizeServiceAccount(parseJsonValue(decoded, 'FIREBASE_SERVICE_ACCOUNT_BASE64'));
}

export function getOrInitAdminApp({ projectId } = {}) {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const resolvedProjectId = projectId || resolveProjectId();
  const useEmulator = isFirestoreEmulatorEnabled();
  const serviceAccount = resolveServiceAccount();

  if (useEmulator) {
    return initializeApp({ projectId: resolvedProjectId });
  }

  if (serviceAccount) {
    return initializeApp({
      projectId: resolvedProjectId,
      credential: cert(serviceAccount),
    });
  }

  try {
    return initializeApp({
      projectId: resolvedProjectId,
      credential: applicationDefault(),
    });
  } catch {
    return initializeApp({ projectId: resolvedProjectId });
  }
}

export function createFirestoreDb(options = {}) {
  const app = getOrInitAdminApp(options);
  const db = getFirestore(app);
  if (!firestoreSettingsApplied) {
    db.settings({ ignoreUndefinedProperties: true });
    firestoreSettingsApplied = true;
  }
  return db;
}
