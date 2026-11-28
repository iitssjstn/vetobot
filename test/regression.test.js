// Regressietests: leggen het huidige gedrag van de bot vast (paper, live met nep-Bitvavo, stops,
// AI-veto, AI-trader, orderboek, risicolimieten, modus wisselen, instellingen).
// Geen netwerk (alleen een lokale nep-AI op 127.0.0.1), geen echte orders, geen echte wachttijden.
// Helpers zijn gekopieerd uit test/bot.test.js en test/limit.test.js zodat die bestanden ongewijzigd blijven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Bot, sellableStake } from '../src/bot.js';
import { PaperBroker, LiveBroker, OPERATOR_ID, orderTiming } from '../src/exchange.js';
import { Store } from '../src/store.js';
import { Settings, RISK_LIMITS, STRATEGY_LIMITS, LIVE_MIN_STAKE_EUR } from '../src/settings.js';
import { checkEntry } from '../src/risk.js';
import { analyzeBook, bookProblem } from '../src/orderbook.js';
import { askVetoChain } from '../src/ai.js';
import { agentForRecipe } from '../src/agents.js';
import { config as envConfig, validateConfig } from '../src/config.js';
import { PUMP_DEFAULTS } from '../src/safety.js';

orderTiming.sleep = async () => {};
orderTiming.pollMs = 0;

const H = 3600000;
const quiet = { info() {}, warn() {}, error() {} };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const wavy = () => [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);

// Nep-exchange (zoals in bot.test.js): alle candles gesloten, koersen instelbaar.
function fakeExchange(prices, { keys = false } = {}) {
  return {
    apiKey: keys ? 'k' : undefined,
    secret: keys ? 's' : undefined,
    prices,
    parseTimeframe: () => 3600,
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { return { last: this.prices.at(-1) }; },
    async fetchBalance() { return { EUR: { free: 1000, total: 1000 } }; },
  };
}

function setup({ keys = false, ex: given = null, risk = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-'));
  const ex = given ?? fakeExchange(wavy(), { keys });
  const baseRisk = { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 50, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25, ...risk };
  const config = {
    timeframe: '1h',
    strategy: {},
    risk: baseRisk,
    ai: { provider: 'none', failMode: 'reject' },
  };
  const settings = new Settings(dir, { liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, risk: baseRisk,
    strategy: { agentMode: 1, agentVeto: 1, agentExplore: 0, agentLiveSmallStart: 0 }, ai: { provider: 'none', model: '', baseUrl: '' } });
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const live = given ? new LiveBroker(ex) : { mode: 'live', buy: async () => { throw new Error('geen echte orders in tests'); } };
  const bot = new Bot({ config, exchange: ex, settings, stores, log: quiet, brokers: { paper: new PaperBroker(ex, 0.25), live } });
  // Koper in de tests: een AI-trader die altijd wil kopen (noodstop gelijk aan de stop-loss van 50%); live pas na setAgentLive.
  bot.getAgent = () => greedyAgent({ stage: 'bewezen', liveCheck: { allMet: true, checks: [] }, safetyStopPct: 50 });
  return { bot, ex, dir, settings, stores };
}

function liveBook(ex) {
  ex.fetchOrderBook = async () => {
    const p = ex.prices.at(-1);
    return { bids: [[p * 0.9999, 1e6], [p * 0.99, 1e6]], asks: [[p * 1.0001, 1e6], [p * 1.01, 1e6]] };
  };
}

// Het koopsignaal van de AI-trader laten beoordelen (één check, en nog één op dezelfde candle),
// zonder te eisen dat er gekocht wordt.
async function crossTicks(bot) {
  for (let n = 0; n < 2 && !bot.store.state.positions['BTC/EUR']; n++) await bot.tick();
  return bot.store.state.positions['BTC/EUR'];
}

// Een bestaande positie zonder eigen plan, zoals de vroegere klassieke strategie die kocht (oude state).
async function legacyPosition(bot, ex, pair = 'BTC/EUR') {
  const fill = await bot.broker.buy(pair, bot.stakeInfo().effective);
  bot.store.state.balanceEur -= fill.costEur;
  bot.store.state.positions[pair] = { pair, openedAt: new Date().toISOString(), entryPrice: fill.price, amount: fill.amount, costEur: fill.costEur,
    entryFeeEur: fill.feeEur, reason: 'EMA fast kruist boven EMA slow (op de laatste candle)', highest: fill.price, lowest: fill.price, atrAtEntry: 1 };
  bot.store.save();
  return bot.store.state.positions[pair];
}

async function openPosition(bot, ex) {
  const pos = await crossTicks(bot, ex);
  assert.ok(pos, `positie geopend (${bot.pairStatus['BTC/EUR']?.reason})`);
  return pos;
}

// Nep-Bitvavo voor de echte LiveBroker: market orders direct gevuld, fees in EUR (0,25%), stop-orders bijgehouden.
function fakeBitvavo() {
  const calls = [];
  const orders = {};
  let n = 0;
  return {
    calls, orders,
    apiKey: 'k', secret: 's',
    has: { createMarketBuyOrderWithCost: true },
    prices: wavy(),
    markets: { 'BTC/EUR': { symbol: 'BTC/EUR', limits: { amount: { min: 0.00001 }, cost: { min: 5 } } } },
    parseTimeframe: () => 3600,
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { return { last: this.prices.at(-1) }; },
    async fetchOrderBook() {
      const p = this.prices.at(-1);
      return { bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] };
    },
    async fetchBalance() { return { EUR: { free: 1000, total: 1000 } }; },
    async loadMarkets() { return this.markets; },
    amountToPrecision: (_p, v) => String(Math.floor(v * 1e8) / 1e8),
    priceToPrecision: (_p, v) => String(v),
    async createMarketBuyOrderWithCost(pair, cost) {
      const price = this.prices.at(-1);
      calls.push(['buy', pair, cost]);
      return { id: `b${++n}`, status: 'closed', filled: cost / price, average: price, cost, fee: { currency: 'EUR', cost: cost * 0.0025 } };
    },
    async createMarketOrder(pair, side, amount) {
      const price = this.prices.at(-1);
      calls.push(['market', side, amount]);
      return { id: `m${++n}`, status: 'closed', filled: amount, average: price, cost: amount * price, fee: { currency: 'EUR', cost: amount * price * 0.0025 } };
    },
    async createOrder(pair, type, side, amount, price, params) {
      calls.push(['create', type, side, amount, params]);
      const id = `s${++n}`;
      orders[id] = { id, status: 'open', filled: 0, amount };
      return orders[id];
    },
    async cancelOrder(id, _pair, params) {
      calls.push(['cancel', id, params]);
      if (orders[id]?.status === 'open') orders[id].status = 'canceled';
    },
    async fetchOrder(id) { return orders[id]; },
  };
}

// Live met een geslaagde saldo-ophaling (vast saldo) en zonder saldocontrole tijdens de test.
async function goLive(bot, eurFree = 1000) {
  await bot.switchMode('live');
  bot.liveBalance = { eurFree, eurTotal: eurFree, at: new Date().toISOString() };
  bot.refreshLiveBalance = async () => bot.liveBalance;
  bot.reconcileRanAt = Date.now();
}

// ---------- Nep-AI (OpenAI-compatibel) ----------
let aiMode = 'approve'; // approve | reject | fail
let aiCalls = 0;
const aiServer = http.createServer((req, res) => {
  aiCalls++;
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (aiMode === 'fail') {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { message: 'interne fout' } }));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: aiMode, reason: `nep-AI zegt ${aiMode}` }) } }] }));
  });
});
await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
test.after(() => aiServer.close());

function withAi(bot, failMode = 'reject', key = 'k') {
  bot.settings.setAi({ provider: 'openai', model: 'm', baseUrl: `http://127.0.0.1:${aiServer.address().port}/v1`, failMode });
  bot.secrets = { get: (n) => (n === 'aiApiKey' ? key : '') };
}

const agentFx = () => JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
// AI-trader die altijd wil kopen; sell=true: wil ook direct verkopen.
const greedyAgent = (extra = {}, sell = false) => {
  const fx = agentFx();
  return { ...fx.agent, stage: 'getest', recipeKey: 'R', entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 },
    exit: { ...fx.agent.exit, init: fx.agent.exit.init + (sell ? -50 : 50) },
    regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } }, ...extra };
};

// =====================================================================
// Paper trading
// =====================================================================

test('paper: kopen haalt de inzet van het saldo, fee van 0,25% gaat van de gekochte hoeveelheid af', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  const pos = await openPosition(bot, ex);
  const price = ex.prices.at(-1);
  assert.equal(pos.costEur, 25);
  assert.ok(near(pos.entryFeeEur, 25 * 0.0025));
  assert.equal(pos.entryPrice, price, 'zonder orderboek en slippage: de laatste koers');
  assert.ok(near(pos.amount, (25 - 0.0625) / price));
  assert.equal(bot.store.state.balanceEur, 475);
  assert.equal(bot.mode, 'paper');
  assert.equal(pos.highest, price);
  assert.equal(pos.lowest, price);
});

test('paper: verkopen zet de netto opbrengst terug; pnl en fees in de trade kloppen', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  const pos = await openPosition(bot, ex);
  const amount = pos.amount;
  ex.fetchTicker = async () => ({ last: 80 });
  const trade = await bot.closeManual('BTC/EUR');
  const gross = amount * 80;
  assert.equal(trade.mode, 'paper');
  assert.equal(trade.exitPrice, 80);
  assert.ok(near(trade.pnlEur, gross * 0.9975 - 25));
  assert.ok(near(trade.feesEur, 0.0625 + gross * 0.0025));
  assert.ok(near(trade.pnlPct, ((gross * 0.9975 - 25) / 25) * 100));
  assert.ok(near(bot.store.state.balanceEur, 475 + gross * 0.9975));
  assert.deepEqual(bot.store.state.positions, {});
  assert.ok(bot.store.state.lastExit['BTC/EUR']);
});

test('paper: saldo te laag voor de inzet → niet kopen, reden in de beslissingen', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  bot.store.state.balanceEur = 10;
  assert.equal(await crossTicks(bot, ex), undefined);
  assert.equal(bot.store.state.decisions[0].outcome, 'blocked');
  assert.match(bot.store.state.decisions[0].reason, /Paper-saldo 10.00 EUR is lager dan de inzet/);
});

test('paper: state wordt bewaard en een nieuwe Store leest dezelfde positie en saldo terug', async () => {
  const { bot, ex, dir } = setup({ risk: { cooldownMinutes: 0 } });
  await openPosition(bot, ex);
  const again = new Store(dir, 'paper', 999);
  assert.equal(again.state.balanceEur, 475, 'startsaldo uit de constructor wordt niet opnieuw gebruikt');
  assert.ok(again.state.positions['BTC/EUR']);
});

// =====================================================================
// Live trading met de echte LiveBroker en een nep-Bitvavo
// =====================================================================

test('live: koop en verkoop via de LiveBroker, fees in pnl, vrij saldo bijgehouden, stop-order met operatorId', async () => {
  const ex = fakeBitvavo();
  const { bot } = setup({ ex, risk: { cooldownMinutes: 0 } });
  await goLive(bot, 1000);
  assert.equal(bot.mode, 'live');
  bot.settings.setAgentLive('R', true);
  const pos = await openPosition(bot, ex);
  const p1 = ex.prices.at(-1);
  // Aankoop: market order met de inzet als bedrag; betaald = inzet + fee.
  assert.deepEqual(ex.calls.find((c) => c[0] === 'buy'), ['buy', 'BTC/EUR', 25]);
  assert.ok(near(pos.costEur, 25 * 1.0025));
  assert.ok(near(pos.entryFeeEur, 0.0625));
  assert.ok(near(pos.amount, 25 / p1));
  assert.ok(near(bot.liveBalance.eurFree, 1000 - 25 * 1.0025), `vrij saldo na kopen: ${bot.liveBalance.eurFree}`);
  assert.equal(bot.stores.paper.state.balanceEur, 500, 'paper-saldo blijft onaangeroerd');
  // Stop-order bij Bitvavo op de stop-loss (50%), met operatorId.
  const stop = ex.calls.find((c) => c[0] === 'create');
  assert.equal(stop[1], 'stopLoss');
  assert.equal(stop[2], 'sell');
  assert.equal(stop[4].operatorId, OPERATOR_ID);
  assert.equal(stop[4].triggerPrice, p1 * 0.5);
  assert.ok(pos.exchangeStop.orderId);
  // Verkopen: eerst de stop annuleren (met operatorId), dan market verkopen.
  ex.prices = [...ex.prices, 70];
  const free = bot.liveBalance.eurFree;
  const trade = await bot.closeManual('BTC/EUR');
  const kinds = ex.calls.map((c) => c[0]);
  assert.ok(kinds.indexOf('cancel') < kinds.indexOf('market'), kinds.join(','));
  assert.equal(ex.calls.find((c) => c[0] === 'cancel')[2].operatorId, OPERATOR_ID);
  const gross = pos.amount * 70;
  assert.equal(trade.mode, 'live');
  assert.ok(near(trade.pnlEur, gross * 0.9975 - 25 * 1.0025, 1e-5), `pnl ${trade.pnlEur}`);
  assert.ok(near(trade.feesEur, 0.0625 + gross * 0.0025, 1e-5));
  assert.ok(near(bot.liveBalance.eurFree, free + gross * 0.9975, 1e-5));
  assert.deepEqual(bot.store.state.positions, {});
});

test('live: geen keys of te weinig vrij saldo → niet kopen', () => {
  const { bot } = setup({ keys: false });
  const risk = { ...bot.risk, maxOpenTrades: 5 };
  assert.match(checkEntry(bot.stores.live, { risk }, 'live', bot.ex, { eurFree: 1000 }, { pair: 'BTC/EUR' }), /keys ontbreken/);
  const ex = fakeExchange([1], { keys: true });
  assert.match(checkEntry(bot.stores.live, { risk }, 'live', ex, { eurFree: 10 }, { pair: 'BTC/EUR' }), /Bitvavo-saldo 10.00 EUR is lager dan de inzet/);
  assert.equal(checkEntry(bot.stores.live, { risk }, 'live', ex, { eurFree: 25 }, { pair: 'BTC/EUR' }), null, 'precies genoeg mag');
});

test('LiveBroker: zonder keys geen enkele order', async () => {
  const ex = fakeBitvavo();
  ex.apiKey = undefined;
  await assert.rejects(new LiveBroker(ex).buy('BTC/EUR', 10), /keys ontbreken/);
  await assert.rejects(new LiveBroker(ex).sell('BTC/EUR', 1), /keys ontbreken/);
  assert.equal(ex.calls.length, 0);
});

// =====================================================================
// Stops: stop-loss, take-profit, trailing, ATR, maximale duur
// =====================================================================

async function withPosition(risk) {
  const s = setup({ risk: { cooldownMinutes: 0, aiExitMinPct: 0, ...risk } });
  await s.bot.setRisk({ cooldownMinutes: 0, aiExitMinPct: 0, ...risk });
  const pos = await legacyPosition(s.bot, s.ex);
  return { ...s, pos, entry: pos.entryPrice };
}

test('AI-trader: mijn stop-loss geldt ook (strakste van eigen stop en noodstop); uit → alleen de noodstop; verkenner altijd noodstop', async () => {
  const { planStopPct, exchangeStopPrice } = await import('../src/safety.js');
  const pos = { entryPrice: 100, plan: { stopLossPct: 10 }, agent: { recipe: 'R' } };
  assert.equal(planStopPct(pos, { stopLossPct: 2.5 }), 2.5, 'standaard aan');
  assert.equal(planStopPct(pos, { stopLossPct: 2.5, agentOwnStop: 0 }), 10);
  assert.equal(planStopPct(pos, { stopLossPct: 20 }), 10, 'de strakste wint');
  assert.equal(planStopPct({ ...pos, agent: { explore: true } }, { stopLossPct: 2.5 }), 10, 'verkenner: noodstop');
  assert.equal(planStopPct({ ...pos, agent: undefined }, { stopLossPct: 2.5 }), 10, 'strategie (geen AI-trader): plan');
  assert.ok(Math.abs(exchangeStopPrice(pos, { stopLossPct: 2.5 }) - 97.5) < 1e-9, 'ook de stop bij de beurs');
  // In de bewaking: AI-trader-positie verkoopt op 2,5% (aan), niet (uit).
  for (const own of [1, 0]) {
    const { bot, ex, pos: p, entry } = await withPosition({ stopLossPct: 2.5, takeProfitPct: 0, pumpTriggerPct: 0, agentOwnStop: own });
    p.plan = { key: null, stopLossPct: 10, takeProfitPct: 0, maxHoldMinutes: 0 };
    p.agent = { timeframe: '15m', recipe: 'R' };
    ex.fetchTicker = async () => ({ last: entry * 0.97 });
    assert.equal(await bot.watchPositions(), own, own ? 'verkocht op mijn stop-loss' : 'uit: alleen de noodstop');
  }
});

test('stop-loss: grens precies op het percentage (net erboven open, net eronder dicht)', async () => {
  const { bot, ex, entry } = await withPosition({ stopLossPct: 5, takeProfitPct: 0 });
  ex.fetchTicker = async () => ({ last: entry * 0.9501 });
  assert.equal(await bot.watchPositions(), 0);
  ex.fetchTicker = async () => ({ last: entry * 0.9499 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Stop-loss \(-5\.01%\)/);
  assert.ok(bot.store.state.trades[0].pnlEur < 0);
});

test('stop-loss verkoopt altijd met een market order, ook met limietorders aan', async () => {
  const { bot, ex, entry } = await withPosition({ stopLossPct: 5, takeProfitPct: 0, limitOrders: 1 });
  const opts = [];
  const sell = bot.brokers.paper.sell.bind(bot.brokers.paper);
  bot.brokers.paper.sell = async (p, a, o) => { opts.push(o); return sell(p, a, o); };
  ex.fetchTicker = async () => ({ last: entry * 0.9 });
  await bot.watchPositions();
  assert.deepEqual(opts, [{}]);
});

test('take-profit: grens precies op het percentage', async () => {
  const { bot, ex, entry } = await withPosition({ stopLossPct: 0, takeProfitPct: 4 });
  ex.fetchTicker = async () => ({ last: entry * 1.0399 });
  assert.equal(await bot.watchPositions(), 0);
  ex.fetchTicker = async () => ({ last: entry * 1.0401 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Take-profit \(4\.01%\)/);
  assert.ok(bot.store.state.trades[0].pnlEur > 0);
});

test('take-profit 0 = uit: ook bij 100% winst geen verkoop', async () => {
  const { bot, ex, entry } = await withPosition({ stopLossPct: 0, takeProfitPct: 0 });
  ex.fetchTicker = async () => ({ last: entry * 2 });
  assert.equal(await bot.watchPositions(), 0);
  assert.ok(bot.store.state.positions['BTC/EUR']);
});

test('trailing stop: top wordt bijgehouden; pas verkopen bij de ingestelde terugval vanaf de top', async () => {
  const { bot, ex, entry } = await withPosition({ stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 3 });
  ex.fetchTicker = async () => ({ last: entry * 1.1 });
  await bot.watchPositions();
  assert.ok(near(bot.store.state.positions['BTC/EUR'].highest, entry * 1.1));
  ex.fetchTicker = async () => ({ last: entry * 1.1 * 0.975 }); // 2,5% onder de top
  assert.equal(await bot.watchPositions(), 0);
  assert.ok(near(bot.store.state.positions['BTC/EUR'].highest, entry * 1.1), 'top zakt niet mee');
  ex.fetchTicker = async () => ({ last: entry * 1.1 * 0.969 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Trailing stop/);
});

test('ATR-stop zonder ATR bij aankoop valt terug op de vaste stop-loss', async () => {
  const { bot, ex, pos, entry } = await withPosition({ stopLossPct: 5, takeProfitPct: 0, atrStopMult: 3 });
  pos.atrAtEntry = null;
  ex.fetchTicker = async () => ({ last: entry * 0.94 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Stop-loss/);
});

test('ATR-stop: verkoopt op instapkoers − mult × ATR, de vaste stop telt dan niet', async () => {
  const { bot, ex, pos, entry } = await withPosition({ stopLossPct: 1, takeProfitPct: 0, atrStopMult: 2 });
  pos.atrAtEntry = entry * 0.05; // ATR-stop op −10%
  ex.fetchTicker = async () => ({ last: entry * 0.95 });
  assert.equal(await bot.watchPositions(), 0, 'vaste stop van 1% telt niet');
  ex.fetchTicker = async () => ({ last: entry * 0.899 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^ATR-stop/);
});

test('maximale duur: 0 = uit, anders na de tijd verkopen', async () => {
  const { bot, ex, pos, entry } = await withPosition({ stopLossPct: 0, takeProfitPct: 0, maxHoldMinutes: 0 });
  pos.openedAt = new Date(Date.now() - 30 * 86400000).toISOString();
  ex.fetchTicker = async () => ({ last: entry });
  assert.equal(await bot.watchPositions(), 0, 'uit');
  await bot.setRisk({ maxHoldMinutes: 60 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Tijdslimiet/);
});

test('plan van de AI-trader/strategie: eigen stop geldt, trailing stop en vaste take-profit niet', async () => {
  // Winstgrens bij een uitschieter uit: die heeft eigen tests (test/pump.test.js).
  const { bot, ex, pos, entry } = await withPosition({ stopLossPct: 2, takeProfitPct: 1, trailingStopPct: 1, pumpTriggerPct: 0, agentOwnStop: 0 });
  pos.plan = { key: null, stopLossPct: 10, takeProfitPct: 0, maxHoldMinutes: 0 };
  pos.agent = { timeframe: '15m', recipe: 'R' };
  ex.fetchTicker = async () => ({ last: entry * 1.05 });
  assert.equal(await bot.watchPositions(), 0, 'geen vaste take-profit');
  ex.fetchTicker = async () => ({ last: entry * 0.95 });
  assert.equal(await bot.watchPositions(), 0, 'geen trailing stop en niet de vaste stop van 2%');
  ex.fetchTicker = async () => ({ last: entry * 0.89 });
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Stop-loss/);
});

// =====================================================================
// AI-veto
// =====================================================================

test('AI-veto: goedgekeurd → gekocht; afgewezen → niet gekocht, als vetoed bewaard', async () => {
  const run = async (mode) => {
    const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
    withAi(bot, 'reject');
    aiMode = mode;
    aiCalls = 0;
    await crossTicks(bot, ex);
    return bot;
  };
  const yes = await run('approve');
  assert.ok(yes.store.state.positions['BTC/EUR']);
  assert.equal(aiCalls, 1, 'één AI-vraag per signaal');
  assert.equal(yes.store.state.decisions[0].outcome, 'approved');
  const no = await run('reject');
  assert.equal(no.store.state.positions['BTC/EUR'], undefined);
  assert.equal(aiCalls, 1, 'hetzelfde signaal niet nog eens gevraagd');
  const d = no.store.state.decisions[0];
  assert.equal(d.outcome, 'vetoed');
  assert.equal(d.aiError, false);
  assert.match(d.reason, /nep-AI zegt reject/);
  assert.equal(no.store.state.balanceEur, 500);
});

test('AI-veto: AI faalt → fail-mode beslist (reject = niet kopen, approve = kopen)', async () => {
  const run = async (failMode) => {
    const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
    withAi(bot, failMode);
    aiMode = 'fail';
    await crossTicks(bot, ex);
    return bot;
  };
  const rej = await run('reject');
  assert.equal(rej.store.state.positions['BTC/EUR'], undefined);
  assert.equal(rej.store.state.decisions[0].outcome, 'vetoed');
  assert.equal(rej.store.state.decisions[0].aiError, true);
  assert.match(rej.store.state.decisions[0].reason, /fail-mode "reject"/);
  const app = await run('approve');
  assert.ok(app.store.state.positions['BTC/EUR']);
  assert.equal(app.store.state.decisions[0].aiError, true);
  aiMode = 'approve';
});

test('AI-veto: provider ingesteld maar geen key → fail-mode; provider none → automatisch goedgekeurd', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  withAi(bot, 'reject', '');
  aiCalls = 0;
  await crossTicks(bot, ex);
  assert.equal(aiCalls, 0, 'zonder key geen verzoek');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.equal(bot.store.state.decisions[0].aiError, true);
  const none = await askVetoChain([], 'reject', {});
  assert.equal(none.decision, 'approve');
  assert.equal(none.provider, 'none');
  const s = setup({ risk: { cooldownMinutes: 0 } });
  await openPosition(s.bot, s.ex);
  assert.equal(s.bot.store.state.decisions[0].provider, 'none');
});

test('AI-veto: onbekende fail-mode wordt "reject" (veilig)', () => {
  const { bot } = setup();
  bot.settings.setAi({ provider: 'openai', model: 'm', baseUrl: 'https://x.example/v1', failMode: 'misschien' });
  assert.equal(bot.settings.ai.failMode, 'reject');
});

// =====================================================================
// AI-trader
// =====================================================================

async function agentBot(agent, { risk = {}, strategy = {}, prep = () => {} } = {}) {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  await bot.setRisk({ cooldownMinutes: 0, ...risk });
  await bot.setStrategy({ agentMode: 1, agentVeto: 0, agentExplore: 0, ...strategy });
  bot.getAgent = () => agent;
  bot.fb = [];
  bot.onFeedback = (t) => bot.fb.push(t);
  ex.prices = wavy();
  await prep(bot, ex);
  await bot.tick();
  return { bot, ex };
}

test('AI-trader: koopt boven de drempel met de noodstop van het recept; onder de drempel niet', async () => {
  const { bot } = await agentBot(greedyAgent());
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, bot.pairStatus['BTC/EUR']?.reason);
  assert.equal(pos.agent.recipe, 'R');
  assert.equal(pos.plan.stopLossPct, agentFx().agent.safetyStopPct);
  assert.equal(pos.plan.takeProfitPct, 0);
  const low = await agentBot(greedyAgent({ threshold: 1e6 }));
  assert.equal(low.bot.store.state.positions['BTC/EUR'], undefined);
});

test('AI-trader: toelating per fase (paper) en nooit live zonder akkoord of eigen risico', async () => {
  const { bot } = setup();
  assert.equal(bot.agentAllowed({ stage: 'geblokkeerd' }), false);
  assert.equal(bot.agentAllowed({ stage: 'getest' }), true);
  assert.equal(bot.agentAllowed({ stage: 'bewezen' }), true);
  await bot.setStrategy({ mlTrialPaper: 1 });
  assert.equal(bot.agentAllowed({ stage: 'oefenen' }), true);
  await bot.setStrategy({ mlTrialPaper: 0 });
  assert.equal(bot.agentAllowed({ stage: 'oefenen' }), false);
  bot.settings.data.mode = 'live';
  assert.equal(bot.agentAllowed({ stage: 'bewezen', recipeKey: 'R' }), false, 'live zonder eisen en akkoord');
  assert.equal(bot.agentAllowed({ stage: 'bewezen', recipeKey: 'R', liveCheck: { allMet: true } }), false, 'eisen gehaald, geen akkoord');
  bot.settings.setAgentLive('R', true);
  assert.equal(bot.agentAllowed({ stage: 'bewezen', recipeKey: 'R', liveCheck: { allMet: true } }), true);
  assert.equal(bot.agentAllowed({ stage: 'geblokkeerd', recipeKey: 'R', liveCheck: { allMet: true } }), false);
  bot.settings.setAgentLiveRisky('O', 10);
  assert.equal(bot.agentAllowed({ stage: 'oefenen', recipeKey: 'O' }), false, 'oefenen nooit op eigen risico');
  bot.settings.setAgentLiveRisky('G', 10);
  assert.equal(bot.agentAllowed({ stage: 'getest', recipeKey: 'G' }), true);
  bot.settings.setAgentLiveRisky('G', null);
  assert.equal(bot.agentAllowed({ stage: 'getest', recipeKey: 'G' }), false, 'eigen risico ingetrokken');
});

test('AI-trader: verkoopt met hetzelfde recept dat kocht', async () => {
  const fx = agentFx();
  const holder = { ...fx.agent, stage: 'getest', recipeKey: 'A', exit: { ...fx.agent.exit, init: fx.agent.exit.init + 50 }, entry: { ...fx.agent.entry, init: fx.agent.entry.init - 50 } };
  const seller = { ...holder, recipeKey: 'B', exit: { ...fx.agent.exit, init: fx.agent.exit.init - 50 } };
  const main = { ...holder, regimes: { stijgend: { key: 'B', why: 'best', agent: seller } } };
  assert.equal(agentForRecipe(main, 'B'), seller);
  assert.equal(agentForRecipe(main, 'A'), main);
  assert.equal(agentForRecipe(main, 'onbekend'), main, 'onbekend recept: het hoofdrecept');
  const run = async (recipe) => agentBot(main, { prep: (bot, ex) => {
    const entry = ex.prices.at(-1);
    bot.store.state.positions['BTC/EUR'] = { pair: 'BTC/EUR', openedAt: new Date(Date.now() - 3 * H).toISOString(), entryPrice: entry, amount: 0.25, costEur: 25,
      entryFeeEur: 0, highest: entry, lowest: entry, agent: { timeframe: '15m', recipe, expectedPct: 1 },
      plan: { key: null, stopLossPct: 10, takeProfitPct: 0, maxHoldMinutes: 0 } };
  } });
  const sold = await run('B');
  assert.equal(sold.bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(sold.bot.store.state.trades[0].exitReason, /^AI-trader verkoopt/);
  assert.equal(sold.bot.store.state.trades[0].agent.recipe, 'B');
  assert.equal(sold.bot.fb.find((f) => f.kind === 'agentTrade').recipe, 'B');
  const kept = await run('A');
  assert.ok(kept.bot.store.state.positions['BTC/EUR'], 'recept A wil vasthouden');
});

test('AI-trader: eigen inzet binnen grenzen (paper): nooit boven maxStakeEur of het vrije saldo, nooit onder je inzet', async () => {
  const run = async (balance) => agentBot(greedyAgent(), { risk: { stakeEur: 10, maxStakeEur: 30 }, strategy: { agentSizing: 1 },
    prep: (bot) => { bot.store.state.balanceEur = balance; } });
  const rich = (await run(1000)).bot.store.state.positions['BTC/EUR'];
  assert.ok(rich, 'gekocht');
  assert.ok(rich.costEur >= 10 && rich.costEur <= 30, `inzet ${rich.costEur}`);
  const tight = (await run(12)).bot.store.state.positions['BTC/EUR'];
  assert.ok(tight.costEur >= 10 && tight.costEur <= 12, `inzet ${tight.costEur}`);
  const off = (await agentBot(greedyAgent(), { risk: { stakeEur: 10, maxStakeEur: 30 }, strategy: { agentSizing: 0 } })).bot.store.state.positions['BTC/EUR'];
  assert.equal(off.costEur, 10);
  // Risk Agent: geen plan voor deze marktfase → halve inzet, nooit onder de kleinste order (€ 5).
  const half = (await agentBot(greedyAgent({ regimes: {} }), { risk: { stakeEur: 30 }, strategy: { agentSizing: 0 } })).bot.store.state.positions['BTC/EUR'];
  assert.equal(half.costEur, 15);
  const min = (await agentBot(greedyAgent({ regimes: {} }), { risk: { stakeEur: 8 }, strategy: { agentSizing: 0 } })).bot.store.state.positions['BTC/EUR'];
  assert.equal(min.costEur, 5);
});

test('AI-trader live: kleinste start aan → hooguit € 5; uit → je eigen inzet', async () => {
  const run = async (small) => {
    const ex = fakeBitvavo();
    ex.prices = wavy();
    const { bot } = setup({ ex, risk: { cooldownMinutes: 0 } });
    await bot.setRisk({ cooldownMinutes: 0, stakeEur: 20, exchangeStop: 0 });
    await bot.setStrategy({ agentMode: 1, agentVeto: 0, agentExplore: 0, agentLiveSmallStart: small });
    await goLive(bot, 1000);
    bot.getAgent = () => greedyAgent({ stage: 'bewezen', liveCheck: { allMet: true, checks: [] } });
    bot.settings.setAgentLive('R', true);
    await bot.tick();
    return bot.store.state.positions['BTC/EUR'];
  };
  const small = await run(1);
  assert.ok(small, 'gekocht');
  assert.ok(small.costEur <= sellableStake(small.plan?.stopLossPct) * 1.0025 + 1e-9 && small.costEur >= LIVE_MIN_STAKE_EUR, `kleinste start: ${small.costEur}`);
  const full = await run(0);
  assert.ok(near(full.costEur, 20 * 1.0025), `eigen inzet: ${full.costEur}`);
});

test('AI-trader live op eigen risico: verliesgrens telt gesloten en open verlies sinds het akkoord', async () => {
  const { bot } = setup();
  bot.settings.setAgentLiveRisky('R', 5);
  const since = Date.parse(bot.settings.agentLive.risky.R.at);
  const live = bot.stores.live.state;
  live.trades.push({ pair: 'X/EUR', closedAt: new Date(since - 60000).toISOString(), pnlEur: -100, agent: { recipe: 'R' } }); // van vóór het akkoord
  live.trades.push({ pair: 'X/EUR', closedAt: new Date(since + 1000).toISOString(), pnlEur: -3, agent: { recipe: 'R' } });
  assert.equal(bot.agentRiskyLoss('R').pnlEur, -3);
  assert.equal(bot.agentRiskyLoss('R').trades, 1);
  live.positions['Y/EUR'] = { pair: 'Y/EUR', openedAt: new Date(since + 1000).toISOString(), amount: 1, costEur: 10, agent: { recipe: 'R' } };
  bot.pairStatus['Y/EUR'] = { price: 8 };
  assert.ok(near(bot.agentRiskyLoss('R').pnlEur, -3 + 8 * 0.9975 - 10));
  bot.settings.data.mode = 'live';
  assert.equal(bot.agentRiskyActive({ stage: 'getest', recipeKey: 'R' }), false, 'grens van € 5 bereikt');
});

// =====================================================================
// Handmatige verkoop
// =====================================================================

test('handmatig verkopen: market (ook met limietorders), geen agentTrade-feedback, geen positie → fout', async () => {
  const { bot } = await agentBot(greedyAgent(), { risk: { limitOrders: 1 } });
  assert.ok(bot.store.state.positions['BTC/EUR']);
  const opts = [];
  const sell = bot.brokers.paper.sell.bind(bot.brokers.paper);
  bot.brokers.paper.sell = async (p, a, o) => { opts.push(o); return sell(p, a, o); };
  const trade = await bot.closeManual('BTC/EUR');
  assert.equal(trade.exitReason, 'Handmatig gesloten');
  assert.deepEqual(opts, [{}], 'market order');
  assert.equal(bot.fb.filter((f) => f.kind === 'agentTrade').length, 0, 'handmatig is geen leerdata voor de AI-trader');
  await assert.rejects(bot.closeManual('BTC/EUR'), /Geen open positie/);
  await assert.rejects(bot.closeManual('ETH/EUR'), /Geen open positie voor ETH\/EUR/);
});

// =====================================================================
// Orderboek
// =====================================================================

test('orderboek: spread- en kostendrempels (grens, 0 = uit, te dun, geen boek)', () => {
  const book = { bids: [[99.5, 100]], asks: [[100.5, 0.1], [101.5, 100]] };
  const info = analyzeBook(book, 20);
  assert.ok(near(info.spreadPct, 1));
  assert.equal(bookProblem(info, { maxSpreadPct: 0, maxBookCostPct: 0 }), null, 'alles uit');
  assert.match(bookProblem(info, { maxSpreadPct: 0.9 }), /verschil tussen bied en laat is 1.00% \(max 0.9%\)/);
  assert.equal(bookProblem(info, { maxSpreadPct: 1.01 }), null);
  assert.ok(info.buyCostPct > 0.5, `kosten ${info.buyCostPct}`);
  assert.match(bookProblem(info, { maxBookCostPct: 0.5 }), /boven de middenprijs gevuld/);
  assert.equal(bookProblem(info, { maxBookCostPct: info.buyCostPct + 0.01 }), null);
  const thin = analyzeBook({ bids: [[99, 1]], asks: [[100, 0.01]] }, 50);
  assert.equal(thin.buyCostPct, null);
  assert.match(bookProblem(thin, { maxBookCostPct: 1 }), /niet genoeg aanbod/);
  assert.equal(bookProblem(null, { maxSpreadPct: 0.1, maxBookCostPct: 0.1 }), null, 'geen boek: niet blokkeren (de bot blokkeert live zelf)');
  assert.equal(analyzeBook({ bids: [], asks: [] }, 10), null);
  assert.equal(analyzeBook({ bids: [[101, 1]], asks: [[100, 1]] }, 10), null, 'gekruist boek is ongeldig');
});

test('orderboek bij een koopsignaal: paper zonder boek koopt; live zonder boek niet, live met boek wel', async () => {
  const paper = setup({ risk: { cooldownMinutes: 0 } });
  assert.ok(await crossTicks(paper.bot, paper.ex), 'paper zonder boek');
  const noBook = fakeBitvavo();
  noBook.fetchOrderBook = async () => { throw new Error('timeout'); };
  const a = setup({ ex: noBook, risk: { cooldownMinutes: 0 } });
  await goLive(a.bot);
  a.bot.settings.setAgentLive('R', true);
  assert.equal(await crossTicks(a.bot, noBook), undefined);
  assert.match(a.bot.store.state.decisions[0].reason, /Orderboek niet beschikbaar: in live koop ik niet blind \(timeout\)/);
  assert.equal(noBook.calls.filter((c) => c[0] === 'buy').length, 0);
  const withBook = fakeBitvavo();
  const b = setup({ ex: withBook, risk: { cooldownMinutes: 0 } });
  await goLive(b.bot);
  b.bot.settings.setAgentLive('R', true);
  assert.ok(await crossTicks(b.bot, withBook), 'live met boek');
});

test('orderboek: te grote spread blokkeert ook in paper, vóór de AI', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0 } });
  await bot.setRisk({ maxSpreadPct: 0.5 });
  ex.fetchOrderBook = async () => { const p = ex.prices.at(-1); return { bids: [[p * 0.99, 1e6]], asks: [[p * 1.01, 1e6]] }; };
  withAi(bot, 'approve');
  aiCalls = 0;
  assert.equal(await crossTicks(bot, ex), undefined);
  assert.equal(aiCalls, 0);
  assert.match(bot.store.state.decisions[0].reason, /^Orderboek: verschil tussen bied en laat/);
});

// =====================================================================
// Risicolimieten
// =====================================================================

test('risicoregels (checkEntry): maxOpenTrades, daglimiet, cooldown, budget, noodstop', () => {
  const { bot } = setup();
  const st = bot.stores.paper;
  const risk = { ...bot.risk, stakeEur: 10, maxOpenTrades: 2, maxDailyLossEur: 20, cooldownMinutes: 30, liveBudgetEur: 0 };
  const chk = (r = risk, extra = { pair: 'BTC/EUR' }, store = st, mode = 'paper') => checkEntry(store, { risk: r }, mode, bot.ex, null, extra);
  assert.equal(chk(), null);
  st.state.positions = { 'A/EUR': { costEur: 10 }, 'B/EUR': { costEur: 10, explore: true } };
  assert.equal(chk(), null, 'verkenner telt niet mee');
  st.state.positions['C/EUR'] = { costEur: 10 };
  assert.match(chk(), /Maximum van 2 open trades bereikt/);
  assert.equal(chk(risk, { pair: 'BTC/EUR', explore: true }), null, 'verkenner heeft een eigen plek');
  st.state.positions = {};
  // Daglimiet: precies op de limiet = geblokkeerd; verkennertrades tellen niet.
  st.addTrade({ pair: 'X/EUR', closedAt: new Date().toISOString(), pnlEur: -15 });
  st.addTrade({ pair: 'X/EUR', closedAt: new Date().toISOString(), pnlEur: -50, agent: { explore: true } });
  assert.equal(chk(), null);
  st.addTrade({ pair: 'X/EUR', closedAt: new Date().toISOString(), pnlEur: -5 });
  assert.match(chk(), /Dagverlies -20.00 EUR bereikt limiet/);
  assert.equal(chk({ ...risk, maxDailyLossEur: 0 }), null, '0 = uit');
  st.state.trades = [{ pair: 'X/EUR', closedAt: new Date(Date.now() - 2 * 86400000).toISOString(), pnlEur: -500 }];
  assert.equal(chk(), null, 'verlies van eergisteren telt niet');
  // Cooldown: verlopen = weer kopen.
  st.state.lastExit = { 'BTC/EUR': new Date(Date.now() - 31 * 60000).toISOString() };
  assert.equal(chk(), null);
  st.state.lastExit = { 'BTC/EUR': new Date(Date.now() - 29 * 60000).toISOString() };
  assert.match(chk(), /Afkoelperiode: nog 1 min/);
  st.state.lastExit = {};
  // Noodstop gaat voor alles.
  st.state.halted = { at: new Date().toISOString(), reason: 'Handmatig gepauzeerd', manual: true };
  assert.match(chk(), /Handel gepauzeerd: Handmatig gepauzeerd/);
  st.state.halted = null;
  // Live budget: inzet van open posities + nieuwe inzet.
  const ex = fakeExchange([1], { keys: true });
  const lv = bot.stores.live;
  lv.state.positions = { 'A/EUR': { costEur: 15 } };
  assert.match(checkEntry(lv, { risk: { ...risk, liveBudgetEur: 20 } }, 'live', ex, { eurFree: 1000 }, { pair: 'BTC/EUR' }), /Budgetplafond/);
  assert.equal(checkEntry(lv, { risk: { ...risk, liveBudgetEur: 25 } }, 'live', ex, { eurFree: 1000 }, { pair: 'BTC/EUR' }), null);
});

test('daglimiet: na een verliestrade boven de limiet wordt de handel gepauzeerd; volgende dag weer vrij, handmatige pauze niet', async () => {
  const { bot, ex, pos } = await withPosition({ stopLossPct: 5, takeProfitPct: 0, maxDailyLossEur: 1 });
  ex.fetchTicker = async () => ({ last: pos.entryPrice * 0.9 });
  await bot.watchPositions();
  assert.match(bot.store.state.halted.reason, /^Dagverlies -/);
  bot.store.state.halted.at = new Date(Date.now() - 2 * 86400000).toISOString();
  delete ex.fetchTicker;
  await bot.tick();
  assert.equal(bot.store.state.halted, null, 'nieuwe dag');
  bot.store.state.halted = { at: new Date(Date.now() - 2 * 86400000).toISOString(), reason: 'Handmatig gepauzeerd', manual: true };
  await bot.tick();
  assert.ok(bot.store.state.halted, 'handmatige pauze blijft');
});

test('maxStakeEur begrenst de meegroeiende inzet; nooit onder je eigen inzet', async () => {
  const { bot } = setup();
  await bot.setRisk({ stakeEur: 20, maxOpenTrades: 1, reinvestPct: 100, maxStakeEur: 30 });
  bot.store.addTrade({ pair: 'X/EUR', pnlEur: 100, closedAt: new Date().toISOString() });
  assert.deepEqual([bot.stakeInfo().effective, bot.stakeInfo().capped], [30, true]);
  await bot.setRisk({ maxStakeEur: 10 });
  assert.equal(bot.stakeInfo().effective, 20, 'maximum onder je inzet: je inzet');
  bot.store.addTrade({ pair: 'X/EUR', pnlEur: -500, closedAt: new Date().toISOString() });
  await bot.setRisk({ maxStakeEur: 0 });
  assert.equal(bot.stakeInfo().effective, 20, 'verlies haalt niets van je eigen inzet af');
});

test('maxOpenTrades: met twee coins en maximum 1 wordt er maar één gekocht', async () => {
  const { bot, ex } = setup({ risk: { cooldownMinutes: 0, maxOpenTrades: 1 } });
  bot.settings.data.pairs = ['BTC/EUR', 'ETH/EUR'];
  await crossTicks(bot, ex);
  assert.equal(Object.keys(bot.store.state.positions).length, 1);
});

// =====================================================================
// Paper/live wisselen
// =====================================================================

test('modus: standaard paper, een check zet nooit vanzelf live, live → paper alleen zonder open posities', async () => {
  const ex = fakeBitvavo();
  const { bot, dir } = setup({ ex, risk: { cooldownMinutes: 0 } });
  assert.equal(bot.mode, 'paper');
  await crossTicks(bot, ex);
  await bot.tick();
  assert.equal(bot.mode, 'paper', 'ticks veranderen de modus niet');
  assert.equal(ex.calls.length, 0, 'in paper geen enkele order bij Bitvavo');
  await bot.closeManual('BTC/EUR');
  await goLive(bot);
  bot.settings.setAgentLive('R', true);
  ex.prices = [...ex.prices, ex.prices.at(-1)]; // nieuwe candle: de AI-trader beoordeelt opnieuw
  await openPosition(bot, ex);
  await assert.rejects(bot.switchMode('paper'), /nog 1 positie\(s\) open in live/);
  assert.equal(bot.mode, 'live');
  await assert.rejects(bot.switchMode('demo'), /Ongeldige modus/);
  await bot.switchMode('live'); // dezelfde modus: niets
  assert.equal(new Settings(dir, { liveTrading: false, ai: {} }).mode, 'live', 'modus bewaard');
  await bot.closeManual('BTC/EUR');
  await bot.switchMode('paper');
  assert.equal(bot.mode, 'paper');
  assert.ok(bot.settings.data.modeChangedAt);
});

// =====================================================================
// Configuratie en instellingen
// =====================================================================

test('config uit de omgeving: veilige standaarden (paper, AI uit, fail-mode reject, geldig)', () => {
  if (process.env.LIVE_TRADING) return; // alleen zinvol zonder eigen omgeving
  assert.equal(envConfig.liveTrading, false);
  assert.equal(envConfig.ai.provider, process.env.AI_PROVIDER || 'none');
  assert.equal(envConfig.ai.failMode, process.env.AI_FAIL_MODE || 'reject');
  assert.deepEqual(validateConfig(), []);
  if (!process.env.STAKE_EUR) assert.equal(envConfig.risk.stakeEur, 25);
  if (!process.env.EXCHANGE_STOP) assert.equal(envConfig.risk.exchangeStop, 1);
  assert.equal(envConfig.paper.startBalanceEur, Number(process.env.PAPER_START_BALANCE_EUR || 500));
});

test('settings: standaardwaarden zonder bestand (paper, alles uit behalve de veiligheidsinstellingen)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-set-'));
  const s = new Settings(dir, { ai: { provider: 'none' } });
  assert.equal(s.mode, 'paper');
  assert.equal(s.ai.failMode, 'reject');
  assert.equal('mode' in s.ai, false, 'geen AI-werkwijze meer (het AI-team is weg)');
  assert.deepEqual(Object.keys(s.risk).sort(), Object.keys(RISK_LIMITS).sort());
  assert.deepEqual(Object.keys(s.strategy).sort(), Object.keys(STRATEGY_LIMITS).sort());
  // Behalve de stop bij Bitvavo en de uitschieter (eigen standaardwaarden) staat alles op 0.
  for (const [k, v] of Object.entries(s.risk)) assert.equal(v, k === 'exchangeStop' || k === 'agentOwnStop' ? 1 : PUMP_DEFAULTS[k] ?? 0, k);
  const on = ['agentLiveSmallStart', 'agentSizing', 'agentVolGuard'];
  for (const [k, v] of Object.entries(s.strategy)) assert.equal(v, ({ agentLossStreak: 3, agentPauseHours: 6 })[k] ?? (on.includes(k) ? 1 : 0), k);
  assert.deepEqual(s.agentLive.approved, []);
  assert.deepEqual(s.agentLive.risky, {});
  assert.equal(s.follow.enabled, false);
  assert.equal(s.notify.summaryTime, '08:00');
  // Met de echte config als standaard: ook paper.
  if (!process.env.LIVE_TRADING) assert.equal(new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-set-')), envConfig).mode, 'paper');
});

test('settings: validatiegrenzen voor elke risico- en strategie-instelling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-set-'));
  const s = new Settings(dir, { ai: { provider: 'none' }, strategy: {}, risk: { stakeEur: 25, maxOpenTrades: 2 } });
  for (const [k, [min, max]] of Object.entries(RISK_LIMITS)) {
    assert.throws(() => s.setRisk({ [k]: min - 1 }), /moet tussen/, `${k} onder min`);
    assert.throws(() => s.setRisk({ [k]: max + 1 }), /moet tussen/, `${k} boven max`);
    assert.throws(() => s.setRisk({ [k]: 'abc' }), /moet tussen/, `${k} geen getal`);
  }
  for (const [k, [min, max]] of Object.entries(STRATEGY_LIMITS)) {
    assert.throws(() => s.setStrategy({ [k]: min - 1 }), /moet tussen/, `${k} onder min`);
    assert.throws(() => s.setStrategy({ [k]: max + 1 }), /moet tussen/, `${k} boven max`);
  }
  // Grenzen zelf mogen, gehele getallen worden afgerond.
  s.setRisk({ stakeEur: 0.1, maxOpenTrades: 2.6 });
  assert.equal(s.risk.stakeEur, 0.1);
  assert.equal(s.risk.maxOpenTrades, 3);
  assert.throws(() => s.setMode('demo'), /Ongeldige modus/);
  assert.throws(() => s.setSchedule({ timeframe: '3m', checkIntervalMinutes: 5 }), /candle-tijd/);
  assert.throws(() => s.setAi({ provider: 'claude' }), /Onbekende AI-provider/);
  assert.throws(() => s.setAi({ provider: 'openai', baseUrl: 'ftp://x' }), /http/);
  assert.throws(() => s.setAgentLiveRisky('R', 0.5), /Verliesgrens/);
  assert.throws(() => s.setPairs(['BTC/EUR'], new Set()), /Onbekend op Bitvavo/);
  // Een mislukte validatie verandert niets.
  assert.equal(s.risk.stakeEur, 0.1);
});

test('settings: onbekende sleutels worden genegeerd (bij opslaan en bij laden)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-set-'));
  const s = new Settings(dir, { ai: { provider: 'none' }, risk: { stakeEur: 25, maxOpenTrades: 2 }, strategy: {} });
  s.setRisk({ stakeEur: 30, hackerMode: 1, __proto__x: 2 });
  assert.equal(s.risk.stakeEur, 30);
  assert.equal('hackerMode' in s.risk, false);
  s.setStrategy({ agentMode: 1, emaFast: 5, onzin: 3 });
  assert.equal('onzin' in s.strategy, false);
  assert.equal('emaFast' in s.strategy, false, 'velden van de vroegere klassieke strategie worden niet bewaard');
  const file = path.join(dir, 'settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.risk.extraKey = 7;
  raw.strategy.nogEen = 1;
  // Oud settings.json van vóór het verwijderen van de klassieke strategie en het AI-team.
  Object.assign(raw.strategy, { emaFast: 12, emaSlow: 26, rsiPeriod: 14, rsiMaxEntry: 70, btcFilter: 1, aiStrictness: 0, mlMinProb: 55 });
  raw.ai.mode = 'team';
  raw.onbekend = { a: 1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  const again = new Settings(dir, { ai: { provider: 'none' } });
  assert.equal('extraKey' in again.risk, false);
  assert.equal('nogEen' in again.strategy, false);
  assert.equal('emaFast' in again.strategy, false);
  assert.equal('aiStrictness' in again.strategy, false);
  assert.equal(again.strategy.agentMode, 1, 'de rest blijft');
  assert.equal('mode' in again.ai, false, 'oude AI-werkwijze (team) valt weg');
  assert.equal('onbekend' in again.data, false);
  assert.equal(again.risk.stakeEur, 30);
});

test('bot: live minimum inzet van € 5 bij instellen en bij wisselen', async () => {
  const { bot } = setup({ keys: true });
  await bot.setRisk({ stakeEur: 4.99 });
  await assert.rejects(bot.switchMode('live'), /minimaal € 5/);
  await bot.setRisk({ stakeEur: 5 });
  await bot.switchMode('live');
  await assert.rejects(bot.setRisk({ stakeEur: 4.99 }), /minimaal € 5/);
  assert.equal(bot.risk.stakeEur, 5);
});

test('AI-trader live: "kleiner kopen" uit → Risk Agent halveert niet bij weinig bewijs; aan → wel', async () => {
  const run = async (small) => {
    const ex = fakeBitvavo();
    ex.prices = wavy();
    const { bot } = setup({ ex, risk: { cooldownMinutes: 0 } });
    await bot.setRisk({ cooldownMinutes: 0, stakeEur: 20, exchangeStop: 0 });
    await bot.setStrategy({ agentMode: 1, agentVeto: 0, agentExplore: 0, agentLiveSmallStart: small, agentSizing: 0 });
    await goLive(bot, 1000);
    // Geen plan per marktfase: de Risk Agent ziet "weinig bewijs" en wil de inzet halveren.
    bot.getAgent = () => greedyAgent({ stage: 'bewezen', liveCheck: { allMet: true, checks: [] }, regimes: {} });
    bot.settings.setAgentLiveRisky('R', 50);
    await bot.tick();
    return bot.store.state.positions['BTC/EUR'];
  };
  const off = await run(0);
  assert.ok(off, 'gekocht');
  assert.ok(near(off.costEur, 20 * 1.0025), `uit: eigen inzet, niet gehalveerd: ${off.costEur}`);
  const on = await run(1);
  assert.ok(on.costEur < 15, `aan: gehalveerd: ${on.costEur}`);
});
