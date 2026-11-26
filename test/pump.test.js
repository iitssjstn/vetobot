import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ccxt from 'ccxt';
import { Bot } from '../src/bot.js';
import { PaperBroker, LiveBroker, orderTiming } from '../src/exchange.js';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';
import { config as envConfig } from '../src/config.js';
import { SAFETY, PUMP, PUMP_DEFAULTS, pumpRawLevel, pumpLevel, exchangeStopPrice } from '../src/safety.js';

// Uitschieter: meeschuivende winstgrens voor posities van de AI-trader, en (live) de stop bij Bitvavo
// die mee omhoog schuift. Nep-Bitvavo zoals in live-safety.test.js; geen echte orders, geen netwerk.
orderTiming.sleep = async () => {};
orderTiming.pollMs = 0;

const H = 3600000;
const quiet = { info() {}, warn() {}, error() {} };
const agentPrices = () => [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
const agentFx = () => JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
// Een AI-trader die altijd wil kopen en zelf nooit verkoopt, live toegestaan (recept R), met een
// noodstop van 5% (de stop-loss van zijn positie).
function greedyAgent() {
  const fx = agentFx();
  return { ...fx.agent, stage: 'bewezen', recipeKey: 'R', liveCheck: { allMet: true, checks: [] }, safetyStopPct: 5,
    entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 }, exit: { ...fx.agent.exit, init: fx.agent.exit.init + 50 },
    regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } } };
}
const market = (base) => ({ symbol: `${base}/EUR`, base, quote: 'EUR', spot: true, active: true, precision: { amount: 1e-8, price: 1e-5 }, limits: { amount: { min: 0.0001 } } });

// Nep-Bitvavo met een saldo dat meebeweegt, die (zoals Bitvavo) coins reserveert voor open
// stop-orders en een verkoop boven het vrije saldo weigert.
function fakeBitvavo() {
  const orders = {};
  const calls = [];
  let n = 0;
  const ex = {
    apiKey: 'k', secret: 's', has: {}, precisionMode: 4, calls, orders,
    prices: agentPrices(),
    holdings: { EUR: 1000 },
    markets: { 'BTC/EUR': market('BTC'), 'ETH/EUR': market('ETH') },
    failStop: null,
    loseStopReply: false,
    loseBuyReply: false,
    failBalance: null,
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    amountToPrecision: (_p, v) => String(Math.floor(v * 1e8) / 1e8),
    priceToPrecision: (_p, v) => String(+Number(v).toPrecision(6)),
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { return { last: this.prices.at(-1) }; },
    async fetchTickers(pairs) { return Object.fromEntries(pairs.map((p) => [p, { last: this.prices.at(-1) }])); },
    async fetchOrderBook() {
      const p = this.prices.at(-1);
      return { bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] };
    },
    reserved(base) {
      return Object.values(orders).filter((o) => o.status === 'open' && o.pair?.startsWith(`${base}/`)).reduce((a, o) => a + o.amount - o.filled, 0);
    },
    async fetchBalance() {
      if (this.failBalance) throw new ccxt.NetworkError(this.failBalance);
      const total = { ...this.holdings };
      return { total, ...Object.fromEntries(Object.entries(total).map(([c, v]) => [c, { free: v - this.reserved(c), used: this.reserved(c), total: v }])) };
    },
    async createOrder(pair, type, side, amount, price, params = {}) {
      calls.push({ op: 'create', pair, type, side, amount, price, params });
      if (type === 'stopLoss' && this.failStop) throw new Error(this.failStop);
      const base = pair.split('/')[0];
      const id = `o${++n}`;
      if (type === 'market') {
        if (side === 'sell' && amount > (this.holdings[base] ?? 0) - this.reserved(base) + 1e-12) throw new ccxt.InsufficientFunds('bitvavo {"errorCode":216,"error":"You do not have sufficient balance to complete this operation."}');
        const p = this.prices.at(-1);
        orders[id] = { id, pair, type, side, status: 'closed', amount, filled: amount, average: p, cost: amount * p, fee: { currency: 'EUR', cost: amount * p * 0.0025 } };
        this.holdings[base] = (this.holdings[base] ?? 0) + (side === 'buy' ? amount : -amount);
        this.holdings.EUR += side === 'buy' ? -amount * p : amount * p;
        if (side === 'buy' && this.loseBuyReply) throw new ccxt.RequestTimeout('bitvavo POST https://api.bitvavo.com/v2/order request timed out');
      } else {
        if (side === 'sell' && amount > (this.holdings[base] ?? 0) - this.reserved(base) + 1e-12) throw new ccxt.InsufficientFunds('bitvavo {"errorCode":216}');
        orders[id] = { id, pair, type, side, status: 'open', amount, filled: 0, triggerPrice: params.triggerPrice };
        // De order staat bij Bitvavo, maar het antwoord komt niet aan.
        if (type === 'stopLoss' && this.loseStopReply) throw new ccxt.RequestTimeout('bitvavo POST https://api.bitvavo.com/v2/order request timed out');
      }
      return { ...orders[id] };
    },
    async createMarketOrder(pair, side, amount) { return this.createOrder(pair, 'market', side, amount); },
    async fetchOrder(id) {
      if (!orders[id]) throw new ccxt.OrderNotFound('No order found');
      return { ...orders[id] };
    },
    async fetchOpenOrders(pair) {
      return Object.values(orders).filter((o) => o.status === 'open' && (!pair || o.pair === pair)).map((o) => ({ ...o, symbol: o.pair }));
    },
    async cancelOrder(id, pair, params) {
      calls.push({ op: 'cancel', id, pair, params });
      const o = orders[id];
      if (!o || o.status !== 'open') throw new ccxt.OrderNotFound('No order found');
      o.status = 'canceled';
      return { id };
    },
    // Bitvavo voert de stop-order maar deels uit en annuleert de rest (marktbescherming bij een flash crash).
    partial(id, share) {
      const o = orders[id];
      const filled = Math.floor(o.amount * share * 1e8) / 1e8;
      const p = o.triggerPrice * 0.99;
      Object.assign(o, { status: 'canceled', filled, cost: filled * p, fee: { currency: 'EUR', cost: filled * p * 0.0025 } });
      const base = o.pair.split('/')[0];
      this.holdings[base] -= filled;
      this.holdings.EUR += filled * p;
    },
  };
  return ex;
}

function setupLive({ mode = 'live', risk = {}, pairs = ['BTC/EUR'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-pump-'));
  const ex = fakeBitvavo();
  const baseRisk = { stakeEur: 25, maxOpenTrades: 3, stopLossPct: 5, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25, cooldownMinutes: 0, aiExitMinPct: 0, ...risk };
  const strategy = { agentMode: 1, agentVeto: 0, agentExplore: 0, agentLiveSmallStart: 0 };
  const config = { timeframe: '1h', strategy, risk: baseRisk, ai: { provider: 'none', failMode: 'reject' } };
  const settings = new Settings(dir, { liveTrading: mode === 'live', pairs, timeframe: '1h', checkIntervalMinutes: 15, risk: baseRisk, strategy, ai: { provider: 'none', model: '', baseUrl: '' } });
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const bot = new Bot({ config, exchange: ex, settings, stores, log: quiet, brokers: { paper: new PaperBroker(ex, 0.25), live: new LiveBroker(ex) } });
  bot.getAgent = () => greedyAgent();
  settings.setAgentLive('R', true);
  const sent = [];
  bot.notifier = { send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  return { bot, ex, sent, dir };
}

// Checks met elk een nieuwe candle, tot until() (hooguit vier): de AI-trader wil bij elke candle kopen.
async function buyTicks(bot, ex, until = () => false) {
  for (let n = 0; n < 4 && !until(); n++) {
    if (n) ex.prices = [...ex.prices, ex.prices.at(-1)];
    await bot.tick();
  }
}

const stopCalls = (ex) => ex.calls.filter((c) => c.op === 'create' && c.type === 'stopLoss');
const marketCalls = (ex, side) => ex.calls.filter((c) => c.op === 'create' && c.type === 'market' && c.side === side);
const near = (a, b, rel = 1e-4) => Math.abs(a - b) <= Math.abs(b) * rel;
// De koers nu (fetchTicker en de laatste candle).
const setPrice = (ex, p) => { ex.prices[ex.prices.length - 1] = p; };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// Een AI-trader die bij elke candle wil verkopen (verwacht van vasthouden sterk negatief).
function sellerAgent() {
  const a = greedyAgent();
  return { ...a, minHoldCandles: 1, exitMarginPct: 0, exit: { ...a.exit, init: a.exit.init - 100 } };
}

async function opened({ mode = 'live', risk = {} } = {}) {
  const s = setupLive({ mode, risk });
  await buyTicks(s.bot, s.ex, () => s.bot.store.state.positions['BTC/EUR']);
  const pos = s.bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, 'gekocht');
  assert.ok(pos.agent && pos.plan, 'positie van de AI-trader');
  return { ...s, pos, entry: pos.entryPrice };
}

test('Uitschieter: niveau = min(instap × (1 + 0,7 × topwinst), top × 0,99)', () => {
  const r = PUMP_DEFAULTS;
  assert.ok(near(pumpRawLevel(100, 110, r), 107), 'top +10% → +7%');
  assert.ok(near(pumpRawLevel(100, 103, r), 101.97), 'top +3% → ± +1,97% (1% onder de top)');
  assert.ok(near(pumpRawLevel(100, 120, { pumpGivebackPct: 50, pumpMinGapPct: 1 }), 110));
  assert.ok(near(pumpRawLevel(100, 105, { pumpGivebackPct: 30, pumpMinGapPct: 2 }), 102.9), 'ruimte 2% → 105 × 0,98');
  const pos = { agent: {}, entryPrice: 100, highest: 102.9 };
  assert.equal(pumpLevel(pos, r), null, 'onder 3% nog niet aan');
  assert.ok(pumpLevel({ ...pos, highest: 103.01 }, r) > 101.9, 'vanaf 3% aan');
  assert.equal(pumpLevel({ ...pos, highest: 110 }, { ...r, pumpTriggerPct: 0 }), null, '0 = uit');
  assert.equal(pumpLevel({ ...pos, agent: undefined, highest: 110 }, r), null, 'alleen de AI-trader');
  assert.equal(pumpLevel({ ...pos, explore: true, highest: 110 }, r), null, 'niet de verkenner');
  // Nooit omlaag: een eerder hoger niveau blijft.
  assert.equal(pumpLevel({ ...pos, highest: 104, pump: { level: 106 } }, r), 106);
  // Stop bij Bitvavo: het hoogste van noodstop en winstgrens.
  const p2 = { agent: {}, plan: { stopLossPct: 5 }, entryPrice: 100, highest: 100 };
  assert.ok(near(exchangeStopPrice(p2, r), 95));
  assert.ok(near(exchangeStopPrice({ ...p2, highest: 110 }, r), 107));
});

test('Uitschieter paper: aan vanaf 3% (niet eronder), verkoopt op de winstgrens via de snelle bewaking', async () => {
  const { bot, ex, pos, entry } = await opened({ mode: 'paper' });
  setPrice(ex, entry * 1.029);
  assert.equal(await bot.watchPositions(), 0);
  assert.equal(pos.pump, undefined, 'onder 3%: geen winstgrens');
  setPrice(ex, entry * 1.0301);
  assert.equal(await bot.watchPositions(), 0);
  assert.ok(pos.pump?.since, 'vanaf 3%: winstgrens aan');
  assert.ok(bot.activity.some((e) => /Uitschieter: .*winstgrens staat aan/.test(e.message)), 'logregel bij aangaan');
  setPrice(ex, entry * 1.10);
  assert.equal(await bot.watchPositions(), 0);
  assert.ok(near(pos.pump.level, entry * 1.07), `niveau schuift mee: ${pos.pump.level / entry}`);
  setPrice(ex, entry * 1.08);
  assert.equal(await bot.watchPositions(), 0, 'boven de grens: blijft open');
  assert.ok(near(pos.pump.level, entry * 1.07), 'gaat niet omlaag');
  setPrice(ex, entry * 1.069);
  assert.equal(await bot.watchPositions(), 1, 'op/onder de grens: verkocht');
  const t = bot.store.state.trades[0];
  assert.match(t.exitReason, /^Winst vastgezet bij uitschieter \(top \+10,00%, nu \+6,90%\)/);
  assert.ok(t.pnlEur > 0);
  assert.equal(bot.activity.filter((e) => /winstgrens staat aan/.test(e.message)).length, 1, 'niet bij elke tik gelogd');
});

test('Uitschieter: het model verkoopt niet zelf zolang de winstgrens aan staat, daarbuiten wel; max. duur blijft', async () => {
  // Zonder uitschieter: het model verkoopt bij de nieuwe candle.
  {
    const { bot, ex, pos } = await opened({ mode: 'paper' });
    pos.openedAt = ago(3 * H);
    bot.getAgent = () => sellerAgent();
    ex.prices = [...ex.prices, ex.prices.at(-1)];
    await bot.tick();
    assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
    assert.match(bot.store.state.trades[0].exitReason, /^AI-trader verkoopt/);
  }
  // Met uitschieter: niet.
  const { bot, ex, pos, entry } = await opened({ mode: 'paper' });
  pos.openedAt = ago(3 * H);
  bot.getAgent = () => sellerAgent();
  setPrice(ex, entry * 1.05);
  await bot.watchPositions();
  assert.ok(pos.pump);
  ex.prices = [...ex.prices, entry * 1.05];
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'model verkocht niet tijdens de uitschieter');
  assert.match(bot.agentHold?.['BTC/EUR'] ?? '', /Uitschieter/);
  // De maximale duur blijft werken.
  pos.openedAt = ago(200 * H);
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Tijdslimiet/);
});

test('Uitschieter: de noodstop blijft werken (koers valt in één keer ver)', async () => {
  const { bot, ex, pos, entry } = await opened({ mode: 'paper', risk: { pumpMinGapPct: 10, pumpGivebackPct: 90 } });
  setPrice(ex, entry * 1.04);
  await bot.watchPositions();
  assert.ok(pos.pump);
  setPrice(ex, entry * 0.9);
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Stop-loss/);
});

test('Uitschieter uit (pumpTriggerPct 0) → gedrag zoals voorheen: geen winstgrens, model beslist, stop blijft op de noodstop', async () => {
  const { bot, ex, pos, entry } = await opened({ risk: { pumpTriggerPct: 0 } });
  const stops = stopCalls(ex).length;
  setPrice(ex, entry * 1.10);
  assert.equal(await bot.watchPositions(), 0);
  setPrice(ex, entry * 1.02);
  assert.equal(await bot.watchPositions(), 0, 'geen winstgrens');
  assert.equal(pos.pump, undefined);
  assert.equal(stopCalls(ex).length, stops, 'stop bij Bitvavo niet verplaatst');
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 0.95, 1e-3));
  pos.openedAt = ago(3 * H);
  bot.getAgent = () => sellerAgent();
  ex.prices = [...ex.prices, entry * 1.02];
  await bot.tick();
  assert.match(bot.store.state.trades[0]?.exitReason ?? '', /^AI-trader verkoopt/, 'model verkoopt zoals voorheen');
});

test('Uitschieter live: stop bij Bitvavo schuift mee omhoog (≥ 0,3%, hooguit eens per 60 s, nooit omlaag); verkoop op het niveau met een market order', async () => {
  // limitOrders 2 = winst nemen met een limietorder; de winstgrens moet toch market zijn.
  const { bot, ex, pos, entry } = await opened({ risk: { limitOrders: 2 } });
  const first = pos.exchangeStop.orderId;
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 0.95, 1e-3), 'eerst de noodstop');
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 0);
  assert.equal(ex.orders[first].status, 'canceled', 'oude stop veilig geannuleerd');
  assert.equal(stopCalls(ex).length, 2);
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 1.035, 1e-3), `stop op de winstgrens: ${pos.exchangeStop.stopPrice / entry}`);
  assert.notEqual(pos.exchangeStop.orderId, first);
  assert.ok(Math.abs(ex.reserved('BTC') - pos.amount) < 1e-9, 'precies één open stop');
  assert.ok(bot.activity.some((e) => /stop bij Bitvavo omhoog geschoven/.test(e.message)));
  const row = bot.safetyStatus().exchangeStop.positions[0];
  assert.equal(row.status, 'actief');
  assert.ok(row.pump?.level > entry, 'winstgrens zichtbaar voor het dashboard');
  assert.equal(bot.safetyStatus().buyBlock.blocked, false);
  // Binnen 60 s: niet opnieuw, ook al ligt het niveau hoger.
  setPrice(ex, entry * 1.06);
  await bot.watchPositions();
  assert.equal(stopCalls(ex).length, 2, 'hooguit eens per 60 s');
  // Na 60 s wel.
  pos.pump.stopAt = ago(PUMP.stopEveryMs + 1000);
  await bot.watchPositions();
  assert.equal(stopCalls(ex).length, 3);
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 1.042, 1e-3));
  // Minder dan 0,3% hoger: niet verplaatsen.
  pos.pump.stopAt = ago(PUMP.stopEveryMs + 1000);
  setPrice(ex, entry * 1.0625);
  await bot.watchPositions();
  assert.equal(stopCalls(ex).length, 3, 'drempel 0,3%');
  // Koers daalt (boven de grens): nooit omlaag.
  setPrice(ex, entry * 1.045);
  await bot.watchPositions();
  assert.equal(stopCalls(ex).length, 3);
  assert.ok(pos.exchangeStop.stopPrice >= entry * 1.0419);
  // Onder de grens: de bot verkoopt zelf, market, na het annuleren van de stop.
  const stopId = pos.exchangeStop.orderId;
  setPrice(ex, entry * 1.0435);
  assert.equal(await bot.watchPositions(), 1);
  assert.equal(ex.orders[stopId].status, 'canceled');
  assert.equal(marketCalls(ex, 'sell').length, 1);
  assert.equal(ex.calls.filter((c) => c.op === 'create' && c.type === 'limit').length, 0, 'geen limietorder');
  assert.match(bot.store.state.trades[0].exitReason, /^Winst vastgezet bij uitschieter/);
  assert.ok(Math.abs(ex.holdings.BTC ?? 0) < 1e-9);
});

test('Uitschieter live: stop intussen volledig uitgevoerd tijdens het vervangen → afsluiten met die uitvoering, niet dubbel verkopen', async () => {
  const { bot, ex, pos, entry } = await opened();
  const id = pos.exchangeStop.orderId;
  const amount = pos.amount;
  // Bitvavo voert de stop uit vlak voordat de bot hem annuleert.
  const cancel = ex.cancelOrder;
  ex.cancelOrder = async (oid, pair, params) => {
    ex.calls.push({ op: 'cancel', id: oid, pair, params });
    const o = ex.orders[oid];
    const p = o.triggerPrice;
    Object.assign(o, { status: 'closed', filled: o.amount, average: p, cost: o.amount * p, fee: { currency: 'EUR', cost: o.amount * p * 0.0025 } });
    ex.holdings.BTC -= o.amount;
    ex.holdings.EUR += o.amount * p;
    throw new ccxt.OrderNotFound('No order found');
  };
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 1);
  ex.cancelOrder = cancel;
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.equal(marketCalls(ex, 'sell').length, 0, 'niet nog eens verkocht');
  assert.equal(stopCalls(ex).length, 1, 'geen nieuwe stop gezet');
  const t = bot.store.state.trades[0];
  assert.equal(t.exitReason, 'Stop-loss bij Bitvavo');
  assert.ok(Math.abs(t.amount - amount) < 1e-9);
  assert.ok(near(t.exitPrice, ex.orders[id].triggerPrice));
});

test('Uitschieter live: stop deels uitgevoerd tijdens het vervangen → rest krijgt de nieuwe stop, trade telt beide delen', async () => {
  const { bot, ex, pos, entry } = await opened();
  const id = pos.exchangeStop.orderId;
  const amount = pos.amount;
  ex.partial(id, 0.4);
  const byStop = ex.orders[id].filled;
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 0);
  const p = bot.store.state.positions['BTC/EUR'];
  assert.ok(p, 'de rest blijft open');
  assert.ok(Math.abs(p.amount - (amount - byStop)) < 1e-9);
  assert.equal(stopCalls(ex).length, 2);
  assert.ok(near(p.exchangeStop.stopPrice, entry * 1.035, 1e-3));
  assert.ok(Math.abs(p.exchangeStop.amount - p.amount) < 1e-8, 'nieuwe stop voor de rest');
  assert.equal(marketCalls(ex, 'sell').length, 0);
  setPrice(ex, entry * 1.03);
  assert.equal(await bot.watchPositions(), 1);
  const sells = marketCalls(ex, 'sell');
  assert.equal(sells.length, 1);
  assert.ok(Math.abs(sells[0].amount - (amount - byStop)) < 1e-8, 'alleen de rest verkocht');
  const t = bot.store.state.trades[0];
  assert.ok(Math.abs(t.amount - amount) < 1e-9, 'trade over de hele positie');
  assert.match(t.exitReason, /^Winst vastgezet/);
});

test('Uitschieter live: nieuwe stop zetten mislukt → bot bewaakt zelf, na 60 s opnieuw; annuleren mislukt → oude stop blijft', async () => {
  const { bot, ex, pos, entry } = await opened();
  ex.failStop = 'bitvavo {"errorCode":203}';
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 0);
  assert.equal(pos.exchangeStop.orderId, null);
  assert.match(pos.exchangeStop.error, /203/);
  assert.equal(ex.reserved('BTC'), 0, 'geen stop meer bij Bitvavo');
  assert.ok(bot.buyBlockReasons().some((r) => /BTC\/EUR/.test(r)), 'echt zonder stop: zichtbaar');
  // De bot bewaakt de winstgrens zelf.
  ex.failStop = null;
  await bot.watchPositions();
  assert.equal(pos.exchangeStop.orderId, null, 'niet meteen opnieuw (hooguit eens per 60 s)');
  pos.pump.stopAt = ago(PUMP.stopEveryMs + 1000);
  await bot.watchPositions();
  assert.ok(pos.exchangeStop.orderId, 'opnieuw gezet');
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 1.035, 1e-3));
  assert.ok(Math.abs(ex.reserved('BTC') - pos.amount) < 1e-9);
  assert.equal(bot.buyBlockReasons().length, 0);
  // Annuleren lukt niet (stand onbekend): de oude stop blijft staan, niets dubbel.
  const keep = pos.exchangeStop.orderId;
  const stops = stopCalls(ex).length;
  const { cancelOrder, fetchOrder } = ex;
  ex.cancelOrder = async () => { throw new ccxt.NetworkError('timeout'); };
  ex.fetchOrder = async () => { throw new ccxt.NetworkError('timeout'); };
  pos.pump.stopAt = ago(PUMP.stopEveryMs + 1000);
  setPrice(ex, entry * 1.08);
  assert.equal(await bot.watchPositions(), 0);
  Object.assign(ex, { cancelOrder, fetchOrder });
  assert.equal(pos.exchangeStop.orderId, keep, 'oude stop blijft de positie beschermen');
  assert.equal(stopCalls(ex).length, stops, 'geen tweede stop');
  assert.ok(bot.store.state.positions['BTC/EUR']);
  // Valt de koers onder de grens, dan verkoopt de bot zelf.
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 1);
  assert.match(bot.store.state.trades[0].exitReason, /^Winst vastgezet/);
});

test('Uitschieter live: stop weg (bijv. na een herstart) → de nieuwe stop komt meteen op de winstgrens, niet op de noodstop', async () => {
  const { bot, ex, pos, entry } = await opened();
  setPrice(ex, entry * 1.05);
  await bot.watchPositions();
  await ex.cancelOrder(pos.exchangeStop.orderId, 'BTC/EUR');
  pos.exchangeStop = { orderId: null, stopPrice: entry * 0.95, attemptAt: ago(11 * 60000) };
  ex.prices = [...ex.prices, entry * 1.05];
  await bot.tick();
  assert.ok(pos.exchangeStop.orderId);
  assert.ok(near(pos.exchangeStop.stopPrice, entry * 1.035, 1e-3), `${pos.exchangeStop.stopPrice / entry}`);
});

test('Uitschieter: oude settings.json zonder deze velden → standaardwaarden; opslaan en grenzen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-pump-set-'));
  // Een oud bestand: alle risico-instellingen van vóór de uitschieter.
  const { pumpTriggerPct, pumpGivebackPct, pumpMinGapPct, ...old } = envConfig.risk;
  assert.ok(pumpTriggerPct != null && pumpGivebackPct != null && pumpMinGapPct != null, 'config kent de velden');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'paper', risk: { ...old, stakeEur: 10 } }));
  const s = new Settings(dir, { ai: { provider: 'none' }, risk: {} });
  assert.equal(s.risk.pumpTriggerPct, 3);
  assert.equal(s.risk.pumpGivebackPct, 30);
  assert.equal(s.risk.pumpMinGapPct, 1);
  assert.equal(s.risk.stakeEur, 10);
  s.setRisk({ stakeEur: 12 });
  s.setRisk({ pumpTriggerPct: 0, pumpGivebackPct: 50, pumpMinGapPct: 0.5 });
  const again = new Settings(dir, { ai: { provider: 'none' }, risk: {} });
  assert.deepEqual([again.risk.pumpTriggerPct, again.risk.pumpGivebackPct, again.risk.pumpMinGapPct, again.risk.stakeEur], [0, 50, 0.5, 12]);
  assert.throws(() => s.setRisk({ pumpTriggerPct: 51 }), /tussen 0 en 50/);
  assert.throws(() => s.setRisk({ pumpGivebackPct: 4 }), /tussen 5 en 90/);
  assert.throws(() => s.setRisk({ pumpMinGapPct: 0.1 }), /tussen 0.2 en 10/);
});
