// Bitvavo ↔ Bybit (src/venuecompare.js en BotManager): nep-reeksen, geen netwerk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VENUE_COMPARE, psi, smd, pearson, compareCoin, comparePrice, compareModel, compareFeatures, compareTrades, compareBacktest,
  collectVenueCompare, compareDue, compareAlert, compareWeeklyLine, compareAlertMessage, totalVerdict, align, windowFor, featureSeries,
} from '../src/venuecompare.js';
import { BotManager } from '../src/manager.js';
import { Users } from '../src/users.js';
import { SharedMarket } from '../src/exchange.js';

const M15 = 15 * 60000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const N = 560; // 300 te vergelijken + aanloop voor de kenmerken

// Herhaalbare ruis.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (r) => () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// Koersreeks (in euro) met candles [ts, open, high, low, close, volume] die eindigen vóór NOW.
function series(seed, { n = N, start = 100, sigma = 0.004, volume = 50 } = {}) {
  const g = gauss(rng(seed));
  const t0 = NOW - (n + 1) * M15;
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = o * Math.exp(sigma * g());
    out.push([t0 + i * M15, o, Math.max(o, p) * 1.001, Math.min(o, p) * 0.999, p, volume * (1 + 0.5 * Math.abs(g()))]);
  }
  return out;
}

// Dezelfde markt op Bybit in een quote-munt: prijs gedeeld door de koers (euro per quote), met optioneel extra
// ruis per candle (noise), geschaalde beweging (scale) of een vaste afwijking (offsetPct).
function onBybit(candles, { rate = 0.9, noise = 0, scale = 1, offsetPct = 0, volumeFactor = 1, seed = 99 } = {}) {
  const g = gauss(rng(seed));
  const first = candles[0][4];
  return candles.map((c) => {
    const k = (x) => {
      const lr = Math.log(x / first) * scale + noise * g();
      return (first * Math.exp(lr) * (1 + offsetPct / 100)) / rate;
    };
    const o = k(c[1]), cl = k(c[4]);
    return [c[0], o, Math.max(o, cl, k(c[2])), Math.min(o, cl, k(c[3])), cl, c[5] * volumeFactor];
  });
}

// Een klein model: verwachting +0,8% als de laatste 3 candles meer dan +0,4% stegen, anders −0,1%.
const ENTRY = { version: 1, kind: 'gbdt-reg', features: ['ret3', 'rsi14', 'atrPct', 'volRatio', 'btcRet12'], medians: [0, 50, 0.5, 1, 0], init: 0, learningRate: 1,
  trees: [{ f: [0, -1, -1], t: [0.4, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0, -0.1, 0.8] }] };
const AGENT = { version: 2, kind: 'agent', timeframe: '15m', threshold: 0.5, recipeKey: 'R1', coins: ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'], entry: ENTRY,
  meta: { trainedAt: '2026-11-26T00:00:00Z', report: { test: { trades: 80, avgPct: 0.3 } } } };

const btcA = series(1, { start: 60000 });
const btcB = onBybit(btcA);

test('identieke markten (alleen in een andere quote) → ✅ zelfde model is goed genoeg', () => {
  const a = series(2);
  const r = compareCoin({ pair: 'ETH/EUR', venuePair: 'ETH/USDC', tf: '15m', a: { candles: a, btc: btcA }, b: { candles: onBybit(a), btc: btcB },
    eurPerQuote: 0.9, quote: 'USDC', agent: AGENT, threshold: 0.5, now: NOW });
  assert.equal(r.status, 'ok', JSON.stringify(r.parts, null, 1));
  assert.ok(Math.abs(r.parts.price.meanPct) < 1e-9);
  assert.ok(r.parts.corr.corr > 0.999);
  assert.ok(Math.abs(r.parts.vol.ratio - 1) < 1e-6);
  assert.ok(Math.abs(r.parts.volume.ratio - 1) < 1e-6);
  assert.ok(r.parts.features.meanPsi < 0.01, 'alleen afrondingsverschillen');
  assert.equal(r.parts.model.aboveA, r.parts.model.aboveB);
  assert.ok(r.parts.model.corr > 0.999 || r.parts.model.corr == null);
  assert.equal(r.text, 'Zelfde model is goed genoeg');
  assert.ok(r.candles >= 200 && r.samples >= VENUE_COMPARE.minSamples);
});

test('matig verschil in één onderdeel → ⚠️ let op', () => {
  const a = series(3);
  // Een vaste afwijking van 0,8% in de prijs: verder precies dezelfde markt.
  const r = compareCoin({ pair: 'ETH/EUR', venuePair: 'ETH/USDT', tf: '15m', a: { candles: a, btc: btcA }, b: { candles: onBybit(a, { offsetPct: 0.8 }), btc: btcB },
    eurPerQuote: 0.9, agent: AGENT, threshold: 0.5, now: NOW });
  assert.equal(r.parts.price.status, 'warn');
  assert.equal(r.parts.corr.status, 'ok');
  assert.equal(r.status, 'warn');
  assert.equal(r.text, 'Let op');
  assert.match(r.detail, /prijsverschil/);
  // 35% onrustiger: de volatiliteit zelf is ⚠️ (en het model ziet dan ook andere kenmerken).
  const v = compareCoin({ pair: 'ETH/EUR', tf: '15m', a: { candles: a, btc: btcA }, b: { candles: onBybit(a, { scale: 1.35 }), btc: btcB }, eurPerQuote: 0.9, now: NOW });
  assert.equal(v.parts.vol.status, 'warn');
  assert.ok(Math.abs(v.parts.vol.ratio - 1.35) < 0.01);
  assert.equal(v.parts.corr.status, 'ok');
  assert.notEqual(v.parts.features.status, 'ok');
});

test('ruisige Bybit-koersen → ❌ apart leren aanbevolen', () => {
  const a = series(4);
  const r = compareCoin({ pair: 'SOL/EUR', venuePair: 'SOL/USDT', tf: '15m', a: { candles: a, btc: btcA }, b: { candles: onBybit(a, { noise: 0.006 }), btc: btcB },
    eurPerQuote: 0.9, agent: AGENT, threshold: 0.5, now: NOW });
  assert.equal(r.parts.corr.status, 'bad');
  assert.equal(r.status, 'bad');
  assert.equal(r.text, 'Apart leren voor Bybit aanbevolen');
  assert.match(r.action, /niet live op Bybit/);
});

test('te weinig data → "Nog te weinig data (x van y)"', () => {
  const a = series(5, { n: 60 });
  const r = compareCoin({ pair: 'ADA/EUR', tf: '15m', a: { candles: a, btc: [] }, b: { candles: onBybit(a), btc: [] }, eurPerQuote: 0.9, now: NOW });
  assert.equal(r.status, 'nodata');
  assert.deepEqual(r.progress, { have: 60, need: VENUE_COMPARE.minCandles });
  assert.equal(r.text, 'Nog te weinig data (60 van 100)');
  // Genoeg candles, maar te weinig aanloop voor de kenmerken: markt wel, model nog niet.
  const b = series(6, { n: 300 });
  const r2 = compareCoin({ pair: 'ADA/EUR', tf: '15m', a: { candles: b, btc: [] }, b: { candles: onBybit(b), btc: [] }, eurPerQuote: 0.9, agent: AGENT, now: NOW });
  assert.equal(r2.parts.features.status, 'nodata');
  assert.equal(r2.status, 'ok');
});

test('prijsverschil wordt in euro omgerekend met de quote-koers', () => {
  const a = series(7, { n: 150 });
  const rows = align(a, onBybit(a, { rate: 0.9 }));
  assert.ok(Math.abs(comparePrice(rows, 0.9, 'USDC').meanPct) < 1e-9, 'juiste koers: geen verschil');
  const wrong = comparePrice(rows, 0.92, 'USDC');
  assert.ok(Math.abs(wrong.meanPct - (0.92 / 0.9 - 1) * 100) < 1e-9);
  assert.equal(wrong.status, 'bad');
  assert.match(wrong.text, /0,9200 euro per USDC/);
  const off = comparePrice(align(a, onBybit(a, { rate: 0.9, offsetPct: 0.8 })), 0.9);
  assert.equal(off.status, 'warn');
  assert.ok(Math.abs(off.meanPct - 0.8) < 1e-6);
  assert.equal(comparePrice(rows, null, 'USDC').status, 'warn', 'zonder koers: ⚠️ met reden');
});

test('PSI en gestandaardiseerd verschil', () => {
  const g = gauss(rng(11));
  const a = [...Array(2000)].map(() => g());
  assert.ok(psi(a, a) < 1e-9);
  assert.equal(smd(a, a), 0);
  const b = a.map((x) => x + 1);
  assert.ok(psi(a, b) > VENUE_COMPARE.psi.bad, `psi ${psi(a, b)}`);
  assert.ok(Math.abs(smd(a, b) - 1 / Math.sqrt(a.reduce((s, x) => s + x * x, 0) / (a.length - 1))) < 0.05);
  const c = [...Array(2000)].map(() => g());
  assert.ok(psi(a, c) < VENUE_COMPARE.psi.ok, 'zelfde verdeling, andere trekking: nauwelijks verschoven');
  assert.equal(psi([1], [1, 2]), null);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  // Verschoven kenmerken in compareFeatures.
  const fa = a.map((x) => ({ ret3: x, rsi14: 50 + x })), fb = a.map((x) => ({ ret3: x + 1, rsi14: 50 + x + 1 }));
  const r = compareFeatures(fa, fb, ['ret3', 'rsi14']);
  assert.equal(r.status, 'bad');
  assert.equal(r.features.length, 2);
});

test('verwachting van de AI-trader op beide beurzen, met de kosten van Bybit', () => {
  const fa = [...Array(200)].map((_, i) => ({ ret3: i % 10 === 0 ? 1 : 0 }));
  const same = compareModel(fa, fa, AGENT, 0.5, 0);
  assert.equal(same.status, 'ok');
  assert.equal(same.aboveA, 20);
  assert.equal(same.aboveB, 20);
  // Bybit ziet de stijgingen nooit: hij komt daar nooit boven de drempel.
  const flat = fa.map(() => ({ ret3: 0 }));
  const off = compareModel(fa, flat, AGENT, 0.5, 0);
  assert.equal(off.aboveB, 0);
  assert.equal(off.statuses.freq, 'bad');
  assert.equal(off.status, 'bad');
  // Hogere kosten op Bybit (costShift −0,4): 0,8 − 0,4 = 0,4 < 0,5, dus nooit boven de drempel.
  const cost = compareModel(fa, fa, AGENT, 0.5, -0.4);
  assert.equal(cost.aboveB, 0);
  assert.match(cost.text, /andere kosten/);
  assert.equal(compareModel(fa, fa, null, 0.5).status, 'nodata');
  // Kenmerken zoals de bot ze ziet (laatste CANDLES_NEEDED candles), op beide gelijk.
  const a = series(8);
  const sa = featureSeries(a, btcA, a.at(-50)[0]);
  assert.equal(sa.size, 50);
});

test('echte trades: Welch-toets alleen bij genoeg trades', () => {
  const g = gauss(rng(5));
  const tr = (m, n, extra = {}) => [...Array(n)].map(() => ({ pair: 'ETH/EUR', pnlPct: m + 0.3 * g(), agent: { recipe: 'R1' }, ...extra }));
  assert.equal(compareTrades(tr(0.2, 10), tr(0.2, 30)).status, 'nodata');
  const same = tr(0.3, 40);
  assert.equal(compareTrades(same, same.map((t) => ({ ...t }))).status, 'ok');
  const worse = compareTrades(tr(0.4, 40), tr(-0.4, 40));
  assert.equal(worse.status, 'bad');
  assert.match(worse.text, /Aantoonbaar slechter op Bybit/);
  // Verkenner en handmatig tellen niet mee.
  assert.equal(compareTrades(tr(0.3, 40, { agent: { explore: true } }), tr(0.3, 40)).nA, 0);
});

test('eindtest op Bybit-koersen tegenover Bitvavo', () => {
  const mk = (avg, trades = 40) => ({ ...AGENT, venueStats: { bybit: { trades, avgPct: avg, backtest: { trades, avgPct: avg, since: '2026-11-01' } } } });
  assert.equal(compareBacktest(mk(0.28)).status, 'ok');
  assert.equal(compareBacktest(mk(0.1)).status, 'warn');
  assert.equal(compareBacktest(mk(-0.05)).status, 'bad');
  assert.equal(compareBacktest(mk(0.3, 5)).status, 'nodata');
  assert.equal(compareBacktest(AGENT).status, 'nodata');
});

// Nep-beurzen voor collectVenueCompare: Bitvavo X/EUR, Bybit X/USDC (Bybit EU).
function fakeVenues({ bybitNoise = {} } = {}) {
  const bv = { 'BTC/EUR': btcA, 'ETH/EUR': series(21), 'SOL/EUR': series(22), 'XRP/EUR': series(23), 'ONLYBV/EUR': series(24) };
  const by = { 'BTC/USDC': btcB, 'ONLYBY/USDC': series(25) };
  for (const p of ['ETH', 'SOL', 'XRP']) by[`${p}/USDC`] = onBybit(bv[`${p}/EUR`], bybitNoise[p] ?? {});
  const calls = { bitvavo: 0, bybit: 0 };
  const venue = (data, name, toVenue) => ({
    loadMarkets: async () => Object.fromEntries(Object.keys(data).map((k) => [k, { symbol: k }])),
    fetchCandles: async (pair, _tf, limit) => {
      calls[name]++;
      if (!data[pair]) throw new Error(`geen markt ${pair}`);
      return data[pair].slice(-limit);
    },
    toVenue,
  });
  return {
    calls, bv, by,
    bitvavo: venue(bv, 'bitvavo', (p) => p),
    bybit: venue(by, 'bybit', (p) => p.replace('/EUR', '/USDC')),
  };
}

test('verzamelen: coins op één beurs, gespreid, fouten worden ⚠️ en totaaloordeel', async () => {
  const f = fakeVenues({ bybitNoise: { SOL: { noise: 0.006 } } });
  const sleeps = [];
  const r = await collectVenueCompare({
    coins: ['BTC/EUR', 'ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ONLYBV/EUR'], bybitPairs: ['ETH/USDC', 'ONLYBY/USDC'], bitvavo: f.bitvavo, bybit: f.bybit,
    eurPerQuote: async () => 0.9, quote: 'USDC', host: 'bybit.eu', agent: AGENT, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, spacingMs: 1500,
  });
  assert.deepEqual(r.onlyBitvavo, ['ONLYBV/EUR']);
  assert.deepEqual(r.onlyBybit, ['ONLYBY/USDC']);
  assert.deepEqual(r.coins.map((c) => [c.pair, c.status]), [['BTC/EUR', 'ok'], ['ETH/EUR', 'ok'], ['SOL/EUR', 'bad'], ['XRP/EUR', 'ok']]);
  assert.equal(r.coins[1].venuePair, 'ETH/USDC');
  assert.deepEqual(sleeps, [1500, 1500, 1500], 'coins gespreid');
  // Eén verzoek per coin per beurs (BTC als context hergebruikt), plus de marktlijsten en de koers.
  assert.equal(f.calls.bitvavo, 4);
  assert.equal(f.calls.bybit, 4);
  assert.equal(r.requests, 4 + 4 + 2 + 1);
  assert.equal(r.verdict.level, 'warn', '1 van 4 coins ❌ (minder dan een derde) → ⚠️ in totaal');
  assert.match(r.verdict.detail, /SOL/);

  // Twee van de drie coins duidelijk anders: totaal ❌.
  const f2 = fakeVenues({ bybitNoise: { SOL: { noise: 0.006 }, ETH: { noise: 0.006, seed: 5 } } });
  const r2 = await collectVenueCompare({ coins: ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'], bitvavo: f2.bitvavo, bybit: f2.bybit, eurPerQuote: async () => 0.9, agent: AGENT, now: () => NOW, spacingMs: 0 });
  assert.equal(r2.verdict.level, 'bad');
  assert.equal(r2.verdict.text, 'Apart leren voor Bybit aanbevolen');

  // Ophalen mislukt voor één coin en geen koers: ⚠️ met de reden, de rest gaat door.
  const f3 = fakeVenues();
  const orig = f3.bybit.fetchCandles;
  f3.bybit.fetchCandles = async (p, tf, l) => (p === 'XRP/USDC' ? Promise.reject(new Error('time-out')) : orig(p, tf, l));
  const r3 = await collectVenueCompare({ coins: ['ETH/EUR', 'XRP/EUR'], bitvavo: f3.bitvavo, bybit: f3.bybit, eurPerQuote: async () => { throw new Error('Geen USDC/EUR-koers'); }, now: () => NOW, spacingMs: 0 });
  const xrp = r3.coins.find((c) => c.pair === 'XRP/EUR');
  assert.equal(xrp.status, 'warn');
  assert.match(xrp.detail, /time-out/);
  assert.equal(r3.coins.find((c) => c.pair === 'ETH/EUR').parts.price.status, 'warn');
  assert.equal(r3.verdict.level, 'warn');
  assert.ok(r3.errors.some((e) => /USDC\/EUR/.test(e)));
});

test('totaaloordeel zonder coins met data: nog te weinig data (x van y)', () => {
  const v = totalVerdict([{ pair: 'A/EUR', status: 'nodata' }, { pair: 'B/EUR', status: 'nodata' }]);
  assert.equal(v.level, 'nodata');
  assert.equal(v.text, 'Nog te weinig data (0 van 2)');
});

test('cache en throttle: automatisch hooguit eens per 6 uur, knop hooguit eens per 15 minuten', () => {
  const at = new Date(NOW).toISOString();
  assert.equal(compareDue(null, NOW).due, true);
  assert.equal(compareDue({ at, sig: 's' }, NOW + 5 * 3600000, { sig: 's' }).due, false);
  assert.equal(compareDue({ at, sig: 's' }, NOW + 5 * 3600000, { sig: 's' }).waitMinutes, 60);
  assert.equal(compareDue({ at, sig: 's' }, NOW + 6 * 3600000, { sig: 's' }).due, true);
  assert.equal(compareDue({ at }, NOW + 10 * 60000, { manual: true }).due, false);
  assert.equal(compareDue({ at }, NOW + 10 * 60000, { manual: true }).waitMinutes, 5);
  assert.equal(compareDue({ at }, NOW + 15 * 60000, { manual: true }).due, true);
  // Andere Bybit-website of AI-trader: eerder opnieuw, maar niet vaker dan de knop.
  assert.equal(compareDue({ at, sig: 'a' }, NOW + 20 * 60000, { sig: 'b' }).due, true);
  assert.equal(compareDue({ at, sig: 'a' }, NOW + 5 * 60000, { sig: 'b' }).due, false);
});

test('melding: één keer per overgang naar ❌', () => {
  const bad = { verdict: { level: 'bad', text: 'Apart leren voor Bybit aanbevolen', detail: '2 van 3 coins', action: 'x' }, host: 'bybit.eu', quote: 'USDC', coins: [{ pair: 'SOL/EUR', status: 'bad', detail: 'duidelijk verschil: koersen bewegen gelijk' }] };
  const warn = { verdict: { level: 'warn', text: 'Let op' } };
  const ok = { verdict: { level: 'ok', text: 'Zelfde model is goed genoeg' } };
  let s = {};
  const step = (r, t) => { const x = compareAlert(s, r, t); s = x.state; return x.send; };
  assert.equal(step(ok, NOW), false);
  assert.equal(step(bad, NOW + 1), true);
  assert.equal(step(bad, NOW + 2), false, 'niet nog een keer');
  assert.equal(step(warn, NOW + 3), false, '⚠️ is geen herstel');
  assert.equal(step(bad, NOW + 4), false);
  assert.equal(step(ok, NOW + 5), false);
  assert.equal(step(bad, NOW + 6), true, 'na herstel opnieuw');
  const m = compareAlertMessage(bad);
  assert.match(m.title, /Bybit EU/);
  assert.match(m.message, /SOL/);
  assert.match(compareWeeklyLine(bad), /^❌ \*\*Bitvavo ↔ Bybit EU\*\* \(USDC\): Apart leren/);
  assert.equal(compareWeeklyLine(null), null);
});

test('windowFor: één verzoek van hooguit 1000 candles per coin', () => {
  for (const tf of ['1m', '5m', '15m', '1h', '4h']) {
    const w = windowFor(tf);
    assert.ok(w.limit <= 1000 && w.window >= 200, tf);
  }
  assert.equal(windowFor('15m').window, 288);
});

// ---------- BotManager ----------
const quiet = { info() {}, warn() {}, error() {} };
const baseConfig = (dir) => ({
  dataDir: dir, liveTrading: false, pairs: ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'], timeframe: '15m', checkIntervalMinutes: 15,
  paper: { startBalanceEur: 500 },
  risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 3, takeProfitPct: 6, maxDailyLossEur: 20, feePct: 0.25, cooldownMinutes: 0, slippagePct: 0 },
  strategy: {}, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
});

function fakeEx(data) {
  const calls = [];
  return {
    calls,
    markets: Object.fromEntries(Object.keys(data).map((p) => [p, { symbol: p }])),
    parseTimeframe: () => 900,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV(pair, _tf, _s, limit) { calls.push(pair); if (!data[pair]) throw new Error('onbekend'); return data[pair].slice(-limit); },
    async fetchTicker(pair) { calls.push(`ticker:${pair}`); if (pair === 'USDC/EUR') return { last: 0.9 }; throw new Error('onbekend'); },
  };
}

function setup({ solNoise = 0.006, ethNoise = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-vc-'));
  const eth = series(31), sol = series(32);
  const bvEx = fakeEx({ 'BTC/EUR': btcA, 'ETH/EUR': eth, 'SOL/EUR': sol });
  const byEx = fakeEx({ 'BTC/USDC': btcB, 'ETH/USDC': onBybit(eth, { noise: ethNoise, seed: 3 }), 'SOL/USDC': onBybit(sol, { noise: solNoise }) });
  const users = new Users(dir);
  users.setup({ username: 'admin', password: 'lang-genoeg-123', code: users.setupCode }, 'x');
  const make = () => {
    const m = new BotManager({ config: baseConfig(dir), users, log: quiet, shared: new SharedMarket(bvEx), sharedVenues: { 'bybit|bybit.eu': new SharedMarket(byEx) }, makePrivateExchange: () => ({}) });
    m.vcSpacingMs = 0;
    m.vcNow = () => NOW;
    m.ml.agent = AGENT;
    return m;
  };
  return { dir, users, make, bvEx, byEx };
}

async function adminCtx(env, m) {
  const admin = env.users.admin;
  const ctx = m.ensure(admin);
  ctx.settings.setBybitHost('bybit.eu');
  return { admin, ctx };
}

test('manager: vergelijkt met de gekozen Bybit-website terwijl hij op Bitvavo staat, cache 6 uur, melding één keer (ook na herstart)', async () => {
  const env = setup();
  let m = env.make();
  const { admin, ctx } = await adminCtx(env, m);
  assert.equal(ctx.settings.exchange, 'bitvavo');
  const sent = [];
  ctx.notifier.send = async (kind, msg) => { sent.push([kind, msg.title]); };
  // Zonder planner start een GET niets (geen netwerk vanuit het dashboard zonder startAll).
  const pending = m.venueCompare(admin.id, NOW);
  assert.equal(pending.pending, true);
  assert.equal(pending.busy, false);
  const r = await m.refreshVenueCompare(admin.id, { now: NOW });
  assert.equal(r.host, 'bybit.eu');
  assert.equal(r.quote, 'USDC');
  assert.equal(r.eurPerQuote, 0.9);
  const by = Object.fromEntries(r.coins.map((c) => [c.pair, c.status]));
  assert.equal(by['SOL/EUR'], 'bad');
  assert.equal(by['ETH/EUR'], 'ok');
  assert.equal(r.verdict.level, 'bad', '1 van 3 coins (BTC, ETH, SOL) = een derde → ❌');
  assert.deepEqual(sent.map((x) => x[0]), ['learning']);
  assert.match(sent[0][1], /Bitvavo ↔ Bybit EU/);
  assert.equal(ctx.settings.learnCheck.venueCompare.level, 'bad');
  assert.ok(fs.existsSync(path.join(ctx.dir, 'venue-compare.json')));
  // Geen Bybit-stores aangemaakt voor iemand die op Bitvavo handelt.
  assert.equal(ctx.venues.bybit, undefined);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'state-paper-bybit.json')));

  // Binnen 6 uur: niets opnieuw (geen verzoeken), de knop pas na 15 minuten.
  const before = env.byEx.calls.length;
  const again = await m.refreshVenueCompare(admin.id, { now: NOW + 3600000 });
  assert.equal(again.at, r.at);
  assert.equal(env.byEx.calls.length, before);
  assert.throws(() => m.startVenueCompare(admin.id, NOW + 5 * 60000), /opnieuw kan over 10 min/);
  const view = m.venueCompare(admin.id, NOW + 3600000);
  assert.equal(view.refreshInMinutes, 0);
  assert.equal(view.nextAutoMinutes, 300);
  assert.equal(view.verdict.level, 'bad');

  // Herstart: resultaat en meldtoestand van schijf; nog steeds ❌ → geen tweede melding.
  m.stopAll();
  m = env.make();
  const ctx2 = m.ensure(admin);
  const sent2 = [];
  ctx2.notifier.send = async (kind, msg) => { sent2.push([kind, msg.title]); };
  assert.equal(m.venueCompareCached(admin.id).verdict.level, 'bad');
  await m.refreshVenueCompare(admin.id, { now: NOW + 7 * 3600000 });
  assert.equal(sent2.length, 0, 'na een herstart niets dubbel');
  m.stopAll();
});

test('manager: weekoverzicht krijgt een regel Bitvavo ↔ Bybit', async () => {
  const env = setup({ solNoise: 0 });
  const m = env.make();
  const { admin, ctx } = await adminCtx(env, m);
  const sent = [];
  ctx.notifier.send = async (kind, msg) => { sent.push([kind, msg]); };
  await m.refreshVenueCompare(admin.id, { now: NOW });
  assert.equal(m.venueCompareCached(admin.id).verdict.level, 'ok');
  assert.equal(sent.length, 0, '✅: geen directe melding');
  // Maandag na de tijd van het dagoverzicht: weekoverzicht van "Leert hij echt?" met de regel erbij.
  const monday = new Date(2026, 10, 30, 9, 0, 0);
  await m.checkLearning(monday);
  const week = sent.find(([, msg]) => /Leert hij echt\?/.test(msg.title));
  assert.ok(week, JSON.stringify(sent));
  assert.match(week[1].message, /✅ \*\*Bitvavo ↔ Bybit EU\*\* \(USDC\): Zelfde model is goed genoeg/);
  m.stopAll();
});
