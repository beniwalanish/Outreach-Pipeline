'use strict';

/**
 * Stage 2 — Prospeo
 *   2a Search Person  : domain(s) -> decision makers (name, title, LinkedIn).
 *   2b Enrich Person  : person_id -> revealed (verified) email.
 *   2b Bulk Enrich    : up to 50 person_ids -> emails (default pipeline path).
 *
 * Endpoints (all POST, header X-KEY + Content-Type: application/json):
 *   /search-person
 *   /enrich-person
 *   /bulk-enrich-person
 *
 * Rate limits: 1 req/sec AND 20 req/min (both enforced below).
 */

const axios = require('axios');
const crypto = require('crypto');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

const PROSPEO_BASE_URL = 'https://api.prospeo.io';
const SEARCH_PERSON_PATH = '/search-person';
const ENRICH_PERSON_PATH = '/enrich-person';
const BULK_ENRICH_PERSON_PATH = '/bulk-enrich-person';

// Bulk enrichment.
// Prospeo max per bulk request = 50. Overridable for diagnostics (set
// PROSPEO_BULK_BATCH_SIZE=1 to isolate 429s to a single record).
const BULK_BATCH_SIZE = Math.min(config.prospeoBulkBatchSize || 50, 50);

// Default enrichment options.
const DEFAULT_ENRICH_OPTIONS = Object.freeze({
  only_verified_email: true,
  enrich_mobile: false,
  only_verified_mobile: false,
});

// Pagination / result caps.
const DEFAULT_MAX_RESULTS = 25; // finite default; NEVER Infinity
const MAX_PAGES = 50; // hard ceiling on calls per search

// Retry policy (transient only).
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Rate limits.
// Per-second spacing is overridable via PROSPEO_MIN_INTERVAL_MS (default 5000
// = 1 req / 5s) to back off from 429s during diagnosis.
const MIN_INTERVAL_MS = config.prospeoMinIntervalMs || 5000;
const MAX_PER_MINUTE = 20; // <= 20 req/min
const MINUTE_MS = 60_000;
const MAX_RETRY_AFTER_MS = 120_000; // cap server-directed Retry-After waits

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = axios.create({
  baseURL: PROSPEO_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/**
 * Enforces both limits: >=1s gap between calls, and <=20 calls per rolling minute.
 * Shared across all requests in this process.
 */
const rateLimiter = (() => {
  let lastCallAt = 0;
  let timestamps = []; // call times within the last minute

  return {
    async acquire() {
      // 1) per-second spacing
      const sinceLast = Date.now() - lastCallAt;
      if (sinceLast < MIN_INTERVAL_MS) {
        await sleep(MIN_INTERVAL_MS - sinceLast);
      }
      // 2) per-minute ceiling
      const now = Date.now();
      timestamps = timestamps.filter((t) => now - t < MINUTE_MS);
      if (timestamps.length >= MAX_PER_MINUTE) {
        const waitMs = MINUTE_MS - (now - timestamps[0]) + 5;
        logger.warn(`Prospeo: per-minute cap reached, waiting ${waitMs}ms`);
        await sleep(waitMs);
        const t = Date.now();
        timestamps = timestamps.filter((ts) => t - ts < MINUTE_MS);
      }
      lastCallAt = Date.now();
      timestamps.push(lastCallAt);
    },
  };
})();

/**
 * Log Prospeo rate-limit / quota signals from response headers.
 *
 * Prospeo's ACTUAL headers (docs, /api-docs/rate-limits) — NOT x-ratelimit-*:
 *   x-daily-request-left, x-minute-request-left, x-daily-reset-seconds,
 *   x-minute-reset-seconds, x-daily-rate-limit, x-minute-rate-limit,
 *   x-second-rate-limit
 *
 * @param {object} headers axios response headers (lowercased keys)
 * @param {string} tag context label (e.g. 'OK 200' or 'ERR 429')
 */
function logRateHeaders(headers, tag) {
  if (!headers || typeof headers !== 'object') return;

  const rate = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (
      key.startsWith('x-daily') ||
      key.startsWith('x-minute') ||
      key.startsWith('x-second') ||
      key.startsWith('x-ratelimit') || // generic fallback, just in case
      key === 'retry-after'
    ) {
      rate[key] = v;
    }
  }

  if (Object.keys(rate).length > 0) {
    logger.info(
      `Prospeo [${tag}] rate headers: ` +
        `daily-left=${rate['x-daily-request-left']} ` +
        `minute-left=${rate['x-minute-request-left']} ` +
        `second-limit=${rate['x-second-rate-limit']} ` +
        `daily-limit=${rate['x-daily-rate-limit']} ` +
        `minute-limit=${rate['x-minute-rate-limit']} ` +
        `daily-reset-s=${rate['x-daily-reset-seconds']} ` +
        `minute-reset-s=${rate['x-minute-reset-seconds']} ` +
        `retry-after=${rate['retry-after']} ` +
        `| raw=${JSON.stringify(rate)}`
    );
  } else {
    // No rate headers => dump full set once so we can diagnose blind.
    logger.warn(
      `Prospeo [${tag}] no rate headers present. All headers: ${JSON.stringify(
        headers
      )}`
    );
  }
}

/**
 * Parse Retry-After header (seconds or HTTP-date) into ms. Null if absent/invalid.
 */
function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * Extract Prospeo's error_code from a response body. Prospeo returns errors as
 * HTTP 4xx/429 with body { error:true, error_code:"RATE_LIMITED" | ... }.
 * Older/edge bodies used message/error_message — kept as fallback.
 */
function extractProspeoCode(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data.error_code ||
    data.message ||
    data.error_message ||
    data.detail ||
    null
  );
}

/**
 * Map a Prospeo error/HTTP failure to a clear Error.
 */
function toProspeoError(err) {
  if (err.response) {
    const { status, data } = err.response;
    const code = extractProspeoCode(data);
    const e = new Error(
      code
        ? `Prospeo request failed (HTTP ${status}): ${code}`
        : `Prospeo request failed (HTTP ${status})`
    );
    e.status = status;
    e.prospeoCode = code; // e.g. RATE_LIMITED, INSUFFICIENT_CREDITS, INVALID_REQUEST
    e.responseData = data;
    return e;
  }
  if (err.request) {
    const e = new Error(`Prospeo no response (network/timeout): ${err.message}`);
    e.status = 0;
    return e;
  }
  return err;
}

function isRetryable(err) {
  if (err.response) return RETRYABLE_STATUS.has(err.response.status);
  return Boolean(err.request);
}

/**
 * Generic Prospeo POST: rate-limited, retry/backoff on transient errors only.
 * Shared by search-person, enrich-person, bulk-enrich-person.
 *
 * Prospeo signals logical errors with `error:true` in a 200 body; the code lives
 * in `message` (e.g. NO_MATCH, INVALID_DATAPOINTS, INSUFFICIENT_CREDITS). Those
 * are non-transient => thrown immediately (never retried).
 *
 * @param {string} path endpoint path
 * @param {object} body request payload
 * @returns {Promise<object>} parsed response data
 */
async function prospeoPost(path, body) {
  let attempt = 0;
  for (;;) {
    await rateLimiter.acquire();
    try {
      const res = await client.post(path, body, {
        headers: { 'X-KEY': config.prospeoApiKey },
      });
      logRateHeaders(res.headers, `OK ${res.status}`);
      if (res.data && res.data.error === true) {
        const code = extractProspeoCode(res.data) || 'UNKNOWN_ERROR';
        const e = new Error(`Prospeo error: ${code}`);
        e.prospeoCode = code; // non-retryable by design
        throw e;
      }
      return res.data;
    } catch (err) {
      // Surface status, body, rate/quota headers on HTTP failures (esp. 429).
      if (err.response) {
        const { status, data, headers } = err.response;
        logger.error(
          new Error(
            `Prospeo [ERR ${status}] ${path} error_code=${extractProspeoCode(data)} ` +
              `body=${JSON.stringify(data)}`
          )
        );
        logRateHeaders(headers, `ERR ${status}`);
      }
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        attempt += 1;
        const status = err.response ? err.response.status : 'network';
        // Prefer server-directed Retry-After; else exponential backoff.
        const retryAfter = err.response
          ? parseRetryAfterMs(err.response.headers)
          : null;
        const delay =
          retryAfter != null
            ? retryAfter
            : RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(
          `Prospeo transient failure (${status}). Retry ${attempt}/${MAX_RETRIES} in ${delay}ms` +
            (retryAfter != null ? ' (server Retry-After)' : '')
        );
        await sleep(delay);
        continue;
      }
      throw toProspeoError(err);
    }
  }
}

/**
 * Normalize one raw result item into our contact shape.
 *
 * VERIFIED against a live search-person response (2026-06-08). Confirmed keys:
 *   person.person_id, first_name, last_name, full_name, current_job_title,
 *   linkedin_url; company.name, company.domain.
 * Fallbacks retained for resilience. Unknown fields resolve to null (never throws).
 *
 * @param {object} item { person, company }
 * @returns {object|null} normalized contact, or null if unusable
 */
function normalizePerson(item) {
  if (!item || typeof item !== 'object') return null;
  const p = item.person || {};
  const c = item.company || {};

  const firstName = p.first_name || p.firstName || null;
  const lastName = p.last_name || p.lastName || null;
  const fullName =
    p.full_name ||
    p.fullName ||
    p.name ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  const linkedinUrl =
    p.linkedin_url || p.linkedinUrl || p.linkedin || p.linkedin_profile || null;

  // Prefer clean `domain` (e.g. openai.com) over `website` (has protocol).
  const companyDomainRaw =
    c.domain || c.website || c.websites || c.company_domain || null;
  const companyDomain = companyDomainRaw
    ? String(Array.isArray(companyDomainRaw) ? companyDomainRaw[0] : companyDomainRaw)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '') // strip protocol if a website slipped through
        .replace(/\/.*$/, '') // strip any path
    : null;

  return {
    personId: p.person_id || p.id || p.uuid || null,
    firstName,
    lastName,
    fullName,
    // Confirmed: current_job_title. Fallbacks for resilience.
    title:
      p.current_job_title ||
      p.job_title ||
      p.title ||
      p.position ||
      null,
    linkedinUrl: linkedinUrl ? String(linkedinUrl).trim() : null,
    companyName: c.name || c.company_name || null,
    companyDomain,
  };
}

/**
 * Stable dedup key for a contact.
 */
function dedupKey(contact) {
  return (
    contact.personId ||
    contact.linkedinUrl ||
    (contact.fullName && contact.companyDomain
      ? `${contact.fullName}@${contact.companyDomain}`
      : null)
  );
}

/**
 * Search people by arbitrary Prospeo filters, walking pagination.
 *
 * @param {object} filters Prospeo filter object (caller-supplied, spec-faithful).
 * @param {number} [maxResults=DEFAULT_MAX_RESULTS] Finite cap on returned people.
 * @returns {Promise<object[]>} normalized, deduped contacts.
 */
async function searchPeople(filters, maxResults = DEFAULT_MAX_RESULTS) {
  if (!config.prospeoApiKey) {
    throw new Error('PROSPEO_API_KEY missing. Set it in .env');
  }
  if (!filters || typeof filters !== 'object') {
    throw new Error('searchPeople: filters object required');
  }
  if (!Number.isFinite(maxResults) || maxResults <= 0) {
    throw new Error(
      `searchPeople: maxResults must be a finite positive number (got ${maxResults})`
    );
  }

  const byKey = new Map();
  let page = 1;
  let totalPage = 1;

  do {
    const data = await prospeoPost(SEARCH_PERSON_PATH, { page, filters });
    const results = Array.isArray(data.results) ? data.results : [];

    for (const item of results) {
      const contact = normalizePerson(item);
      if (!contact) continue;
      const key = dedupKey(contact);
      // Keyless contacts still kept (rare); use a unique fallback.
      byKey.set(key || `__anon_${byKey.size}`, contact);
      if (byKey.size >= maxResults) break;
    }

    const pg = data.pagination || {};
    totalPage = Number(pg.total_page) || page;
    logger.info(
      `Prospeo page ${page}/${totalPage}: +${results.length} results ` +
        `(collected ${byKey.size})`
    );

    if (byKey.size >= maxResults) break;
    if (results.length === 0) break;
    if (page >= MAX_PAGES) {
      logger.warn(`Prospeo: hit MAX_PAGES (${MAX_PAGES}) cap. Stopping.`);
      break;
    }
    page += 1;
  } while (page <= totalPage);

  return [...byKey.values()].slice(0, maxResults);
}

/**
 * Stage 2 entry point: find decision makers for one or more company domains.
 * Continues on per-domain failure (graceful) — one bad domain won't abort all.
 *
 * @param {string[]} domains Company domains from Stage 1.
 * @param {number} [maxResultsPerDomain=DEFAULT_MAX_RESULTS]
 * @returns {Promise<object[]>} normalized contacts across all domains (deduped).
 */
async function searchPeopleByCompanyDomains(
  domains,
  maxResultsPerDomain = DEFAULT_MAX_RESULTS
) {
  if (!Array.isArray(domains)) {
    throw new Error('searchPeopleByCompanyDomains: domains array required');
  }

  const byKey = new Map();

  for (const raw of domains) {
    const domain = String(raw || '').trim().toLowerCase();
    if (!domain) continue;

    const filters = { company: { websites: { include: [domain] } } };

    try {
      logger.info(`Prospeo: searching people for "${domain}"`);
      const contacts = await searchPeople(filters, maxResultsPerDomain);
      for (const contact of contacts) {
        const key = dedupKey(contact) || `__anon_${byKey.size}`;
        if (!byKey.has(key)) byKey.set(key, contact);
      }
    } catch (err) {
      // Graceful: log and move to next domain.
      logger.error(
        new Error(`Prospeo: domain "${domain}" failed: ${err.message}`)
      );
      continue;
    }
  }

  const all = [...byKey.values()];
  logger.info(`Prospeo: ${all.length} unique contacts across ${domains.length} domains`);
  return all;
}

/**
 * Locate the {person, company} item inside an enrich response.
 *
 * NEEDS-VERIFICATION: single-enrich wrapper key not confirmed. Handles the most
 * likely shapes — top-level {person,company}, or nested under response/result/data.
 * Isolated here so one diagnostic fixes it without touching logic.
 */
function extractEnrichItem(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.person || data.company) return data;
  const w = data.response || data.result || data.data || null;
  if (w && (w.person || w.company)) return w;
  return null;
}

/**
 * Normalize an enriched item into the outreach-ready contact shape.
 * Extends normalizePerson() with email fields. `fallback` (the original
 * search-person record) fills any field enrich omits.
 *
 * Email mapping (confirmed keys): person.email.{email,status,revealed}.
 *
 * @param {object} item     { person, company }
 * @param {object} [fallback] prior normalized record to backfill from
 * @returns {object|null}
 */
function normalizeEnrichedPerson(item, fallback = {}) {
  const base = normalizePerson(item) || {};
  const email = (item && item.person && item.person.email) || {};

  return {
    personId: base.personId || fallback.personId || null,
    email: email.email || null,
    emailStatus: email.status || null,
    emailRevealed: email.revealed === true,
    firstName: base.firstName || fallback.firstName || null,
    lastName: base.lastName || fallback.lastName || null,
    fullName: base.fullName || fallback.fullName || null,
    linkedinUrl: base.linkedinUrl || fallback.linkedinUrl || null,
    title: base.title || fallback.title || null,
    companyName: base.companyName || fallback.companyName || null,
    companyDomain: base.companyDomain || fallback.companyDomain || null,
  };
}

/**
 * Stage 2b — enrich ONE person by person_id (reveals verified email).
 * Reuses the shared client, retry strategy, and rate limiter via prospeoPost().
 *
 * @param {string} personId person_id from search-person results
 * @param {object} [options] overrides DEFAULT_ENRICH_OPTIONS
 * @returns {Promise<object>} normalized enriched contact
 */
async function enrichPerson(personId, options = {}) {
  if (!personId || typeof personId !== 'string') {
    throw new Error('enrichPerson: personId required (string)');
  }
  const body = { person_id: personId, ...DEFAULT_ENRICH_OPTIONS, ...options };

  logger.info(`Prospeo: enriching person ${personId}`);
  const data = await prospeoPost(ENRICH_PERSON_PATH, body);

  const item = extractEnrichItem(data);
  if (!item) {
    throw new Error('enrichPerson: unexpected response shape (no person/company)');
  }
  return normalizeEnrichedPerson(item);
}

/**
 * Locate the array of enriched items inside a bulk response.
 * Confirmed primary path: response.data.matched[]
 *   (siblings: not_matched[], invalid_datapoints[]).
 * Each matched item: { identifier, person, company }.
 */
function extractBulkItems(data) {
  if (!data || typeof data !== 'object') return [];
  const arr = data.matched || data.results || data.response || null;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Stage 2b (default path) — bulk-enrich up to BULK_BATCH_SIZE people per request.
 * Chunks input into batches, auto-generates a stable identifier per person, and
 * maps responses back by that identifier (falling back to person_id).
 *
 * Graceful: a failed batch is logged and skipped; remaining batches continue.
 *
 * Request schema (confirmed): { ...options, data: [ { identifier, person_id } ] }.
 * Response (confirmed): { matched: [ { identifier, person, company } ], ... }.
 *
 * @param {Array<object>} people [{ personId, firstName, lastName, companyDomain }]
 * @param {object} [options] overrides DEFAULT_ENRICH_OPTIONS
 * @returns {Promise<object[]>} normalized enriched contacts
 */
async function bulkEnrichPeople(people, options = {}) {
  if (!Array.isArray(people)) {
    throw new Error('bulkEnrichPeople: people array required');
  }
  const valid = people.filter((p) => p && p.personId);
  if (valid.length === 0) return [];

  // Stable identifier per person (used to map response -> input).
  const withId = valid.map((p) => ({
    identifier: p.personId || crypto.randomUUID(),
    input: p,
  }));

  // Build one request item — official schema: { identifier, person_id }.
  const buildBulkItem = ({ identifier, input }) => ({
    identifier,
    person_id: input.personId,
  });

  const enrichOpts = { ...DEFAULT_ENRICH_OPTIONS, ...options };
  const out = [];

  for (let i = 0; i < withId.length; i += BULK_BATCH_SIZE) {
    const batch = withId.slice(i, i + BULK_BATCH_SIZE);
    const batchNo = Math.floor(i / BULK_BATCH_SIZE) + 1;
    const inputByIdentifier = new Map(batch.map((b) => [b.identifier, b.input]));

    const body = { ...enrichOpts, data: batch.map(buildBulkItem) };

    try {
      logger.info(`Prospeo bulk-enrich batch ${batchNo}: ${batch.length} people`);
      // Exact payload sent to /bulk-enrich-person. X-KEY lives in the HTTP
      // header (NOT this body), so logging the body exposes no secret.
      logger.info(
        `Prospeo bulk-enrich batch ${batchNo} payload: ${JSON.stringify(body)}`
      );
      const data = await prospeoPost(BULK_ENRICH_PERSON_PATH, body);
      const items = extractBulkItems(data);

      for (const it of items) {
        // Official: matched[].identifier. Fallbacks for resilience.
        const id =
          it.identifier ||
          it.id ||
          (it.person && it.person.person_id) ||
          null;
        const fallback =
          (id && inputByIdentifier.get(id)) ||
          // last-resort match by person_id
          batch.find(
            (b) => b.input.personId === (it.person && it.person.person_id)
          )?.input ||
          {};
        out.push(normalizeEnrichedPerson(it, fallback));
      }
    } catch (err) {
      logger.error(
        new Error(`Prospeo bulk-enrich batch ${batchNo} failed: ${err.message}`)
      );
      continue; // graceful: skip batch, keep going
    }
  }

  logger.info(`Prospeo bulk-enrich: ${out.length} enriched from ${valid.length} input`);
  return out;
}

module.exports = {
  searchPeople,
  searchPeopleByCompanyDomains,
  enrichPerson,
  bulkEnrichPeople,
  normalizePerson,
  normalizeEnrichedPerson,
  DEFAULT_ENRICH_OPTIONS,
  BULK_BATCH_SIZE,
  _internals: { toProspeoError, isRetryable, dedupKey, extractEnrichItem, extractBulkItems },
};
