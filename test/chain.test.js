import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { askVetoChain, runChain, testChain } from '../src/ai.js';

// Nep-provider: /bad/ geeft een quota-fout, /good/ een geldig antwoord, /nee/ een afwijzing.
let calls = [];
const server = http.createServer((req, res) => {
  calls.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/nojson/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      if (JSON.parse(body).response_format) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Failed to generate JSON. Please adjust your prompt.', code: 'json_validate_failed' } }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'Mijn oordeel: {"decision": "reject", "reason": "zwak"}' } }] }));
    });
  }
  if (req.url.startsWith('/bad/')) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: { message: 'Quota exceeded' } }));
  }
  const decision = req.url.startsWith('/nee/') ? 'reject' : 'approve';
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision, reason: 'ok' }) } }] }));
});
await new Promise((r) => server.listen(0, r));
const base = (path) => `http://127.0.0.1:${server.address().port}/${path}/v1`;
const entry = (slot, path, apiKey = 'k') => ({ slot, provider: 'openai', model: `m${slot}`, baseUrl: base(path), apiKey, timeoutMs: 2000 });
const ctx = { pair: 'BTC/EUR', timeframe: '1h', indicators: { close: 1, emaFast: 1, emaSlow: 1, rsi: 50, change24: 0 }, recentCandles: [] };

test('valt door naar het volgende model bij een fout', async () => {
  calls = [];
  const r = await askVetoChain([entry(1, 'bad'), entry(2, 'bad'), entry(3, 'good')], 'reject', ctx);
  assert.equal(r.decision, 'approve');
  assert.equal(r.usedSlot, 3);
  assert.equal(r.fallbackErrors.length, 2);
  assert.match(r.fallbackErrors[0].error, /429.*Quota exceeded/);
});

test('een afwijzing is een geldig antwoord en gaat niet door naar de back-up', async () => {
  calls = [];
  const r = await askVetoChain([entry(1, 'nee'), entry(2, 'good')], 'reject', ctx);
  assert.equal(r.decision, 'reject');
  assert.equal(r.usedSlot, 1);
  assert.equal(calls.length, 1);
});

test('alles faalt: fail-mode bepaalt en alle fouten komen mee', async () => {
  const r = await askVetoChain([entry(1, 'bad'), entry(2, 'bad', '')], 'approve', ctx);
  assert.equal(r.decision, 'approve');
  assert.equal(r.error, true);
  assert.deepEqual(r.chainErrors.map((e) => e.slot), [1, 2]);
  assert.match(r.chainErrors[1].error, /Geen API-key/);
});

test('zonder modellen is de AI uit', async () => {
  const r = await askVetoChain([], 'reject', ctx);
  assert.equal(r.decision, 'approve');
  await assert.rejects(runChain([], async () => 1));
});

test('model dat de JSON-modus niet aankan: één keer opnieuw zonder', async () => {
  calls = [];
  const r = await askVetoChain([entry(1, 'nojson')], 'approve', ctx);
  assert.equal(r.decision, 'reject');
  assert.equal(r.usedSlot, 1);
  assert.equal(calls.length, 2, 'eerst met, dan zonder JSON-modus');
});

test('testChain test elk model los', async () => {
  const r = await testChain([entry(1, 'bad'), entry(2, 'good')], ctx);
  assert.deepEqual(r.map((x) => [x.slot, x.ok]), [[1, false], [2, true]]);
  server.close();
});

test('alleen tekstmodellen komen in de keuzelijst', async () => {
  const { isTextModel } = await import('../src/ai.js');
  for (const id of ['llama-3.3-70b-versatile', 'gemini-3.8-flash', 'openai/gpt-oss-120b', 'qwen/qwen3-32b']) assert.ok(isTextModel(id), id);
  for (const id of ['whisper-large-v3', 'playai-tts', 'meta-llama/llama-guard-4-12b', 'text-embedding-004', 'imagen-4.0', 'veo-3', 'gemini-2.5-flash-image']) {
    assert.ok(!isTextModel(id), id);
  }
});
