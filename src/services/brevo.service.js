'use strict';

/**
 * Stage 5 — Brevo (transactional email).
 *
 * Endpoint: POST https://api.brevo.com/v3/smtp/email
 * Auth:     header `api-key: <BREVO_API_KEY>`
 * Request:  { sender:{name,email}, to:[{email,name}], subject, htmlContent }
 * Response: 201 { messageId }
 *
 * Safety: respects config.dryRun (DRY_RUN env). When dry-run, the payload is
 * logged and NO request is made. Isolated from app.js until verified.
 */

const axios = require('axios');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');
const { generateColdEmail } = require('../utils/emailTemplate');

const BREVO_BASE_URL = 'https://api.brevo.com/v3';
const SEND_EMAIL_PATH = '/smtp/email';

// Retry policy (transient only).
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Basic email sanity check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = axios.create({
  baseURL: BREVO_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

function toBrevoError(err) {
  if (err.response) {
    const { status, data } = err.response;
    const detail = (data && (data.message || data.code)) || '';
    const e = new Error(
      detail
        ? `Brevo request failed (HTTP ${status}): ${detail}`
        : `Brevo request failed (HTTP ${status})`
    );
    e.status = status;
    e.responseData = data;
    return e;
  }
  if (err.request) {
    const e = new Error(`Brevo no response (network/timeout): ${err.message}`);
    e.status = 0;
    return e;
  }
  return err;
}

function isRetryable(err) {
  // Retry transient HTTP (429/5xx) and network errors only.
  if (err.response) return RETRYABLE_STATUS.has(err.response.status);
  return Boolean(err.request);
}

/**
 * POST the email with retry/backoff on transient errors.
 * Client validation errors (4xx except 429) are NOT retried.
 */
async function postEmail(payload) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await client.post(SEND_EMAIL_PATH, payload, {
        headers: { 'api-key': config.brevoApiKey },
      });
      return res.data; // { messageId }
    } catch (err) {
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        attempt += 1;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        const status = err.response ? err.response.status : 'network';
        logger.warn(
          `Brevo transient failure (${status}). Retry ${attempt}/${MAX_RETRIES} in ${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      throw toBrevoError(err);
    }
  }
}

/**
 * Build the Brevo send payload from a contact (+ optional template override).
 * @param {object} contact { fullName, email, companyName, title }
 * @param {object} [templateData] { subject?, htmlContent? } overrides generated content
 */
function buildPayload(contact, templateData = {}) {
  const generated = generateColdEmail(contact);
  const subject = templateData.subject || generated.subject;
  const htmlContent = templateData.htmlContent || generated.htmlContent;

  return {
    sender: {
      email: config.brevoSenderEmail,
      name: config.brevoSenderName || 'Outreach Team',
    },
    to: [{ email: contact.email, name: contact.fullName || undefined }],
    subject,
    htmlContent,
  };
}

/**
 * Send one cold email.
 *  - DRY_RUN (config.dryRun, default true): logs payload, makes NO request.
 *  - Real send: validates sender + recipient, posts to Brevo.
 *
 * @param {object} contact { fullName, email, companyName, title }
 * @param {object} [templateData] optional { subject, htmlContent } override
 * @returns {Promise<object>} { dryRun, messageId?, payload }
 */
async function sendEmail(contact, templateData = {}) {
  if (!contact || !contact.email || !EMAIL_RE.test(contact.email)) {
    throw new Error('sendEmail: valid contact.email required');
  }

  const payload = buildPayload(contact, templateData);

  if (config.dryRun) {
    logger.info(
      `DRY_RUN: would send to ${contact.email} | subject="${payload.subject}"`
    );
    logger.debug(`DRY_RUN payload: ${JSON.stringify(payload)}`);
    return { dryRun: true, payload };
  }

  // Real send — sender identity is mandatory.
  if (!config.brevoSenderEmail) {
    throw new Error(
      'sendEmail: BREVO_SENDER_EMAIL not set. Configure a Brevo-verified sender.'
    );
  }

  const data = await postEmail(payload);
  logger.info(`Brevo sent to ${contact.email} | messageId=${data && data.messageId}`);
  return { dryRun: false, messageId: data && data.messageId, payload };
}

module.exports = {
  sendEmail,
  buildPayload,
  _internals: { toBrevoError, isRetryable, EMAIL_RE },
};
