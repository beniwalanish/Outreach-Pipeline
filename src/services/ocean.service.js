'use strict';

/**
 * Stage 1 — Ocean.io
 * Find companies similar to a seed domain.
 *
 * Official endpoint (per docs/searchCompaniesV3):
 *   POST https://api.ocean.io/v3/search/companies
 *   Auth header: x-api-token: <token>
 *
 * Pagination: cursor-based via `searchAfter`.
 *   - Pass returned `searchAfter` into the next request.
 *   - Response without `searchAfter` => no more pages.
 *
 * This module returns ONLY company domains (deduped, lowercased).
 */

const axios = require('axios');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

const OCEAN_BASE_URL = 'https://api.ocean.io';
const SEARCH_COMPANIES_PATH = '/v3/search/companies';

// Doc limits.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 10000;

// Safety caps — prevent runaway pagination from draining credits.
const DEFAULT_MAX_RESULTS = 100; // finite default; NEVER Infinity
const MAX_PAGES = 50; // hard ceiling on API calls per search
const PAGE_DELAY_MS = 250; // throttle between pages (avoid 429 storms)

// Retry policy (transient failures only).
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Single axios instance so config/headers live in one place.
const client = axios.create({
  baseURL: OCEAN_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map a documented Ocean.io HTTP status to a clear Error.
 * Documented codes: 400, 402 (insufficient credits), 403 (invalid token),
 * 404 (not found), 422 (validation error).
 */
function toOceanError(err) {
  if (err.response) {
    const { status, data } = err.response;
    const messages = {
      400: 'Bad request',
      402: 'Insufficient credits',
      403: 'Invalid API token',
      404: 'Not found',
      422: 'Validation error',
    };
    const base = messages[status] || `Ocean.io request failed (HTTP ${status})`;
    const detail =
      (data && (data.detail || data.message || data.error)) || '';
    const e = new Error(detail ? `${base}: ${detail}` : base);
    e.status = status;
    e.responseData = data;
    return e;
  }
  if (err.request) {
    const e = new Error(`Ocean.io no response (network/timeout): ${err.message}`);
    e.status = 0;
    return e;
  }
  return err;
}

function isRetryable(err) {
  if (err.response) return RETRYABLE_STATUS.has(err.response.status);
  // No response => network error / timeout => retry.
  return Boolean(err.request);
}

/**
 * POST one page to Ocean.io with retry/backoff on transient errors.
 * @param {object} body Full request body (size, searchAfter, filters, fields).
 * @returns {Promise<object>} Parsed response data.
 */
async function postSearchPage(body) {
  let attempt = 0;
  // attempt 0 = first try; retries = attempts 1..MAX_RETRIES
  for (;;) {
    try {
      const res = await client.post(SEARCH_COMPANIES_PATH, body, {
        headers: { 'x-api-token': config.oceanApiKey },
      });
      return res.data;
    } catch (err) {
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        attempt += 1;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        const status = err.response ? err.response.status : 'network';
        logger.warn(
          `Ocean.io transient failure (${status}). Retry ${attempt}/${MAX_RETRIES} in ${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      throw toOceanError(err);
    }
  }
}

/**
 * Run a company search and walk all pages via searchAfter.
 * Spec-faithful: caller supplies the filter objects exactly as the API expects.
 *
 * @param {object}  params
 * @param {object}  [params.companiesFilters={}] Company-level filters (API schema).
 * @param {object}  [params.peopleFilters]        Optional people-level filters.
 * @param {string[]}[params.fields]               Fields to return (e.g. ['domain','name']).
 * @param {number}  [params.size=DEFAULT_PAGE_SIZE] Page size (1..MAX_PAGE_SIZE).
 * @param {number}  [params.maxResults=DEFAULT_MAX_RESULTS] Stop after this many companies.
 * @returns {Promise<object[]>} Raw company objects from all pages.
 */
async function searchCompanies({
  companiesFilters = {},
  peopleFilters,
  fields,
  size = DEFAULT_PAGE_SIZE,
  maxResults = DEFAULT_MAX_RESULTS,
} = {}) {
  if (!config.oceanApiKey) {
    throw new Error('OCEAN_API_KEY missing. Set it in .env');
  }
  // Hard guard: maxResults must be a finite positive number. No Infinity.
  if (!Number.isFinite(maxResults) || maxResults <= 0) {
    throw new Error(
      `searchCompanies: maxResults must be a finite positive number (got ${maxResults})`
    );
  }

  const collected = [];
  let searchAfter;
  let page = 0;

  do {
    // Request only what's still needed → fewer credits, never over-fetch.
    const remaining = maxResults - collected.length;
    const pageSize = Math.min(Math.max(1, size), MAX_PAGE_SIZE, remaining);

    const body = { size: pageSize, companiesFilters };
    if (searchAfter) body.searchAfter = searchAfter;
    if (peopleFilters) body.peopleFilters = peopleFilters;
    if (fields) body.fields = fields;

    const data = await postSearchPage(body);
    page += 1;

    const companies = Array.isArray(data.companies) ? data.companies : [];
    collected.push(...companies);

    logger.info(
      `Ocean.io page ${page}: +${companies.length} companies ` +
        `(total so far ${collected.length}${
          data.total ? ` / ${data.total} matches` : ''
        })`
    );

    // Cursor advances; absence => last page.
    searchAfter = data.searchAfter || null;

    if (collected.length >= maxResults) break;
    if (companies.length === 0) break; // empty page => stop, don't spin
    if (page >= MAX_PAGES) {
      logger.warn(`Ocean.io: hit MAX_PAGES (${MAX_PAGES}) cap. Stopping pagination.`);
      break;
    }
    if (searchAfter) await sleep(PAGE_DELAY_MS); // throttle next call
  } while (searchAfter);

  return collected.slice(0, maxResults);
}

/**
 * Extract deduped, normalized domains from raw result items.
 * Confirmed shape: companies[i] = { company: { domain, ... }, relevance }.
 * Falls back to a top-level `domain` for resilience.
 * @param {object[]} items
 * @returns {string[]}
 */
function extractDomains(items) {
  const seen = new Set();
  for (const item of items) {
    const co = item && item.company ? item.company : item;
    const domain = (co && co.domain ? String(co.domain) : '')
      .trim()
      .toLowerCase();
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/**
 * Stage 1 entry point: given a seed domain, return similar company domains.
 * Uses the official Ocean.io lookalike filter (`lookalikeDomains`).
 *
 * @param {string} seedDomain  e.g. 'openai.com'
 * @param {number} [maxResults=50] Max similar domains to return.
 * @returns {Promise<string[]>} similar company domains (excludes the seed).
 */
async function findSimilarCompanies(seedDomain, maxResults = 50) {
  if (!seedDomain || typeof seedDomain !== 'string') {
    throw new Error('seedDomain required (string)');
  }
  const seed = seedDomain.trim().toLowerCase();

  // Official Ocean.io lookalike filter schema.
  const companiesFilters = {
    lookalikeDomains: [seed],
  };

  logger.info(`Ocean.io: finding companies similar to "${seed}"`);

  // NOTE: not passing `fields` — full company objects reliably include `domain`.
  // (A restrictive `fields` list previously returned objects without domain.)
  const companies = await searchCompanies({
    companiesFilters,
    size: maxResults,
    maxResults,
  });

  // Drop the seed itself if Ocean returns it among results.
  const domains = extractDomains(companies).filter((d) => d !== seed);

  logger.info(`Ocean.io: ${domains.length} similar domains for "${seed}"`);
  return domains;
}

module.exports = {
  findSimilarCompanies,
  searchCompanies,
  extractDomains,
  // exported for testing
  _internals: { toOceanError, isRetryable },
};
