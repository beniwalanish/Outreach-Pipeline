'use strict';

/**
 * HTTP API layer for the outreach pipeline.
 *
 *   POST /api/generate { domain, maxSimilar, maxPeople } -> { contacts, counts }
 *   POST /api/send     { contacts? }                     -> send report (DRY_RUN gated)
 *   GET  /api/health
 *   (static) serves ../frontend
 *
 * The CLI (src/app.js) is untouched; this reuses its exported stage functions.
 *
 * SECURITY / COST: /api/generate and /api/send spend real Ocean + Prospeo
 * credits. A simple in-memory rate limiter guards against accidental drains.
 * For production this should sit behind real auth + a shared rate-limit store.
 */

const path = require('path');
const fs = require('fs/promises');
const express = require('express');

const { config } = require('./config/env');
const { logger } = require('./utils/logger');
const {
  stageOcean,
  stageSearch,
  mapPeopleToContacts,
  stageSend,
  FILES,
} = require('./app');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Dev CORS — allows the frontend to call the API when served from another
// origin (e.g. Live Server on :5500). Tighten/remove for production.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---- Minimal in-memory rate limiter (per IP) ----
// Protects paid endpoints from runaway calls. Not durable across restarts.
const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RL_MAX = 10; // max paid calls per window per IP
const rlHits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    const retryMs = RL_WINDOW_MS - (now - hits[0]);
    res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
    return res.status(429).json({
      error: 'Rate limit exceeded. These endpoints spend API credits.',
      retryAfterSeconds: Math.ceil(retryMs / 1000),
    });
  }
  hits.push(now);
  rlHits.set(ip, hits);
  next();
}

// ---- Routes ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dryRun: config.dryRun });
});

/**
 * Run the full data pipeline for one domain.
 * NOTE: synchronous/blocking — Prospeo's rate limits make this slow for
 * large inputs. Inputs are capped server-side to bound credit spend.
 */
app.post('/api/generate', rateLimit, async (req, res) => {
  const domain = String(req.body.domain || '').trim().toLowerCase();
  // Clamp to sane maxima regardless of client input (credit safety).
  const maxSimilar = Math.min(
    Math.max(1, parseInt(req.body.maxSimilar, 10) || config.maxSimilarCompanies),
    25
  );
  const maxPeople = Math.min(
    Math.max(1, parseInt(req.body.maxPeople, 10) || config.maxPeoplePerCompany),
    25
  );

  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ error: 'Valid company domain required' });
  }

  try {
    logger.info(`API /generate domain=${domain} maxSimilar=${maxSimilar} maxPeople=${maxPeople}`);

    const domains = await stageOcean(domain, maxSimilar);
    if (domains.length === 0) {
      return res.json({ contacts: [], counts: { companies: 0, people: 0, contacts: 0 } });
    }

    const people = await stageSearch(domains, maxPeople);
    if (people.length === 0) {
      return res.json({ contacts: [], counts: { companies: domains.length, people: 0, contacts: 0 } });
    }

    // Bulk-enrich stage removed: discovered contacts are returned directly.
    const contacts = mapPeopleToContacts(people);
    await fs.writeFile(FILES.contacts, JSON.stringify(contacts, null, 2), 'utf8');

    res.json({
      contacts,
      counts: {
        companies: domains.length,
        people: people.length,
        contacts: contacts.length,
      },
    });
  } catch (err) {
    logger.error(err);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, code: err.prospeoCode || undefined });
  }
});

/**
 * Send outreach to provided contacts (or the saved contacts.json).
 * DRY_RUN-gated: real sends require DRY_RUN=false on the server.
 */
app.post('/api/send', rateLimit, async (req, res) => {
  try {
    let contacts = req.body && req.body.contacts;
    if (!Array.isArray(contacts)) {
      contacts = JSON.parse(await fs.readFile(FILES.contacts, 'utf8'));
    }
    const report = await stageSend(contacts);
    res.json(report);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  logger.info(`Server on port ${PORT} (DRY_RUN=${config.dryRun})`);
});

module.exports = app;
