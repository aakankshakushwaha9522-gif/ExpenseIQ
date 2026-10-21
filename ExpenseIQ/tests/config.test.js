'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');

test('works with an empty environment (no configuration required)', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.geminiConfigured, false);
  assert.equal(c.cookieSecure, false);
  assert.equal(c.sessionDays, 7);
  assert.match(c.dataFile, /expenseiq-data\.json$/);
});

test('production turns on secure cookies unless overridden', () => {
  assert.equal(loadConfig({ NODE_ENV: 'production' }).cookieSecure, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: '0' }).cookieSecure, false);
});

test('values are read from the environment', () => {
  const c = loadConfig({ PORT: '8080', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm', TRUST_PROXY: '1', SESSION_DAYS: '2', DATA_FILE: '/x/y.json', CHAT_RATE_LIMIT_PER_MIN: '3' });
  assert.deepEqual([c.port, c.geminiConfigured, c.gemini.model, c.trustProxy, c.sessionDays, c.dataFile, c.rateLimit.chatPerMinute], [8080, true, 'm', true, 2, '/x/y.json', 3]);
});
