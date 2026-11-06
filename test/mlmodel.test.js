import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeFeatures, predict, validateModel, FEATURES } from '../src/mlmodel.js';

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
