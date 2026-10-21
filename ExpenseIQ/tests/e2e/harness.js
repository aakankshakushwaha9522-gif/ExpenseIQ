'use strict';
/**
 * E2E harness: runs the REAL ExpenseIQ server (real auth, real storage, real live stream)
 * on a random port with a throw-away data file. Only the Gemini call is replaced by a stub.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store');
const { createApp } = require('../../server/app');
const { loadConfig } = require('../../server/config');
const { GeminiError } = require('../../server/gemini');
const { LoginThrottle } = require('../../server/auth');

async function startHarness({ ask, env = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eiq-e2e-')), 'db.json');
  const config = loadConfig({ GEMINI_API_KEY: 'test-key', AUTH_RATE_LIMIT_PER_MIN: '1000', API_RATE_LIMIT_PER_MIN: '100000', CHAT_RATE_LIMIT_PER_MIN: '1000', ...env });
  const store = createStore({ file });
  const calls = { ask: [] };
  const app = createApp({
    config, store, throttle: new LoginThrottle(),
    ask: async (o) => { calls.ask.push(o); return (ask || (async () => 'stub reply'))(o); },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${app.server.address().port}`,
    store, calls, app,
    dropConnections: () => app.server.closeAllConnections(),
    close: () => app.close(),
  };
}

module.exports = { startHarness, GeminiError };
