import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewardSummary, exploreScore, EXPLORE, onlineCorrection, correctedExpectation, LEARN, agentForRecipe, allAgentCoins, chooseForRegime, assessRisk, riskStake, slippagePct, execSummary, lossStreak, RISK } from '../src/agents.js';

const main = { recipeKey: 'A', coins: ['BTC/EUR'], regimes: {
  stijgend: { key: 'B', why: 'best', edge: 0.3, trades: 40, agent: { recipeKey: 'B', coins: ['ETH/EUR'] } },
  zijwaarts: { key: 'A', why: 'weinig bewijs', trades: 5 },
  dalend: { key: null, why: 'pauze', edge: -0.2, trades: 30 },
} };

test('Strategy Agent: recept per marktfase, of niet handelen', () => {
  assert.equal(chooseForRegime(main, 'stijgend').agent.recipeKey, 'B');
  assert.equal(chooseForRegime(main, 'stijgend').why, 'best');
  assert.equal(chooseForRegime(main, 'zijwaarts').agent, main);
  assert.equal(chooseForRegime(main, 'dalend').agent, null);
  assert.equal(chooseForRegime(main, null).agent, main, 'fase onbekend: hoofdrecept');
  assert.equal(chooseForRegime({ recipeKey: 'A' }, 'dalend').agent.recipeKey, 'A', 'zonder plan: hoofdrecept');
  // Plan wijst naar een ander recept zonder model: terug naar het hoofdrecept, voorzichtig.
  const broken = { recipeKey: 'A', regimes: { stijgend: { key: 'C', why: 'best' } } };
  assert.deepEqual([chooseForRegime(broken, 'stijgend').agent.recipeKey, chooseForRegime(broken, 'stijgend').why], ['A', 'weinig bewijs']);
  assert.equal(agentForRecipe(main, 'B').recipeKey, 'B');
  assert.equal(agentForRecipe(main, 'X'), main);
  assert.deepEqual(allAgentCoins(main).sort(), ['BTC/EUR', 'ETH/EUR']);
});

test('Risk Agent: verliesreeks, slechte uitvoering en inzet', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const loss = (h) => ({ agent: {}, pnlEur: -1, closedAt: new Date(now - h * 3600000).toISOString() });
  const trades = [loss(1), { pnlEur: 5 }, loss(2), loss(3), { agent: {}, pnlEur: 2 }];
  assert.equal(lossStreak(trades), 3, 'trades zonder AI-trader tellen niet mee');
  assert.match(assessRisk({ pair: 'BTC/EUR', trades, now }).block, /3 verliezen op rij: ik koop 5 uur niets/);
  assert.equal(assessRisk({ pair: 'BTC/EUR', trades: [loss(7), loss(8), loss(9)], now }).block, null, 'pauze voorbij');
  const execLog = [1, 2, 3].map(() => ({ pair: 'ETH/EUR', slipPct: 0.8 }));
  assert.match(assessRisk({ pair: 'ETH/EUR', execLog, now }).block, /slechter uit dan verwacht/);
  assert.equal(assessRisk({ pair: 'BTC/EUR', execLog, now }).block, null, 'andere coin');
  assert.equal(assessRisk({ pair: 'BTC/EUR', choice: { why: 'best' }, now }).stakeFactor, 1);
  assert.equal(assessRisk({ pair: 'BTC/EUR', choice: { why: 'weinig bewijs' }, now }).stakeFactor, RISK.carefulFactor);
  assert.equal(riskStake(20, 0.5), 10);
  assert.equal(riskStake(8, 0.5), 5, 'nooit onder de kleinste order');
  assert.equal(riskStake(4, 0.5), 4, 'nooit boven de gewone inzet');
  assert.equal(riskStake(20, 1), 20);
});

test('Execution Agent: afwijking van de verwachte prijs', () => {
  assert.ok(Math.abs(slippagePct('buy', 100, 100.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(slippagePct('sell', 100, 99.5) - (100 / 99.5 - 1) * 100) < 1e-9);
  assert.ok(slippagePct('buy', 100, 99.9) < 0, 'beter dan verwacht');
  assert.equal(slippagePct('buy', null, 100), null);
  const s = execSummary([{ pair: 'A', side: 'buy', slipPct: 0.1 }, { pair: 'B', side: 'sell', slipPct: 0.5 }, { pair: 'C', slipPct: null }]);
  assert.equal(s.orders, 2);
  assert.equal(s.worst.pair, 'B');
  assert.equal(execSummary([]), null);
});

test('Directe bijsturing: leert meteen van afgesloten trades, voorzichtig bij weinig data', () => {
  const t = (pair, exp, got, explore = false) => ({ pair, pnlPct: got, agent: { expectedPct: exp, ...(explore ? { explore: true } : {}) } });
  assert.equal(correctedExpectation(0.3, 'A', onlineCorrection([])).adj, 0, 'zonder trades niets');
  // 20 trades rond +0,3% verwacht die steeds 0,4 punt slechter uitkwamen (ook verkenner telt mee).
  const rows = [...Array(20)].map((_, i) => t(i % 2 ? 'A' : 'B', 0.3, -0.1, i % 3 === 0));
  const c = onlineCorrection(rows);
  const r = correctedExpectation(0.3, 'A', c);
  // Groep: -0,4 × 20 / (20 + 20) = -0,2. Coin A (10 trades) houdt daarna -0,2 per trade over: -2 / (10 + 20).
  const expect = (-0.4 * 20) / (20 + LEARN.prior) + (-0.2 * 10) / (10 + LEARN.prior);
  assert.ok(Math.abs(r.adj - expect) < 1e-9, `krimp naar 0: ${r.adj}`);
  assert.equal(correctedExpectation(-1, 'Z', c).adj, 0, 'andere groep verwachtingen en een coin zonder trades: geen bijsturing');
  // Eén coin structureel slechter: die coin extra omlaag.
  const more = [...rows, ...[...Array(30)].map(() => t('C', 0.3, -1.0))];
  const c2 = onlineCorrection(more);
  assert.ok(correctedExpectation(0.3, 'C', c2).adj < correctedExpectation(0.3, 'A', c2).adj);
  assert.ok(Math.abs(correctedExpectation(5, 'C', onlineCorrection([...Array(500)].map(() => t('C', 5, -50)))).adj) <= LEARN.maxAdj * 2, 'begrensd');
});

test('Slimme verkenner: kiest waar hij het meest leert, slaat bewezen slecht over', () => {
  const none = onlineCorrection([]);
  const near = exploreScore({ q: 0.18, thr: 0.2, pair: 'A', regime: 'stijgend', corr: none });
  const far = exploreScore({ q: -1.5, thr: 0.2, pair: 'A', regime: 'stijgend', corr: none });
  assert.ok(near.p > far.p, 'dicht bij de drempel eerder dan ver eronder');
  assert.ok(far.p >= EXPLORE.floor, 'ver weg nog af en toe');
  // Veel ervaring in deze coin en fase: minder te leren dan in een onbekende coin.
  const t = (pair, exp, got) => ({ pair, pnlPct: got, agent: { expectedPct: exp, marketRegime: 'stijgend' } });
  const known = onlineCorrection([...Array(80)].map(() => t('A', -0.4, -0.4)));
  assert.ok(exploreScore({ q: -0.4, thr: 0.2, pair: 'A', regime: 'stijgend', corr: known }).p
    < exploreScore({ q: -0.4, thr: 0.2, pair: 'B', regime: 'stijgend', corr: known }).p);
  // Beter uitgekomen dan verwacht: extra interessant.
  const better = onlineCorrection([...Array(40)].map(() => t('C', -0.2, 0.4)));
  const plain = onlineCorrection([...Array(40)].map(() => t('C', -0.2, -0.2)));
  assert.ok(exploreScore({ q: -0.2, thr: 0.2, pair: 'C', regime: 'stijgend', corr: better }).parts.optimism > 0);
  assert.ok(exploreScore({ q: -0.2, thr: 0.2, pair: 'C', regime: 'stijgend', corr: better }).p
    > exploreScore({ q: -0.2, thr: 0.2, pair: 'C', regime: 'stijgend', corr: plain }).p);
  // Bewezen slecht: 30+ trades duidelijk slechter dan verwacht en ver onder de drempel.
  const bad = onlineCorrection([...Array(60)].map(() => t('D', 0, -2)));
  const s = exploreScore({ q: -1, thr: 0.2, pair: 'D', regime: 'stijgend', corr: bad });
  assert.equal(s.p, 0);
  assert.match(s.skip, /steeds slechter uit dan verwacht/);
  assert.equal(exploreScore({ q: 0.15, thr: 0.2, pair: 'D', regime: 'stijgend', corr: bad }).skip, null, 'dicht bij de drempel blijft hij kijken');
});

test('Beloningen door de tijd: punten, weken en conclusie', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const day = 86400000;
  const t = (daysAgo, pct, explore = false) => ({ pair: 'BTC/EUR', pnlPct: pct, closedAt: new Date(now - daysAgo * day).toISOString(), agent: { expectedPct: 0.1, ...(explore ? { explore: true } : {}) } });
  const old = [...Array(12)].map((_, i) => t(15 + i, -0.3));
  const fresh = [...Array(12)].map((_, i) => t(1 + i, i % 2 ? 0.4 : 0.2, i % 3 === 0));
  const r = rewardSummary([...fresh, ...old, { pair: 'X', pnlPct: 5, closedAt: new Date(now).toISOString() }], now);
  assert.equal(r.points.length, 24, 'trades zonder AI-trader tellen niet');
  assert.ok(r.points[0].at < r.points.at(-1).at, 'oud naar nieuw');
  assert.equal(r.trend.verdict, 'beter');
  assert.equal(r.trend.recent.n, 12);
  assert.ok(Math.abs(r.trend.before.avgPct + 0.3) < 1e-9);
  assert.equal(r.weeks.reduce((a, w) => a + w.trades, 0), 24);
  assert.equal(r.weeks.reduce((a, w) => a + w.rewards + w.penalties, 0), 24);
  assert.equal(rewardSummary(fresh, now).trend.verdict, 'te weinig');
  assert.equal(r.points.filter((p) => p.who === 'verkenner').length, 4);
});
