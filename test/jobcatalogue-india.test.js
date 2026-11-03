'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { INDIA_COMPANIES } = require('../admin/lib/jobcatalogue-india');
const { CATALOGUE, SECTOR_COMPANIES, SECTORS } = require('../admin/lib/jobcatalogue');
const { parseBoardUrl } = require('../admin/lib/jobsources');
const { WRONG_MATCH } = require('../scripts/india-candidates');

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

test('Indian company list: every entry has a careers link the app can read and a real sector', () => {
  assert.ok(INDIA_COMPANIES.length > 0);
  for (const c of INDIA_COMPANIES) {
    assert.ok(c.name && c.url, 'name and url: ' + JSON.stringify(c));
    assert.ok(parseBoardUrl(c.url), `${c.name}: the link is not a careers system the app reads (${c.url})`);
    assert.ok(c.sector === 'it' || SECTORS.some(s => s.id === c.sector), `${c.name}: unknown sector ${c.sector}`);
  }
});

test('Indian company list: no duplicates, nothing already built in, and no known wrong match', () => {
  const builtIn = new Set(CATALOGUE.concat(SECTOR_COMPANIES).map(c => norm(c.name)));
  const seen = new Set();
  for (const c of INDIA_COMPANIES) {
    assert.ok(!seen.has(norm(c.name)), 'listed twice: ' + c.name);
    seen.add(norm(c.name));
    assert.ok(!builtIn.has(norm(c.name)), 'already in the built-in lists: ' + c.name);
    assert.ok(!WRONG_MATCH.includes(c.name), 'a known wrong match: ' + c.name);
  }
  assert.equal(new Set(INDIA_COMPANIES.map(c => c.url)).size, INDIA_COMPANIES.length, 'two companies share one careers board');
});
