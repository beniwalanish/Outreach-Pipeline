'use strict';

/**
 * Enriches ONE known personId and prints the normalized output.
 * Usage: node test-prospeo-enrich.js <person_id>
 * (falls back to a placeholder id if none passed)
 */

const { enrichPerson } = require('./src/services/prospeo.service');

const personId = process.argv[2] || 'aaaa1df6838490f53d26cba7';

(async () => {
  try {
    const contact = await enrichPerson(personId);
    console.log(JSON.stringify(contact, null, 2));
  } catch (err) {
    console.error('Enrich test failed:', err.prospeoCode || err.message);
    process.exit(1);
  }
})();
