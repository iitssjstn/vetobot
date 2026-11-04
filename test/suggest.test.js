import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions } from '../src/suggest.js';
import { parseSummary } from '../src/ai.js';

const current = { emaFast: 12, emaSlow: 26, rsiPeriod: 14, rsiMaxEntry: 70, stopLossPct: 3, takeProfitPct: 6, timeframe: '5m', checkIntervalMinutes: 5 };

test('alleen toegestane, geldige en veranderde instellingen blijven over', () => {
  const s = cleanSuggestions({
    stopLossPct: 4.5,
    takeProfitPct: 6,          // geen verandering
    stakeEur: 5000,            // bedragen mag de AI niet voorstellen
    maxOpenTrades: 50,
    maxDailyLossEur: 0,
    timeframe: '3m',           // bestaat niet
    rsiMaxEntry: 500,          // buiten de grenzen
    checkIntervalMinutes: '15',
  }, current);
  assert.deepEqual(s.map((x) => [x.key, x.from, x.to]), [['stopLossPct', 3, 4.5], ['checkIntervalMinutes', 5, 15]]);
});

test('EMA fast groter dan slow wordt geweigerd', () => {
  const s = cleanSuggestions({ emaFast: 30, stopLossPct: 4 }, current);
  assert.deepEqual(s.map((x) => x.key), ['stopLossPct']);
});

test('antwoord van de AI wordt gelezen, ook als het geen JSON is', () => {
  const r = parseSummary('{"analyse":"Rustige dag.","voorstel":{"stopLossPct":4},"toelichting":"Minder ruis."}');
  assert.equal(r.analysis, 'Rustige dag.');
  assert.deepEqual(r.suggestions, { stopLossPct: 4 });
  const t = parseSummary('Gewoon tekst zonder JSON');
  assert.equal(t.analysis, 'Gewoon tekst zonder JSON');
  assert.deepEqual(t.suggestions, {});
  assert.equal(parseSummary(''), null);
});
