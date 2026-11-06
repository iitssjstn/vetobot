import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { predictRaw, validateAgent, positionFeatures } from '../src/mlmodel.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));

test('AI-trader: koop- en verkoopwaarde gelijk aan Python', () => {
  assert.equal(validateAgent(fx.agent), null);
  for (const p of fx.points) {
    const e = predictRaw(fx.agent.entry, p.features);
    const x = predictRaw(fx.agent.exit, { ...p.features, ...p.pos });
    assert.ok(Math.abs(e - p.entry) < 1e-9, `entry ${e} vs ${p.entry}`);
    assert.ok(Math.abs(x - p.exit) < 1e-9, `exit ${x} vs ${p.exit}`);
  }
  assert.match(validateAgent({ ...fx.agent, kind: 'x' }), /Onbekend/);
});

test('AI-trader: kenmerken van de eigen positie', () => {
  const f = positionFeatures(100, 103, 106, 12);
  assert.ok(Math.abs(f.posPnlPct - 3) < 1e-9);
  assert.ok(Math.abs(f.posMaxPct - 6) < 1e-9);
  assert.ok(Math.abs(f.posDrawPct - 3) < 1e-9);
  assert.equal(f.posCandles, 12);
});
