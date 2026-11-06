import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeFeatures, predict, validateModel, FEATURES, regimeOf, contributions, explain, formatFeature } from '../src/mlmodel.js';

// Gemaakt door Python (trainer/features.py + sklearn), zie trainer/test_trainer.py.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));

test('kenmerken in JavaScript zijn gelijk aan die van de Python-trainer', () => {
  for (const pt of fx.points) {
    const js = computeFeatures(fx.candles.slice(0, pt.end), { btc: fx.btc });
    for (const k of FEATURES) {
      const a = js[k], b = pt.features[k];
      assert.ok(a == null ? b == null : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${k} op ${pt.end}: js ${a} vs py ${b}`);
    }
  }
});

test('modeluitkomst in JavaScript is gelijk aan sklearn', () => {
  assert.equal(validateModel(fx.model), null);
  fx.points.forEach((pt, i) => assert.ok(Math.abs(predict(fx.model, pt.features) - fx.probs[i]) < 1e-9));
  // Alles ontbreekt → medianen
  assert.ok(Math.abs(predict(fx.model, {}) - fx.missing) < 1e-9);
});

test('te weinig candles of verkeerd model wordt herkend', () => {
  assert.equal(computeFeatures(fx.candles.slice(0, 100)), null);
  assert.match(validateModel({ version: 1, kind: 'gbdt', features: ['x'] }), /andere kenmerken/);
  // Een ouder model met minder kenmerken blijft bruikbaar
  const old = { ...fx.model, features: FEATURES.slice(0, 16), medians: fx.model.medians.slice(0, 16), trees: [{ f: [0, -2, -2], t: [50, -2, -2], l: [1, -1, -1], r: [2, -1, -1], v: [0, -1, 1] }] };
  assert.equal(validateModel(old), null);
  assert.ok(predict(old, { rsi14: 30 }) < predict(old, { rsi14: 70 }));
  // Zonder BTC-candles zijn de BTC-kenmerken leeg (het model vult ze met de mediaan)
  const noBtc = computeFeatures(fx.candles);
  assert.equal(noBtc.btcRet12, null);
  assert.equal(noBtc.relRet12, null);
  assert.ok(Number.isFinite(noBtc.htfTrendPct));
  assert.match(validateModel(null), /Onbekend/);
});

test('marktfase: trend over het grotere plaatje gemeten in normale beweging', () => {
  assert.equal(regimeOf({ htfTrendPct: 4, atrPct: 1 }), 'stijgend');
  assert.equal(regimeOf({ htfTrendPct: -4, atrPct: 1 }), 'dalend');
  assert.equal(regimeOf({ htfTrendPct: 4, atrPct: 2 }), 'zijwaarts'); // wilde coin: 4% is niet veel
  assert.equal(regimeOf({}), 'zijwaarts');
});

test('uitleg: bijdragen per kenmerk gelijk aan Python en tellen op tot de voorspelling', () => {
  for (const pt of fx.points) {
    const { base, contrib } = contributions(fx.model, pt.features);
    assert.ok(Math.abs(base - pt.base) < 1e-9, `basis bij ${pt.end}`);
    contrib.forEach((v, j) => assert.ok(Math.abs(v - pt.contrib[j]) < 1e-9, `${FEATURES[j]} bij ${pt.end}: ${v} vs ${pt.contrib[j]}`));
    const raw = base + contrib.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(1 / (1 + Math.exp(-raw)) - predict(fx.model, pt.features)) < 1e-9);
    const why = explain(fx.model, pt.features);
    assert.ok(why.length > 0 && why.length <= 6);
    assert.ok(why.every((w, i) => i === 0 || Math.abs(w.effect) <= Math.abs(why[i - 1].effect)), 'grootste eerst');
    assert.ok(why.every((w) => typeof w.label === 'string' && w.label !== w.key));
  }
  assert.equal(formatFeature('btcRet12', 0.834), '+0.83%');
  assert.equal(formatFeature('distEma20Atr', -1.25), '-1.3 × ATR');
  assert.equal(formatFeature('dowUtc', 0), 'maandag');
  assert.equal(formatFeature('rsi14', null), 'onbekend');
});

test('orderboek-kenmerken: via ctx.micro, anders leeg (model vult aan met de mediaan)', () => {
  const micro = { microBookImb: 0.7, microSpread: 0.05, microBuyRatio60: 0.62, microFlow60: 0.3, microIntensity: 1.8 };
  const f = computeFeatures(fx.candles, { btc: fx.btc, micro });
  assert.equal(f.microBookImb, 0.7);
  assert.equal(f.microIntensity, 1.8);
  assert.equal(computeFeatures(fx.candles).microBookImb, null);
  // Model dat op microBookImb splitst
  const m = { version: 1, kind: 'gbdt', features: ['rsi14', 'microBookImb'], init: 0, learningRate: 1, medians: [50, 0.5],
    trees: [{ f: [1, -2, -2], t: [0.6, -2, -2], l: [1, -1, -1], r: [2, -1, -1], v: [0, -1, 1], n: [10, 5, 5] }] };
  assert.equal(validateModel(m), null);
  assert.ok(predict(m, { microBookImb: 0.7 }) > 0.7);
  assert.ok(predict(m, {}) < 0.3, 'ontbreekt: mediaan 0,5');
  assert.match(explain(m, { microBookImb: 0.7 })[0].label, /kopers in het orderboek/);
});
