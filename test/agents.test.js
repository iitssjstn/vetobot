import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentForRecipe, allAgentCoins, chooseForRegime, assessRisk, riskStake, slippagePct, execSummary, lossStreak, RISK } from '../src/agents.js';

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
