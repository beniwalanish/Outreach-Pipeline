'use strict';

const { findSimilarCompanies } = require('./src/services/ocean.service');

(async () => {
  try {
    // size=5, maxResults=5 => single page, no pagination.
    const domains = await findSimilarCompanies('openai.com', 5);
    console.log(`Domains found: ${domains.length}`);
    console.log('First 5:', domains.slice(0, 5));
  } catch (err) {
    console.error('Ocean test failed:', err.message);
    process.exit(1);
  }
})();
