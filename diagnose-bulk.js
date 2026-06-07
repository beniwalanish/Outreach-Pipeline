'use strict';

/**
 * Minimal Stage 2b re-validation (official schema). TWO requests:
 *   1) search-person (1 page) -> one real person_id
 *   2) bulk-enrich-person     -> batch size 1, dump raw
 * Then runs the SERVICE bulkEnrichPeople on the same person to confirm
 * extraction + identifier mapping produce a normalized contact.
 */

const axios = require('axios');
const { config } = require('./src/config/env');
const prospeo = require('./src/services/prospeo.service');

const H = { 'X-KEY': config.prospeoApiKey, 'Content-Type': 'application/json' };

(async () => {
  try {
    const search = await axios.post(
      'https://api.prospeo.io/search-person',
      { page: 1, filters: { company: { websites: { include: ['openai.com'] } } } },
      { headers: H, timeout: 30_000 }
    );
    const results = (search.data && search.data.results) || [];
    // Prefer a candidate whose search email.status looks enrichable.
    const pick =
      results.find(
        (x) => x.person && x.person.email && x.person.email.status === 'VERIFIED'
      ) || results[0] || {};
    const r = pick;
    const personId = r.person && r.person.person_id;
    const statuses = results
      .map((x) => x.person && x.person.email && x.person.email.status)
      .filter(Boolean);
    console.log('search email statuses:', statuses);
    console.log('person_id:', personId);

    const body = {
      only_verified_email: true,
      enrich_mobile: false,
      only_verified_mobile: false,
      data: [{ identifier: 'item_0', person_id: personId }],
    };
    const bulk = await axios.post(
      'https://api.prospeo.io/bulk-enrich-person',
      body,
      { headers: H, timeout: 60_000 }
    );
    console.log('--- raw matched[0] ---');
    const m = (bulk.data && bulk.data.matched || [])[0];
    console.dir(
      m && { identifier: m.identifier, email: m.person && m.person.email },
      { depth: null }
    );
    console.log('keys:', Object.keys(bulk.data || {}));

    // service-level confirmation (one more bulk call via the service)
    const contacts = await prospeo.bulkEnrichPeople([
      {
        personId,
        firstName: r.person && r.person.first_name,
        lastName: r.person && r.person.last_name,
        companyDomain: r.company && r.company.domain,
      },
    ]);
    console.log('--- service normalized ---');
    console.dir(contacts[0], { depth: null });
  } catch (err) {
    if (err.response) {
      console.error('HTTP', err.response.status);
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Failed:', err.message);
    }
    process.exit(1);
  }
})();
