// "Bitvavo ↔ Bybit": komt de marktdata van Bybit (de website die je koos: bybit.com in USDT, Bybit EU/NL in USDC)
// overeen met Bitvavo, en ziet de AI-trader (geleerd op Bitvavo) op Bybit hetzelfde? Met een oordeel per coin en
// in totaal: is apart leren voor Bybit nodig?
//
// Alleen rekenwerk (pure functies) plus één verzamelfunctie (collectVenueCompare) die zijn gegevens via
// meegegeven functies ophaalt, zodat alles zonder netwerk te testen is. Het ophalen (gedeelde publieke
// verbindingen met cache), de planning (hooguit eens per 6 uur) en de meldingen zitten in src/manager.js.
//
// Per coin (X/EUR op Bitvavo tegenover X/<quote> op Bybit), op gelijke tijdstempels, over de laatste
// windowDays dagen (minstens minWindowCandles candles) op de timeframe van het recept dat die coin handelt:
//   1. price     prijsverschil: slot Bybit × euro per quote (QuoteRate) tegenover slot Bitvavo, gemiddeld en max in %.
//   2. corr      koersen bewegen gelijk: correlatie van de candle-rendementen (log) op gelijke tijdstempels.
//   3. vol       even onrustig: standaardafwijking van de rendementen op Bybit gedeeld door die op Bitvavo.
//   4. volume    handelsvolume in euro (volume × slot, Bybit × koers), Bybit gedeeld door Bitvavo.
//   5. features  het model ziet hetzelfde: computeFeatures op beide reeksen (BTC-context van dezelfde beurs, net
//                als de bot: de laatste CANDLES_NEEDED candles), per kenmerk de PSI en het gestandaardiseerde
//                gemiddelde verschil.
//      model     de verwachting van de AI-trader (predictRaw(agent.entry, f)) op beide: gemiddelde, correlatie en
//                hoe vaak hij boven zijn drempel komt (Bybit met de kosten van Bybit, zoals de bot rekent).
//   6. trades    echte trades van de AI-trader op Bybit tegenover Bitvavo (Welch-toets uit src/stats.js), alleen
//                bij minstens trades.minTrades per beurs. In totaal ook de eindtest van de leerserver op
//                Bybit-koersen (venueStats.bybit.backtest) tegenover die op Bitvavo (meta.report.test).
import { computeFeatures, predictRaw, FEATURES, CANDLES_NEEDED, FEATURE_INFO } from './mlmodel.js';
import { agentParts } from './agents.js';
import { welch } from './stats.js';

// Drempels (één plek, zodat uitleg, dashboard en tests hetzelfde zijn).
export const VENUE_COMPARE = {
  windowDays: 3,            // vergelijkingsperiode
  minWindowCandles: 200,    // minstens zoveel candles (op 1h/4h dus langer dan 3 dagen)
  maxFetch: 1000,           // Bybit geeft hooguit 1000 candles per verzoek: één verzoek per coin per beurs
  minCandles: 100,          // minder gelijke tijdstempels: "nog te weinig data"
  minSamples: 100,          // kenmerken/verwachting op minstens zoveel candles
  price: { okMeanPct: 0.5, okMaxPct: 2, warnMeanPct: 1.5, warnMaxPct: 5 }, // 1. gemiddeld (absoluut) en max verschil
  corr: { ok: 0.9, warn: 0.75 },        // 2. ✅ vanaf 0,9, ⚠️ vanaf 0,75, anders ❌
  vol: { okPct: 25, warnPct: 50 },      // 3. ✅ binnen ±25%, ⚠️ binnen ±50%, anders ❌
  volume: { warnRatio: 0.1 },           // 4. alleen ⚠️: minder dan 10% van het Bitvavo-volume (dunne markt, meer slippage)
  psi: { ok: 0.1, bad: 0.25, bins: 10 }, // 5. PSI < 0,1 nauwelijks, ≥ 0,25 duidelijk verschoven (gangbare grenzen)
  model: {
    corrOk: 0.9, corrWarn: 0.7,         // correlatie van de verwachtingen
    meanOkPp: 0.05, meanWarnPp: 0.15,   // verschil in gemiddelde verwachting (%-punt, zonder kostenverschil)
    freqMinAbs: 3,                      // boven drempel: zoveel candles verschil is altijd goed
    freqRatioOk: 1.5,                   // ... of hooguit 1,5 × zo vaak
    freqRatioBad: 3, freqBadMin: 10,    // ❌ als de ene beurs ≥ 3 × zo vaak boven de drempel komt (en minstens 10 keer)
  },
  trades: { minTrades: 20, confidence: 0.95 }, // 6. echte trades: Welch, eenzijdig 95%
  backtest: { minTrades: 20 },                  // 6. eindtest op Bybit-koersen: pas vanaf 20 trades
  multiWarnBad: 3,          // zoveel ⚠️ in één coin samen: ❌
  totalBadShare: 1 / 3,     // totaal ❌ als minstens een derde van de coins ❌ is
  refreshHours: 6,          // hooguit eens per 6 uur opnieuw berekenen (automatisch)
  manualMinMinutes: 15,     // "Opnieuw vergelijken": hooguit eens per 15 minuten
  spacingMs: 1500,          // pauze tussen twee coins (verzoeken gespreid)
  candleCacheMinutes: 30,   // candles gedeeld tussen gebruikers zo lang bewaard
};

export const STATUS_ICON = { ok: '✅', warn: '⚠️', bad: '❌', nodata: '⏳' };
export const VERDICT_TEXT = {
  ok: 'Zelfde model is goed genoeg',
  warn: 'Let op',
  bad: 'Apart leren voor Bybit aanbevolen',
  nodata: 'Nog te weinig data',
};
export const PART_TITLES = {
  price: 'Prijsverschil', corr: 'Koersen bewegen gelijk', vol: 'Even onrustig', volume: 'Volume',
  features: 'Het model ziet hetzelfde', model: 'Verwachting AI-trader', trades: 'Echte trades',
};
// Kenmerken die per definitie gelijk zijn (tijd) of op Bybit ontbreken (orderboek van Bitvavo) tellen niet mee.
const SKIP_FEATURES = new Set(['hourUtc', 'dowUtc', 'microBookImb', 'microSpread', 'microBuyRatio60', 'microFlow60', 'microIntensity']);

// ---------- opmaak ----------
const nl = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(d).replace('.', ','));
const pct = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nl(Math.abs(v), d)}%`);
const pp = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nl(Math.abs(v), d)} %-punt`);
const finite = (x) => x != null && Number.isFinite(x);
const RANK = { ok: 0, nodata: 0, warn: 1, bad: 2 };
const worst = (...s) => s.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

// ---------- statistiek ----------
export function mean(xs) {
  const v = xs.filter(finite);
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
}

export function std(xs) {
  const v = xs.filter(finite);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

// Pearson-correlatie van gelijke paren; null bij te weinig paren of geen spreiding.
export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => finite(x) && finite(y));
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx <= 1e-18 || syy <= 1e-18) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Population Stability Index: hoeveel verschoof de verdeling van b (Bybit) tegenover a (Bitvavo)?
// Vakken op de kwantielen van a (dubbele grenzen samengevoegd), lege vakken met een kleine ondergrens.
export function psi(a, b, bins = VENUE_COMPARE.psi.bins) {
  const xs = a.filter(finite).sort((x, y) => x - y);
  const ys = b.filter(finite);
  if (xs.length < 2 || ys.length < 2) return null;
  const edges = [];
  for (let k = 1; k < bins; k++) {
    const q = xs[Math.min(xs.length - 1, Math.floor((k * xs.length) / bins))];
    if (!edges.length || q > edges.at(-1)) edges.push(q);
  }
  const share = (arr) => {
    const c = new Array(edges.length + 1).fill(0);
    for (const v of arr) {
      let i = 0;
      while (i < edges.length && v > edges[i]) i++;
      c[i]++;
    }
    return c.map((n) => Math.max(n / arr.length, 1e-4));
  };
  const pa = share(xs), pb = share(ys);
  return pa.reduce((s, x, i) => s + (pb[i] - x) * Math.log(pb[i] / x), 0);
}

// Gestandaardiseerd gemiddeld verschil (in standaardafwijkingen van Bitvavo).
export function smd(a, b) {
  const ma = mean(a), mb = mean(b), sa = std(a);
  if (ma == null || mb == null) return null;
  if (!sa || sa <= 1e-12) return Math.abs(mb - ma) <= 1e-12 ? 0 : null;
  return (mb - ma) / sa;
}

// ---------- candles ----------
const TF_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
export function timeframeMs(tf) {
  const m = String(tf ?? '').match(/^(\d+)([mhdw])$/);
  return m ? Number(m[1]) * TF_MS[m[2]] : 15 * 60000;
}

// Hoeveel candles vergelijken en hoeveel er op te halen (met de aanloop voor de kenmerken), in één verzoek.
export function windowFor(tf) {
  const C = VENUE_COMPARE;
  const per = Math.round((C.windowDays * 86400000) / timeframeMs(tf));
  const window = Math.min(C.maxFetch - CANDLES_NEEDED - 2, Math.max(per, C.minWindowCandles));
  return { window, limit: Math.min(C.maxFetch, window + CANDLES_NEEDED + 2) };
}

// Alleen gesloten candles, gesorteerd, zonder dubbele tijdstempels.
export function closedCandles(candles, tf, now = Date.now()) {
  const ms = timeframeMs(tf);
  const seen = new Set();
  return (Array.isArray(candles) ? candles : [])
    .filter((c) => Array.isArray(c) && finite(Number(c[0])) && finite(Number(c[4])) && c[4] > 0 && Number(c[0]) + ms <= now)
    .sort((x, y) => x[0] - y[0])
    .filter((c) => !seen.has(c[0]) && seen.add(c[0]));
}

// Gelijke tijdstempels in de vergelijkingsperiode: [{ ts, a, b }] (a = Bitvavo-candle, b = Bybit-candle).
export function align(a, b, fromTs = -Infinity) {
  const mb = new Map(b.map((c) => [c[0], c]));
  return a.filter((c) => c[0] >= fromTs && mb.has(c[0])).map((c) => ({ ts: c[0], a: c, b: mb.get(c[0]) }));
}

// ---------- 1–4: de markt zelf ----------
const fmtRatio = (r) => (r == null ? '–' : `${nl(r, 2)}×`);

export function comparePrice(rows, eurPerQuote, quote = 'USDT') {
  const C = VENUE_COMPARE.price;
  if (!finite(eurPerQuote) || eurPerQuote <= 0) {
    return { status: 'warn', text: `Geen ${quote}/EUR-koers van Bybit, dus het prijsverschil in euro is niet te berekenen.`, meanPct: null, maxPct: null };
  }
  const d = rows.map((r) => (r.b[4] * eurPerQuote / r.a[4] - 1) * 100);
  const m = mean(d);
  const mx = d.reduce((a, x) => Math.max(a, Math.abs(x)), 0);
  const am = Math.abs(m);
  const status = am <= C.okMeanPct && mx <= C.okMaxPct ? 'ok' : am <= C.warnMeanPct && mx <= C.warnMaxPct ? 'warn' : 'bad';
  const text = `Bybit-koers (× ${nl(eurPerQuote, 4)} euro per ${quote}) is gemiddeld ${pct(m)} en hooguit ${nl(mx)}% anders dan Bitvavo.`;
  return { status, text, meanPct: m, maxPct: mx, eurPerQuote };
}

// Log-rendementen op opeenvolgende gelijke tijdstempels (geen gat ertussen op beide beurzen).
export function returns(rows, tfMs) {
  const ra = [], rb = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ts - rows[i - 1].ts !== tfMs) continue;
    ra.push(Math.log(rows[i].a[4] / rows[i - 1].a[4]));
    rb.push(Math.log(rows[i].b[4] / rows[i - 1].b[4]));
  }
  return { ra, rb };
}

export function compareCorr(ra, rb) {
  const C = VENUE_COMPARE.corr;
  const r = pearson(ra, rb);
  if (r == null) return { status: 'warn', text: 'De koers bewoog niet genoeg om de correlatie te meten.', corr: null };
  const status = r >= C.ok ? 'ok' : r >= C.warn ? 'warn' : 'bad';
  return { status, corr: r, text: `Correlatie van de candle-rendementen ${nl(r)} (${r >= C.ok ? 'bewegen vrijwel gelijk' : r >= C.warn ? 'bewegen grotendeels gelijk' : 'bewegen duidelijk anders'}; ✅ vanaf ${nl(C.ok)}).` };
}

export function compareVol(ra, rb) {
  const C = VENUE_COMPARE.vol;
  const sa = std(ra), sb = std(rb);
  if (!sa || !sb) return { status: 'warn', text: 'Geen beweging om de onrust te vergelijken.', ratio: null };
  const ratio = sb / sa;
  const dev = Math.abs(ratio - 1) * 100;
  const status = dev <= C.okPct ? 'ok' : dev <= C.warnPct ? 'warn' : 'bad';
  return { status, ratio, stdA: sa * 100, stdB: sb * 100,
    text: `Beweging per candle op Bybit ${nl(sb * 100, 3)}% tegenover ${nl(sa * 100, 3)}% op Bitvavo: ${fmtRatio(ratio)} (✅ binnen ±${C.okPct}%).` };
}

export function compareVolume(rows, eurPerQuote) {
  const C = VENUE_COMPARE.volume;
  const va = rows.reduce((s, r) => s + (Number(r.a[5]) || 0) * r.a[4], 0);
  const vb = finite(eurPerQuote) ? rows.reduce((s, r) => s + (Number(r.b[5]) || 0) * r.b[4] * eurPerQuote, 0) : null;
  if (!va || vb == null) return { status: 'ok', ratio: null, eurA: va || null, eurB: vb, text: 'Volume niet te vergelijken (geen volume of koers).' };
  const ratio = vb / va;
  const eur = (x) => `€ ${x >= 1e6 ? `${nl(x / 1e6, 1)} mln` : x >= 1e3 ? `${nl(x / 1e3, 0)}k` : nl(x, 0)}`;
  const status = ratio < C.warnRatio ? 'warn' : 'ok';
  return { status, ratio, eurA: va, eurB: vb,
    text: `Volume op Bybit ${eur(vb)} tegenover ${eur(va)} op Bitvavo in deze periode (${fmtRatio(ratio)})${status === 'warn' ? ': een dunne markt, dus meer slippage en grilligere candles' : ''}.` };
}

// ---------- 5: wat het model ziet ----------
// Kenmerken per candle in de periode, precies zoals de bot ze ziet: de laatste CANDLES_NEEDED candles tot en met
// die candle, met BTC van dezelfde beurs als context. Geeft Map ts → kenmerken.
export function featureSeries(candles, btc, fromTs, need = CANDLES_NEEDED) {
  const out = new Map();
  const bi = new Map((btc ?? []).map((c, i) => [c[0], i]));
  for (let i = need - 1; i < candles.length; i++) {
    const ts = candles[i][0];
    if (ts < fromTs) continue;
    const j = bi.get(ts);
    const ctxBtc = j == null ? null : btc.slice(Math.max(0, j - need + 1), j + 1);
    const f = computeFeatures(candles.slice(i - need + 1, i + 1), { btc: ctxBtc });
    if (f) out.set(ts, f);
  }
  return out;
}

export function featureKeys(agent) {
  const keys = Array.isArray(agent?.entry?.features) ? agent.entry.features : FEATURES;
  return keys.filter((k) => !SKIP_FEATURES.has(k));
}

export function compareFeatures(fa, fb, keys) {
  const C = VENUE_COMPARE.psi;
  const rows = keys.map((key) => {
    const a = fa.map((f) => f[key]), b = fb.map((f) => f[key]);
    if (a.filter(finite).length < 2) return null;
    return { key, label: FEATURE_INFO[key]?.[0] ?? key, psi: psi(a, b), smd: smd(a, b) };
  }).filter((r) => r && r.psi != null);
  if (!rows.length) return { status: 'warn', text: 'Geen kenmerken te vergelijken.', features: [] };
  rows.sort((x, y) => y.psi - x.psi);
  const maxPsi = rows[0].psi;
  const meanPsi = mean(rows.map((r) => r.psi));
  const status = meanPsi >= C.bad ? 'bad' : maxPsi < C.bad && meanPsi < C.ok ? 'ok' : 'warn';
  const top = rows.slice(0, 3).map((r) => `${r.label} ${nl(r.psi)}`).join(', ');
  const word = status === 'ok' ? 'nauwelijks verschoven' : status === 'warn' ? 'deels verschoven' : 'duidelijk verschoven';
  return { status, maxPsi, meanPsi, features: rows,
    text: `Kenmerken ${word}: PSI gemiddeld ${nl(meanPsi)} over ${rows.length} kenmerken, meest verschoven ${top} (✅ onder ${nl(C.ok)}, ❌ vanaf ${nl(C.bad)}).` };
}

// Verwachting van de AI-trader op beide beurzen voor dezelfde candles. costShift: wat de bot op Bybit bij de
// verwachting optelt (andere kosten, venueCostShift); threshold: de drempel van de gebruiker (recept + bijstelling).
export function compareModel(fa, fb, agent, threshold, costShift = 0) {
  const C = VENUE_COMPARE.model;
  if (!agent?.entry) return { status: 'nodata', text: 'Geen AI-trader van de leerserver, dus zijn verwachting is niet te vergelijken.' };
  const qa = fa.map((f) => predictRaw(agent.entry, f));
  const qb = fb.map((f) => predictRaw(agent.entry, f));
  const ma = mean(qa), mb = mean(qb);
  const r = pearson(qa, qb);
  const diff = mb - ma;
  const thr = Number(threshold) || 0;
  const nA = qa.filter((q) => q > thr).length;
  const nB = qb.filter((q) => q + costShift > thr).length;
  const n = qa.length;
  const hi = Math.max(nA, nB), lo = Math.min(nA, nB);
  const ratio = hi / Math.max(lo, 0.5);
  const freq = hi - lo <= C.freqMinAbs || ratio <= C.freqRatioOk ? 'ok' : hi >= C.freqBadMin && ratio >= C.freqRatioBad ? 'bad' : 'warn';
  const corrS = r == null ? 'ok' : r >= C.corrOk ? 'ok' : r >= C.corrWarn ? 'warn' : 'bad';
  const meanS = Math.abs(diff) <= C.meanOkPp ? 'ok' : Math.abs(diff) <= C.meanWarnPp ? 'warn' : 'bad';
  const status = worst(freq, corrS, meanS);
  const share = (k) => `${k}× (${nl((k / Math.max(n, 1)) * 100, 1)}%)`;
  const shiftTxt = Math.abs(costShift) >= 0.005 ? `, op Bybit ${pp(costShift)} voor de andere kosten` : '';
  return { status, n, meanA: ma, meanB: mb, diffPp: diff, corr: r, aboveA: nA, aboveB: nB, threshold: thr, costShift,
    statuses: { freq, corr: corrS, mean: meanS },
    text: `Verwachting gemiddeld ${pct(ma, 3)} op Bitvavo en ${pct(mb, 3)} op Bybit (${pp(diff, 3)}), correlatie ${r == null ? '–' : nl(r)}. ` +
      `Boven zijn drempel van ${pct(thr)}${shiftTxt}: Bitvavo ${share(nA)}, Bybit ${share(nB)} van ${n} candles.` };
}

// ---------- 6: echte trades en de eindtest ----------
const agentTrade = (t) => t && t.agent && !t.agent.explore && !t.virtual && finite(t.pnlPct) && !/^Handmatig/.test(String(t.exitReason ?? ''));

export function compareTrades(bitvavo = [], bybit = []) {
  const C = VENUE_COMPARE.trades;
  const a = bitvavo.filter(agentTrade).map((t) => t.pnlPct);
  const b = bybit.filter(agentTrade).map((t) => t.pnlPct);
  if (a.length < C.minTrades || b.length < C.minTrades) {
    return { status: 'nodata', nA: a.length, nB: b.length, progress: { have: Math.min(a.length, b.length), need: C.minTrades },
      text: `Echte trades van de AI-trader: ${b.length} op Bybit en ${a.length} op Bitvavo; minstens ${C.minTrades} per beurs nodig voor een toets.` };
  }
  const w = welch(b, a, C.confidence);
  const base = `Gemiddeld ${pct(w.a.mean)} per trade op Bybit (${w.a.n}) tegenover ${pct(w.b.mean)} op Bitvavo (${w.b.n}): ${pp(w.diff)}`;
  if (w.upper < 0) return { status: 'bad', nA: a.length, nB: b.length, meanA: w.b.mean, meanB: w.a.mean, diff: w.diff, upper: w.upper, lower: w.lower,
    text: `Aantoonbaar slechter op Bybit. ${base}, met ${C.confidence * 100}% zekerheid minstens ${pp(-w.upper)} lager.` };
  return { status: 'ok', nA: a.length, nB: b.length, meanA: w.b.mean, meanB: w.a.mean, diff: w.diff, upper: w.upper, lower: w.lower,
    text: `Niet aantoonbaar slechter op Bybit. ${base} (toets met ${C.confidence * 100}% zekerheid).` };
}

// Eindtest van de leerserver op Bybit-koersen (venueStats.bybit.backtest) tegenover die op Bitvavo
// (meta.report.test), per recept. Zonder spreiding per trade is dit geen echte toets; daarom alleen ❌ als
// het recept op Bitvavo winst en op Bybit verlies maakte.
export function compareBacktest(agent) {
  const C = VENUE_COMPARE.backtest;
  const seen = new Set();
  const rows = agentParts(agent).filter((p) => p && !seen.has(p.recipeKey ?? p) && seen.add(p.recipeKey ?? p)).map((p) => {
    const bv = p.meta?.report?.test ?? null;
    const by = p.venueStats?.bybit?.backtest ?? null;
    const row = { recipe: p.recipeKey ?? null, timeframe: p.timeframe ?? null,
      bitvavo: bv ? { trades: bv.trades ?? 0, avgPct: bv.avgPct ?? null } : null,
      bybit: by ? { trades: by.trades ?? 0, avgPct: by.avgPct ?? null, reason: by.reason ?? null, since: by.since ?? null } : null };
    if (!by || !(by.trades >= C.minTrades) || !finite(by.avgPct)) {
      row.status = 'nodata';
      row.text = by?.reason ? `Eindtest op Bybit: ${by.reason}.` : `Eindtest op Bybit-koersen: ${by?.trades ?? 0} trades (minstens ${C.minTrades} nodig).`;
      row.progress = { have: by?.trades ?? 0, need: C.minTrades };
      return row;
    }
    const ref = finite(bv?.avgPct) ? bv.avgPct : null;
    row.status = ref != null && ref > 0 && by.avgPct <= 0 ? 'bad' : ref != null && by.avgPct < ref / 2 ? 'warn' : 'ok';
    row.text = `Eindtest op Bybit-koersen: ${by.trades} trades, gemiddeld ${pct(by.avgPct)} per trade na Bybit-kosten; op Bitvavo ${ref == null ? 'onbekend' : `${pct(ref)} (${bv.trades} trades)`}.`;
    return row;
  });
  const known = rows.filter((r) => r.status !== 'nodata');
  const status = known.length ? worst(...known.map((r) => r.status)) : 'nodata';
  return { status, recipes: rows };
}

// ---------- oordeel ----------
// Welke onderdelen van een coin tellen mee: alles met een status (trades alleen als er genoeg waren).
export function coinVerdict(parts) {
  const C = VENUE_COMPARE;
  const list = Object.entries(parts).filter(([, p]) => p && p.status && p.status !== 'nodata');
  const bad = list.filter(([, p]) => p.status === 'bad').map(([k]) => k);
  const warn = list.filter(([, p]) => p.status === 'warn').map(([k]) => k);
  const names = (ks) => ks.map((k) => PART_TITLES[k].charAt(0).toLowerCase() + PART_TITLES[k].slice(1)).join(', ');
  if (bad.length) return { status: 'bad', text: VERDICT_TEXT.bad, detail: `duidelijk verschil: ${names(bad)}`, action: actionFor('bad') };
  if (warn.length >= C.multiWarnBad) return { status: 'bad', text: VERDICT_TEXT.bad, detail: `op ${warn.length} punten matig anders: ${names(warn)}`, action: actionFor('bad') };
  if (warn.length) return { status: 'warn', text: VERDICT_TEXT.warn, detail: `matig verschil: ${names(warn)}`, action: actionFor('warn') };
  return { status: 'ok', text: VERDICT_TEXT.ok, detail: 'koersen, onrust en wat het model ziet komen overeen', action: actionFor('ok') };
}

function actionFor(status) {
  if (status === 'bad') return 'Handel deze coin niet live op Bybit met het Bitvavo-model (haal hem uit je Bybit-coins). Apart leren op Bybit-koersen zit nog niet in de leerserver; tot dan blijft het model op Bitvavo het betrouwbaarst.';
  if (status === 'warn') return 'Houd deze coin in de gaten en vergelijk over een paar dagen opnieuw; live op Bybit eerst met een kleine inzet.';
  if (status === 'nodata') return 'Wacht tot er genoeg candles op beide beurzen zijn; de vergelijking draait vanzelf opnieuw.';
  return 'Niets nodig: het Bitvavo-model kan op Bybit gebruikt worden.';
}

// Eén coin vergelijken. a/b: { candles, btc } van Bitvavo en Bybit (gesloten candles, oud → nieuw).
export function compareCoin({ pair, venuePair, tf, a, b, eurPerQuote, quote = 'USDT', agent = null, threshold = 0, costShift = 0,
  trades = null, now = Date.now() }) {
  const C = VENUE_COMPARE;
  const tfMs = timeframeMs(tf);
  const { window } = windowFor(tf);
  const last = Math.min(a.candles.at(-1)?.[0] ?? 0, b.candles.at(-1)?.[0] ?? 0);
  void now;
  const rows = align(a.candles, b.candles, last - (window - 1) * tfMs).filter((r) => r.ts <= last);
  const base = { pair, venuePair, timeframe: tf, candles: rows.length, need: C.minCandles };
  if (rows.length < C.minCandles) {
    return { ...base, status: 'nodata', text: `${VERDICT_TEXT.nodata} (${rows.length} van ${C.minCandles})`, progress: { have: rows.length, need: C.minCandles },
      detail: `${rows.length} candles met dezelfde tijd op beide beurzen; minstens ${C.minCandles} nodig.`, action: actionFor('nodata'), parts: {} };
  }
  const start = rows[0].ts;
  const { ra, rb } = returns(rows, tfMs);
  const parts = {
    price: comparePrice(rows, eurPerQuote, quote),
    corr: compareCorr(ra, rb),
    vol: compareVol(ra, rb),
    volume: compareVolume(rows, eurPerQuote),
  };
  const sa = featureSeries(a.candles, a.btc, start);
  const sb = featureSeries(b.candles, b.btc, start);
  const ts = [...sa.keys()].filter((t) => sb.has(t));
  if (ts.length >= C.minSamples) {
    const fa = ts.map((t) => sa.get(t)), fb = ts.map((t) => sb.get(t));
    parts.features = compareFeatures(fa, fb, featureKeys(agent));
    parts.model = compareModel(fa, fb, agent, threshold, costShift);
  } else {
    parts.features = { status: 'nodata', text: `Kenmerken op ${ts.length} candles (minstens ${C.minSamples} nodig; de bot gebruikt er ${CANDLES_NEEDED} als aanloop).`, progress: { have: ts.length, need: C.minSamples } };
    parts.model = { status: 'nodata', text: 'Te weinig candles om de verwachting te vergelijken.' };
  }
  if (trades) {
    const t = compareTrades(trades.bitvavo, trades.bybit);
    if (t.status !== 'nodata') parts.trades = t;
    else base.tradeCounts = { bitvavo: t.nA, bybit: t.nB };
  }
  const v = coinVerdict(parts);
  return { ...base, from: new Date(start).toISOString(), to: new Date(last).toISOString(), samples: ts.length, parts, ...v };
}

export function totalVerdict(coins, { backtest = null, trades = null, errors = [] } = {}) {
  const C = VENUE_COMPARE;
  const rated = coins.filter((c) => c.status === 'ok' || c.status === 'warn' || c.status === 'bad');
  const withData = rated.filter((c) => !c.error);
  const bad = withData.filter((c) => c.status === 'bad');
  const warn = rated.filter((c) => c.status === 'warn');
  const extraBad = [backtest?.status === 'bad' ? 'de eindtest op Bybit-koersen' : null, trades?.status === 'bad' ? 'de echte trades op Bybit' : null].filter(Boolean);
  const list = (cs) => cs.map((c) => c.pair.split('/')[0]).join(', ');
  if (!withData.length && !extraBad.length) {
    const have = withData.length, need = coins.length || 1;
    const why = errors.length ? errors[0] : coins.find((c) => c.error)?.detail ?? null;
    if (why && coins.every((c) => c.error || c.status !== 'nodata')) {
      return { level: 'warn', key: 'warn', text: `${VERDICT_TEXT.warn}: niet te vergelijken`, detail: why, action: 'De vergelijking probeert het vanzelf opnieuw; blijft dit, kijk dan of Bybit bereikbaar is.' };
    }
    return { level: 'nodata', key: 'nodata', text: `${VERDICT_TEXT.nodata} (${have} van ${need})`, progress: { have, need },
      detail: coins.length ? 'nog geen coin met genoeg candles op beide beurzen' : 'geen coins die op beide beurzen bestaan', action: actionFor('nodata') };
  }
  if (extraBad.length || (bad.length && bad.length >= Math.max(1, Math.ceil(withData.length * C.totalBadShare)))) {
    const what = [bad.length ? `${bad.length} van ${withData.length} coins duidelijk anders (${list(bad)})` : null, ...extraBad.map((x) => `aantoonbaar slechter: ${x}`)].filter(Boolean).join('; ');
    return { level: 'bad', key: 'bad', text: VERDICT_TEXT.bad, detail: what, action: actionFor('bad').replace('deze coin', bad.length ? 'deze coins' : 'met dit recept') };
  }
  if (bad.length || warn.length || errors.length || backtest?.status === 'warn') {
    const what = [bad.length ? `duidelijk anders: ${list(bad)}` : null, warn.length ? `matig anders: ${list(warn)}` : null,
      backtest?.status === 'warn' ? 'eindtest op Bybit-koersen zwakker dan op Bitvavo' : null, ...errors].filter(Boolean).join('; ');
    return { level: 'warn', key: 'warn', text: VERDICT_TEXT.warn, detail: what,
      action: bad.length ? `Handel ${list(bad)} niet live op Bybit; de andere coins kunnen met het Bitvavo-model.` : actionFor('warn').replace('deze coin', 'die coins') };
  }
  return { level: 'ok', key: 'ok', text: VERDICT_TEXT.ok, detail: `${withData.length} ${withData.length === 1 ? 'coin komt' : 'coins komen'} overeen`, action: actionFor('ok') };
}

// ---------- verzamelen ----------
// Welk recept handelt deze coin (X/EUR)? Het hoofdrecept als het de coin handelt (of geen lijst heeft), anders
// het eerste recept dat hem wel handelt; geen: het hoofdrecept.
export function agentFor(agent, pair) {
  if (!agent) return null;
  const parts = agentParts(agent);
  return parts.find((p) => !Array.isArray(p.coins) || !p.coins.length ? p === agent : p.coins.includes(pair)) ?? agent;
}

const baseOf = (s) => String(s).split('/')[0];

// Haalt alles op en rekent. Alle toegang tot de beurzen gaat via de meegegeven functies:
//   bitvavo / bybit: { loadMarkets(): markets-object, fetchCandles(pair, tf, limit): candles, toVenue(pair X/EUR) }
//   eurPerQuote(): euro per quote-munt van Bybit (QuoteRate)
// coins: de coins (X/EUR) van de AI-trader en de gebruiker; bybitPairs: de Bybit-lijst van de gebruiker (X/quote).
// Fouten per coin worden ⚠️ met de reden; de rest gaat door.
export async function collectVenueCompare({ coins = [], bybitPairs = [], bitvavo, bybit, eurPerQuote, quote = 'USDT', host = 'bybit.com',
  agent = null, thrAdjust = 0, costShift = () => 0, trades = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  spacingMs = VENUE_COMPARE.spacingMs, fallbackTf = '15m' }) {
  const errors = [];
  let requests = 0;
  const count = (fn) => async (...args) => { requests++; return fn(...args); };
  const fetchA = count(bitvavo.fetchCandles), fetchB = count(bybit.fetchCandles);
  const markets = async (v, name) => {
    try { requests++; return await v.loadMarkets(); } catch (err) { errors.push(`marktlijst van ${name} niet op te halen (${err.message})`); return null; }
  };
  const [ma, mb] = [await markets(bitvavo, 'Bitvavo'), await markets(bybit, 'Bybit')];
  let rate = null;
  try { requests++; rate = await eurPerQuote(); } catch (err) { errors.push(err.message); }
  const want = [...new Set(coins.map(String))];
  const has = (m, p) => (m ? Object.hasOwn(m, p) : true);
  const onlyBitvavo = mb ? want.filter((p) => has(ma, p) && !has(mb, bybit.toVenue(p))) : [];
  const onlyBybit = ma ? [...new Set(bybitPairs.map(String))].filter((p) => has(mb, p) && !has(ma, `${baseOf(p)}/EUR`)) : [];
  const both = want.filter((p) => has(ma, p) && has(mb, bybit.toVenue(p)));
  // Elke reeks maar één keer per ronde (BTC als coin én als context: één verzoek).
  const memo = new Map();
  const get = (which, pair, tf, limit) => {
    const k = `${which}|${pair}|${tf}|${limit}`;
    if (!memo.has(k)) memo.set(k, (which === 'a' ? fetchA : fetchB)(pair, tf, limit).then((c) => closedCandles(c, tf, now())));
    return memo.get(k);
  };
  const out = [];
  for (const [i, pair] of both.entries()) {
    if (i > 0 && spacingMs > 0) await sleep(spacingMs);
    const part = agentFor(agent, pair);
    const tf = part?.timeframe ?? fallbackTf;
    const { limit } = windowFor(tf);
    const vp = bybit.toVenue(pair);
    try {
      const [ca, cb] = await Promise.all([get('a', pair, tf, limit), get('b', vp, tf, limit)]);
      const [ba, bb] = await Promise.all([get('a', bitvavo.toVenue('BTC/EUR'), tf, limit).catch(() => null), get('b', bybit.toVenue('BTC/EUR'), tf, limit).catch(() => null)]);
      const a = { candles: ca, btc: ba };
      const b = { candles: cb, btc: bb };
      const threshold = part ? Math.max(0, (Number(part.threshold) || 0) + (Number(thrAdjust) || 0)) : 0;
      const t = trades ? { bitvavo: trades.bitvavo.filter((x) => x.pair === pair), bybit: trades.bybit.filter((x) => `${baseOf(x.pair)}/EUR` === pair) } : null;
      out.push(compareCoin({ pair, venuePair: vp, tf, a, b, eurPerQuote: rate, quote, agent: part, threshold, costShift: part ? costShift(part, pair) : 0, trades: t, now: now() }));
    } catch (err) {
      out.push({ pair, venuePair: vp, timeframe: tf, status: 'warn', error: true, text: `${VERDICT_TEXT.warn}: niet te vergelijken`,
        detail: `Candles niet op te halen (${err.message}).`, action: 'De vergelijking probeert het bij de volgende ronde opnieuw.', parts: {} });
    }
  }
  const backtest = agent ? compareBacktest(agent) : null;
  const tradesAll = trades ? compareTrades(trades.bitvavo, trades.bybit) : null;
  const verdict = totalVerdict(out, { backtest, trades: tradesAll, errors });
  return { at: new Date(now()).toISOString(), host, quote, eurPerQuote: rate, coins: out, onlyBitvavo, onlyBybit,
    backtest, trades: tradesAll, verdict, errors, requests, thresholds: VENUE_COMPARE,
    timeframes: [...new Set(out.map((c) => c.timeframe))], recipe: agent?.recipeKey ?? null };
}

// ---------- cache en throttle ----------
// Moet de vergelijking opnieuw? Automatisch hooguit eens per refreshHours (of eerder als de Bybit-website of de
// AI-trader veranderde, maar nooit vaker dan manualMinMinutes); met de knop hooguit eens per manualMinMinutes.
export function compareDue(prev, now = Date.now(), { manual = false, sig = null } = {}) {
  const C = VENUE_COMPARE;
  const at = prev?.at ? Date.parse(prev.at) : null;
  if (!prev || at == null || !Number.isFinite(at)) return { due: true };
  const age = now - at;
  const minGap = C.manualMinMinutes * 60000;
  if (manual || (sig != null && prev.sig != null && prev.sig !== sig)) {
    if (age >= minGap) return { due: true };
    return { due: false, waitMinutes: Math.ceil((minGap - age) / 60000) };
  }
  if (age >= C.refreshHours * 3600000) return { due: true };
  return { due: false, waitMinutes: Math.ceil((C.refreshHours * 3600000 - age) / 60000) };
}

// ---------- meldingen ----------
// Een directe melding als het totaaloordeel naar ❌ gaat: één keer per overgang. Opnieuw pas na ✅ of
// "te weinig data" (een ⚠️ door een tijdelijke fout is geen herstel). prev: { level, since, notifiedAt }.
export function compareAlert(prev = {}, result, now = Date.now()) {
  const level = result?.verdict?.level;
  if (!level) return { send: false, state: prev ?? {} };
  const iso = new Date(now).toISOString();
  const since = prev?.level === level && prev?.since ? prev.since : iso;
  let notifiedAt = level === 'bad' || level === 'warn' ? prev?.notifiedAt ?? null : null;
  let send = false;
  if (level === 'bad' && !notifiedAt) { send = true; notifiedAt = iso; }
  return { send, state: { level, since, ...(notifiedAt ? { notifiedAt } : {}) } };
}

const hostLabel = (h) => ({ 'bybit.com': 'Bybit (bybit.com)', 'bybit.eu': 'Bybit EU', 'bybit.nl': 'Bybit NL' }[h] ?? 'Bybit');

export function compareWeeklyLine(result) {
  if (!result?.verdict) return null;
  const v = result.verdict;
  return `${STATUS_ICON[v.level] ?? ''} **Bitvavo ↔ ${hostLabel(result.host)}** (${result.quote}): ${v.text}${v.detail ? ` — ${v.detail}` : ''}.`;
}

export function compareAlertMessage(result) {
  const v = result.verdict;
  const bad = (result.coins ?? []).filter((c) => c.status === 'bad').map((c) => `• ${c.pair.split('/')[0]}: ${c.detail}`);
  return {
    title: `❌ Bitvavo ↔ ${hostLabel(result.host)}: ${v.text}`,
    message: `${v.detail}.${bad.length ? `\n${bad.join('\n')}` : ''}\n\n**Wat je kunt doen:** ${v.action}\n\nZie Learning → "Bitvavo ↔ Bybit" op het dashboard.`,
    level: 'error',
  };
}
