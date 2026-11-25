// Betrouwbaarheid van de leerdata in de bot: labels van afgewezen beslissingen (dagboek) en de
// directe bijsturing van de verwachting (onlineCorrection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, computeLabel } from '../src/journal.js';
import { onlineCorrection, correctedExpectation, LEARN } from '../src/agents.js';

const M = 60000;
const FIVE = 5 * M;
const quiet = { info() {}, warn() {}, error() {} };

// 5m-candles vanaf `from` (op het 5-minutenrooster), close = fn(i).
function candles(from, n, fn) {
  const start = Math.ceil(from / FIVE) * FIVE;
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return [start + i * FIVE, c, c * 1.001, c * 0.999, c, 1];
  });
}

function journal(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-learning-'));
  return new Journal(path.join(dir, 'learning.db'), { log: quiet, ...opts });
}

test('label hangt niet af van wanneer hij berekend wordt: wachten tot de laatste candle van het venster dicht is', async () => {
  const t0 = Date.parse('2026-03-01T10:02:30Z'); // besluit midden in een candle
  const all = candles(t0 - 20 * M, 40, (i) => 100 + i); // ruim voorbij de horizon, oplopend
  const d = { at: t0, price: 100 };
  // Venster (zoals gedocumenteerd): candles die openen op of na 10:02:30 en vóór 11:02:30, dus
  // 10:05 t/m 11:00. De candle van 11:00 sluit pas om 11:05.
  const late = computeLabel(d, 60, all, { now: t0 + 70 * M });
  assert.ok(late, 'na 11:05 is het label er');
  const expectedLast = all.find((c) => c[0] === Date.parse('2026-03-01T11:00:00Z'));
  assert.ok(Math.abs(late.retPct - (expectedLast[4] / 100 - 1) * 100) < 1e-9);
  // Om 11:03 is de candle van 11:00 nog open: geen label met een candle te weinig, maar wachten.
  assert.equal(computeLabel(d, 60, all, { now: t0 + 61 * M }), null, 'nog niet: anders een korter venster');

  // Via settle: een vroege ronde (11:03) legt niets vast, een latere (11:08) het juiste label.
  const j = journal({ horizons: [60] });
  const id = j.record({ at: t0, mode: 'paper', pair: 'BTC/EUR', price: 100, outcome: 'rejected', stage: 'ai-veto' });
  const r1 = await j.settle(async () => all, { now: t0 + 61 * M });
  assert.equal(r1.labeled, 0);
  const r2 = await j.settle(async () => all, { now: t0 + 66 * M });
  assert.equal(r2.labeled, 1);
  const lab = j.db.prepare('SELECT ret_pct FROM labels WHERE decision_id = ?').get(id);
  assert.ok(Math.abs(lab.ret_pct - late.retPct) < 1e-6);
});

test('label: open candle, candles vóór het besluit, dubbele en ongesorteerde candles, kapotte prijzen', () => {
  const t0 = Date.parse('2026-03-01T10:00:00Z');
  const win = candles(t0, 12, () => 100);
  win[11] = [win[11][0], 100, 103, 99, 102, 1]; // laatste candle van het venster (10:55)
  const before = [t0 - FIVE, 100, 500, 1, 100, 1]; // uitschieter vóór het besluit
  const after = [t0 + 60 * M, 100, 900, 1, 50, 1]; // na de horizon
  const messy = [after, ...win.slice().reverse(), win[3], win[7], before, [win[5][0], NaN, 0, -1, 0, 1], null, 'x'];
  const lab = computeLabel({ at: t0, price: 100 }, 60, messy, { now: t0 + 2 * 3600000, costPct: 0.7 });
  assert.ok(Math.abs(lab.retPct - (2 - 0.7)) < 1e-9, 'close van 10:55 min de rondekosten');
  assert.ok(Math.abs(lab.mfePct - 3) < 1e-9, 'geen uitschieter van vóór het besluit of na de horizon');
  assert.ok(Math.abs(lab.maePct + 1) < 1e-9);
  // Open candle (sluit na `now`) telt niet mee, en vóór de horizon nooit een label.
  assert.equal(computeLabel({ at: t0, price: 100 }, 60, win, { now: t0 + 59 * M }), null);
  // Prijs 0 of onbekend: geen label.
  assert.equal(computeLabel({ at: t0, price: 0 }, 60, win, { now: t0 + 2 * 3600000 }), null);
  assert.equal(computeLabel({ at: t0, price: NaN }, 60, win, { now: t0 + 2 * 3600000 }), null);
  // Gat aan het eind (laatste 30 minuten ontbreken): geen label.
  assert.equal(computeLabel({ at: t0, price: 100 }, 60, win.slice(0, 6), { now: t0 + 2 * 3600000 }), null);
});

test('bijsturing: één extreme of kapotte uitkomst pint de verwachting niet vast', () => {
  const t = (exp, got) => ({ pair: 'A', pnlPct: got, agent: { expectedPct: exp } });
  const normal = [...Array(20)].map(() => t(0.3, 0.3));
  // Een uitkomst van -100% (bijv. een prijs 0 in de data) tussen 20 trades die precies uitkwamen.
  const c = onlineCorrection([t(0.3, -100), ...normal]);
  const adj = correctedExpectation(0.3, 'A', c).adj;
  assert.ok(adj > -0.5, `één uitschieter stuurt niet de hele groep naar -${LEARN.maxAdj}: ${adj}`);
  assert.ok(adj < 0, 'maar telt wel mee als slechter');
  // NaN / Infinity / null tellen niet mee.
  const junk = onlineCorrection([t(0.3, NaN), t(0.3, Infinity), t(NaN, 1), t(0.3, null), ...normal]);
  assert.equal(junk.trades, 20);
  assert.equal(correctedExpectation(0.3, 'A', junk).adj, 0);
  // Afgewezen kansen met extreme labels ook begrensd.
  const rej = [...Array(40)].map(() => ({ pair: 'A', expectedPct: 0.3, retPct: 0.3 }));
  rej[0] = { pair: 'A', expectedPct: 0.3, retPct: -100 };
  const cr = onlineCorrection(normal, LEARN, rej);
  assert.ok(correctedExpectation(0.3, 'A', cr).adj > -0.3);
});

test('bijsturing: alleen trades met een verwachting; volgorde van binnenkomst maakt niet uit binnen het venster', () => {
  const t = (exp, got, k) => ({ pair: k % 2 ? 'A' : 'B', pnlPct: got, agent: { expectedPct: exp } });
  const rows = [...Array(50)].map((_, k) => t(0.2, k % 3 ? 0.5 : -0.4, k));
  const a = onlineCorrection(rows);
  const b = onlineCorrection(rows.slice().reverse());
  assert.deepEqual(a.bins, b.bins);
  assert.deepEqual(a.coins, b.coins);
});
