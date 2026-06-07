'use strict';

/**
 * Outreach data pipeline (Stages 1–3, no Brevo yet).
 *
 *   domain
 *     → Ocean.findSimilarCompanies        (Stage 1)
 *     → take first N similar              (MAX_SIMILAR_COMPANIES)
 *     → Prospeo.searchPeopleByCompanyDomains (Stage 2a)
 *     → take top M people per company     (MAX_PEOPLE_PER_COMPANY)
 *     → Prospeo.bulkEnrichPeople          (Stage 2b, default path)
 *     → filter emailRevealed && emailStatus==='VERIFIED'
 *     → outputs/contacts.json
 *
 * Stages run independently so you can resume from saved intermediates
 * WITHOUT re-spending API credits:
 *
 *   node src/app.js openai.com                 # full pipeline
 *   node src/app.js openai.com --stage ocean   # just Stage 1
 *   node src/app.js --stage search             # reuse outputs/ocean.json
 *   node src/app.js --stage enrich             # reuse outputs/people.json
 *   node src/app.js --stage filter             # reuse outputs/enriched.json (no API)
 *
 * Flags: --max-similar N  --max-people M  --input <file>  --dry-run
 * --dry-run skips network calls and only re-runs file-based stages (filter).
 */

const path = require('path');
const fs = require('fs/promises');

const { config } = require('./config/env');
const { logger } = require('./utils/logger');
const ocean = require('./services/ocean.service');
const prospeo = require('./services/prospeo.service');
const brevo = require('./services/brevo.service');

const OUTPUT_DIR = path.join(__dirname, '..', 'outputs');
const FILES = {
  ocean: path.join(OUTPUT_DIR, 'ocean.json'),
  people: path.join(OUTPUT_DIR, 'people.json'),
  enriched: path.join(OUTPUT_DIR, 'enriched.json'),
  contacts: path.join(OUTPUT_DIR, 'contacts.json'),
  sendReport: path.join(OUTPUT_DIR, 'send-report.json'),
};

// Email validity (mirror of brevo's check) for pre-send skipping.
const EMAIL_RE = brevo._internals.EMAIL_RE;

// ---------- IO helpers ----------

async function saveJson(file, data) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  logger.info(`Saved ${path.relative(process.cwd(), file)}`);
}

async function loadJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

// ---------- Stages ----------

/** Stage 1: similar company domains. */
async function stageOcean(domain, maxSimilar) {
  if (!domain) throw new Error('stageOcean: domain required');
  const domains = await ocean.findSimilarCompanies(domain, maxSimilar);
  logger.info(`Companies discovered: ${domains.length}`);
  await saveJson(FILES.ocean, { seed: domain, domains });
  return domains;
}

/** Stage 2a: people across the similar domains (capped per company). */
async function stageSearch(domains, maxPeople) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('stageSearch: domains array required (run ocean first)');
  }
  const people = await prospeo.searchPeopleByCompanyDomains(domains, maxPeople);
  logger.info(`People discovered: ${people.length}`);
  await saveJson(FILES.people, people);
  return people;
}

/** Stage 2b: bulk-enrich people to reveal verified emails. */
async function stageEnrich(people) {
  if (!Array.isArray(people) || people.length === 0) {
    throw new Error('stageEnrich: people array required (run search first)');
  }
  const enriched = await prospeo.bulkEnrichPeople(people);
  const matches = enriched.filter((p) => p.email);
  logger.info(`Enrich matches (any email): ${matches.length}/${enriched.length}`);
  await saveJson(FILES.enriched, enriched);
  return enriched;
}

/** Stage 3: keep only revealed + VERIFIED, map to final output shape. No API. */
function stageFilter(enriched) {
  if (!Array.isArray(enriched)) {
    throw new Error('stageFilter: enriched array required');
  }
  const contacts = enriched
    .filter((p) => p.emailRevealed === true && p.emailStatus === 'VERIFIED')
    .map((p) => ({
      companyDomain: p.companyDomain,
      companyName: p.companyName,
      fullName: p.fullName,
      title: p.title,
      email: p.email,
      linkedinUrl: p.linkedinUrl,
    }));
  logger.info(`Final verified contacts: ${contacts.length}`);
  return contacts;
}

/**
 * Stage 5 (send): contacts.json -> dedup by email -> DRY_RUN gate -> Brevo.
 * Continues on per-contact failure. Brevo stays isolated behind sendEmail().
 *
 * @param {object[]} contacts final contacts (output shape from stageFilter)
 * @returns {Promise<object>} send report
 */
async function stageSend(contacts) {
  if (!Array.isArray(contacts)) {
    throw new Error('stageSend: contacts array required');
  }

  // Dedup by normalized email; skip invalid/missing emails.
  const seen = new Set();
  const unique = [];
  let invalidSkipped = 0;

  for (const c of contacts) {
    const email = String(c && c.email ? c.email : '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      invalidSkipped += 1;
      continue;
    }
    if (seen.has(email)) continue; // never send duplicates
    seen.add(email);
    unique.push({ ...c, email });
  }

  const report = {
    dryRun: config.dryRun,
    total: contacts.length,
    unique: unique.length,
    sent: 0,
    skipped: invalidSkipped, // invalid/duplicate dropped before sending
    failed: 0,
    results: [],
  };

  logger.info(
    `Send: total=${report.total} unique=${report.unique} ` +
      `invalid/dup-skipped=${invalidSkipped} dryRun=${config.dryRun}`
  );

  for (const contact of unique) {
    try {
      const res = await brevo.sendEmail(contact);
      report.sent += 1;
      report.results.push({
        email: contact.email,
        status: res.dryRun ? 'dry-run' : 'sent',
        messageId: res.messageId || null,
      });
    } catch (err) {
      report.failed += 1;
      report.results.push({
        email: contact.email,
        status: 'failed',
        reason: err.message,
      });
      logger.error(new Error(`Send failed for ${contact.email}: ${err.message}`));
      continue; // per-contact resilience
    }
  }

  logger.info(
    `Send done: sent=${report.sent} skipped=${report.skipped} failed=${report.failed}` +
      (config.dryRun ? ' (DRY_RUN — no emails actually sent)' : '')
  );
  await saveJson(FILES.sendReport, report);
  return report;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { stage: 'all', domain: null, dryRun: false, input: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--stage') args.stage = rest[++i];
    else if (a === '--max-similar') args.maxSimilar = parseInt(rest[++i], 10);
    else if (a === '--max-people') args.maxPeople = parseInt(rest[++i], 10);
    else if (a === '--input') args.input = rest[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (!a.startsWith('--') && !args.domain) args.domain = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const maxSimilar = args.maxSimilar || config.maxSimilarCompanies;
  const maxPeople = args.maxPeople || config.maxPeoplePerCompany;

  logger.info(
    `Pipeline start | stage=${args.stage} domain=${args.domain || '(from file)'} ` +
      `maxSimilar=${maxSimilar} maxPeople=${maxPeople} dryRun=${args.dryRun}`
  );

  if (args.dryRun && ['all', 'ocean', 'search', 'enrich'].includes(args.stage)) {
    logger.warn(
      'Dry-run: network stages skipped. Only file-based stages (filter) run. ' +
        'Use --stage filter to process existing outputs/enriched.json.'
    );
    if (args.stage !== 'filter') return;
  }

  let domains;
  let people;
  let enriched;

  // Each stage loads its input from the prior stage's saved file when run alone.
  switch (args.stage) {
    case 'ocean':
      await stageOcean(args.domain, maxSimilar);
      break;

    case 'search':
      domains = (await loadJson(args.input || FILES.ocean)).domains;
      await stageSearch(domains, maxPeople);
      break;

    case 'enrich':
      people = await loadJson(args.input || FILES.people);
      await stageEnrich(people);
      break;

    case 'filter': {
      enriched = await loadJson(args.input || FILES.enriched);
      const contacts = stageFilter(enriched);
      await saveJson(FILES.contacts, contacts);
      break;
    }

    case 'send': {
      const contacts = await loadJson(args.input || FILES.contacts);
      await stageSend(contacts);
      break;
    }

    case 'all':
    default: {
      domains = await stageOcean(args.domain, maxSimilar);
      if (domains.length === 0) {
        logger.warn('No similar companies — stopping.');
        await saveJson(FILES.contacts, []);
        break;
      }
      people = await stageSearch(domains, maxPeople);
      if (people.length === 0) {
        logger.warn('No people found — stopping.');
        await saveJson(FILES.contacts, []);
        break;
      }
      enriched = await stageEnrich(people);
      const contacts = stageFilter(enriched);
      await saveJson(FILES.contacts, contacts);
      break;
    }
  }

  logger.info('Pipeline done.');
}

// Run only when invoked directly (so stages remain importable/testable).
if (require.main === module) {
  main().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}

module.exports = {
  stageOcean,
  stageSearch,
  stageEnrich,
  stageFilter,
  stageSend,
  parseArgs,
  FILES,
};
