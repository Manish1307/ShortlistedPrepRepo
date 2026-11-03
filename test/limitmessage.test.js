'use strict';
// What a candidate reads when a plan limit is reached (the website turns it into an upgrade popup).
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitMessage } = require('../admin/lib/entitlements');

test('the plan-limit message names the plan, the limit and what was used, with the right singular and plural', () => {
  assert.equal(limitMessage({ name: 'Free', free: true }, 'preps', 1, 2),
    'Your Free plan includes 1 insight plan in the last 30 days. You have used 2. Upgrade your plan at pricing.html to continue.');
  assert.equal(limitMessage({ name: 'Shortlist Pass', free: false }, 'jobSearches', 30, 30),
    'Your Shortlist Pass plan includes 30 Live Searches in your plan period. You have used 30. Upgrade your plan at pricing.html to continue.');
  assert.equal(limitMessage({ name: 'Free', free: true }, 'roleResumes', 1, 1),
    'Your Free plan includes 1 role-based resume. You have used 1. Upgrade your plan at pricing.html to continue.');
  assert.equal(limitMessage({ name: 'Free', free: true }, 'jobSearches', 2, 2),
    'Your Free plan includes 2 Live Searches in the last 30 days. You have used 2. Upgrade your plan at pricing.html to continue.');
});
