'use strict';
/**
 * auth.js — hand-written authentication primitives (no auth library, no third party).
 *
 *  • Passwords: salted scrypt hashes (Node's built-in crypto), constant-time comparison.
 *  • Sessions:  random 256-bit token in an HttpOnly cookie. Only the SHA-256 *hash* of the
 *               token is stored on the server, so a leaked data file cannot be used to log in.
 *  • Throttle:  limits repeated wrong passwords per IP+email and per email.
 */
const crypto = require('node:crypto');

const SCRYPT_N = 16384;
const KEYLEN = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const COOKIE_NAME = 'sid';

function scrypt(password, salt, N) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** → "scrypt$N$salt$hash" (base64) */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  try {
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const actual = await scrypt(String(password).normalize('NFKC'), salt, N);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// A real hash of a random password: verifying against it costs the same time as a real
// check, so "unknown email" and "wrong password" are indistinguishable by timing.
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, dummyHash);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
function validateEmail(e) {
  const email = normalizeEmail(e);
  if (!email) return 'Please enter your email.';
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'That email address does not look right.';
  return null;
}
function validatePassword(p) {
  if (typeof p !== 'string' || !p) return 'Please enter your password.';
  if (p.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (p.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters.`;
  if (!p.trim()) return 'Password cannot be only spaces.';
  return null;
}

// ─── Cookies ──────────────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad escape */ }
  });
  return out;
}
function sessionCookie(value, { maxAgeSec, secure }) {
  return [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
}

// ─── Login throttle (in memory) ───────────────────────────────────
class LoginThrottle {
  constructor({ perIpEmail = 5, perEmail = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { perIpEmail, perEmail, windowMs, now });
    this.map = new Map();
  }
  _entry(key) {
    const e = this.map.get(key);
    if (e && this.now() - e.first > this.windowMs) { this.map.delete(key); return null; }
    return e || null;
  }
  /** → { blocked:boolean, retryAfterSec:number } */
  check(ip, email) {
    let retry = 0;
    for (const [key, max] of [[`${ip}|${email}`, this.perIpEmail], [`@${email}`, this.perEmail]]) {
      const e = this._entry(key);
      if (e && e.count >= max) retry = Math.max(retry, Math.ceil((e.first + this.windowMs - this.now()) / 1000));
    }
    return { blocked: retry > 0, retryAfterSec: retry };
  }
  fail(ip, email) {
    for (const key of [`${ip}|${email}`, `@${email}`]) {
      const e = this._entry(key);
      if (e) e.count++; else this.map.set(key, { count: 1, first: this.now() });
    }
  }
  success(ip, email) { this.map.delete(`${ip}|${email}`); }
}

module.exports = {
  COOKIE_NAME, MIN_PASSWORD, MAX_PASSWORD, hashPassword, verifyPassword, burnTime, newToken, hashToken,
  normalizeEmail, validateEmail, validatePassword, parseCookies, sessionCookie, LoginThrottle,
};
