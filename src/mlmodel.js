// Eigen voorspelmodel (getraind door vetobot-trainer op de VPS).
//
// computeFeatures() rekent exact dezelfde kenmerken uit als trainer/features.py, en predict()
// rekent het gradient-boosting-model uit dat de trainer als JSON exporteert. De test
// test/mlmodel.test.js controleert met door Python gemaakte voorbeelden dat beide gelijk zijn.
import { ema, rsi, atr, adx } from './indicators.js';

export const FEATURES = [
  'rsi14', 'adx14', 'atrPct', 'volRatio', 'distEma20Atr', 'distEma50Atr', 'emaSpreadPct',
  'ret1', 'ret3', 'ret12', 'er24', 'greens', 'toHigh48Atr', 'fromLow48Atr', 'upperWick', 'volTrend',
  // Het grotere plaatje, wat Bitcoin doet, en de tijd (zie trainer/features.py).
  'ret48', 'htfTrendPct', 'htfRet96', 'htfPos240',
  'btcRet3', 'btcRet12', 'btcRet48', 'btcTrendPct', 'relRet12', 'relRet48',
  'hourUtc', 'dowUtc',
];
export const WARMUP = 250;
const HTF = 240;
// Zoveel candles heeft de bot minimaal nodig voor het model.
export const CANDLES_NEEDED = WARMUP + 10;

const pct = (p, q) => (q ? (p / q - 1) * 100 : 0);
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

// Kenmerken van BTC/EUR op tijdstip ts (zelfde timeframe), of null als die candle er niet is.
function btcAt(btc, ts) {
  if (!btc?.length) return null;
  let j = -1;
  for (let k = btc.length - 1; k >= 0; k--) {
    if (btc[k][0] === ts) { j = k; break; }
    if (btc[k][0] < ts) break;
  }
  if (j < WARMUP) return null;
  const bc = btc.map((x) => x[4]);
  return {
    btcRet3: pct(bc[j], bc[j - 3]), btcRet12: pct(bc[j], bc[j - 12]), btcRet48: pct(bc[j], bc[j - 48]),
    btcTrendPct: pct(bc[j], mean(bc.slice(j - HTF + 1, j + 1))),
  };
}

// Kenmerken op de laatste candle. candles: [ts, open, high, low, close, volume], oud -> nieuw.
// ctx.btc: candles van BTC/EUR op dezelfde timeframe (mag ontbreken).
// Geeft null als er te weinig geschiedenis is.
export function computeFeatures(candles, ctx = {}) {
  const c = candles;
  const i = c.length - 1;
  if (i < WARMUP) return null;
  const closes = c.map((x) => x[4]);
  const close = closes[i];
  const a = atr(c, 14)[i];
  if (!a || close <= 0) return null;
  const vol = c.map((x) => x[5]);
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  const prev20 = sum(vol.slice(i - 20, i)) / 20;
  let path = 0;
  for (let k = i - 23; k <= i; k++) path += Math.abs(closes[k] - closes[k - 1]);
  let greens = 0;
  for (let k = i; k >= 0 && c[k][4] > c[k][1] && greens < 10; k--) greens++;
  const prev48 = c.slice(i - 48, i);
  const hi48 = Math.max(...prev48.map((x) => x[2]));
  const lo48 = Math.min(...prev48.map((x) => x[3]));
  const x = c[i];
  const rng = x[2] - x[3];
  const v3 = sum(vol.slice(i - 2, i + 1)) / 3;
  const v20 = sum(vol.slice(i - 22, i - 2)) / 20;
  const e9 = ema(closes, 9)[i], e20 = ema(closes, 20)[i], e21 = ema(closes, 21)[i], e50 = ema(closes, 50)[i];
  const ret12 = pct(close, closes[i - 12]);
  const ret48 = pct(close, closes[i - 48]);
  const prev240 = c.slice(i - HTF, i);
  const hi = Math.max(...prev240.map((y) => y[2]));
  const lo = Math.min(...prev240.map((y) => y[3]));
  const ts = Number(x[0]);
  const btc = btcAt(ctx.btc, ts) ?? { btcRet3: null, btcRet12: null, btcRet48: null, btcTrendPct: null };
  return {
    ret48,
    htfTrendPct: pct(close, mean(closes.slice(i - HTF + 1, i + 1))),
    htfRet96: pct(close, closes[i - 96]),
    htfPos240: hi > lo ? (close - lo) / (hi - lo) : 0.5,
    ...btc,
    relRet12: btc.btcRet12 != null ? ret12 - btc.btcRet12 : null,
    relRet48: btc.btcRet48 != null ? ret48 - btc.btcRet48 : null,
    hourUtc: Math.floor(ts / 3600000) % 24,
    dowUtc: (Math.floor(ts / 86400000) + 3) % 7,
    rsi14: rsi(closes, 14)[i],
    adx14: adx(c, 14)[i],
    atrPct: (a / close) * 100,
    volRatio: prev20 > 0 ? vol[i] / prev20 : null,
    distEma20Atr: (close - e20) / a,
    distEma50Atr: (close - e50) / a,
    emaSpreadPct: ((e9 - e21) / close) * 100,
    ret1: pct(close, closes[i - 1]),
    ret3: pct(close, closes[i - 3]),
    ret12,
    er24: path > 0 ? Math.abs(closes[i] - closes[i - 24]) / path : 0,
    greens,
    toHigh48Atr: (hi48 - close) / a,
    fromLow48Atr: (close - lo48) / a,
    upperWick: rng > 0 ? (x[2] - Math.max(x[1], x[4])) / rng : 0,
    volTrend: v20 > 0 ? v3 / v20 : null,
  };
}

// Controleert of een model van de trainer bruikbaar is.
export function validateModel(m) {
  if (!m || m.version !== 1 || m.kind !== 'gbdt') return 'Onbekend modelformaat';
  // Een model mag een deel van de kenmerken gebruiken (oudere modellen hebben er minder).
  if (!Array.isArray(m.features) || !m.features.length || m.features.some((k) => !FEATURES.includes(k))) return 'Het model gebruikt andere kenmerken dan deze versie van vetobot; update de bot of de trainer';
  if (!Array.isArray(m.trees) || !m.trees.length || !Array.isArray(m.medians) || m.medians.length !== m.features.length) return 'Model is onvolledig';
  if (!Number.isFinite(m.init) || !Number.isFinite(m.learningRate)) return 'Model is onvolledig';
  return null;
}

// Winstkans (0-1) volgens het model. Ontbrekende kenmerken worden gevuld met de mediaan
// uit de trainingsdata, net als bij het trainen.
export function predict(model, features) {
  const row = model.features.map((k, j) => {
    const v = features?.[k];
    return v == null || !Number.isFinite(v) ? model.medians[j] : v;
  });
  let total = 0;
  for (const t of model.trees) {
    let n = 0;
    while (t.l[n] !== -1) n = row[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
    total += t.v[n];
  }
  const raw = model.init + model.learningRate * total;
  return 1 / (1 + Math.exp(-raw));
}
