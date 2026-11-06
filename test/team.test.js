import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { askTeamChain } from '../src/ai.js';

// Nep-AI: antwoordt per rol, herkend aan de systeemprompt. /down/ faalt altijd.
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/down/')) { res.statusCode = 500; return res.end('{"error":{"message":"stuk"}}'); }
    const b = JSON.parse(body);
    const system = b.messages[0].content;
    const user = b.messages.at(-1).content;
    const role = /ANALIST/.test(system) ? 'analyst' : /CRITICUS/.test(system) ? 'critic' : 'decider';
    seen.push({ url: req.url, role, json: Boolean(b.response_format), user });
    const content = role === 'analyst' ? '<think>even rekenen</think>Sterke trend met volume; winstkans 55%, verwachte winst 2 keer het risico. Kopen.'
      : role === 'critic' ? 'De weerstand ligt vlakbij; winstkans eerder 45%. Ik steun het advies niet volledig.'
      : JSON.stringify({ decision: 'reject', reason: 'De weerstand vlakbij gaf de doorslag.' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => server.listen(0, r));
test.after(() => server.close());
const url = (p) => `http://127.0.0.1:${server.address().port}/${p}/v1`;
const entry = (slot, p, model = `m${slot}`) => ({ slot, provider: 'openai', model, baseUrl: url(p), apiKey: 'k' });
const ctx = { pair: 'SOL/EUR', timeframe: '5m', indicators: { close: 100, emaFast: 101, emaSlow: 99, rsi: 60, adx: 30, change24: 2, volumeRatio: 1.2, atr: 1, atrPct: 1 }, recentCandles: [], extra: {} };

test('team: analist → criticus → beslisser, elk met eigen model; gesprek wordt meegegeven', async () => {
  seen.length = 0;
  const r = await askTeamChain([entry(1, 'a'), entry(2, 'b'), entry(3, 'c')], 'reject', ctx);
  assert.equal(r.decision, 'reject');
  assert.equal(r.reason, 'De weerstand vlakbij gaf de doorslag.');
  assert.deepEqual(r.transcript.map((t) => t.role), ['analyst', 'critic', 'decider']);
  assert.deepEqual(seen.map((s) => s.url.split('/')[1]), ['a', 'b', 'c'], 'elke rol een eigen model');
  assert.deepEqual(seen.map((s) => s.json), [false, false, true], 'alleen de beslisser in JSON');
  assert.equal(r.transcript[0].text.startsWith('Sterke trend'), true, 'denkblok weggehaald');
  assert.match(seen[1].user, /Analyse van de analist[\s\S]*Sterke trend/);
  assert.match(seen[2].user, /Kritiek van de criticus[\s\S]*weerstand ligt vlakbij/);
  assert.equal(r.transcript[2].decision, 'reject');
});

test('team: met één model speelt dat model alle rollen; faalt een model dan neemt de volgende over', async () => {
  seen.length = 0;
  const one = await askTeamChain([entry(1, 'a')], 'reject', ctx);
  assert.equal(one.transcript.length, 3);
  assert.ok(seen.every((s) => s.url.startsWith('/a/')));
  seen.length = 0;
  const r = await askTeamChain([entry(1, 'a'), entry(2, 'down'), entry(3, 'c')], 'reject', ctx);
  assert.equal(r.transcript[1].role, 'critic');
  assert.match(r.transcript[1].model, /m3/, 'criticus valt terug op model 3');
  assert.ok(r.fallbackErrors.some((e) => /stuk/.test(e.error)));
});

test('team: harde filter met ✗ → direct afgewezen zonder AI-vragen', async () => {
  seen.length = 0;
  const r = await askTeamChain([entry(1, 'a')], 'reject', { ...ctx, indicators: { ...ctx.indicators, rsi: 90 } });
  assert.equal(r.decision, 'reject');
  assert.equal(seen.length, 0);
  assert.match(r.reason, /harde eis.*RSI 90/);
  assert.equal(r.transcript[0].role, 'filters');
});

test('team: alles faalt → fail-mode, met uitleg in het gesprek', async () => {
  const r = await askTeamChain([entry(1, 'down')], 'reject', ctx);
  assert.equal(r.decision, 'reject');
  assert.equal(r.error, true);
  assert.equal(r.transcript.at(-1).role, 'error');
});
