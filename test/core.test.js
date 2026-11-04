import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ema, rsi } from '../src/indicators.js';
import { evaluate } from '../src/strategy.js';
import { parseDecision, askVeto, testConnection } from '../src/ai.js';
import { checkEntry } from '../src/risk.js';
import { Store } from '../src/store.js';

const params = { emaFast: 3, emaSlow: 6, rsiPeriod: 5, rsiMaxEntry: 70 };
const candlesFrom = (closes) => closes.map((c, i) => [i * 3600000, c, c, c, c, 1]);

test('ema van constante reeks is die constante', () => {
  const out = ema([5, 5, 5, 5, 5], 3);
  assert.equal(out.at(-1), 5);
  assert.equal(out[0], null);
});

test('rsi is 100 bij alleen stijgingen en 0 bij alleen dalingen', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7], 5).at(-1), 100);
  assert.equal(rsi([7, 6, 5, 4, 3, 2, 1], 5).at(-1), 0);
});

// Loopt de reeks candle voor candle af, zoals de bot dat live doet.
const signalsOver = (closes, p) =>
  closes.map((_, i) => evaluate(candlesFrom(closes.slice(0, i + 1)), p).signal);

test('strategie geeft koopsignaal na een daling met draai omhoog', () => {
  const closes = [...Array(15)].map((_, i) => 30 - i).concat([16.5, 17.5, 18.5, 19.5]);
  const signals = signalsOver(closes, { ...params, rsiMaxEntry: 100 });
  assert.ok(signals.includes('buy'));
  assert.ok(!signals.slice(0, 15).includes('buy'), 'geen koopsignaal tijdens de daling');
});

test('strategie geeft verkoopsignaal na een stijging met draai omlaag', () => {
  const closes = [...Array(15)].map((_, i) => 10 + i).concat([23.5, 22.5, 21.5, 20.5]);
  assert.ok(signalsOver(closes, params).includes('sell'));
});

test('RSI-filter blokkeert een koopsignaal bij een te hoge RSI', () => {
  const closes = [...Array(15)].map((_, i) => 30 - i).concat([16.5, 17.5, 18.5, 19.5]);
  assert.ok(!signalsOver(closes, { ...params, rsiMaxEntry: 1 }).includes('buy'));
});

test('strategie zonder genoeg data geeft geen signaal', () => {
  assert.equal(evaluate(candlesFrom([1, 2, 3]), params).signal, 'none');
});

test('parseDecision leest JSON, ook met tekst eromheen', () => {
  assert.deepEqual(parseDecision('ok: {"decision":"Reject","reason":"te volatiel"}'), {
    decision: 'reject',
    reason: 'te volatiel',
  });
  assert.throws(() => parseDecision('{"decision":"maybe"}'));
  assert.throws(() => parseDecision('geen json'));
});

test('askVeto valt bij een fout terug op reject', async () => {
  const res = await askVeto(
    { provider: 'openai', apiKey: 'x', baseUrl: 'http://127.0.0.1:9', timeoutMs: 500, failMode: 'reject' },
    { pair: 'BTC/EUR', timeframe: '1h', indicators: { close: 1, emaFast: 1, emaSlow: 1, rsi: 50, change24: 0 }, recentCandles: [] },
  );
  assert.equal(res.decision, 'reject');
  assert.equal(res.error, true);
});

test('risicoregels blokkeren bij te veel open trades en bij dagverlies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  const store = new Store(dir, 'paper', 500);
  const config = { risk: { stakeEur: 25, maxOpenTrades: 1, maxDailyLossEur: 10 } };
  assert.equal(checkEntry(store, config, 'paper'), null);

  store.state.positions['BTC/EUR'] = {};
  assert.match(checkEntry(store, config, 'paper'), /open trades/);

  store.state.positions = {};
  store.addTrade({ closedAt: new Date().toISOString(), pnlEur: -12 });
  assert.match(checkEntry(store, config, 'paper'), /Dagverlies/);

  store.save();
  assert.equal(new Store(dir, 'paper', 500).state.trades.length, 1);
});

test('AI-test geeft echte fouten door in plaats van de fail-mode', async () => {
  const ctx = { pair: 'BTC/EUR', timeframe: '1h', indicators: { close: 1, emaFast: 1, emaSlow: 1, rsi: 50, change24: 0 }, recentCandles: [] };
  await assert.rejects(testConnection({ provider: 'none' }, ctx), /geen AI-provider/);
  await assert.rejects(testConnection({ provider: 'gemini', apiKey: '' }, ctx), /geen AI-key/);
  await assert.rejects(
    testConnection({ provider: 'openai', apiKey: 'x', baseUrl: 'http://127.0.0.1:9', timeoutMs: 500, failMode: 'approve' }, ctx),
  );
});

test('kruisingen tussen twee checks worden niet gemist (lookback)', () => {
  // Kruising omhoog en daarna nog twee candles stijging: met lookback 1 gemist, met 3 gevonden.
  const closes = [...Array(15)].map((_, i) => 30 - i).concat([16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5]);
  const p = { ...params, rsiMaxEntry: 100 };
  let crossIdx = -1;
  for (let i = 10; i <= closes.length; i++) if (evaluate(candlesFrom(closes.slice(0, i)), p).signal === 'buy') { crossIdx = i; break; }
  assert.ok(crossIdx > 0, 'er is een kruising');
  const later = closes.slice(0, crossIdx + 2);
  assert.ok(later.length === crossIdx + 2, 'genoeg candles na de kruising');
  assert.notEqual(evaluate(candlesFrom(later), p, 1).signal, 'buy');
  const r = evaluate(candlesFrom(later), p, 3);
  assert.equal(r.signal, 'buy');
  assert.match(r.reason, /candles? geleden/);
  assert.ok(r.crossAt != null);
});

test('een oude kruising telt niet meer als de trend alweer omgedraaid is', () => {
  const closes = [...Array(15)].map((_, i) => 30 - i).concat([16.5, 17.5, 18.5, 12, 9, 6]);
  const r = evaluate(candlesFrom(closes), { ...params, rsiMaxEntry: 100 }, 10);
  assert.notEqual(r.signal, 'buy');
});

test('ATR, ADX en volumeratio', async () => {
  const { atr, adx, volumeRatio } = await import('../src/indicators.js');
  // Elke candle exact 2 breed (high = close+1, low = close-1), geen gaten: ATR = 2
  const flat = [...Array(40)].map((_, i) => [i, 10, 11, 9, 10, 100]);
  assert.ok(Math.abs(atr(flat, 14).at(-1) - 2) < 1e-9);
  // Constante stijging: sterke trend, ADX hoog. Zijwaarts heen en weer: ADX laag.
  const up = [...Array(60)].map((_, i) => [i, 10 + i, 11 + i, 9.5 + i, 10.5 + i, 100]);
  const chop = [...Array(60)].map((_, i) => { const b = 10 + (i % 2); return [i, b, b + 1, b - 1, b, 100]; });
  assert.ok(adx(up, 14).at(-1) > 50, `trend: ${adx(up, 14).at(-1)}`);
  assert.ok(adx(chop, 14).at(-1) < 20, `zijwaarts: ${adx(chop, 14).at(-1)}`);
  // Laatste candle 3× zoveel volume als het gemiddelde ervoor
  const vol = [...Array(21)].map((_, i) => [i, 1, 1, 1, 1, i === 20 ? 300 : 100]);
  assert.ok(Math.abs(volumeRatio(vol, 20) - 3) < 1e-9);
});

// Candles met realistische high/low en volume, voor de filters.
const fullCandles = (closes, vol = () => 100) =>
  closes.map((c, i) => [i * 3600000, i ? closes[i - 1] : c, Math.max(c, i ? closes[i - 1] : c) + 0.2, Math.min(c, i ? closes[i - 1] : c) - 0.2, c, vol(i)]);
const signalsWith = (closes, p, vol) => closes.map((_, i) => evaluate(fullCandles(closes.slice(0, i + 1), vol), p, 1));

test('trendfilter: geen aankoop als de koers onder de lange EMA ligt', () => {
  // Lange daling, dan een korte opleving: kruising omhoog, maar nog ver onder de EMA 50.
  const closes = [...Array(80)].map((_, i) => 200 - i * 1.5).concat([82, 84, 86, 88]);
  const p = { ...params, rsiMaxEntry: 100 };
  assert.ok(signalsWith(closes, { ...p, trendEma: 0 }).some((r) => r.signal === 'buy'), 'zonder filter wel een signaal');
  const withFilter = signalsWith(closes, { ...p, trendEma: 50 });
  assert.ok(!withFilter.some((r) => r.signal === 'buy'));
  assert.ok(withFilter.some((r) => /trend-EMA 50/.test(r.reason)));
});

test('ADX- en volumefilter houden zwakke signalen tegen', () => {
  const closes = [...Array(80)].map((_, i) => 200 - i * 1.5).concat([82, 84, 86, 88]);
  const p = { ...params, rsiMaxEntry: 100 };
  const adxBlocked = signalsWith(closes, { ...p, adxMin: 99 });
  assert.ok(!adxBlocked.some((r) => r.signal === 'buy'));
  assert.ok(adxBlocked.some((r) => /ADX/.test(r.reason)));
  // Normaal volume: met volumefilter 3× geen aankoop
  const volBlocked = signalsWith(closes, { ...p, volumeMult: 3 });
  assert.ok(!volBlocked.some((r) => r.signal === 'buy'));
  // Volumepiek op de kruising: wel een aankoop
  const spike = signalsWith(closes, { ...p, volumeMult: 3 }, (i) => (i >= 80 ? 1000 : 100));
  assert.ok(spike.some((r) => r.signal === 'buy'));
});
