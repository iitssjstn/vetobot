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

test('schaduwtrades: leren van trades die niet echt gedaan zijn', () => {
  const b = new Bandit(null);
  const t0 = 1_000_000;
  assert.equal(b.addShadow({ key: 'a', pair: 'X/EUR', entry: 100, at: t0, targetPct: 2, stopPct: 1, holdMinutes: 60 }), true);
  assert.equal(b.addShadow({ key: 'a', pair: 'X/EUR', entry: 101, at: t0, targetPct: 2, stopPct: 1, holdMinutes: 60 }), false, 'één tegelijk per strategie en coin');
  b.addShadow({ key: 'b', pair: 'X/EUR', entry: 100, at: t0, targetPct: 5, stopPct: 1, holdMinutes: 60 });
  b.addShadow({ key: 'c', pair: 'Y/EUR', entry: 10, at: t0, targetPct: 5, stopPct: 5, holdMinutes: 30 });
  assert.deepEqual(b.settleShadows({ 'X/EUR': 101 }, 0.5, t0 + 60000), [], 'nog niets geraakt');
  const done = b.settleShadows({ 'X/EUR': 102.1, 'Y/EUR': 10.2 }, 0.5, t0 + 31 * 60000);
  assert.deepEqual(done.map((d) => [d.key, d.why, +d.pct.toFixed(2)]), [['a', 'doel gehaald', 1.5], ['c', 'maximale duur', 1.5]]);
  assert.equal(b.openShadows(), 1);
  const s = b.stats('a');
  assert.equal(s.trades, 0, 'geen echte trade');
  assert.equal(s.shadowTrades, 1);
  assert.equal(s.n, 0.5, 'telt half');
  assert.ok(b.estimate('a').mean > 0);
  const stop = b.settleShadows({ 'X/EUR': 98.9 }, 0.5, t0 + 32 * 60000);
  assert.equal(stop[0].why, 'stop geraakt');
  assert.equal(+stop[0].pct.toFixed(2), -1.5);
  assert.equal(b.summary(['a', 'b'])[0].shadowTrades, 1);
});
