import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ema, rsi, marketIndicators } from '../src/indicators.js';
import { parseDecision, testConnection } from '../src/ai.js';
import { checkEntry } from '../src/risk.js';
import { Store } from '../src/store.js';

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

test('marktbeeld (marketIndicators): EMA 12/26, RSI, verandering over 24 candles; te weinig data = null', () => {
  assert.equal(marketIndicators(candlesFrom([1, 2, 3])), null);
  assert.equal(marketIndicators([]), null);
  const up = marketIndicators(candlesFrom([...Array(60)].map((_, i) => 100 + i)));
  assert.equal(up.close, 159);
  assert.ok(up.emaFast > up.emaSlow, 'stijgende trend');
  assert.equal(up.rsi, 100);
  assert.ok(Math.abs(up.change24 - ((159 - 135) / 135) * 100) < 1e-9);
  assert.equal(up.emaTrend, null);
  const down = marketIndicators(candlesFrom([...Array(60)].map((_, i) => 200 - i)));
  assert.ok(down.emaFast < down.emaSlow, 'dalende trend');
  for (const k of ['adx', 'atr', 'atrPct', 'volumeRatio']) assert.ok(k in down, k);
});

test('parseDecision leest JSON, ook met tekst eromheen', () => {
  assert.deepEqual(parseDecision('ok: {"decision":"Reject","reason":"te volatiel"}'), {
    decision: 'reject',
    reason: 'te volatiel',
  });
  assert.throws(() => parseDecision('{"decision":"maybe"}'));
  assert.throws(() => parseDecision('geen json'));
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

test('fetchPrice: laatste koers, anders midden van bied en laat, anders een fout (nooit NaN)', async () => {
  const { fetchPrice } = await import('../src/exchange.js');
  const ex = (t) => ({ fetchTicker: async () => t });
  assert.equal(await fetchPrice(ex({ last: 2 }), 'A/EUR'), 2);
  assert.equal(await fetchPrice(ex({ last: null, close: 3 }), 'A/EUR'), 3);
  assert.equal(await fetchPrice(ex({ last: undefined, bid: 1, ask: 3 }), 'A/EUR'), 2);
  await assert.rejects(fetchPrice(ex({ last: NaN }), 'A/EUR'), /Geen bruikbare koers voor A\/EUR/);
  await assert.rejects(fetchPrice(ex({}), 'A/EUR'), /Geen bruikbare koers/);
});
