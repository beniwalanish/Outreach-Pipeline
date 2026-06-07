'use strict';

/**
 * Centralized environment config.
 * Loads .env once, validates required keys, exports a frozen config object.
 * Import this instead of touching process.env elsewhere.
 *
 * Usage (CommonJS):
 *   const { config } = require('../config/env');
 *   config.oceanApiKey
 */

const dotenv = require('dotenv');

dotenv.config();

/**
 * Schema-driven env definition.
 * key      -> env var name
 * prop     -> config property name
 * required -> throw if missing/empty
 */
const ENV_SCHEMA = [
  { key: 'OCEAN_API_KEY', prop: 'oceanApiKey', required: true },
  { key: 'PROSPEO_API_KEY', prop: 'prospeoApiKey', required: true },
  { key: 'BREVO_API_KEY', prop: 'brevoApiKey', required: true },
  // Brevo sender identity — must be a Brevo-verified sender. Optional at load
  // time; sendEmail() fails fast if missing when actually sending.
  { key: 'BREVO_SENDER_EMAIL', prop: 'brevoSenderEmail', required: false },
  { key: 'BREVO_SENDER_NAME', prop: 'brevoSenderName', required: false },
];

/**
 * Numeric tunables. Parsed as positive integers; fall back to `default`
 * when unset or invalid.
 */
const NUMERIC_SCHEMA = [
  { key: 'MAX_SIMILAR_COMPANIES', prop: 'maxSimilarCompanies', default: 5 },
  { key: 'MAX_PEOPLE_PER_COMPANY', prop: 'maxPeoplePerCompany', default: 10 },
];

function buildConfig() {
  const config = {};
  const missing = [];

  for (const { key, prop, required } of ENV_SCHEMA) {
    const raw = process.env[key];
    const value = typeof raw === 'string' ? raw.trim() : raw;

    if (required && !value) {
      missing.push(key);
      continue;
    }
    // Optional vars default to null when absent => explicit "not configured".
    config[prop] = value || null;
  }

  for (const { key, prop, default: def } of NUMERIC_SCHEMA) {
    const n = parseInt(process.env[key], 10);
    config[prop] = Number.isInteger(n) && n > 0 ? n : def;
  }

  // DRY_RUN: default TRUE (safe). Only an explicit "false" enables real sends.
  config.dryRun = String(process.env.DRY_RUN).toLowerCase() !== 'false';

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Add them to your .env file.`
    );
  }

  return Object.freeze(config);
}

const config = buildConfig();

module.exports = { config };
