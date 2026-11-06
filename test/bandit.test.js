import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bandit } from '../src/bandit.js';

// Vaste "willekeur" zodat de test herhaalbaar is.
function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

test('bandit: kiest vaker wat winst oplevert, probeert de rest af en toe nog', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-')), 'bandit.json');
  const b = new Bandit(file);
  const rnd = seeded(42);
  const truth = { goed: 0.8, matig: 0.1, slecht: -0.6 };
  const noise = () => (rnd() - 0.5) * 3;
  const picks = { goed: 0, matig: 0, slecht: 0 };
  for (let i = 0; i < 300; i++) {
    const c = b.pick(Object.keys(truth), rnd);
    picks[c.key]++;
    b.reward(c.key, truth[c.key] + noise());
  }
  assert.ok(picks.goed > picks.matig && picks.goed > picks.slecht, JSON.stringify(picks));
  assert.ok(picks.goed > 150, JSON.stringify(picks));
  assert.ok(picks.slecht > 0, 'ook de slechte is geprobeerd');
  // Onthouden na een herstart
  const again = new Bandit(file);
  assert.equal(again.stats('goed').trades, picks.goed);
  const sum = again.summary(['goed', 'matig', 'slecht']);
  assert.equal(sum[0].key, 'goed');
  assert.ok(sum[0].estimatePct > 0.4);
  assert.ok(sum.find((r) => r.key === 'slecht').estimatePct < 0);
});

test('bandit: past zich aan als een strategie ineens slecht wordt', () => {
  const b = new Bandit(null);
  const rnd = seeded(7);
  for (let i = 0; i < 60; i++) b.reward('a', 1);
  for (let i = 0; i < 60; i++) b.reward('b', 0.3);
  assert.equal(b.summary(['a', 'b'])[0].key, 'a');
  // a gaat verliezen: oudere winsten tellen steeds minder mee
  for (let i = 0; i < 60; i++) b.reward('a', -1);
  assert.equal(b.summary(['a', 'b'])[0].key, 'b');
  let a = 0;
  for (let i = 0; i < 100; i++) if (b.pick(['a', 'b'], rnd).key === 'a') a++;
  assert.ok(a < 30, `a nog ${a}× gekozen`);
});
