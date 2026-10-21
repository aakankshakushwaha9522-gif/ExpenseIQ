'use strict';
/** `npm run check` — shows what is configured. Prints no secret values. */
try { process.loadEnvFile(); } catch { /* optional */ }
const { loadConfig } = require('../server/config');
const c = loadConfig();
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > 20 || (maj === 20 && min >= 12);
console.log(`${nodeOk ? '✔' : '✖'} Node ${process.versions.node} (need >= 20.12)`);
console.log(`✔ Data file: ${c.dataFile}`);
console.log(`${c.geminiConfigured ? '✔' : '⚠'} Gemini API key ${c.geminiConfigured ? '(model: ' + c.gemini.model + ')' : 'not set — optional; the assistant falls back to computed summaries'}`);
process.exit(nodeOk ? 0 : 1);
