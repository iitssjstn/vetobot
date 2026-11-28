import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ccxt from 'ccxt';
import { Bot, sellableStake, belowMinimum } from '../src/bot.js';
import { PaperBroker, LiveBroker, orderTiming, isOrderRefusal } from '../src/exchange.js';
import { BybitLiveBroker } from '../src/bybit-broker.js';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';
import { PUMP, compareBalances } from '../src/safety.js';
import { QuoteRate, liveAllowedOnVenue, venueAgent, checkAccordInput } from '../src/venue.js';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { createApp } from '../src/server.js';

// Bybit fase 2: live op eigen risico. Alleen een nagebootste Bybit (geen netwerk, geen echte orders). De nep-beurs
// geeft orders terug zoals ccxt 4.5 (js/src/bybit.js, parseOrder) ze maakt: status uit orderStatus, fee in
// info.cumFeeDetail (bij kopen in de coin, bij verkopen in USDT), market-koop op kosten (qty in USDT), TP/SL-orders
// met orderFilter 'tpslOrder' (coins vanaf het plaatsen gereserveerd), fetchOrder alleen met acknowledged, en
// foutmeldingen als "bybit {"retCode":170140,...}".
orderTiming.sleep = async () => {};
orderTiming.pollMs = 0;

const H = 3600000;
const quiet = { info() {}, warn() {}, error() {} };
const RATE = 0.9; // 1 USDT = € 0,90
const FEE = 0.001; // 0,1%
const agentPrices = () => [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
const agentFx = () => JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
function greedyAgent() {
  const fx = agentFx();
  return { ...fx.agent, stage: 'bewezen', recipeKey: 'R', liveCheck: { allMet: true, checks: [] }, safetyStopPct: 5,
    entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 }, exit: { ...fx.agent.exit, init: fx.agent.exit.init + 50 },
    regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } } };
}
const near = (a, b, rel = 1e-6) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-12;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const bybitErr = (Cls, code, msg) => new Cls(`bybit {"retCode":${code},"retMsg":"${msg}","result":{},"retExtInfo":{},"time":1700000000000}`);

// ccxt bybit.parseOrderStatus
const STATUS = { New: 'open', PartiallyFilled: 'open', Filled: 'closed', Cancelled: 'canceled', Rejected: 'rejected', PartiallyFilledCanceled: 'closed',
  Untriggered: 'open', Triggered: 'open', Active: 'open', Deactivated: 'canceled' };

function fakeBybit({ minCost = 5, minAmount = 0.0001 } = {}) {
  const orders = {};
  const calls = [];
  let n = 0;
  let clock = Date.now();
  const market = (base) => ({ symbol: `${base}/USDT`, id: `${base}USDT`, base, quote: 'USDT', spot: true, active: true, taker: FEE, maker: FEE,
    precision: { amount: 0.000001, price: 0.01 }, limits: { amount: { min: minAmount }, cost: { min: minCost } } });
  const ex = {
    apiKey: 'k', secret: 's', has: { createMarketBuyOrderWithCost: true }, precisionMode: 4, calls, orders,
    prices: agentPrices(), holdings: { USDT: 1000 }, classic: false,
    markets: { 'BTC/USDT': market('BTC'), 'ETH/USDT': market('ETH'), 'USDT/EUR': { symbol: 'USDT/EUR', base: 'USDT', quote: 'EUR', spot: true, active: true } },
    failBalance: null, loseStopReply: false, failNextCreate: null,
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    amountToPrecision: (_p, v) => String(Math.floor(v * 1e6 + 1e-7) / 1e6),
    priceToPrecision: (_p, v) => String(Math.round(v * 100) / 100),
    costToPrecision: (_p, v) => String(Math.floor(v * 100) / 100),
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker(p) {
      if (p === 'USDT/EUR') return { last: RATE };
      if (p === 'EUR/USDT') return { last: 1 / RATE };
      const px = this.prices.at(-1);
      return { last: px, bid: px * 0.9999, ask: px * 1.0001 };
    },
    async fetchTickers(pairs) { return Object.fromEntries(await Promise.all(pairs.map(async (p) => [p, await this.fetchTicker(p)]))); },
    async fetchOrderBook() { const p = this.prices.at(-1); return { bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] }; },
    // TP/SL-orders reserveren de coins al vóór de trigger (zoals Bybit bij orderFilter tpslOrder); open limietorders ook.
    reserved(cur) {
      return Object.values(orders).filter((o) => STATUS[o.raw] === 'open' && o.raw !== 'Active').reduce((a, o) => {
        const [b, q] = o.pair.split('/');
        if (o.side === 'sell' && b === cur) return a + o.amount - o.filled;
        if (o.side === 'buy' && q === cur) return a + (o.amount - o.filled) * o.price;
        return a;
      }, 0);
    },
    async fetchBalance() {
      if (this.failBalance) throw new ccxt.NetworkError(this.failBalance);
      const total = { ...this.holdings };
      return { total, ...Object.fromEntries(Object.entries(total).map(([c, v]) => [c, { free: v - this.reserved(c), used: this.reserved(c), total: v }])) };
    },
    // Zoals ccxt.parseOrder het teruggeeft.
    view(o) {
      return { id: o.id, clientOrderId: o.link ?? undefined, timestamp: o.ts, symbol: o.pair, type: o.type, side: o.side, price: o.price ?? undefined,
        triggerPrice: o.trigger ?? undefined, amount: o.byCost ? undefined : o.amount, cost: o.cost ?? 0, average: o.filled > 0 ? o.cost / o.filled : undefined,
        filled: o.filled, remaining: o.byCost ? undefined : o.amount - o.filled, status: STATUS[o.raw] ?? o.raw,
        fee: o.fees && Object.keys(o.fees).length ? { currency: Object.keys(o.fees)[0], cost: Object.values(o.fees)[0] } : undefined,
        info: { orderId: o.id, orderLinkId: o.link ?? '', orderStatus: o.raw, qty: String(o.amount), cumFeeDetail: o.noFee ? {} : { ...(o.fees ?? {}) },
          stopOrderType: o.filter === 'tpslOrder' ? 'tpslOrder' : '', triggerPrice: o.trigger ? String(o.trigger) : '' } };
    },
    fill(o, amount, px) {
      const [b, q] = o.pair.split('/');
      if (o.side === 'buy') {
        const fee = amount * FEE;
        this.holdings[b] = (this.holdings[b] ?? 0) + amount - fee;
        this.holdings[q] -= amount * px;
        o.fees = { ...o.fees, [b]: (o.fees?.[b] ?? 0) + fee };
      } else {
        const fee = amount * px * FEE;
        this.holdings[b] -= amount;
        this.holdings[q] += amount * px - fee;
        o.fees = { ...o.fees, [q]: (o.fees?.[q] ?? 0) + fee };
      }
      o.filled += amount;
      o.cost = (o.cost ?? 0) + amount * px;
    },
    async createOrder(pair, type, side, amount, price, params = {}) {
      calls.push({ op: 'create', pair, type, side, amount, price, params });
      if (this.failNextCreate) { const e = this.failNextCreate; this.failNextCreate = null; throw e; }
      const [b, q] = pair.split('/');
      const m = this.markets[pair];
      const px = this.prices.at(-1);
      const id = `${1000 + ++n}`;
      clock += 1000;
      const isStop = params.triggerPrice != null;
      const o = { id, pair, type, side, amount, filled: 0, cost: 0, ts: clock, link: params.clientOrderId ?? null, filter: params.orderFilter ?? (isStop ? 'StopOrder' : 'Order') };
      if (type === 'market' && side === 'buy' && params.cost != null) {
        const cost = Number(params.cost);
        if (cost < m.limits.cost.min) throw bybitErr(ccxt.InvalidOrder, 170140, 'Order value exceeded lower limit.');
        if (cost > this.holdings[q] - this.reserved(q) + 1e-9) throw bybitErr(ccxt.InsufficientFunds, 170131, 'Insufficient balance.');
        Object.assign(o, { byCost: true, amount: cost / px, raw: 'Filled' });
        this.fill(o, cost / px, px);
        o.cost = cost;
        orders[id] = o;
        return { id, info: { orderId: id, orderLinkId: '' } };
      }
      if (amount < m.limits.amount.min) throw bybitErr(ccxt.InvalidOrder, 170136, 'Order quantity lower than the minimum.');
      const val = amount * (isStop ? Number(params.triggerPrice) : price ?? px);
      if (val < m.limits.cost.min) throw bybitErr(ccxt.InvalidOrder, 170140, 'Order value exceeded lower limit.');
      if (side === 'sell' && amount > (this.holdings[b] ?? 0) - this.reserved(b) + 1e-12) throw bybitErr(ccxt.InsufficientFunds, 170131, 'Insufficient balance.');
      if (isStop) {
        Object.assign(o, { raw: 'Untriggered', trigger: Number(params.triggerPrice) });
        orders[id] = o;
        if (this.loseStopReply) throw new ccxt.RequestTimeout('bybit POST https://api.bybit.com/v5/order/create request timed out (10000 ms)');
        return { id, clientOrderId: o.link, info: { orderId: id, orderLinkId: o.link } };
      }
      if (type === 'market') {
        o.raw = 'Filled';
        this.fill(o, amount, px);
      } else {
        Object.assign(o, { raw: 'New', price });
      }
      orders[id] = o;
      return { id, info: { orderId: id, orderLinkId: '' } };
    },
    async createMarketBuyOrderWithCost(pair, cost, params = {}) { return this.createOrder(pair, 'market', 'buy', -1, undefined, { ...params, cost }); },
    async createMarketOrder(pair, side, amount) { return this.createOrder(pair, 'market', side, amount); },
    // ccxt: op een Unified account alleen met acknowledged; klassiek: NotSupported voor spot.
    match(o, params) {
      const f = params.orderFilter ?? (params.trigger ? 'StopOrder' : 'Order');
      return o.filter === f || (f === 'Order' && o.filter === 'child');
    },
    async fetchOrder(id, pair, params = {}) {
      calls.push({ op: 'fetchOrder', id, params });
      if (this.classic) throw new ccxt.NotSupported('bybit fetchOrder() is not supported for spot markets');
      if (!params.acknowledged) throw new ccxt.ArgumentsRequired('bybit fetchOrder() can only access an order if it is in last 500 orders');
      const o = orders[id];
      if (!o || !this.match(o, params)) throw new ccxt.OrderNotFound(`Order ${id} was not found.`);
      return this.view(o);
    },
    async fetchOpenOrders(pair, since, limit, params = {}) {
      return Object.values(orders).filter((o) => STATUS[o.raw] === 'open' && (!pair || o.pair === pair) && this.match(o, params)
        && (!params.orderId || o.id === params.orderId)).map((o) => this.view(o));
    },
    async fetchCanceledAndClosedOrders(pair, since, limit, params = {}) {
      return Object.values(orders).filter((o) => STATUS[o.raw] !== 'open' && (!pair || o.pair === pair) && this.match(o, params)
        && (!params.orderId || o.id === params.orderId) && (since == null || o.ts >= since)).map((o) => this.view(o));
    },
    async cancelOrder(id, pair, params = {}) {
      calls.push({ op: 'cancel', id, pair, params });
      const o = orders[id];
      if (!o || !this.match(o, params)) throw bybitErr(ccxt.OrderNotFound, 170213, 'Order does not exist.');
      if (!['New', 'PartiallyFilled', 'Untriggered'].includes(o.raw)) throw bybitErr(ccxt.InvalidOrder, 170142, 'Order has been canceled');
      o.raw = o.raw === 'Untriggered' ? 'Deactivated' : o.filled > 0 ? 'PartiallyFilledCanceled' : 'Cancelled';
      return { id };
    },
    // --- Hulpjes voor de tests ---
    // De stop gaat af. how: 'same' (Unified: zelfde orderId, Filled), 'new' (conditional → 'Active', verkoop in een
    // nieuwe order), 'pending' ('Triggered', nog geen uitvoering bekend), 'partial' (deels, rest geannuleerd).
    trigger(id, how = 'same', share = 0.4) {
      const o = orders[id];
      const px = o.trigger * 0.998;
      if (how === 'same') { o.raw = 'Filled'; this.fill(o, o.amount, px); return o; }
      if (how === 'partial') { o.raw = 'PartiallyFilledCanceled'; this.fill(o, Math.floor(o.amount * share * 1e6) / 1e6, px); return o; }
      o.raw = how === 'new' ? 'Active' : 'Triggered';
      if (how === 'pending') return o;
      clock += 1000;
      const cid = `${1000 + ++n}`;
      const child = { id: cid, pair: o.pair, type: 'market', side: 'sell', amount: o.amount, filled: 0, cost: 0, ts: clock, link: null, filter: 'child', raw: 'Filled' };
      this.fill(child, o.amount, px);
      orders[cid] = child;
      return child;
    },
    fillLimit(id, share = 1) {
      const o = orders[id];
      this.fill(o, Math.floor(o.amount * share * 1e6) / 1e6, o.price);
      o.raw = o.filled >= o.amount - 1e-12 ? 'Filled' : 'PartiallyFilled';
    },
  };
  return ex;
}

// Bot op Bybit (USDT-paren, bedragen in euro). live: met een akkoord op eigen risico live gezet (zoals de server doet).
async function setupBybit({ live = true, risk = {}, pairs = ['BTC/USDT'], maxLossEur = 20, ex = fakeBybit(), agent = greedyAgent } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-live-'));
  const baseRisk = { agentOwnStop: 0, stakeEur: 25, maxOpenTrades: 3, stopLossPct: 5, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.1, makerFeePct: 0.1, cooldownMinutes: 0, aiExitMinPct: 0, ...risk };
  const strategy = { agentMode: 1, agentVeto: 0, agentExplore: 0, agentLiveSmallStart: 0 };
  const config = { timeframe: '1h', strategy, risk: baseRisk, ai: { provider: 'none', failMode: 'reject' } };
  const settings = new Settings(dir, { liveTrading: false, pairs: pairs.map((p) => p.replace('/USDT', '/EUR')), timeframe: '1h', checkIntervalMinutes: 15, risk: baseRisk, strategy, ai: { provider: 'none', model: '', baseUrl: '' } });
  settings.setExchange('bybit');
  settings.setRisk(baseRisk);
  const fx = new QuoteRate(ex, 'bybit');
  const stores = { paper: new Store(dir, 'paper', 500, 'bybit'), live: new Store(dir, 'live', 500, 'bybit') };
  const brokers = { paper: new PaperBroker(ex, 0.1, 0, 0.1, fx), live: new BybitLiveBroker(ex, fx, { allowed: () => liveAllowedOnVenue('bybit', settings) }) };
  const bot = new Bot({ config, exchange: ex, settings, stores, log: quiet, brokers });
  bot.fx = fx;
  bot.getAgent = () => venueAgent(agent(), 'bybit');
  settings.setAgentLive('R', true);
  const sent = [];
  bot.notifier = { send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  if (live) await bot.switchMode('live', { accord: { confirmText: 'EIGEN RISICO', maxLossEur } });
  return { bot, ex, sent, dir, settings, fx };
}

async function buyTicks(bot, ex, until = () => false) {
  for (let n = 0; n < 4 && !until(); n++) {
    if (n) ex.prices = [...ex.prices, ex.prices.at(-1)];
    await bot.tick();
  }
}
const creates = (ex, f) => ex.calls.filter((c) => c.op === 'create' && f(c));
const stopCreates = (ex) => creates(ex, (c) => c.params?.triggerPrice != null);
const marketSells = (ex) => creates(ex, (c) => c.type === 'market' && c.side === 'sell' && c.params?.triggerPrice == null);
const marketBuys = (ex) => creates(ex, (c) => c.type === 'market' && c.side === 'buy');
const setPrice = (ex, p) => { ex.prices[ex.prices.length - 1] = p; };

async function opened(opts = {}) {
  const s = await setupBybit(opts);
  await buyTicks(s.bot, s.ex, () => s.bot.store.state.positions['BTC/USDT']);
  const pos = s.bot.store.state.positions['BTC/USDT'];
  assert.ok(pos, 'gekocht op Bybit');
  return { ...s, pos };
}

// ---------- Akkoord vereist ----------
test('akkoord: centrale check en invoer (zonder akkoord, verkeerd getypt, zonder of te kleine verliesgrens geweigerd)', () => {
  assert.deepEqual(liveAllowedOnVenue('bitvavo', null), { ok: true, reason: null });
  const no = liveAllowedOnVenue('bybit', { venueLive: {} });
  assert.equal(no.ok, false);
  assert.equal(no.accord, true);
  assert.match(no.reason, /alleen op eigen risico/);
  const yes = liveAllowedOnVenue('bybit', { venueLive: { bybit: { maxLossEur: 20, at: new Date().toISOString() } } });
  assert.equal(yes.ok, true);
  assert.equal(yes.maxLossEur, 20);
  const stopped = liveAllowedOnVenue('bybit', { venueLive: { bybit: { maxLossEur: 20, at: ago(H), stoppedAt: new Date().toISOString() } } });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopped, true);
  assert.throws(() => checkAccordInput('bybit', { confirmText: 'eigen risco', maxLossEur: 20 }), /Typ EIGEN RISICO/);
  assert.throws(() => checkAccordInput('bybit', { confirmText: 'EIGEN RISICO' }), /verliesgrens/);
  assert.throws(() => checkAccordInput('bybit', { confirmText: 'EIGEN RISICO', maxLossEur: '' }), /verliesgrens/);
  assert.throws(() => checkAccordInput('bybit', { confirmText: 'EIGEN RISICO', maxLossEur: 0.5 }), /verliesgrens/);
  assert.equal(checkAccordInput('bybit', { confirmText: ' eigen risico ', maxLossEur: '12.345' }), 12.35);
});

test('akkoord in de bot: zonder akkoord, fout getypt of zonder verliesgrens geen live; geen order naar Bybit; keys kapot → akkoord vervalt', async () => {
  const { bot, ex, settings } = await setupBybit({ live: false });
  await assert.rejects(bot.switchMode('live'), /alleen op eigen risico/);
  await assert.rejects(bot.switchMode('live', { accord: { confirmText: 'LIVE', maxLossEur: 20 } }), /Typ EIGEN RISICO/);
  await assert.rejects(bot.switchMode('live', { accord: { confirmText: 'EIGEN RISICO' } }), /verliesgrens/);
  assert.equal(bot.mode, 'paper');
  assert.equal(settings.venueLive.bybit, undefined, 'geen akkoord bewaard');
  // De broker zelf koopt zonder akkoord ook niets (vangnet).
  await assert.rejects(bot.brokers.live.buy('BTC/USDT', 25), /alleen op eigen risico/);
  assert.equal(ex.calls.filter((c) => c.op === 'create').length, 0);
  // Keys werken niet: geen live, en het akkoord wordt weer ingetrokken.
  ex.failBalance = 'bybit GET /v5/account/wallet-balance 401';
  await assert.rejects(bot.switchMode('live', { accord: { confirmText: 'EIGEN RISICO', maxLossEur: 20 } }), /Bybit-keys werken niet/);
  assert.equal(bot.mode, 'paper');
  assert.equal(settings.venueLive.bybit, undefined);
  ex.failBalance = null;
  // Goed: live, akkoord met tijdstip, saldo in USDT en euro.
  await bot.switchMode('live', { accord: { confirmText: 'EIGEN RISICO', maxLossEur: 20 } });
  assert.equal(bot.mode, 'live');
  assert.equal(settings.venueLive.bybit.maxLossEur, 20);
  assert.ok(bot.liveBalance.quote === 'USDT' && bot.liveBalance.quoteFree === 1000);
  assert.ok(near(bot.liveBalance.eurFree, 900), `vrij saldo in euro: ${bot.liveBalance.eurFree}`);
  // Terug naar paper: akkoord vervalt (opnieuw live = nieuw akkoord).
  await bot.switchMode('paper');
  assert.equal(settings.venueLive.bybit, undefined);
  await assert.rejects(bot.switchMode('live'), /alleen op eigen risico/);
  // Een herstart met een bestand dat live zegt maar zonder akkoord: paper.
  const raw = JSON.parse(fs.readFileSync(settings.file, 'utf8'));
  fs.writeFileSync(settings.file, JSON.stringify({ ...raw, mode: 'live' }));
  assert.equal(new Settings(path.dirname(settings.file), { liveTrading: false, ai: {} }).mode, 'paper');
});

// ---------- Server ----------
async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-srv-'));
  const users = new Users(dir);
  const PW = 'lang-genoeg-123';
  const ex = fakeBybit();
  const bitvavo = { markets: { 'BTC/EUR': { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true } }, parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; }, async fetchTicker() { return { last: 90 }; }, async fetchTickers() { return {}; }, async fetchOHLCV() { return []; } };
  const manager = new BotManager({
    config: { dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, paper: { startBalanceEur: 500 },
      risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 5, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25, makerFeePct: 0.15, cooldownMinutes: 0, slippagePct: 0 },
      strategy: {}, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 } },
    users, log: quiet, shared: new SharedMarket(bitvavo), sharedVenues: { bybit: new SharedMarket(ex) },
    makePrivateExchange: (secrets, venue) => (venue === 'bybit' ? ex : { apiKey: 'k', secret: 's', async loadMarkets() { return {}; }, async fetchBalance() { return { EUR: { free: 40, total: 40 } }; } }),
  });
  const app = createApp({ users, manager, log: quiet }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  await call('POST', '/api/auth/setup', { username: 'justin', password: PW, code: users.setupCode });
  const close = () => { manager.stopAll(); app.close(); };
  return { post: (u, b) => call('POST', u, b), get: (u) => call('GET', u), close, manager, users, PW, ex };
}

test('server: live op Bybit alleen met wachtwoord, EIGEN RISICO en verliesgrens; status toont grens en resultaat', async () => {
  const { post, get, close, manager, users, PW, ex } = await serve();
  try {
    assert.equal((await post('/api/settings/exchange', { exchange: 'bybit' })).status, 200);
    let st = (await get('/api/state')).body;
    assert.equal(st.liveAllowed.ok, false);
    assert.equal(st.liveAllowed.accord, true, 'dashboard weet dat het de eigen-risico-dialoog moet openen');
    assert.equal(st.venueRisk, null);
    const base = { mode: 'live', password: PW, confirmText: 'EIGEN RISICO', maxLossEur: 15 };
    for (const [body, re] of [
      [{ ...base, password: undefined }, /wachtwoord/i],
      [{ ...base, password: 'fout-wachtwoord-1' }, /wachtwoord/i],
      [{ ...base, confirmText: 'EIGEN RISCO' }, /Typ EIGEN RISICO/],
      [{ ...base, confirmText: undefined, confirm: 'LIVE' }, /Typ EIGEN RISICO/],
      [{ ...base, maxLossEur: undefined }, /verliesgrens/],
      [{ ...base, maxLossEur: 0 }, /verliesgrens/],
    ]) {
      const r = await post('/api/settings/mode', body);
      assert.equal(r.status === 400 || r.status === 401 || r.status === 403, true, `${JSON.stringify(body)} → ${r.status}`);
      assert.match(r.body.error, re);
    }
    const ctx = manager.get(users.admin.id);
    assert.equal(ctx.settings.mode, 'paper');
    assert.equal(ctx.settings.venueLive.bybit, undefined);
    assert.equal(ex.calls.filter((c) => c.op === 'create').length, 0, 'geen order');
    const ok = await post('/api/settings/mode', base);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.mode, 'live');
    st = (await get('/api/state')).body;
    assert.equal(st.mode, 'live');
    assert.equal(st.liveAllowed.ok, true);
    assert.equal(st.venueRisk.maxLossEur, 15);
    assert.equal(st.venueRisk.lossEur, 0);
    assert.equal(st.safety.venueRisk.maxLossEur, 15);
    assert.equal(st.safety.venueLabel, 'Bybit');
    assert.equal(st.liveBalance.quote, 'USDT');
    // Terug naar paper trekt het akkoord in.
    assert.equal((await post('/api/settings/mode', { mode: 'paper', password: PW })).status, 200);
    assert.equal(ctx.settings.venueLive.bybit, undefined);
    assert.equal((await get('/api/state')).body.venueRisk, null);
  } finally {
    close();
  }
});

// ---------- Kopen en verkopen met euro-omrekening ----------
test('koop/verkoop op Bybit: market-koop op kosten in USDT, fee in de coin en in USDT, alles in euro geboekt', async () => {
  const { bot, ex, pos } = await opened();
  const buy = marketBuys(ex)[0];
  // Inzet € 25 → 25 / 0,9 = 27,77 USDT, via createMarketBuyOrderWithCost (qty in USDT).
  assert.equal(buy.params.cost, 27.77);
  const px = ex.prices.at(-1);
  const got = 27.77 / px;
  assert.ok(near(pos.amount, got * (1 - FEE)), `fee in BTC van de hoeveelheid af: ${pos.amount}`);
  assert.ok(near(pos.costEur, 27.77 * RATE), `kosten in euro: ${pos.costEur}`);
  assert.ok(near(pos.costQuote, 27.77), 'en in USDT bewaard');
  assert.equal(pos.entryEurRate, RATE);
  assert.ok(near(pos.entryFeeEur, got * FEE * px * RATE), `fee in euro: ${pos.entryFeeEur}`);
  assert.ok(Math.abs(ex.holdings.BTC - pos.amount) < 1e-12, 'de bot houdt precies aan wat er op Bybit staat');
  // Stop-order bij Bybit: TP/SL-order (orderFilter tpslOrder) op de noodstop van 5%, de volle hoeveelheid.
  const sc = stopCreates(ex);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].type, 'market');
  assert.equal(sc[0].params.orderFilter, 'tpslOrder');
  assert.ok(near(sc[0].params.triggerPrice, Math.round(px * 0.95 * 100) / 100));
  assert.equal(sc[0].amount, Number(ex.amountToPrecision('', pos.amount)));
  assert.ok(bot.activity.some((e) => /Stop-order bij Bybit gezet op .* USDT/.test(e.message)));
  // Verkopen: eerst de stop weg (coins gereserveerd), dan market; opbrengst na USDT-fee in euro.
  setPrice(ex, px * 1.02);
  const t = await bot.closeManual('BTC/USDT');
  assert.equal(ex.orders[pos.exchangeStop.lastOrderId ?? sc[0].id]?.raw ?? ex.orders[Object.keys(ex.orders)[1]].raw, 'Deactivated');
  const sells = marketSells(ex);
  assert.equal(sells.length, 1);
  const gross = sells[0].amount * px * 1.02;
  assert.ok(near(t.proceedsQuote, gross * (1 - FEE)), `opbrengst in USDT: ${t.proceedsQuote}`);
  assert.ok(near(t.pnlEur, gross * (1 - FEE) * RATE - pos.costEur), `winst in euro: ${t.pnlEur}`);
  assert.equal(t.venue, 'bybit');
  assert.equal(t.quote, 'USDT');
  assert.ok(near(t.feesEur, pos.entryFeeEur + gross * FEE * RATE));
  assert.equal(t.exitEurRate, RATE);
});

test('fees: fee in USDT bij kopen, geen fee-info (geschat), classic account zonder fetchOrder', async () => {
  const ex = fakeBybit();
  const fx = new QuoteRate(ex, 'bybit');
  const b = new BybitLiveBroker(ex, fx);
  // Klassiek account: fetchOrder bestaat niet voor spot → via open/gesloten orders.
  ex.classic = true;
  const f1 = await b.buy('BTC/USDT', 18);
  assert.ok(f1.amount > 0 && f1.costQuote === 20, `${JSON.stringify(f1)}`);
  // Fee in USDT (bijv. andere fee-instelling): niet van de hoeveelheid af, wel in de kosten.
  ex.classic = false;
  const origFill = ex.fill.bind(ex);
  ex.fill = function (o, amount, px) {
    const [b0, q] = o.pair.split('/');
    this.holdings[b0] = (this.holdings[b0] ?? 0) + amount;
    this.holdings[q] -= amount * px + amount * px * FEE;
    o.fees = { [q]: amount * px * FEE };
    o.filled += amount;
    o.cost = (o.cost ?? 0) + amount * px;
  };
  const f2 = await b.buy('BTC/USDT', 18);
  const px = ex.prices.at(-1);
  assert.ok(near(f2.amount, 20 / px), 'fee in USDT: volle hoeveelheid');
  assert.ok(near(f2.costQuote, 20 * (1 + FEE)), `kosten inclusief USDT-fee: ${f2.costQuote}`);
  assert.ok(near(f2.costEur, 20 * (1 + FEE) * RATE));
  ex.fill = origFill;
  // Geen fee-informatie: schatten met de fee van de markt, en bij kopen iets minder coins aanhouden.
  const view = ex.view.bind(ex);
  ex.view = (o) => { const v = view(o); delete v.fee; v.info.cumFeeDetail = {}; return v; };
  const f3 = await b.buy('BTC/USDT', 18);
  assert.equal(f3.feeEstimated, true);
  assert.ok(near(f3.amount, (20 / px) * (1 - FEE)));
});

// ---------- Stop plaatsen/opvragen/annuleren ----------
test('stop: plaatsen, opvragen (Untriggered = open), annuleren (Deactivated), terugvinden na verloren antwoord; onder het minimum overslaan', async () => {
  const ex = fakeBybit();
  ex.holdings.BTC = 1;
  const fx = new QuoteRate(ex, 'bybit');
  await fx.eurPerQuote();
  const b = new BybitLiveBroker(ex, fx);
  const r = await b.placeStop('BTC/USDT', 0.2, 95.123);
  assert.equal(r.stopPrice, 95.12);
  assert.equal(r.amount, 0.2);
  assert.equal(ex.reserved('BTC'), 0.2, 'TP/SL-order reserveert de coins al');
  assert.deepEqual(await b.fetchStop('BTC/USDT', r.orderId), { state: 'open', filled: 0, fill: null });
  const fo = ex.calls.find((c) => c.op === 'fetchOrder');
  assert.equal(fo.params.acknowledged, true);
  assert.equal(fo.params.orderFilter, 'tpslOrder');
  assert.equal((await b.cancelStop('BTC/USDT', r.orderId)).state, 'canceled');
  assert.equal(ex.calls.find((c) => c.op === 'cancel').params.orderFilter, 'tpslOrder');
  assert.equal(ex.reserved('BTC'), 0);
  // Antwoord verloren: findStop vindt hem terug.
  ex.loseStopReply = true;
  await assert.rejects(b.placeStop('BTC/USDT', 0.2, 95), /timed out/);
  ex.loseStopReply = false;
  const found = await b.findStop('BTC/USDT', 0.2, 95);
  assert.ok(found?.orderId);
  // Onder het minimum (5 USDT per order, of de minimale hoeveelheid): niet plaatsen.
  assert.match((await b.placeStop('BTC/USDT', 0.04, 100)).skipped, /4\.00 USDT \(± € 3\.60\) waard, onder het minimum van Bybit \(5 USDT\)/);
  assert.match((await b.placeStop('BTC/USDT', 0.00005, 100)).skipped, /onder het minimum van Bybit \(0\.0001\)/);
});

test('stop uitgevoerd (zelfde orderId, Filled) → positie gesloten met die verkoop, nooit dubbel verkocht', async () => {
  const { bot, ex, pos } = await opened();
  const id = pos.exchangeStop.orderId;
  ex.trigger(id, 'same');
  bot.stopCheckedAt = {};
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/USDT'], undefined, 'positie dicht');
  const t = bot.store.state.trades[0];
  assert.equal(t.exitReason, 'Stop-loss bij Bybit');
  assert.equal(marketSells(ex).length, 0, 'de bot verkocht niet zelf nog eens');
  const o = ex.orders[id];
  assert.ok(near(t.pnlEur, (o.cost - o.fees.USDT) * RATE - pos.costEur), `resultaat uit de uitvoering: ${t.pnlEur}`);
  assert.ok(Math.abs(ex.holdings.BTC) < 1e-6, 'hooguit een afrondingsrestje over');
});

test('stop uitgevoerd als nieuwe order (status Active, nieuw id) → herkend via de verkoop na de stop; ook bij een eigen verkoop niet dubbel', async () => {
  // a) De stopronde ziet het.
  {
    const { bot, ex, pos } = await opened();
    const child = ex.trigger(pos.exchangeStop.orderId, 'new');
    bot.stopCheckedAt = {};
    await bot.tick();
    assert.equal(bot.store.state.positions['BTC/USDT'], undefined);
    assert.equal(marketSells(ex).length, 0);
    const t = bot.store.state.trades[0];
    assert.ok(near(t.proceedsQuote, child.cost - child.fees.USDT), 'opbrengst van de nieuwe order');
  }
  // b) De bot wil zelf verkopen terwijl de stop net afging: niet nog eens verkopen.
  {
    const { bot, ex, pos } = await opened();
    ex.trigger(pos.exchangeStop.orderId, 'new');
    ex.holdings.BTC += 1; // eigen coins van de gebruiker: een tweede verkoop zou hier wél lukken
    const t = await bot.closeManual('BTC/USDT');
    assert.equal(t.exitReason, 'Stop-loss bij Bybit');
    assert.equal(marketSells(ex).length, 0, 'geen dubbele verkoop');
  }
  // c) Getriggerd, uitvoering nog onbekend: niet verkopen, positie blijft (beschermd door de stop).
  {
    const { bot, ex, pos } = await opened();
    ex.trigger(pos.exchangeStop.orderId, 'pending');
    ex.holdings.BTC += 1;
    await assert.rejects(bot.closeManual('BTC/USDT'), /kon niet geannuleerd worden.*getriggerd/);
    assert.ok(bot.store.state.positions['BTC/USDT'], 'positie blijft');
    assert.equal(marketSells(ex).length, 0);
    bot.stopCheckedAt = {};
    await bot.tick();
    assert.ok(bot.store.state.positions['BTC/USDT'], 'stopronde: nog open (getriggerd), niets verkocht');
    assert.equal(marketSells(ex).length, 0);
  }
});

test('stop deels uitgevoerd (PartiallyFilledCanceled) → rest blijft open, nieuwe stop voor de rest, trade telt beide delen', async () => {
  const { bot, ex, pos } = await opened();
  const amount = pos.amount;
  const id = pos.exchangeStop.orderId;
  ex.trigger(id, 'partial', 0.4);
  const soldByStop = ex.orders[id].filled;
  bot.stopCheckedAt = {};
  await bot.tick();
  const p = bot.store.state.positions['BTC/USDT'];
  assert.ok(p, 'rest open');
  assert.ok(near(p.amount, amount - soldByStop), `rest: ${p.amount}`);
  assert.ok(p.stopFill?.costQuote > 0, 'opbrengst van het deel in USDT bewaard');
  assert.ok(bot.safetyStatus().buyBlock.blocked, 'rest nog zonder stop: geen nieuwe aankopen');
  p.exchangeStop.attemptAt = ago(11 * 60000);
  await bot.tick();
  assert.ok(p.exchangeStop.orderId, 'nieuwe stop voor de rest');
  assert.ok(near(ex.orders[p.exchangeStop.orderId].amount, Number(ex.amountToPrecision('', p.amount))));
  const t = await bot.closeManual('BTC/USDT');
  assert.ok(near(t.amount, amount), 'trade over de hele positie');
});

// ---------- Limietorders ----------
test('limietorder: deels gevuld kopen, verkopen met rest market; verbindingsfout tijdens het wachten → annuleren en echte stand, geen dubbele verkoop', async () => {
  const ex = fakeBybit();
  const fx = new QuoteRate(ex, 'bybit');
  const b = new BybitLiveBroker(ex, fx);
  // Kopen: limiet op de biedprijs; Bybit vult de helft, de rest wordt geannuleerd.
  const realFetch = ex.fetchOrder.bind(ex);
  const realCreate = ex.createOrder.bind(ex);
  ex.createOrder = async (...a) => {
    const r = await realCreate(...a);
    if (a[1] === 'limit' && a[2] === 'buy') ex.fillLimit(r.id, 0.5);
    return r;
  };
  const f = await b.buy('BTC/USDT', 27, { limit: true, waitSec: 0 });
  ex.createOrder = realCreate;
  assert.equal(f.limit, true);
  assert.equal(f.partial, true);
  const lim = creates(ex, (c) => c.type === 'limit')[0];
  assert.equal(lim.params.postOnly, true);
  assert.ok(near(f.amount, (Math.floor(lim.amount * 0.5 * 1e6) / 1e6) * (1 - FEE)));
  ex.fetchOrder = realFetch;
  // Verkopen: verbinding weg tijdens het wachten, terwijl de limietorder deels gevuld is.
  const have = ex.holdings.BTC;
  let first = true;
  ex.fetchOrder = async (id, pair, params) => {
    const o = ex.orders[id];
    if (o?.type === 'limit' && o.side === 'sell' && first) {
      first = false;
      ex.fillLimit(id, 0.3);
      throw new ccxt.RequestTimeout('bybit GET /v5/order/realtime request timed out');
    }
    return realFetch(id, pair, params);
  };
  const s = await b.sell('BTC/USDT', have, { limit: true, waitSec: 5 });
  ex.fetchOrder = realFetch;
  const lsell = Object.values(ex.orders).find((o) => o.type === 'limit' && o.side === 'sell');
  assert.equal(lsell.raw, 'PartiallyFilledCanceled', 'limietorder geannuleerd na de verbindingsfout');
  const msells = creates(ex, (c) => c.type === 'market' && c.side === 'sell');
  assert.equal(msells.length, 1);
  assert.ok(near(msells[0].amount + lsell.filled, Number(ex.amountToPrecision('', have))), 'alleen de rest met een market order');
  assert.ok(near(s.amount, msells[0].amount + lsell.filled));
  assert.ok(ex.holdings.BTC >= -1e-12, 'niet meer verkocht dan er was');
  // Aanmaken van de limiet-verkoop zelf geeft een time-out: niet alles market verkopen (de order kan bestaan).
  ex.holdings.BTC = 0.5;
  ex.failNextCreate = new ccxt.RequestTimeout('bybit POST /v5/order/create request timed out');
  await assert.rejects(b.sell('BTC/USDT', 0.5, { limit: true }), /timed out/);
  assert.equal(creates(ex, (c) => c.type === 'market' && c.side === 'sell').length, 1, 'geen extra market-verkoop');
  // Bybit-time-out als foutcode (170146 "Order creation timeout") is géén weigering: onzeker.
  ex.failNextCreate = bybitErr(ccxt.InvalidOrder, 170146, 'Order creation timeout');
  const err = await b.buy('BTC/USDT', 20).catch((e) => e);
  assert.match(err.message, /onzeker/);
  assert.equal(isOrderRefusal(err), false, 'de bot behandelt dit als onzekere aankoop');
});

// ---------- Minimums per markt ----------
test('minimum per markt: verkoopbare inzet uit limits (USDT → euro), te kleine verkoop → duidelijke melding, positie blijft', async () => {
  // Markt met minimum 10 USDT: bij 5% noodstop minstens 10 × 0,9 × 1,03 / 0,95 = € 9,76.
  assert.equal(sellableStake(5, 9), 9.76);
  assert.equal(sellableStake(10), 5.73, 'Bitvavo ongewijzigd');
  const { bot, ex, sent, pos } = await opened({ ex: fakeBybit({ minCost: 10 }), risk: { stakeEur: 5 } });
  // € 9,76 → 10,84 USDT (afgerond op hele centen omlaag) = € 9,756.
  assert.ok(pos.costEur >= 9.75 && pos.costQuote >= 10.84, `inzet verhoogd naar het verkoopbare minimum van deze markt: ${pos.costEur}`);
  assert.ok(bot.activity.some((e) => /boven het minimum van Bybit blijft/.test(e.message)));
  assert.ok(pos.exchangeStop.orderId, 'stop past boven het minimum');
  // Koers zakt hard: de positie is minder dan 10 USDT waard; verkopen weigert Bybit (of de broker vooraf).
  ex.orders[pos.exchangeStop.orderId].raw = 'Deactivated';
  pos.exchangeStop = { orderId: null, skipped: 'test' };
  setPrice(ex, ex.prices.at(-1) * 0.5);
  await assert.rejects(bot.closeManual('BTC/USDT'), /onder het minimum van Bybit \(10 USDT \(± € 9,00\)\)/);
  await assert.rejects(bot.closeManual('BTC/USDT'), /onder het minimum van Bybit/);
  assert.ok(bot.store.state.positions['BTC/USDT'], 'positie blijft bewaakt');
  assert.equal(sent.filter((m) => /te klein om te verkopen/.test(m.title ?? '')).length, 1, 'één melding');
  assert.equal(marketSells(ex).length, 0, 'niets naar Bybit gestuurd');
  // Herkennen van de Bybit-foutcodes.
  assert.ok(belowMinimum(bybitErr(ccxt.InvalidOrder, 170140, 'Order value exceeded lower limit.')));
  assert.ok(belowMinimum(bybitErr(ccxt.InvalidOrder, 170136, 'Order quantity lower than the minimum.')));
  assert.equal(belowMinimum(bybitErr(ccxt.InvalidOrder, 170133, 'Order price lower than the minimum.')), false, 'prijs te laag is iets anders');
  assert.equal(belowMinimum(bybitErr(ccxt.InsufficientFunds, 170131, 'Insufficient balance.')), false);
});

test('deels verkocht: rest onder het Bybit-minimum → positie dicht (restje blijft), rest erboven → blijft open', async () => {
  const { bot, ex, pos } = await opened();
  const orig = ex.createOrder.bind(ex);
  ex.createOrder = async (pair, type, side, amount, price, params) => {
    if (type === 'market' && side === 'sell' && !params?.triggerPrice) return orig(pair, type, side, Math.floor(amount * 0.5 * 1e6) / 1e6, price, params);
    return orig(pair, type, side, amount, price, params);
  };
  await assert.rejects(bot.closeManual('BTC/USDT'), /Maar deels verkocht bij Bybit/);
  const p = bot.store.state.positions['BTC/USDT'];
  assert.ok(p && near(p.amount, pos.amount), 'rest (± 13 USDT) blijft open');
  ex.createOrder = async (pair, type, side, amount, price, params) => {
    if (type === 'market' && side === 'sell' && !params?.triggerPrice) return orig(pair, type, side, Math.floor(amount * 0.8 * 1e6) / 1e6, price, params);
    return orig(pair, type, side, amount, price, params);
  };
  p.exchangeStop = { orderId: null, skipped: 'test' };
  await bot.closeManual('BTC/USDT');
  assert.equal(bot.store.state.positions['BTC/USDT'], undefined, 'rest (± 2,8 USDT) onder het minimum: dicht');
});

// ---------- Verliesgrens ----------
test('verliesgrens bereikt → geen nieuwe aankopen, akkoord ingetrokken, Discord-melding; open positie bewaakt; daarna paper', async () => {
  const { bot, ex, sent, settings, pos } = await opened({ maxLossEur: 1, pairs: ['BTC/USDT', 'ETH/USDT'], risk: { maxOpenTrades: 1 } });
  assert.equal(bot.venueRiskStatus().lossEur < 0, true, 'de fee telt al mee');
  // Koers 4,5% lager: open verlies ± € 1,15 voorbij de grens van € 1 (de noodstop van 5% is nog niet geraakt).
  const entry = pos.entryPrice;
  ex.prices = [...ex.prices, entry * 0.955];
  bot.livePrices = { 'BTC/USDT': { price: entry * 0.955, at: Date.now() } };
  await bot.tick();
  const acc = settings.venueLive.bybit;
  assert.ok(acc.stoppedAt, 'akkoord beëindigd');
  assert.match(acc.stopReason, /verliesgrens van € 1,00 is bereikt/);
  assert.equal(liveAllowedOnVenue('bybit', settings).ok, false);
  assert.ok(sent.some((m) => m.event === 'mode' && /Live op Bybit gestopt: verliesgrens bereikt/.test(m.title)), 'Discord-melding');
  assert.equal(bot.mode, 'live', 'nog live zolang de positie open is (bewaken en beschermen)');
  assert.ok(bot.store.state.positions['BTC/USDT'], 'positie blijft open');
  assert.ok(bot.safetyStatus().buyBlock.reasons.some((r) => /gestopt/.test(r)));
  // Geen nieuwe aankopen, ook niet met ruimte (maxOpenTrades 2).
  settings.setRisk({ maxOpenTrades: 2 });
  const buysBefore = marketBuys(ex).length;
  await buyTicks(bot, ex);
  assert.equal(marketBuys(ex).length, buysBefore, 'niets gekocht');
  await assert.rejects(bot.brokers.live.buy('ETH/USDT', 25), /gestopt/);
  // Herstart tijdens het afbouwen: blijft live (de positie mag niet onbewaakt blijven).
  assert.equal(new Settings(path.dirname(settings.file), { liveTrading: false, ai: {} }).mode, 'live');
  // De positie sluit (stop gaat af) → terug naar paper, akkoord weg.
  ex.trigger(bot.store.state.positions['BTC/USDT'].exchangeStop.orderId, 'same');
  bot.stopCheckedAt = {};
  await bot.tick();
  assert.equal(bot.mode, 'paper');
  assert.equal(settings.venueLive.bybit, undefined);
  assert.ok(sent.some((m) => /vetobot staat nu op paper/.test(m.title)));
});

// ---------- Saldocontrole in USDT ----------
test('saldocontrole op Bybit: USDT als quote, TP/SL-stops tellen als open, afwijkingen met Bybit-teksten en euro-waarde', async () => {
  const { bot, ex, pos } = await opened({ pairs: ['BTC/USDT'] });
  const r = await bot.reconcile();
  assert.equal(r.ok, true, JSON.stringify(r));
  // Eigen ETH van de gebruiker: gemeld met waarde in euro; USDT zelf niet.
  ex.holdings.ETH = 1;
  ex.holdings.BTC = pos.amount / 2;
  const r2 = await bot.reconcile();
  const mist = r2.issues.find((i) => i.pair === 'BTC/USDT');
  assert.equal(mist.kind, 'mist');
  assert.match(mist.note, /Minder op Bybit/);
  const extra = r2.issues.find((i) => i.pair === 'ETH/USDT');
  assert.match(extra.note, new RegExp(`ETH op Bybit \\(± € ${(ex.prices.at(-1) * RATE).toFixed(2).replace('.', ',')}\\)`));
  assert.equal(r2.issues.some((i) => /USDT\/USDT|EUR/.test(i.pair)), false);
  assert.ok(bot.safetyStatus().buyBlock.reasons.some((r) => /mist op Bybit/.test(r)));
  // Rechtstreeks: compareBalances met quote en koers.
  const issues = compareBalances({ positions: {}, balance: { total: { USDT: 50, SOL: 2 } }, prices: { 'SOL/USDT': 100 }, quote: 'USDT', label: 'Bybit', eurRate: 0.9 });
  assert.deepEqual(issues.map((i) => i.pair), ['SOL/USDT']);
  assert.match(issues[0].note, /SOL op Bybit \(± € 180,00\)/);
});

// ---------- Uitschieter-winstgrens ----------
test('uitschieter op Bybit: stop schuift mee omhoog (oude TP/SL veilig geannuleerd, nieuwe op de winstgrens)', async () => {
  const { bot, ex, pos } = await opened();
  const entry = pos.entryPrice;
  const first = pos.exchangeStop.orderId;
  setPrice(ex, entry * 1.05);
  assert.equal(await bot.watchPositions(), 0);
  assert.equal(ex.orders[first].raw, 'Deactivated', 'oude stop geannuleerd');
  assert.equal(stopCreates(ex).length, 2);
  assert.ok(Math.abs(pos.exchangeStop.stopPrice - entry * 1.035) < 0.02, `stop op de winstgrens: ${pos.exchangeStop.stopPrice / entry}`);
  assert.ok(near(ex.reserved('BTC'), Number(ex.amountToPrecision('', pos.amount))), 'precies één open stop');
  assert.ok(bot.activity.some((e) => /stop bij Bybit omhoog geschoven van .* USDT naar .* USDT/.test(e.message)));
  // Na 60 s en hoger: weer mee; de oude stop ging net af → afsluiten met die uitvoering, niet dubbel.
  pos.pump.stopAt = ago(PUMP.stopEveryMs + 1000);
  setPrice(ex, entry * 1.08);
  ex.trigger(pos.exchangeStop.orderId, 'same');
  await bot.watchPositions();
  assert.equal(bot.store.state.positions['BTC/USDT'], undefined);
  assert.equal(bot.store.state.trades[0].exitReason, 'Stop-loss bij Bybit');
  assert.equal(marketSells(ex).length, 0);
});

// ---------- Live-veiligheid en Bitvavo ongewijzigd ----------
test('live-veiligheid op Bybit: saldo ophalen mislukt → geen aankopen; aankoop onzeker → saldocontrole; teksten noemen Bybit', async () => {
  const { bot, ex } = await setupBybit();
  ex.failBalance = 'bybit GET /v5/account/wallet-balance 503';
  await buyTicks(bot, ex);
  assert.equal(marketBuys(ex).length, 0);
  assert.ok(bot.safetyStatus().buyBlock.reasons.some((r) => /saldo ophalen bij Bybit mislukt/.test(r)));
  ex.failBalance = null;
  // Antwoord op de koop verloren: coins wel gekocht.
  const orig = ex.createMarketBuyOrderWithCost.bind(ex);
  ex.createMarketBuyOrderWithCost = async (...a) => { await orig(...a); throw new ccxt.RequestTimeout('bybit POST /v5/order/create request timed out'); };
  await buyTicks(bot, ex, () => marketBuys(ex).length);
  ex.createMarketBuyOrderWithCost = orig;
  assert.equal(bot.store.state.positions['BTC/USDT'], undefined);
  assert.ok(bot.safetyStatus().buyBlock.reasons.some((r) => /onzeker/.test(r)));
  await bot.tick();
  assert.ok(bot.store.state.reconcile.issues.some((i) => i.pair === 'BTC/USDT' && i.kind === 'extra'));
  assert.equal(marketBuys(ex).length, 1, 'niet nog eens gekocht');
  const h = bot.health.assess({ mode: 'live', openPositions: [{ pair: 'X', live: true, stop: 'mislukt' }], buyBlock: bot.safetyStatus().buyBlock });
  assert.ok(h.problems.some((p) => p.title === 'Stop-loss bij Bybit niet bevestigd'));
});

test('Bitvavo ongewijzigd: live zonder akkoord, LiveBroker, € 5-minimum, teksten met Bitvavo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bv-'));
  const s = new Settings(dir, { liveTrading: false, ai: {}, risk: { stakeEur: 10 } });
  assert.equal(s.exchange, 'bitvavo');
  assert.deepEqual(liveAllowedOnVenue('bitvavo', s), { ok: true, reason: null });
  s.setMode('live');
  assert.equal(s.mode, 'live');
  assert.equal('venueLive' in JSON.parse(fs.readFileSync(s.file, 'utf8')), false, 'geen nieuw veld in een Bitvavo-settings.json');
  assert.equal(sellableStake(10), 5.73);
  assert.equal(sellableStake(5), 5.43);
  assert.ok(new LiveBroker({}) instanceof LiveBroker);
  assert.deepEqual(compareBalances({ positions: {}, balance: { total: { EUR: 10, ADA: 100 } }, prices: { 'ADA/EUR': 0.5 } })[0].note,
    'ADA op Bitvavo (± € 50,00) zonder positie in de bot; misschien eigen coins. De bot doet er niets mee.');
});
