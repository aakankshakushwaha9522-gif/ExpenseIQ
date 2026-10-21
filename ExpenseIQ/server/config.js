'use strict';
const path = require('node:path');

/** Reads configuration from environment variables only. Nothing secret is hard-coded. */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const flag = (v, dflt) => (v === undefined || v === '' ? dflt : v === '1' || v === 'true');
  return {
    port: Number(env.PORT) || 3000,
    nodeEnv,
    dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'expenseiq-data.json'),
    trustProxy: flag(env.TRUST_PROXY, false),
    // Secure cookies need HTTPS. On by default in production; set COOKIE_SECURE=0 to test production mode on plain http.
    cookieSecure: flag(env.COOKIE_SECURE, nodeEnv === 'production'),
    sessionDays: Number(env.SESSION_DAYS) || 7,
    gemini: { apiKey: env.GEMINI_API_KEY || '', model: env.GEMINI_MODEL || 'gemini-2.5-flash' },
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    rateLimit: {
      chatPerMinute: Number(env.CHAT_RATE_LIMIT_PER_MIN) || 10,
      apiPerMinute: Number(env.API_RATE_LIMIT_PER_MIN) || 240,
      authPerMinute: Number(env.AUTH_RATE_LIMIT_PER_MIN) || 20,
    },
  };
}

module.exports = { loadConfig };
