'use strict';
/**
 * app.js — HTTP server built on Node's own `http` module (no Express, no dependencies).
 * Responsibilities: routing, security headers, CSRF/Origin checks, rate limiting,
 * body-size limits, static files, and the live-update stream. All business logic is in handlers.js.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { createHandlers } = require('./handlers');
const { askGemini } = require('./gemini');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const SMALL_BODY = 4 * 1024;            // chat / auth / single records
const IMPORT_BODY = 512 * 1024;         // CSV import & migration
const MAX_STREAMS_PER_USER = 10;

/** Fixed-window in-memory rate limiter. */
function createLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  const timer = setInterval(() => { const t = now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, windowMs);
  timer.unref();
  return {
    /** → seconds to wait, or 0 when allowed */
    hit(key) {
      const t = now();
      let e = hits.get(key);
      if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
      e.n++;
      return e.n > max ? Math.ceil((e.reset - t) / 1000) : 0;
    },
    stop: () => clearInterval(timer),
  };
}

function createApp({ config, store, ask = askGemini, now = () => new Date(), throttle } = {}) {
  const handlers = createHandlers({ config, store, ask, now, throttle });
  const apiLimiter = createLimiter({ windowMs: 60_000, max: config.rateLimit.apiPerMinute });
  const authLimiter = createLimiter({ windowMs: 60_000, max: config.rateLimit.authPerMinute });
  const chatLimiter = createLimiter({ windowMs: 60_000, max: config.rateLimit.chatPerMinute });

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');

  function securityHeaders(res, req) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  function sendJson(res, status, body, { cookie, headers } = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...(cookie ? { 'Set-Cookie': cookie.set } : {}), ...(headers || {}),
    });
    res.end(payload);
  }
  const sendResult = (res, r) => sendJson(res, r.status, r.body, { cookie: r.cookie, headers: r.headers });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length'] || 0);
      if (len > limit) { const e = new Error('too large'); e.code = 'TOO_LARGE'; req.resume(); return reject(e); }
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { const e = new Error('too large'); e.code = 'TOO_LARGE'; req.destroy(); reject(e); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** CSRF defence: SameSite=Strict cookie + custom header + same-origin check. */
  function csrfProblem(req) {
    if (req.headers['x-requested-with'] !== 'ExpenseIQ') return 'Missing request header.';
    const origin = req.headers.origin;
    if (origin) {
      let host; try { host = new URL(origin).host; } catch { return 'Bad origin.'; }
      if (host !== req.headers.host) return 'Cross-origin request blocked.';
    }
    return null;
  }

  // ── live updates (Server-Sent Events) ──────────────────────────
  async function handleEvents(req, res, token) {
    const a = await handlers.authenticate(token);
    if (a.error) return sendResult(res, a.error);
    if (store.subscriberCount(a.uid) >= MAX_STREAMS_PER_USER) return sendJson(res, 429, { error: 'Too many open connections.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 3000\n\n');
    send('data', store.snapshot(a.uid));
    send('chat', { messages: await store.getChatHistory(a.uid, 100) });

    const unsubscribe = store.subscribe(a.uid, async (type) => {
      if (type === 'chat') send('chat', { messages: await store.getChatHistory(a.uid, 100) });
      else send('data', store.snapshot(a.uid));
    });
    const hash = auth.hashToken(token);
    const beat = setInterval(() => {
      if (!store.getSession(hash)) { send('signout', {}); cleanup(); res.end(); return; }   // logged out elsewhere / expired
      res.write(': ping\n\n');
    }, 25_000);
    beat.unref();
    function cleanup() { clearInterval(beat); unsubscribe(); }
    req.on('close', cleanup);
  }

  // ── router ─────────────────────────────────────────────────────
  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const ip = clientIp(req);
    const cookies = auth.parseCookies(req.headers.cookie);
    const token = cookies[auth.COOKIE_NAME];

    const wait = apiLimiter.hit(ip);
    if (wait) return sendJson(res, 429, { error: 'Too many requests. Please slow down.' }, { headers: { 'Retry-After': String(wait) } });

    if (method !== 'GET' && method !== 'HEAD') {
      const problem = csrfProblem(req);
      if (problem) return sendJson(res, 403, { error: problem });
    }

    async function body(limit = SMALL_BODY) {
      const raw = await readBody(req, limit);
      if (!raw) return {};
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) { const e = new Error('type'); e.code = 'BAD_TYPE'; throw e; }
      try { return JSON.parse(raw); } catch { const e = new Error('json'); e.code = 'BAD_JSON'; throw e; }
    }
    let m;

    if (pathname === '/api/health' && method === 'GET') return sendResult(res, handlers.health());

    // authentication
    if (pathname === '/api/auth/register' && method === 'POST') {
      const w = authLimiter.hit(ip); if (w) return sendJson(res, 429, { error: 'Too many attempts. Please wait a moment.' }, { headers: { 'Retry-After': String(w) } });
      return sendResult(res, await handlers.register({ body: await body(), ip }));
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const w = authLimiter.hit(ip); if (w) return sendJson(res, 429, { error: 'Too many attempts. Please wait a moment.' }, { headers: { 'Retry-After': String(w) } });
      return sendResult(res, await handlers.login({ body: await body(), ip }));
    }
    if (pathname === '/api/auth/logout' && method === 'POST') return sendResult(res, await handlers.logout({ token }));
    if (pathname === '/api/auth/me' && method === 'GET') return sendResult(res, await handlers.me({ token }));

    // live stream
    if (pathname === '/api/events' && method === 'GET') return handleEvents(req, res, token);

    // data
    if (pathname === '/api/data' && method === 'GET') return sendResult(res, await handlers.getData({ token }));
    if (pathname === '/api/data' && method === 'DELETE') return sendResult(res, await handlers.clearAll({ token }));

    if ((m = /^\/api\/(expenses|income)\/([^/]+)$/.exec(pathname))) {
      if (method === 'PUT') return sendResult(res, await handlers.putTx({ token, coll: m[1], id: m[2], body: await body() }));
      if (method === 'DELETE') return sendResult(res, await handlers.deleteTx({ token, coll: m[1], id: m[2] }));
    }
    if ((m = /^\/api\/budgets\/([^/]+)$/.exec(pathname))) {
      if (method === 'PUT') return sendResult(res, await handlers.putBudget({ token, month: m[1], body: await body() }));
      if (method === 'DELETE') return sendResult(res, await handlers.deleteBudget({ token, month: m[1] }));
    }
    if (pathname === '/api/import' && method === 'POST') return sendResult(res, await handlers.importExpenses({ token, body: await body(IMPORT_BODY) }));
    if (pathname === '/api/migration' && method === 'GET') return sendResult(res, await handlers.migrationStatus({ token }));
    if (pathname === '/api/migration' && method === 'POST') return sendResult(res, await handlers.migrate({ token, body: await body(IMPORT_BODY) }));
    if (pathname === '/api/migration/skip' && method === 'POST') return sendResult(res, await handlers.skipMigration({ token }));

    // chat
    if (pathname === '/api/chat' && method === 'POST') {
      const w = chatLimiter.hit(token ? auth.hashToken(token) : ip);
      if (w) return sendJson(res, 429, { error: 'You are sending messages too quickly. Please wait a moment.' }, { headers: { 'Retry-After': String(w) } });
      return sendResult(res, await handlers.chat({ token, body: await body() }));
    }
    if (pathname === '/api/chat/history' && method === 'GET') return sendResult(res, await handlers.chatHistory({ token }));
    if (pathname === '/api/chat/history' && method === 'DELETE') return sendResult(res, await handlers.clearHistory({ token }));

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    return serveStatic(req, res, pathname);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(404); return res.end('Not found'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(PUBLIC_DIR, '.' + rel);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(full).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, req);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err && err.code === 'TOO_LARGE') return sendJson(res, 413, { error: 'Request too large.' });
      if (err && err.code === 'BAD_JSON') return sendJson(res, 400, { error: 'Invalid JSON.' });
      if (err && err.code === 'BAD_TYPE') return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
      console.error('[server] unhandled error:', err && err.name);      // never log request content
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const close = () => new Promise((resolve) => {
    apiLimiter.stop(); authLimiter.stop(); chatLimiter.stop();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  return { server, handlers, close };
}

module.exports = { createApp, createLimiter };
