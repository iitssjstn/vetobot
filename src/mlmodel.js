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

// Begrijpelijke namen en notatie per kenmerk (voor de uitleg aan de AI en op het dashboard).
export const FEATURE_INFO = {
  rsi14: ['RSI (14)', 0, ''], adx14: ['trendsterkte (ADX)', 0, ''], atrPct: ['normale beweging per candle (ATR)', 2, '%'],
  volRatio: ['volume t.o.v. gemiddeld', 1, '×'], distEma20Atr: ['afstand tot EMA20', 1, '× ATR'], distEma50Atr: ['afstand tot EMA50', 1, '× ATR'],
  emaSpreadPct: ['afstand snelle/trage EMA', 2, '%'], ret1: ['beweging laatste candle', 2, '%'], ret3: ['beweging laatste 3 candles', 2, '%'],
  ret12: ['beweging laatste 12 candles', 2, '%'], er24: ['hoe recht de koers liep (24 candles)', 2, ''], greens: ['groene candles op rij', 0, ''],
  toHigh48Atr: ['ruimte tot recente top', 1, '× ATR'], fromLow48Atr: ['afstand tot recente bodem', 1, '× ATR'], upperWick: ['bovenwick laatste candle', 2, ''],
  volTrend: ['volume-trend (kort t.o.v. lang)', 1, '×'], ret48: ['beweging laatste 48 candles', 2, '%'], htfTrendPct: ['trend groter plaatje', 2, '%'],
  htfRet96: ['beweging laatste 96 candles', 2, '%'], htfPos240: ['positie in de range van 240 candles', 2, ''], btcRet3: ['Bitcoin laatste 3 candles', 2, '%'],
  btcRet12: ['Bitcoin laatste 12 candles', 2, '%'], btcRet48: ['Bitcoin laatste 48 candles', 2, '%'], btcTrendPct: ['trend van Bitcoin', 2, '%'],
  relRet12: ['coin t.o.v. Bitcoin (12 candles)', 2, '%'], relRet48: ['coin t.o.v. Bitcoin (48 candles)', 2, '%'], hourUtc: ['uur (UTC)', 0, ''], dowUtc: ['dag van de week', 0, ''],
};
const DAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
export function formatFeature(key, v) {
  if (v == null || !Number.isFinite(v)) return 'onbekend';
  if (key === 'dowUtc') return DAYS[v] ?? String(v);
  if (key === 'hourUtc') return `${v}:00`;
  const [, dec, unit] = FEATURE_INFO[key] ?? [key, 2, ''];
  const sign = unit === '%' && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(dec)}${unit && unit !== '×' ? (unit.startsWith('%') ? '%' : ` ${unit}`) : unit}`;
}

// Gemiddelde uitkomst onder elke knoop van een boom (voor de uitleg). Met het aantal
// voorbeelden per knoop (t.n, nieuwere modellen) is dat exact; anders de waarde van de knoop.
function nodeMeans(t) {
  if (t._mean) return t._mean;
  const mean = new Array(t.l.length);
  const walk = (n) => {
    if (t.l[n] === -1) return (mean[n] = t.v[n]);
    const a = walk(t.l[n]), b = walk(t.r[n]);
    if (t.n) { const na = t.n[t.l[n]], nb = t.n[t.r[n]]; mean[n] = (na * a + nb * b) / (na + nb); } else mean[n] = t.v[n];
    return mean[n];
  };
  walk(0);
  Object.defineProperty(t, '_mean', { value: mean, enumerable: false });
  return mean;
}

// Waarom geeft het model deze kans? Per kenmerk hoeveel het de uitkomst omhoog of omlaag duwde
// (in log-odds), door elke splitsing langs het pad toe te rekenen aan het kenmerk waarop gesplitst
// wordt. Samen tellen ze precies op tot de voorspelling.
export function contributions(model, features) {
  const row = model.features.map((k, j) => {
    const v = features?.[k];
    return v == null || !Number.isFinite(v) ? model.medians[j] : v;
  });
  const c = new Array(model.features.length).fill(0);
  let base = model.init;
  for (const t of model.trees) {
    const mean = nodeMeans(t);
    let n = 0;
    base += model.learningRate * mean[0];
    while (t.l[n] !== -1) {
      const next = row[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
      c[t.f[n]] += model.learningRate * (mean[next] - mean[n]);
      n = next;
    }
  }
  return { base, contrib: c };
}

// Top-uitleg in procentpunten winstkans: [{ key, label, value, text, effect }], grootste eerst.
export function explain(model, features, top = 6) {
  const { base, contrib } = contributions(model, features);
  const raw = base + contrib.reduce((a, b) => a + b, 0);
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const p = sig(raw);
  return model.features
    .map((key, j) => ({ key, label: FEATURE_INFO[key]?.[0] ?? key, value: features?.[key] ?? null,
      text: formatFeature(key, features?.[key]), effect: (p - sig(raw - contrib[j])) * 100 }))
    .filter((x) => Math.abs(x.effect) >= 0.5)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, top);
}

// Soort markt voor deze coin (zelfde berekening als regime_of in trainer/train.py): de trend
// over het grotere plaatje, gemeten in "normale beweging" (ATR).
export const REGIME_LABEL = { stijgend: 'stijgende markt', zijwaarts: 'zijwaartse markt', dalend: 'dalende markt' };
export function regimeOf(f) {
  const t = f?.htfTrendPct, a = f?.atrPct;
  if (t == null || !a) return 'zijwaarts';
  const score = t / a;
  return score > 3 ? 'stijgend' : score < -3 ? 'dalend' : 'zijwaarts';
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
