'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { askGemini, GeminiError, SYSTEM_PROMPT } = require('../server/gemini');

const base = { apiKey: 'SECRET-KEY-123', model: 'gemini-test', summary: { a: 1 }, message: 'hello' };
const okFetch = (text = 'answer') => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('sends key in header (never in URL), system prompt, and data as context', async () => {
  let seen;
  const reply = await askGemini({ ...base, fetchImpl: async (url, opts) => { seen = { url, opts }; return okFetch('hi there')(); } });
  assert.equal(reply, 'hi there');
  assert.ok(!seen.url.includes('SECRET-KEY-123'), 'API key must not be in URL');
  assert.equal(seen.opts.headers['x-goog-api-key'], 'SECRET-KEY-123');
  assert.ok(seen.url.includes('gemini-test:generateContent'));
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  const last = body.contents[body.contents.length - 1];
  assert.match(last.parts[0].text, /FINANCIAL_DATA/);
  assert.match(last.parts[0].text, /hello/);
});

test('maps history roles to Gemini roles and caps length', async () => {
  let body;
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i }));
  await askGemini({ ...base, history, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return okFetch()(); } });
  assert.equal(body.contents.length, 9); // last 8 history + new question
  assert.ok(body.contents.some((c) => c.role === 'model'));
});

test('throws NOT_CONFIGURED without an API key', async () => {
  await assert.rejects(() => askGemini({ ...base, apiKey: '', fetchImpl: okFetch() }), (e) => e instanceof GeminiError && e.code === 'NOT_CONFIGURED');
});

for (const [status, code] of [[429, 'QUOTA'], [403, 'REJECTED'], [400, 'REJECTED'], [500, 'UPSTREAM']]) {
  test(`HTTP ${status} -> ${code}`, async () => {
    await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => ({ ok: false, status }) }), (e) => e.code === code);
  });
}

test('network failure and timeout are mapped, without leaking details', async () => {
  await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => { throw new Error('ECONNRESET secret'); } }),
    (e) => e.code === 'NETWORK' && !/secret/.test(e.message));
  await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } }),
    (e) => e.code === 'TIMEOUT');
});

test('empty / blocked / malformed responses are errors', async () => {
  await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [] }) }) }), (e) => e.code === 'EMPTY');
  await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }) }), (e) => e.code === 'EMPTY');
  await assert.rejects(() => askGemini({ ...base, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) }), (e) => e.code === 'BAD_RESPONSE');
});
