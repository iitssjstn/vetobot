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
import { SAFETY } from '../src/safety.js';

// Audit live-veiligheid: stop-orders bij Bitvavo in randgevallen en het blokkeren van nieuwe
// aankopen zolang de stand bij Bitvavo niet betrouwbaar is. Alleen nep-Bitvavo, geen netwerk.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-live-safety-'));
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

test('A5: stop-order deels uitgevoerd en de rest geannuleerd → hoeveelheid bijgewerkt, alleen de rest verkopen, winst over beide delen', async () => {
  const { bot, ex } = setupLive();
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos?.exchangeStop?.orderId);
  const amount = pos.amount;
  const id = pos.exchangeStop.orderId;
  ex.partial(id, 0.4);
  const soldByStop = ex.orders[id].filled;
  bot.stopCheckedAt = {};
  await bot.tick();
  const p = bot.store.state.positions['BTC/EUR'];
  assert.ok(p, 'positie (de rest) blijft open');
  assert.ok(Math.abs(p.amount - (amount - soldByStop)) < 1e-9, `hoeveelheid bijgewerkt: ${p.amount}`);
  assert.equal(bot.safetyStatus().exchangeStop.positions[0].status, 'mislukt', 'rest is (nog) niet beschermd: zichtbaar');
  assert.ok(bot.safetyStatus().buyBlock.blocked, 'geen nieuwe aankopen zolang de rest geen stop heeft');
  // Een eigen verkoop verkoopt alleen de rest (meer staat er niet), en de trade telt beide delen.
  await bot.closeManual('BTC/EUR');
  const sells = marketCalls(ex, 'sell');
  assert.equal(sells.length, 1);
  assert.ok(Math.abs(sells[0].amount - (amount - soldByStop)) < 1e-8, `alleen de rest verkocht: ${sells[0].amount}`);
  const t = bot.store.state.trades[0];
  assert.ok(Math.abs(t.amount - amount) < 1e-9, 'trade over de hele positie');
  const stopEur = ex.orders[id].cost * 0.9975;
  const restEur = sells[0].amount * ex.prices.at(-1) * 0.9975;
  assert.ok(Math.abs(t.pnlEur - (stopEur + restEur - pos.costEur)) < 1e-6, `winst over beide delen: ${t.pnlEur}`);
});

test('A13: antwoord van Bitvavo op de stop-order verloren (order wél geplaatst) → bij de nieuwe poging de bestaande overnemen, geen tweede', async () => {
  const { bot, ex } = setupLive();
  ex.loseStopReply = true;
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.equal(pos.exchangeStop.orderId, null);
  assert.match(pos.exchangeStop.error, /timed out/);
  assert.equal(stopCalls(ex).length, 1);
  ex.loseStopReply = false;
  pos.exchangeStop.attemptAt = new Date(Date.now() - 11 * 60000).toISOString();
  await bot.tick();
  assert.equal(stopCalls(ex).length, 1, 'geen tweede stop-order geplaatst');
  const open = (await ex.fetchOpenOrders('BTC/EUR')).filter((o) => o.type === 'stopLoss');
  assert.equal(open.length, 1);
  assert.equal(pos.exchangeStop.orderId, open[0].id, 'de bestaande stop-order is overgenomen');
  assert.equal(bot.safetyStatus().exchangeStop.positions[0].status, 'actief');
  // Verkopen kan daarna gewoon: eerst die stop annuleren.
  await bot.closeManual('BTC/EUR');
  assert.equal(ex.orders[open[0].id].status, 'canceled');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
});

test('B: saldo ophalen mislukt → geen nieuwe aankopen (reden zichtbaar); werkt het weer, dan wel', async () => {
  const { bot, ex } = setupLive();
  ex.failBalance = 'bitvavo GET https://api.bitvavo.com/v2/balance 503 Service Unavailable';
  await buyTicks(bot, ex);
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined, 'niet gekocht');
  assert.equal(marketCalls(ex, 'buy').length, 0);
  const bb = bot.safetyStatus().buyBlock;
  assert.equal(bb.blocked, true);
  assert.ok(bb.reasons.some((r) => /saldo/i.test(r)), JSON.stringify(bb));
  const dec = bot.store.state.decisions.find((d) => d.outcome === 'blocked');
  assert.match(dec?.reason ?? '', /Live-veiligheid/);
  ex.failBalance = null;
  ex.prices = [...ex.prices, ex.prices.at(-1)];
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  assert.ok(bot.store.state.positions['BTC/EUR'], 'na herstel weer kopen');
  assert.deepEqual(bot.safetyStatus().buyBlock, { blocked: false, reasons: [] });
});

test('B: stop van een bestaande positie mislukt → in dezelfde check geen tweede aankoop; verkopen blijft werken', async () => {
  const { bot, ex } = setupLive({ pairs: ['BTC/EUR', 'ETH/EUR'] });
  ex.failStop = 'bitvavo {"errorCode":203,"error":"Unknown error"}';
  await buyTicks(bot, ex, () => Object.keys(bot.store.state.positions).length);
  assert.deepEqual(Object.keys(bot.store.state.positions), ['BTC/EUR'], 'alleen de eerste coin gekocht');
  assert.equal(marketCalls(ex, 'buy').length, 1);
  assert.match(bot.pairStatus['ETH/EUR'].reason, /stop-order/i);
  const bb = bot.safetyStatus().buyBlock;
  assert.equal(bb.blocked, true);
  assert.ok(bb.reasons.some((r) => /BTC\/EUR/.test(r)), JSON.stringify(bb));
  await bot.closeManual('BTC/EUR');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined, 'verkopen nooit geblokkeerd');
  assert.equal(bot.safetyStatus().buyBlock.blocked, false);
});

test('B: aankoop onzeker (antwoord verloren, coins wel gekocht) → geen nieuwe aankopen tot een saldocontrole; die volgt bij de volgende check', async () => {
  const { bot, ex, sent } = setupLive();
  ex.loseBuyReply = true;
  await buyTicks(bot, ex, () => marketCalls(ex, 'buy').length);
  ex.loseBuyReply = false;
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.ok(ex.holdings.BTC > 0, 'bij Bitvavo wel gekocht');
  const bb = bot.safetyStatus().buyBlock;
  assert.equal(bb.blocked, true);
  assert.ok(bb.reasons.some((r) => /onzeker/i.test(r)), JSON.stringify(bb));
  const before = bot.store.state.reconcile?.at;
  await bot.tick();
  assert.notEqual(bot.store.state.reconcile.at, before, 'saldocontrole meteen bij de volgende check, niet pas na 24 uur');
  assert.ok(bot.store.state.reconcile.issues.some((i) => i.pair === 'BTC/EUR' && i.kind === 'extra'), 'de gekochte coins worden gemeld');
  assert.ok(sent.some((s) => /Saldocontrole/.test(s.title)));
  assert.equal(marketCalls(ex, 'buy').length, 1, 'niet nog eens gekocht');
});

test('B: saldocontrole vond een positie die op Bitvavo mist → geen nieuwe aankopen; mislukte saldocontrole na 10 minuten opnieuw', async () => {
  const { bot, ex } = setupLive({ pairs: ['BTC/EUR', 'ETH/EUR'] });
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  // Gebruiker verkocht handmatig de helft op Bitvavo.
  ex.holdings.BTC /= 2;
  const r = await bot.reconcile();
  assert.ok(r.issues.some((i) => i.kind === 'mist'));
  const bb = bot.safetyStatus().buyBlock;
  assert.equal(bb.blocked, true);
  assert.ok(bb.reasons.some((r2) => /mist/i.test(r2)), JSON.stringify(bb));
  // Saldocontrole mislukt: blokkeren en na 10 minuten (niet 24 uur) opnieuw proberen.
  const c = setupLive();
  c.ex.failBalance = 'timeout';
  await c.bot.tick();
  assert.match(c.bot.store.state.reconcile.error, /timeout/);
  assert.ok(c.bot.safetyStatus().buyBlock.blocked);
  assert.ok(Date.parse(c.bot.safetyStatus().nextReconcileAt) - Date.now() <= SAFETY.retryMs + 1000, 'volgende poging binnen 10 minuten');
});

test('B: paper verandert niet — buyBlock altijd leeg, geen orders bij Bitvavo', async () => {
  const { bot, ex } = setupLive({ mode: 'paper' });
  ex.failBalance = 'kapot';
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  assert.ok(bot.store.state.positions['BTC/EUR']);
  assert.deepEqual(bot.safetyStatus().buyBlock, { blocked: false, reasons: [] });
  assert.equal(ex.calls.length, 0);
});

test('B: volgorde in live — stop-status en saldo vóór de coins: een uitgevoerde stop wordt afgesloten vóór er iets gekocht wordt', async () => {
  const { bot, ex } = setupLive();
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  let order = [];
  const fb = ex.fetchBalance.bind(ex);
  const fo = ex.fetchOrder.bind(ex);
  const fh = ex.fetchOHLCV.bind(ex);
  ex.fetchBalance = async () => { order.push('balance'); return fb(); };
  ex.fetchOrder = async (id) => { order.push('stop'); return fo(id); };
  ex.fetchOHLCV = async (...a) => { order.push('candles'); return fh(...a); };
  bot.stopCheckedAt = {};
  order = [];
  await bot.tick();
  const firstCandles = order.indexOf('candles');
  // prefetch haalt candles al op; de stop- en saldocontrole gaan vóór de beoordeling van de coins.
  assert.ok(order.includes('balance') && order.includes('stop'), order.join(','));
  const handleStart = order.lastIndexOf('candles');
  assert.ok(order.indexOf('balance') < handleStart && order.indexOf('stop') < handleStart, order.join(','));
  assert.ok(firstCandles >= 0);
  assert.equal(order.filter((o) => o === 'balance').length, 1, 'niet meer saldoverzoeken dan nu');
});

test('B: duidelijke weigering bij kopen (te weinig saldo) → niet onzeker, geen blokkade; isOrderRefusal', async () => {
  const { isOrderRefusal } = await import('../src/exchange.js');
  assert.equal(isOrderRefusal(new ccxt.InsufficientFunds('x')), true);
  assert.equal(isOrderRefusal(new ccxt.InvalidOrder('x')), true);
  assert.equal(isOrderRefusal(new ccxt.AuthenticationError('x')), true);
  assert.equal(isOrderRefusal(new ccxt.RequestTimeout('x')), false);
  assert.equal(isOrderRefusal(new ccxt.NetworkError('x')), false);
  assert.equal(isOrderRefusal(new Error('Order o1 is niet gevuld (status open)')), false);
  const { bot, ex } = setupLive();
  ex.createMarketOrder = async () => { throw new ccxt.InsufficientFunds('bitvavo {"errorCode":216}'); };
  await buyTicks(bot, ex, () => bot.store.state.buyFails?.length);
  assert.ok(bot.store.state.buyFails?.length, 'kopen mislukte');
  assert.equal(bot.buyUncertain ?? null, null);
  assert.deepEqual(bot.safetyStatus().buyBlock, { blocked: false, reasons: [] });
});

test('LiveBroker.findStop: neemt alleen een stop-verkoop met dezelfde hoeveelheid en stopprijs over', async () => {
  const ex = fakeBitvavo();
  ex.holdings.BTC = 1;
  const b = new LiveBroker(ex);
  assert.equal(await b.findStop('BTC/EUR', 0.1, 90), null, 'niets open');
  await ex.createOrder('BTC/EUR', 'stopLoss', 'sell', 0.2, undefined, { triggerPrice: 90 }); // eigen stop van de gebruiker: andere hoeveelheid
  await ex.createOrder('BTC/EUR', 'stopLoss', 'sell', 0.1, undefined, { triggerPrice: 80 }); // andere stopprijs
  await ex.createOrder('BTC/EUR', 'limit', 'sell', 0.1, 90, {}); // geen stop-order
  assert.equal(await b.findStop('BTC/EUR', 0.1, 90), null);
  const o = await ex.createOrder('BTC/EUR', 'stopLoss', 'sell', 0.1, undefined, { triggerPrice: 90 });
  assert.deepEqual(await b.findStop('BTC/EUR', 0.1, 90), { orderId: o.id, stopPrice: 90, amount: 0.1 });
});

// ---------- Review live: randgevallen bij verkopen ----------

test('Review: stop deels uitgevoerd vlak voor een eigen verkoop en die verkoop mislukt → verkochte deel blijft vastgelegd, later alleen de rest verkopen', async () => {
  const { bot, ex } = setupLive();
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  const pos = bot.store.state.positions['BTC/EUR'];
  const amount = pos.amount;
  const id = pos.exchangeStop.orderId;
  // De stop-order is deels uitgevoerd maar staat nog open (het annuleren haalt de rest weg).
  const o = ex.orders[id];
  const filled = Math.floor(o.amount * 0.4 * 1e8) / 1e8;
  const px = o.triggerPrice * 0.99;
  Object.assign(o, { filled, cost: filled * px, fee: { currency: 'EUR', cost: filled * px * 0.0025 } });
  ex.holdings.BTC -= filled;
  ex.holdings.EUR += filled * px;
  const orig = ex.createMarketOrder;
  ex.createMarketOrder = async () => { throw new ccxt.RequestTimeout('bitvavo POST order request timed out'); };
  await assert.rejects(bot.closeManual('BTC/EUR'), /timed out/);
  const p = bot.store.state.positions['BTC/EUR'];
  assert.ok(p, 'positie blijft open');
  assert.ok(Math.abs(p.amount - (amount - filled)) < 1e-9, `alleen de rest staat nog open: ${p.amount}`);
  assert.ok(Math.abs((p.stopFill?.amount ?? 0) - filled) < 1e-9, 'het door de stop verkochte deel is vastgelegd');
  ex.createMarketOrder = orig;
  await bot.closeManual('BTC/EUR');
  const sells = marketCalls(ex, 'sell');
  assert.equal(sells.length, 1);
  assert.ok(Math.abs(sells[0].amount - (amount - filled)) < 1e-8, `alleen de rest verkocht: ${sells[0].amount}`);
  const t = bot.store.state.trades[0];
  assert.ok(Math.abs(t.amount - amount) < 1e-9, 'trade over de hele positie');
  const restEur = sells[0].amount * ex.prices.at(-1) * 0.9975;
  assert.ok(Math.abs(t.pnlEur - (filled * px * 0.9975 + restEur - pos.costEur)) < 1e-6, `winst over beide delen: ${t.pnlEur}`);
});

test('Review: market-verkoop maar deels uitgevoerd bij Bitvavo → positie houdt de rest (bewaakt, nieuwe stop), niet stil verdwenen', async () => {
  const { bot, ex } = setupLive();
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  const pos = bot.store.state.positions['BTC/EUR'];
  const amount = pos.amount;
  const orig = ex.createMarketOrder;
  let half = 0;
  ex.createMarketOrder = async (pair, side, amt) => {
    half = Math.floor(amt * 0.5 * 1e8) / 1e8;
    return orig.call(ex, pair, side, half); // Bitvavo vult maar de helft (marktbescherming)
  };
  await assert.rejects(bot.closeManual('BTC/EUR'), /deels/i);
  const p = bot.store.state.positions['BTC/EUR'];
  assert.ok(p, 'de rest blijft als positie bewaakt');
  assert.ok(Math.abs(p.amount - (amount - half)) < 1e-9, `rest: ${p.amount}`);
  assert.ok(Math.abs((p.stopFill?.amount ?? 0) - half) < 1e-9);
  assert.equal(bot.store.state.trades.length, 0, 'nog geen (halve) trade geboekt');
  ex.createMarketOrder = orig;
  await bot.tick();
  assert.ok(p.exchangeStop?.orderId, 'nieuwe stop-order voor de rest');
  assert.ok(Math.abs(ex.orders[p.exchangeStop.orderId].amount - (amount - half)) < 1e-8);
  await bot.closeManual('BTC/EUR');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.ok(Math.abs(bot.store.state.trades[0].amount - amount) < 1e-9);
  assert.ok(ex.holdings.BTC < 1e-8, 'alles verkocht');
});

test('Review: live aankoop en verkoop staan direct op schijf (niet pas aan het eind van de check)', async () => {
  const { bot, ex } = setupLive();
  const disk = () => JSON.parse(fs.readFileSync(bot.store.file, 'utf8')).positions ?? {};
  let atOpen = null;
  let atClose = null;
  bot.onTrade = (type) => { if (type === 'open') atOpen = disk()['BTC/EUR'] ?? null; else atClose = disk(); };
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  assert.ok(atOpen, 'positie al opgeslagen vóór de rest van de check');
  assert.ok(atOpen.exchangeStop?.orderId, 'met de stop-order');
  // Verkoop door de eigen stop-loss van de bot.
  ex.prices = [...ex.prices.slice(0, -1), ex.prices.at(-1) * 0.9];
  await bot.watchPositions();
  assert.ok(atClose, 'verkocht');
  assert.equal(atClose['BTC/EUR'], undefined, 'gesloten positie al van schijf');
});

test('Live: kleinste verkoopbare inzet (boven het Bitvavo-minimum bij de noodstop) en herkennen van de minimum-weigering', async () => {
  const { sellableStake, belowMinimum } = await import('../src/bot.js');
  // Bij 10% noodstop: € 5 × 1,03 / 0,9 = € 5,73; bij de stop is hij dan nog ruim € 5 waard.
  assert.equal(sellableStake(10), 5.73);
  assert.ok(sellableStake(10) * 0.9 * 0.9975 >= 5);
  assert.equal(sellableStake(5), 5.43);
  assert.equal(sellableStake(0), 5.73); // geen stop bekend: uitgaan van 10%
  assert.ok(belowMinimum(new Error('bitvavo {"errorCode":212,"error":"You set amount to less than the minimum value possible for this market."}')));
  assert.equal(belowMinimum(new Error('bitvavo {"errorCode":216,"error":"insufficient balance"}')), false);
});

test('Live: verkoop geweigerd onder het Bitvavo-minimum (212) → duidelijke fout, één melding, positie blijft; later lukt het', async () => {
  const { bot, ex, sent } = setupLive();
  await buyTicks(bot, ex, () => bot.store.state.positions['BTC/EUR']);
  assert.ok(bot.store.state.positions['BTC/EUR']);
  const orig = ex.createMarketOrder;
  ex.createMarketOrder = async () => { throw new ccxt.InvalidOrder('bitvavo {"errorCode":212,"error":"You set amount to less than the minimum value possible for this market."}'); };
  await assert.rejects(bot.closeManual('BTC/EUR'), /onder het minimum van Bitvavo/);
  await assert.rejects(bot.closeManual('BTC/EUR'), /onder het minimum van Bitvavo/);
  assert.ok(bot.store.state.positions['BTC/EUR'], 'positie blijft open en bewaakt');
  assert.equal(sent.filter((m) => /te klein om te verkopen/.test(m.title ?? '')).length, 1, 'één melding, geen spam');
  ex.createMarketOrder = orig;
  await bot.closeManual('BTC/EUR');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
});
