import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import QRCode from 'qrcode';
import { resolveServiceAccount } from './firestore.mjs';

const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export class GoogleGmailServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GoogleGmailServiceError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'google_gmail_error';
    this.details = options.details;
  }
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalBool(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeEmail(value) {
  return readOptionalText(value).toLowerCase();
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseJsonValue(value, sourceName) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  throw new GoogleGmailServiceError(`Invalid ${sourceName}: expected valid JSON`, {
    statusCode: 500,
    code: 'gmail_service_account_invalid',
  });
}

function normalizeServiceAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const normalized = { ...raw };
  if (typeof normalized.private_key === 'string') {
    normalized.private_key = normalized.private_key.replace(/\\n/g, '\n');
  }
  return normalized;
}

function resolveGmailServiceAccount(env = process.env) {
  const rawPath = readOptionalText(env.GOOGLE_GMAIL_SERVICE_ACCOUNT_PATH);
  if (rawPath) {
    return normalizeServiceAccount(parseJsonValue(
      fs.readFileSync(rawPath, 'utf8'),
      'GOOGLE_GMAIL_SERVICE_ACCOUNT_PATH',
    ));
  }

  const rawJson = readOptionalText(env.GOOGLE_GMAIL_SERVICE_ACCOUNT_JSON);
  if (rawJson) return normalizeServiceAccount(parseJsonValue(rawJson, 'GOOGLE_GMAIL_SERVICE_ACCOUNT_JSON'));

  const rawBase64 = readOptionalText(env.GOOGLE_GMAIL_SERVICE_ACCOUNT_BASE64);
  if (rawBase64) {
    return normalizeServiceAccount(parseJsonValue(
      Buffer.from(rawBase64, 'base64').toString('utf8'),
      'GOOGLE_GMAIL_SERVICE_ACCOUNT_BASE64',
    ));
  }

  const drivePath = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH);
  if (drivePath) {
    return normalizeServiceAccount(parseJsonValue(
      fs.readFileSync(drivePath, 'utf8'),
      'GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH',
    ));
  }

  const driveJson = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  if (driveJson) return normalizeServiceAccount(parseJsonValue(driveJson, 'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'));

  const driveBase64 = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_BASE64);
  if (driveBase64) {
    return normalizeServiceAccount(parseJsonValue(
      Buffer.from(driveBase64, 'base64').toString('utf8'),
      'GOOGLE_DRIVE_SERVICE_ACCOUNT_BASE64',
    ));
  }

  return resolveServiceAccount(env);
}

export function resolveGoogleGmailServiceConfig(env = process.env) {
  const serviceAccount = resolveGmailServiceAccount(env);
  const allowedSenderDomains = parseCsv(env.GOOGLE_GMAIL_ALLOWED_SENDER_DOMAINS || 'mysc.co.kr');
  return {
    serviceAccount,
    enabled: readOptionalBool(env.GOOGLE_GMAIL_SEND_ENABLED, false),
    dryRun: readOptionalBool(env.GOOGLE_GMAIL_DRY_RUN, false),
    allowedSenderDomains,
    defaultSenderEmail: normalizeEmail(env.GOOGLE_GMAIL_DEFAULT_SENDER_EMAIL),
  };
}

function assertConfigured(config) {
  if (!config.enabled) {
    throw new GoogleGmailServiceError(
      'Gmail send is not enabled. Set GOOGLE_GMAIL_SEND_ENABLED=true.',
      { statusCode: 503, code: 'google_gmail_not_enabled' },
    );
  }
  if (config.dryRun) return;
  if (!config.serviceAccount?.client_email || !config.serviceAccount?.private_key) {
    throw new GoogleGmailServiceError(
      'Gmail service account is not configured. Set GOOGLE_GMAIL_SERVICE_ACCOUNT_JSON or GOOGLE_GMAIL_SERVICE_ACCOUNT_BASE64.',
      { statusCode: 503, code: 'google_gmail_not_configured' },
    );
  }
}

function domainOf(email) {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');
  return atIndex >= 0 ? normalized.slice(atIndex + 1) : '';
}

function assertSenderAllowed(config, senderEmail) {
  const senderDomain = domainOf(senderEmail);
  if (!senderEmail || !senderDomain) {
    throw new GoogleGmailServiceError('senderEmail is required', {
      statusCode: 400,
      code: 'gmail_sender_required',
    });
  }
  if (config.allowedSenderDomains.length && !config.allowedSenderDomains.includes(senderDomain)) {
    throw new GoogleGmailServiceError('Sender email domain is not allowed', {
      statusCode: 400,
      code: 'gmail_sender_domain_not_allowed',
    });
  }
}

function encodeMimeHeader(value) {
  const raw = readOptionalText(value);
  if (!raw) return '';
  return `=?UTF-8?B?${Buffer.from(raw, 'utf8').toString('base64')}?=`;
}

function encodeAddress(email, name = '') {
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = readOptionalText(name);
  if (!normalizedName) return `<${normalizedEmail}>`;
  return `${encodeMimeHeader(normalizedName)} <${normalizedEmail}>`;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function formatWon(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return `${amount.toLocaleString('ko-KR')}원`;
}

function buildDefaultSubject(paymentCase) {
  return `[MYSC] 비용지급 증빙 제출 요청 - ${readOptionalText(paymentCase.payeeName) || paymentCase.id}`;
}

function buildDefaultHtml({ paymentCase, submissionUrl, expiresAt, message }) {
  const customMessage = readOptionalText(message);
  const amount = formatWon(paymentCase.expectedAmount);
  return [
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#0f172a">',
    `<p>${escapeHtml(paymentCase.payeeName)}님, 안녕하세요.</p>`,
    customMessage
      ? `<p>${nl2br(customMessage)}</p>`
      : '<p>비용지급을 위한 증빙 서류 제출을 요청드립니다.</p>',
    '<ul>',
    `<li>제출 대상: ${escapeHtml(paymentCase.campaignName || paymentCase.campaignId || paymentCase.id)}</li>`,
    amount ? `<li>예정 금액: ${escapeHtml(amount)}</li>` : '',
    paymentCase.expectedPayDate ? `<li>예정 지급일: ${escapeHtml(paymentCase.expectedPayDate)}</li>` : '',
    expiresAt ? `<li>링크 만료: ${escapeHtml(new Date(expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</li>` : '',
    '</ul>',
    '<p>아래 버튼 또는 첨부된 QR 이미지를 통해 제출 페이지에 접속해 주세요. Google 로그인은 필요하지 않습니다.</p>',
    `<p><a href="${escapeHtml(submissionUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700">증빙 서류 제출하기</a></p>`,
    `<p style="font-size:12px;color:#475569">버튼이 열리지 않으면 다음 링크를 복사해 브라우저에 붙여넣어 주세요:<br>${escapeHtml(submissionUrl)}</p>`,
    '<p>감사합니다.<br>MYSC</p>',
    '</div>',
  ].filter(Boolean).join('\n');
}

function buildMimeMessage({
  senderEmail,
  senderName,
  recipientEmail,
  replyToEmail,
  subject,
  html,
  qrPng,
  qrFileName,
}) {
  const boundary = `submit_mysc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${encodeAddress(senderEmail, senderName || 'MYSC')}`,
    `To: ${encodeAddress(recipientEmail)}`,
    replyToEmail ? `Reply-To: ${encodeAddress(replyToEmail)}` : '',
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}`,
    `Content-Type: image/png; name="${qrFileName}"`,
    `Content-Disposition: attachment; filename="${qrFileName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    qrPng.toString('base64'),
    `--${boundary}--`,
    '',
  ];

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createGoogleGmailService(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = options.config || resolveGoogleGmailServiceConfig(env);

  async function sendPaymentEvidenceSubmissionRequest({
    paymentCase,
    submissionUrl,
    expiresAt,
    senderEmail,
    senderName,
    recipientEmail,
    replyToEmail,
    subject,
    message,
  }) {
    const normalizedSenderEmail = normalizeEmail(senderEmail || config.defaultSenderEmail);
    const normalizedRecipientEmail = normalizeEmail(recipientEmail);
    const normalizedReplyToEmail = normalizeEmail(replyToEmail || normalizedSenderEmail);

    assertConfigured(config);
    assertSenderAllowed(config, normalizedSenderEmail);
    if (!normalizedRecipientEmail) {
      throw new GoogleGmailServiceError('recipientEmail is required', {
        statusCode: 400,
        code: 'gmail_recipient_required',
      });
    }

    const emailSubject = readOptionalText(subject) || buildDefaultSubject(paymentCase);
    const html = buildDefaultHtml({
      paymentCase,
      submissionUrl,
      expiresAt,
      message,
    });
    const qrPng = await QRCode.toBuffer(submissionUrl, {
      type: 'png',
      margin: 1,
      width: 512,
      errorCorrectionLevel: 'M',
    });
    const qrFileName = `submit-mysc-${readOptionalText(paymentCase.id) || 'request'}-qr.png`;

    if (config.dryRun) {
      return {
        status: 'DRY_RUN',
        messageId: `dry_run_${Date.now()}`,
        senderEmail: normalizedSenderEmail,
        recipientEmail: normalizedRecipientEmail,
        replyToEmail: normalizedReplyToEmail,
        subject: emailSubject,
      };
    }

    const jwtClient = new JWT({
      email: config.serviceAccount.client_email,
      key: config.serviceAccount.private_key,
      scopes: [GMAIL_SEND_SCOPE],
      subject: normalizedSenderEmail,
    });
    const authHeaders = await jwtClient.getRequestHeaders();
    const rawMime = buildMimeMessage({
      senderEmail: normalizedSenderEmail,
      senderName,
      recipientEmail: normalizedRecipientEmail,
      replyToEmail: normalizedReplyToEmail,
      subject: emailSubject,
      html,
      qrPng,
      qrFileName,
    });
    const response = await fetchImpl(`${GMAIL_API_BASE_URL}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw: base64Url(rawMime) }),
    });

    if (!response.ok) {
      const details = await readJsonResponse(response);
      throw new GoogleGmailServiceError(`Gmail API request failed (${response.status})`, {
        statusCode: response.status >= 500 ? 502 : response.status,
        code: 'google_gmail_api_error',
        details,
      });
    }

    const data = await readJsonResponse(response);
    return {
      status: 'SENT',
      messageId: readOptionalText(data?.id),
      threadId: readOptionalText(data?.threadId),
      senderEmail: normalizedSenderEmail,
      recipientEmail: normalizedRecipientEmail,
      replyToEmail: normalizedReplyToEmail,
      subject: emailSubject,
    };
  }

  return {
    getConfig() {
      return {
        enabled: config.enabled,
        dryRun: config.dryRun,
        serviceAccountEmail: readOptionalText(config.serviceAccount?.client_email),
        allowedSenderDomains: config.allowedSenderDomains,
        defaultSenderEmail: config.defaultSenderEmail,
      };
    },
    sendPaymentEvidenceSubmissionRequest,
  };
}
