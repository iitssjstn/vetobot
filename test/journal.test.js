import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, volRegimeOf, computeLabel, journalOptionsFromEnv } from '../src/journal.js';

const M = 60000;
const FIVE = 5 * M;
const DAY = 86400000;
const quiet = { info() {}, warn() {}, error() {} };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-journal-'));
}

function journal(opts = {}) {
  const dir = tmp();
  return { j: new Journal(path.join(dir, 'learning.db'), { log: quiet, ...opts }), dir };
}

// 5m-candles vanaf `from` (ts op 5 minuten), elke candle via fn(i, ts) → [open, high, low, close].
function candles(from, n, fn) {
  const start = Math.ceil(from / FIVE) * FIVE;
  return Array.from({ length: n }, (_, i) => {
    const ts = start + i * FIVE;
    const [o, h, l, c] = fn(i, ts);
    return [ts, o, h, l, c, 1];
  });
}

test('dagboek: beslissing opslaan, schema met versie, opnieuw openen is idempotent', () => {
  const { j, dir } = journal();
  const id = j.record({ mode: 'paper', pair: 'BTC/EUR', timeframe: '15m', price: 100, kind: 'agent', outcome: 'rejected', stage: 'toelating',
    reason: 'oefenen in paper staat uit', features: { rsi14: 55 }, indicators: { rsi: 55, trend: 'up' }, rule: { type: 'ai-trader', expectedPct: 0.4, threshold: 0.2 },
    recipe: 'R', modelVersion: 'v1', expectedPct: 0.4, regime: 'stijgend', volRegime: 'normaal' });
  assert.ok(id > 0);
  const row = j.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  assert.equal(row.stage, 'toelating');
  assert.equal(row.kind, 'agent');
  assert.deepEqual(JSON.parse(row.features), { rsi14: 55 });
  assert.deepEqual(JSON.parse(row.rule), { type: 'ai-trader', expectedPct: 0.4, threshold: 0.2 });
  assert.equal(row.vol_regime, 'normaal');
  assert.equal(j.db.prepare('SELECT MAX(version) v FROM schema_version').get().v, 1);
  j.close();
  // Opnieuw openen: migraties niet opnieuw, data blijft.
  const j2 = new Journal(path.join(dir, 'learning.db'), { log: quiet });
  assert.equal(j2.record({ pair: 'ETH/EUR', price: 1, outcome: 'accepted', stage: 'approved' }), id + 1);
  assert.equal(j2.db.prepare('SELECT count(*) n FROM schema_version').get().n, 1);
  assert.equal(j2.db.prepare('SELECT count(*) n FROM decisions').get().n, 2);
  // Onbekende waarden worden veilig opgeslagen (kind rules, stage error).
  const odd = j2.record({ pair: 'X/EUR', kind: 'iets', stage: 'drempel', outcome: '?' });
  const r = j2.db.prepare('SELECT kind, stage, outcome FROM decisions WHERE id = ?').get(odd);
  assert.deepEqual({ ...r }, { kind: 'rules', stage: 'error', outcome: 'rejected' });
  j2.close();
});

test('dagboek: trade koppelen en opslaan, spread/regime/AI uit de beslissing', () => {
  const { j } = journal();
  const id = j.record({ mode: 'live', pair: 'BTC/EUR', price: 100, outcome: 'accepted', stage: 'approved', book: { spreadPct: 0.05 },
    regime: 'zijwaarts', volRegime: 'laag', ai: { provider: 'groq/llama', decision: 'approve' } });
  assert.equal(j.linkTrade(id, 'live:BTC/EUR:2026-01-01'), true);
  const tid = j.recordTrade({ decisionId: id, mode: 'live', pair: 'BTC/EUR', openedAt: '2026-01-01T00:00:00Z', closedAt: Date.now(), entryPrice: 100, exitPrice: 102,
    costEur: 10, feesEur: 0.05, entrySlipPct: 0.02, exitSlipPct: 0.01, pnlEur: 0.15, pnlPct: 1.5, mfePct: 2.5, maePct: -0.4, exitReason: 'Take-profit' });
  const t = j.db.prepare('SELECT * FROM trades WHERE id = ?').get(tid);
  assert.equal(t.spread_pct, 0.05);
  assert.equal(t.regime, 'zijwaarts');
  assert.equal(t.vol_regime, 'laag');
  assert.equal(t.ai_provider, 'groq/llama');
  assert.equal(t.mae_pct, -0.4);
  assert.equal(j.db.prepare('SELECT trade_ref FROM decisions WHERE id = ?').get(id).trade_ref, 'live:BTC/EUR:2026-01-01');
});

test('labels zonder leakage: niet vóór t + horizon, alleen candles strikt na het besluit', async () => {
  const { j } = journal({ horizons: [60, 240] });
  const t0 = Date.parse('2026-03-01T10:02:00Z');
  const features = { rsi14: 50, atrPct: 1 };
  const id = j.record({ at: t0, mode: 'paper', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'ai-veto', features });
  // Later aanpassen van het object verandert de opgeslagen beslissing niet.
  features.rsi14 = 99;
  const before = j.db.prepare('SELECT features, indicators FROM decisions WHERE id = ?').get(id);
  assert.deepEqual(JSON.parse(before.features), { rsi14: 50, atrPct: 1 });

  // Candles: vóór het besluit een uitschieter (mag niet meetellen), daarna rustig omhoog naar 103.
  const all = [
    [Math.floor(t0 / FIVE) * FIVE, 100, 500, 1, 100, 1], // opent vóór t0 (10:00): telt niet mee
    ...candles(t0, 12 * 5, (i) => { const c = 100 + (i + 1) * 0.05; return [c - 0.05, c + 0.1, c - 0.2, c]; }),
  ];
  let calls = 0;
  const fetchCandles = async () => { calls++; return all; };

  // Vóór t + 60 min: niets te doen, ook niet als de "toekomst" al in de candles zou staan.
  assert.deepEqual(j.due(t0 + 59 * M), []);
  const early = await j.settle(fetchCandles, { now: t0 + 59 * M });
  assert.equal(early.labeled, 0);
  assert.equal(j.db.prepare('SELECT count(*) n FROM labels').get().n, 0);
  assert.equal(computeLabel({ at: t0, price: 100 }, 60, all, { now: t0 + 30 * M }), null, 'settle weigert vóór t+horizon');

  // Na 60 min (+ de laatste candle gesloten): label voor 60, niet voor 240.
  const now = t0 + 66 * M;
  assert.deepEqual(j.due(now).map((d) => d.horizons), [[60]]);
  const r = await j.settle(fetchCandles, { now, costPct: 0.6 });
  assert.equal(r.labeled, 1);
  const lab = j.db.prepare('SELECT * FROM labels WHERE decision_id = ?').get(id);
  assert.equal(lab.horizon_min, 60);
  // Venster: candles met ts ≥ 10:02 en < 11:02, dus 10:05 t/m 11:00 (12 candles). De candle van 10:00 telt niet.
  const win = all.filter((c) => c[0] >= t0 && c[0] < t0 + 60 * M);
  assert.equal(win.length, 12);
  assert.ok(Math.abs(lab.ret_pct - ((win.at(-1)[4] / 100 - 1) * 100 - 0.6)) < 1e-6);
  assert.ok(lab.mfe_pct < 1, `geen uitschieter van vóór het besluit in de MFE: ${lab.mfe_pct}`);
  assert.ok(lab.mae_pct > -1, `geen uitschieter van vóór het besluit in de MAE: ${lab.mae_pct}`);
  // De kenmerken bij het besluit zijn niet veranderd door het uitrekenen van de labels.
  const after = j.db.prepare('SELECT features, indicators FROM decisions WHERE id = ?').get(id);
  assert.deepEqual(after, before);
  assert.deepEqual(j.due(now), []);
  assert.ok(calls >= 1);
});

test('labels: ontbrekende data → later opnieuw, na 3 dagen opgeven; fouten breken niets', async () => {
  const { j } = journal({ horizons: [60] });
  const t0 = Date.parse('2026-03-01T10:00:00Z');
  const id = j.record({ at: t0, pair: 'DOGE/EUR', price: 0.1, outcome: 'rejected', stage: 'risk' });
  const r1 = await j.settle(async () => [], { now: t0 + 2 * 3600000 });
  assert.deepEqual(r1, { labeled: 0, gaveUp: 0, waiting: 1 });
  const r2 = await j.settle(async () => { throw new Error('Bitvavo plat'); }, { now: t0 + 3 * 3600000 });
  assert.equal(r2.waiting, 1);
  assert.equal(j.db.prepare('SELECT count(*) n FROM labels').get().n, 0);
  // Gat aan het eind van het venster: wachten.
  const gap = candles(t0, 6, () => [0.1, 0.1, 0.1, 0.1]);
  assert.equal(computeLabel({ at: t0, price: 0.1 }, 60, gap, { now: t0 + 5 * 3600000 }), null);
  // Na 3 dagen opgeven: label null, met settled_at.
  const r3 = await j.settle(async () => [], { now: t0 + 60 * M + 3 * DAY + M });
  assert.equal(r3.gaveUp, 1);
  const lab = j.db.prepare('SELECT * FROM labels WHERE decision_id = ?').get(id);
  assert.equal(lab.ret_pct, null);
  assert.ok(lab.settled_at > 0);
  assert.deepEqual(j.due(t0 + 4 * DAY), []);
});

test('corrupte db: hernoemd naar .corrupt-<tijd> en opnieuw begonnen; lukt dat niet dan uit (alles no-op)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'learning.db');
  fs.writeFileSync(file, 'dit is geen sqlite-bestand '.repeat(200));
  const j = new Journal(file, { log: quiet });
  const id = j.record({ pair: 'BTC/EUR', price: 1, outcome: 'rejected', stage: 'orderboek' });
  assert.ok(id > 0, 'werkt weer na opnieuw beginnen');
  assert.ok(fs.readdirSync(dir).some((f) => /^learning\.db\.corrupt-/.test(f)), 'oude bestand bewaard');
  j.close();

  // Map van het bestand is een gewoon bestand: openen en opnieuw beginnen lukken allebei niet.
  fs.writeFileSync(path.join(dir, 'blok'), 'x');
  const logs = [];
  const bad = new Journal(path.join(dir, 'blok', 'learning.db'), { log: { warn: (m) => logs.push(m), info() {} } });
  assert.equal(bad.record({ pair: 'BTC/EUR', price: 1 }), null);
  assert.equal(bad.enabled, false);
  assert.equal(bad.linkTrade(1, 'x'), false);
  assert.equal(bad.recordTrade({ pair: 'BTC/EUR' }), null);
  assert.deepEqual(bad.due(Date.now()), []);
  assert.deepEqual(await bad.settle(async () => { throw new Error('mag niet gevraagd worden'); }), { labeled: 0, gaveUp: 0, waiting: 0 });
  const s = bad.stats();
  assert.equal(s.enabled, false);
  assert.equal(s.counts.decisions, 0);
  assert.equal(bad.prune(), 0);
  bad.close();
  assert.ok(logs.length >= 1 && logs.length <= 2, `fouten gelogd, maar niet steeds opnieuw: ${logs.length}`);
});

test('dagboek: fouten hooguit één keer per minuut gelogd, nooit gegooid', () => {
  const logs = [];
  const { j } = journal({ log: { warn: (m) => logs.push(m), info() {} } });
  j.record({ pair: 'BTC/EUR', price: 1 });
  j.db.close(); // "db op slot / weg"
  for (let i = 0; i < 20; i++) assert.equal(j.record({ pair: 'BTC/EUR', price: 1 }), null);
  assert.equal(j.stats().counts.decisions, 0);
  assert.equal(logs.length, 1);
});

test('node:sqlite laden laat andere waarschuwingen gewoon door', () => {
  const orig = process.emitWarning;
  const { j } = journal();
  j.record({ pair: 'BTC/EUR', price: 1 });
  assert.equal(process.emitWarning, orig, 'emitWarning niet blijvend vervangen');
});

test('retentie: beslissingen (met labels) en trades ouder dan de bewaartermijn worden opgeruimd', () => {
  const { j } = journal({ retentionDays: 180 });
  const now = Date.now();
  const old = j.record({ at: now - 200 * DAY, pair: 'BTC/EUR', price: 1 });
  const recent = j.record({ at: now - 10 * DAY, pair: 'BTC/EUR', price: 1 });
  j.db.prepare('INSERT INTO labels VALUES (?, 60, 1, 1, 0, ?)').run(old, now);
  j.recordTrade({ decisionId: old, pair: 'BTC/EUR', closedAt: now - 199 * DAY, pnlEur: 1 });
  j.recordTrade({ decisionId: recent, pair: 'BTC/EUR', closedAt: now - 9 * DAY, pnlEur: 1 });
  assert.equal(j.prune(now), 1);
  assert.deepEqual(j.db.prepare('SELECT id FROM decisions').all().map((r) => r.id), [recent]);
  assert.equal(j.db.prepare('SELECT count(*) n FROM labels').get().n, 0);
  assert.equal(j.db.prepare('SELECT count(*) n FROM trades').get().n, 1);
});

test('stats: vaste vorm en definities (goed/slecht, terecht/onterecht afgewezen, gemist), per modus en periode', () => {
  const { j } = journal();
  const now = Date.now();
  const at = now - 2 * DAY;
  const lab = (id, ret, h = 240) => j.db.prepare('INSERT INTO labels VALUES (?, ?, ?, NULL, NULL, ?)').run(id, h, ret, now);
  const ai = (decision) => ({ provider: 'groq', decision });
  // Geaccepteerd met winst en met verlies
  const a1 = j.record({ at, mode: 'paper', pair: 'BTC/EUR', price: 100, kind: 'rules', outcome: 'accepted', stage: 'approved', ai: ai('approve'), regime: 'stijgend', volRegime: 'normaal' });
  const a2 = j.record({ at, mode: 'paper', pair: 'ETH/EUR', price: 100, kind: 'agent', outcome: 'accepted', stage: 'approved', regime: 'dalend', volRegime: 'hoog' });
  j.recordTrade({ decisionId: a1, mode: 'paper', pair: 'BTC/EUR', closedAt: now - 1.5 * DAY, pnlEur: 1, pnlPct: 2, mfePct: 3, maePct: -1 });
  j.recordTrade({ decisionId: a2, mode: 'paper', pair: 'ETH/EUR', closedAt: now - 1.5 * DAY, pnlEur: -0.5, pnlPct: -1 });
  // AI wees af: onterecht (+) en terecht (−)
  const v1 = j.record({ at, mode: 'paper', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'ai-veto', ai: ai('reject'), regime: 'stijgend', volRegime: 'normaal' });
  const v2 = j.record({ at, mode: 'paper', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'ai-veto', ai: ai('reject') });
  lab(v1, 1.2); lab(v2, -0.8);
  // Andere afwijzingen: gemist (+) en terecht (−); niet gevuld telt niet als afwijzing
  const r1 = j.record({ at, mode: 'paper', pair: 'SOL/EUR', price: 10, outcome: 'rejected', stage: 'risk' });
  const r2 = j.record({ at, mode: 'paper', pair: 'SOL/EUR', price: 10, outcome: 'rejected', stage: 'orderboek' });
  const nf = j.record({ at, mode: 'paper', pair: 'SOL/EUR', price: 10, outcome: 'rejected', stage: 'not-filled' });
  lab(r1, 0.5); lab(r2, -0.1); lab(nf, 3); lab(r1, 9, 60);
  // Nog zonder label (pending), andere modus, en te oud
  j.record({ at, mode: 'paper', pair: 'ADA/EUR', price: 1, outcome: 'rejected', stage: 'pauze' });
  j.record({ at, mode: 'live', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'ai-veto', ai: ai('reject') });
  j.record({ at: now - 40 * DAY, mode: 'paper', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'risk' });

  const s = j.stats({ mode: 'paper', days: 30, now });
  assert.deepEqual(Object.keys(s), ['enabled', 'horizons', 'counts', 'outcomes', 'byAi', 'byPair', 'byRegime', 'byStage', 'recent']);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.horizons, [60, 240, 1440]);
  assert.deepEqual(s.counts, { decisions: 8, accepted: 2, rejected: 6, labeled: 5, pending: 3, trades: 2 });
  assert.deepEqual(s.outcomes, { good: 1, bad: 1, correctRejections: 2, missedOpportunities: 1, wrongRejections: 1 });
  assert.deepEqual(s.byAi, [{ provider: 'groq', decisions: 3, approved: 1, vetoed: 2, vetoRight: 1, vetoWrong: 1 }]);
  const btc = s.byPair.find((p) => p.pair === 'BTC/EUR');
  assert.deepEqual(btc, { pair: 'BTC/EUR', decisions: 3, accepted: 1, trades: 1, avgPnlPct: 2, winRate: 100, missed: 1 });
  assert.deepEqual(Object.keys(s.byPair[0]), ['pair', 'decisions', 'accepted', 'trades', 'avgPnlPct', 'winRate', 'missed']);
  const up = s.byRegime.find((r) => r.regime === 'stijgend' && r.volRegime === 'normaal');
  assert.deepEqual(up, { regime: 'stijgend', volRegime: 'normaal', decisions: 2, accepted: 1, trades: 1, avgPnlPct: 2, avgRetPct: 1.2 });
  const veto = s.byStage.find((x) => x.stage === 'ai-veto');
  assert.deepEqual(veto, { stage: 'ai-veto', decisions: 2, labeled: 2, avgRetPct: 0.2, positiveShare: 50 });
  assert.equal(s.recent.length, 8);
  const rec = s.recent.find((x) => x.id === r1);
  assert.deepEqual(Object.keys(rec), ['id', 'at', 'pair', 'kind', 'outcome', 'stage', 'reason', 'price', 'expectedPct', 'regime', 'volRegime', 'aiProvider', 'labels', 'trade']);
  assert.deepEqual(rec.labels, { 60: 9, 240: 0.5, 1440: null });
  assert.equal(rec.trade, null);
  assert.deepEqual(s.recent.find((x) => x.id === a1).trade, { pnlPct: 2, pnlEur: 1, mfePct: 3, maePct: -1 });
  assert.match(rec.at, /^\d{4}-\d\d-\d\dT/);
  // Live apart; alle modi samen; lege periode → nullen, geen crash.
  assert.equal(j.stats({ mode: 'live', now }).counts.decisions, 1);
  assert.equal(j.stats({ mode: null, days: 60, now }).counts.decisions, 10);
  const empty = j.stats({ mode: 'paper', days: 1, now });
  assert.deepEqual(empty.counts, { decisions: 0, accepted: 0, rejected: 0, labeled: 0, pending: 0, trades: 0 });
  assert.deepEqual(empty.recent, []);
});

test('volatiliteitsregime: laatste ATR% tegen de mediaan van de voorgaande 500 candles', () => {
  const mk = (n, rangeAt) => Array.from({ length: n }, (_, i) => {
    const r = rangeAt(i);
    return [i * FIVE, 100, 100 + r, 100 - r, 100, 1];
  });
  assert.equal(volRegimeOf(mk(50, () => 1)), null, 'te weinig data');
  assert.equal(volRegimeOf(null), null);
  assert.equal(volRegimeOf(mk(600, () => 1)), 'normaal');
  // De laatste 14 candles veel onrustiger: hoog. Veel rustiger: laag.
  assert.equal(volRegimeOf(mk(600, (i) => (i >= 586 ? 5 : 1))), 'hoog');
  assert.equal(volRegimeOf(mk(600, (i) => (i >= 570 ? 0.2 : 1))), 'laag');
  // Alleen verleden: candles van vóór de laatste 500 tellen niet mee.
  assert.equal(volRegimeOf(mk(900, (i) => (i < 300 ? 10 : 1))), 'normaal');
});

test('instellingen uit environment variables', () => {
  assert.deepEqual(journalOptionsFromEnv({}), { enabled: true, horizons: [60, 240, 1440], retentionDays: 180, mainHorizon: 240 });
  const o = journalOptionsFromEnv({ JOURNAL_ENABLED: '0', JOURNAL_HORIZONS: '30,120', JOURNAL_MAIN_HORIZON: '120', JOURNAL_RETENTION_DAYS: '90' });
  assert.deepEqual(o, { enabled: false, horizons: [30, 120], retentionDays: 90, mainHorizon: 120 });
  const d = new Journal(null);
  assert.equal(d.enabled, false);
  assert.equal(d.record({}), null);
});
