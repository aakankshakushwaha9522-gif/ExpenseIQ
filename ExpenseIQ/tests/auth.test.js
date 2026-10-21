'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../server/auth');

test('password hashes are salted, never contain the password, and verify correctly', async () => {
  const h1 = await A.hashPassword('correct horse');
  const h2 = await A.hashPassword('correct horse');
  assert.notEqual(h1, h2, 'random salt → different hash every time');
  assert.match(h1, /^scrypt\$16384\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!h1.includes('correct'));
  assert.equal(await A.verifyPassword('correct horse', h1), true);
  assert.equal(await A.verifyPassword('correct horsE', h1), false);
  assert.equal(await A.verifyPassword('', h1), false);
});

test('verifyPassword rejects malformed or tampered stored hashes without throwing', async () => {
  for (const bad of ['', 'x', 'scrypt$1$a$b', 'md5$16384$a$b', 'scrypt$notanumber$a$b', null, undefined]) {
    assert.equal(await A.verifyPassword('pw', bad), false, String(bad));
  }
});

test('unicode passwords are normalised consistently', async () => {
  const h = await A.hashPassword('café-pässword');
  assert.equal(await A.verifyPassword('café-pässword', h), true);
});

test('session tokens are unpredictable and only their hash is meant to be stored', () => {
  const a = A.newToken(), b = A.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.notEqual(A.hashToken(a), a);
  assert.equal(A.hashToken(a), A.hashToken(a));
  assert.match(A.hashToken(a), /^[0-9a-f]{64}$/);
});

test('email and password validation', () => {
  assert.equal(A.validateEmail('ann@example.com'), null);
  assert.equal(A.validateEmail('  ANN@Example.com '), null);
  for (const bad of ['', 'ann', 'ann@', '@x.com', 'a b@x.com', 'ann@x', 'a@@x.com']) assert.ok(A.validateEmail(bad), bad);
  assert.equal(A.normalizeEmail('  ANN@Example.com '), 'ann@example.com');
  assert.equal(A.validatePassword('longenough'), null);
  assert.ok(A.validatePassword('short'));
  assert.ok(A.validatePassword('        '));
  assert.ok(A.validatePassword('x'.repeat(129)));
  assert.ok(A.validatePassword(undefined));
  assert.ok(A.validatePassword(12345678));
});

test('cookie parsing and session cookie flags', () => {
  assert.deepEqual(A.parseCookies('a=1; sid=abc%20d; junk; =x'), { a: '1', sid: 'abc d' });
  assert.deepEqual(A.parseCookies(undefined), {});
  assert.deepEqual(A.parseCookies('sid=%E0%A4%A'), {}, 'bad escapes are ignored');
  const c = A.sessionCookie('tok', { maxAgeSec: 60, secure: true });
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=60', 'Secure']) assert.ok(c.includes(flag), flag);
  assert.ok(!A.sessionCookie('tok', { maxAgeSec: 60, secure: false }).includes('Secure'));
});

test('login throttle: blocks after repeated failures, per ip+email and per email, and expires', () => {
  let t = 0;
  const th = new A.LoginThrottle({ perIpEmail: 3, perEmail: 5, windowMs: 1000, now: () => t });
  assert.equal(th.check('1.1.1.1', 'a@x.io').blocked, false);
  for (let i = 0; i < 3; i++) th.fail('1.1.1.1', 'a@x.io');
  const blocked = th.check('1.1.1.1', 'a@x.io');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(th.check('2.2.2.2', 'a@x.io').blocked, false, 'other IP not yet blocked');
  assert.equal(th.check('1.1.1.1', 'b@x.io').blocked, false, 'other account not blocked');
  th.fail('2.2.2.2', 'a@x.io'); th.fail('3.3.3.3', 'a@x.io');       // 5 failures on the email overall
  assert.equal(th.check('9.9.9.9', 'a@x.io').blocked, true, 'distributed guessing against one account is blocked');
  t = 2000;
  assert.equal(th.check('1.1.1.1', 'a@x.io').blocked, false, 'window expired');
});

test('a successful login clears the ip+email counter', () => {
  const th = new A.LoginThrottle({ perIpEmail: 3 });
  th.fail('i', 'e'); th.fail('i', 'e'); th.success('i', 'e'); th.fail('i', 'e');
  assert.equal(th.check('i', 'e').blocked, false);
});
