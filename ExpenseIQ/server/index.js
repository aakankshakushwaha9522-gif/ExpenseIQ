'use strict';
// Load .env for local development (Node >= 20.12). In production the host injects real env vars.
try { process.loadEnvFile(); } catch { /* no .env file — fine */ }

const { loadConfig } = require('./config');
const { createStore } = require('./store');
const { createApp } = require('./app');

const config = loadConfig();
if (!config.geminiConfigured) console.warn('[startup] GEMINI_API_KEY not set — the assistant will answer with the built-in computed summary.');

const store = createStore({ file: config.dataFile });
const { server, close } = createApp({ config, store });

server.listen(config.port, () => {
  console.log(`ExpenseIQ running at http://localhost:${config.port}  (${config.nodeEnv})`);
  console.log(`Data file: ${config.dataFile}`);
});

// Finish pending disk writes before exiting.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await close();
    await store.flush();
    process.exit(0);
  });
}
