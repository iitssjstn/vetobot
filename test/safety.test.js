import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ccxt from 'ccxt';
import { Bot } from '../src/bot.js';
import { PaperBroker, LiveBroker, OPERATOR_ID, orderTiming } from '../src/exchange.js';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';
import { compareBalances, exchangeStopPrice, amountUnit, SAFETY } from '../src/safety.js';

// Geen echte wachttijden bij het annuleren van stop-orders.
orderTiming.sleep = async () => {};
orderTiming.pollMs = 0;

const H = 3600000;
const quiet = { info() {}, warn() {}, error() {} };
const crossPrices = (n) => [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]).slice(0, n);

// Nep-Bitvavo: koersen en candles zoals in bot.test.js, plus orders, stop-orders en een saldo dat
// meebeweegt met wat er gekocht en verkocht wordt.
function fakeBitvavo() {
  const orders = {};
  const calls = [];
  let n = 0;
  const ex = {
    apiKey: 'k', secret: 's', has: {}, precisionMode: 4, calls, orders,
    prices: crossPrices(41),
    holdings: { EUR: 1000 },
    extraBalance: {},
    markets: { 'BTC/EUR': { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true, precision: { amount: 1e-8, price: 1e-5 }, limits: { amount: { min: 0.0001 } } } },
    failStop: null,
    failCancel: null,
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    amountToPrecision: (_p, v) => String(Math.floor(v * 1e8) / 1e8),
    priceToPrecision: (_p, v) => String(+Number(v).toPrecision(6)),
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { return { last: this.prices.at(-1) }; },
    async fetchTickers(pairs) { return Object.fromEntries(pairs.map((p) => [p, { last: p === 'ETH/EUR' ? 2000 : this.prices.at(-1) }])); },
    async fetchOrderBook() {
      const p = this.prices.at(-1);
      return { bids: [[p * 0.9999, 1e6], [p * 0.99, 1e6]], asks: [[p * 1.0001, 1e6], [p * 1.01, 1e6]] };
    },
    async fetchBalance() {
      const total = { ...this.holdings, ...this.extraBalance };
      return { total, ...Object.fromEntries(Object.entries(total).map(([c, v]) => [c, { free: v, used: 0, total: v }])) };
    },
    async createOrder(pair, type, side, amount, price, params = {}) {
      calls.push({ op: 'create', pair, type, side, amount, price, params });
      if (type === 'stopLoss' && this.failStop) throw new Error(this.failStop);
      const id = `o${++n}`;
      const base = pair.split('/')[0];
      if (type === 'market') {
        const p = this.prices.at(-1);
        orders[id] = { id, type, side, status: 'closed', amount, filled: amount, average: p, cost: amount * p, fee: { currency: 'EUR', cost: amount * p * 0.0025 } };
        this.holdings[base] = (this.holdings[base] ?? 0) + (side === 'buy' ? amount : -amount);
      } else {
        orders[id] = { id, type, side, status: 'open', amount, filled: 0, triggerPrice: params.triggerPrice, pair };
      }
      return { ...orders[id] };
    },
    async createMarketOrder(pair, side, amount) { return this.createOrder(pair, 'market', side, amount); },
    async fetchOrder(id) { return { ...orders[id] }; },
    async fetchOpenOrders() { return Object.values(orders).filter((o) => o.status === 'open').map((o) => ({ ...o })); },
    async cancelOrder(id, pair, params) {
      calls.push({ op: 'cancel', id, pair, params });
      if (this.failCancel) throw new Error(this.failCancel);
      const o = orders[id];
      if (!o || o.status !== 'open') throw new ccxt.OrderNotFound('No order found');
      o.status = 'canceled';
      return { id };
    },
    // Bitvavo voert de stop-order uit (bijv. terwijl de bot offline was).
    trigger(id) {
      const o = orders[id];
      const p = o.triggerPrice * 0.998;
      Object.assign(o, { status: 'closed', filled: o.amount, average: p, cost: o.amount * p, fee: { currency: 'EUR', cost: o.amount * p * 0.0025 } });
      const base = o.pair.split('/')[0];
      this.holdings[base] = (this.holdings[base] ?? 0) - o.amount;
    },
  };
  return ex;
}

function setupLive({ mode = 'live', risk = {}, strategy = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-safety-'));
  const ex = fakeBitvavo();
  const baseRisk = { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 5, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25, cooldownMinutes: 0, aiExitMinPct: 0, ...risk };
  const config = { timeframe: '1h', strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100, maxChasePct: 0, ...strategy }, risk: baseRisk, ai: { provider: 'none', failMode: 'reject' } };
  const settings = new Settings(dir, { liveTrading: mode === 'live', pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, risk: baseRisk, strategy: config.strategy, ai: { provider: 'none', model: '', baseUrl: '' } });
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const bot = new Bot({ config, exchange: ex, settings, stores, log: quiet, brokers: { paper: new PaperBroker(ex, 0.25), live: new LiveBroker(ex) } });
  const sent = [];
  bot.notifier = { send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  return { bot, ex, sent, dir };
}

async function openPosition(bot, ex) {
  for (let n = 41; n <= 44 && !bot.store.state.positions['BTC/EUR']; n++) {
    ex.prices = crossPrices(n);
    await bot.tick();
  }
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, `positie geopend: ${bot.pairStatus['BTC/EUR']?.reason}`);
  return pos;
}

const stopCalls = (ex) => ex.calls.filter((c) => c.op === 'create' && c.type === 'stopLoss');
const marketSells = (ex) => ex.calls.filter((c) => c.op === 'create' && c.type === 'market' && c.side === 'sell');

test('exchange-stop: na een live aankoop een stop-loss-order bij Bitvavo op de stop-loss, met operatorId en de volle hoeveelheid', async () => {
  const { bot, ex, sent } = setupLive();
  const pos = await openPosition(bot, ex);
  const [c] = stopCalls(ex);
  assert.ok(c, 'stop-order geplaatst');
  assert.equal(c.side, 'sell');
  assert.equal(c.price, undefined, 'market-stop: geen limietprijs');
  assert.equal(c.params.operatorId, OPERATOR_ID);
  assert.equal(c.params.triggerType, 'price');
  assert.equal(c.params.triggerReference, 'lastTrade');
  assert.equal(c.params.triggerPrice, +(pos.entryPrice * 0.95).toPrecision(6), 'stop op instap − 5%');
  assert.equal(c.amount, Math.floor(pos.amount * 1e8) / 1e8, 'hele positie, afgerond op de precisie');
  assert.equal(pos.exchangeStop.orderId, 'o2');
  assert.equal(pos.exchangeStop.stopPrice, c.params.triggerPrice);
  assert.ok(Date.parse(pos.exchangeStop.placedAt) > 0);
  assert.equal(sent.filter((s) => s.event === 'errors').length, 0, `geen fouten: ${JSON.stringify(sent.filter((s) => s.event === 'errors'))}`);
  const st = bot.safetyStatus();
  assert.equal(st.mode, 'live');
  assert.equal(st.exchangeStop.enabled, true);
  assert.deepEqual(st.exchangeStop.positions[0], { pair: 'BTC/EUR', orderId: 'o2', stopPrice: c.params.triggerPrice, placedAt: pos.exchangeStop.placedAt, status: 'actief', error: null });
  // De saldocontrole liep bij de eerste live check en vond niets.
  assert.equal(st.reconcile.ok, true, JSON.stringify(st.reconcile));
  assert.deepEqual(st.reconcile.issues, []);
  assert.ok(Date.parse(st.nextReconcileAt) - Date.parse(st.reconcile.at) >= SAFETY.reconcileMs - 1000);
});

test('exchange-stop: bij de AI-trader de veiligheidsstop van het recept', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  // Zonder de kleinste live-start (€ 5): een stop van € 4,60 zou onder het minimum van Bitvavo vallen.
  const { bot, ex } = setupLive({ strategy: { agentMode: 1, agentVeto: 0, agentLiveSmallStart: 0 } });
  const agent = { ...fx.agent, stage: 'bewezen', recipeKey: 'R', safetyStopPct: 8, liveCheck: { allMet: true, checks: [] }, entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 },
    exit: { ...fx.agent.exit, init: fx.agent.exit.init + 50 }, regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } } };
  bot.getAgent = () => agent;
  bot.settings.setAgentLive('R', true);
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, bot.pairStatus['BTC/EUR']?.reason);
  const [c] = stopCalls(ex);
  assert.equal(c.params.triggerPrice, +(pos.entryPrice * 0.92).toPrecision(6), 'noodstop van het recept (8%), niet de stop-loss van 5%');
  assert.equal(pos.exchangeStop.orderId, c && 'o2');
});

test('exchange-stop: vóór elke eigen verkoop eerst annuleren (en controleren), daarna pas verkopen', async () => {
  const { bot, ex } = setupLive();
  await openPosition(bot, ex);
  const id = bot.store.state.positions['BTC/EUR'].exchangeStop.orderId;
  ex.calls.length = 0;
  await bot.closeManual('BTC/EUR');
  assert.deepEqual(ex.calls.map((c) => `${c.op}:${c.type ?? c.id}`), [`cancel:${id}`, 'create:market'], 'eerst annuleren, dan verkopen');
  assert.equal(ex.calls[0].params.operatorId, OPERATOR_ID);
  assert.equal(ex.orders[id].status, 'canceled');
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.equal(bot.store.state.trades[0].exitReason, 'Handmatig gesloten');
  // Ook bij de stop-loss van de bot zelf (bewaking tussen de checks).
  const b = setupLive();
  await openPosition(b.bot, b.ex);
  b.ex.calls.length = 0;
  b.ex.prices = [...b.ex.prices.slice(0, -1), b.ex.prices.at(-1) * 0.97];
  await b.bot.setRisk({ stopLossPct: 2 });
  assert.equal(await b.bot.watchPositions(), 1);
  assert.deepEqual(b.ex.calls.map((c) => c.op), ['cancel', 'create']);
  assert.match(b.bot.store.state.trades[0].exitReason, /^Stop-loss \(/);
});

test('exchange-stop: al uitgevoerd bij Bitvavo → afsluiten met die uitvoering, NIET nog eens verkopen', async () => {
  const { bot, ex, sent } = setupLive();
  const pos = await openPosition(bot, ex);
  const id = pos.exchangeStop.orderId;
  ex.trigger(id);
  await bot.closeManual('BTC/EUR');
  assert.equal(marketSells(ex).length, 0, 'geen tweede verkoop');
  const t = bot.store.state.trades[0];
  assert.equal(t.exitReason, 'Stop-loss bij Bitvavo');
  assert.ok(Math.abs(t.exitPrice - ex.orders[id].average) < 1e-9, 'echte prijs van de stop-order');
  assert.ok(t.feesEur > pos.entryFeeEur, 'fee van de stop-order telt mee');
  assert.ok(sent.some((s) => s.event === 'stoploss'));
});

test('exchange-stop: annuleren onzeker (order staat nog open) → niet verkopen, positie blijft', async () => {
  const { bot, ex } = setupLive();
  await openPosition(bot, ex);
  ex.failCancel = 'netwerkfout';
  await assert.rejects(bot.closeManual('BTC/EUR'), /kon niet geannuleerd worden/);
  assert.equal(marketSells(ex).length, 0);
  assert.ok(bot.store.state.positions['BTC/EUR'].exchangeStop.orderId, 'stop-order blijft de positie beschermen');
});

test('exchange-stop: uitgevoerd terwijl de bot de positie open had → bij de volgende check afsluiten, met melding', async () => {
  const { bot, ex, sent } = setupLive();
  const pos = await openPosition(bot, ex);
  ex.trigger(pos.exchangeStop.orderId);
  bot.stopCheckedAt = {};
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  const t = bot.store.state.trades[0];
  assert.equal(t.exitReason, 'Stop-loss bij Bitvavo');
  assert.equal(marketSells(ex).length, 0, 'niet zelf nog eens verkocht');
  assert.ok(sent.some((s) => s.event === 'stoploss' && /Stop-loss/.test(s.title)));
  const rows = bot.journal.db.prepare('SELECT exit_reason FROM trades').all();
  assert.equal(rows.at(-1).exit_reason, 'Stop-loss bij Bitvavo', 'in het leerdagboek zoals een gewone verkoop');
  // Hooguit elke minuut per positie bij Bitvavo kijken.
  const b = setupLive();
  const p2 = await openPosition(b.bot, b.ex);
  let fetches = 0;
  const fo = b.ex.fetchOrder.bind(b.ex);
  b.ex.fetchOrder = async (...a) => { fetches++; return fo(...a); };
  await b.bot.tick();
  await b.bot.tick();
  assert.equal(fetches, 0, 'binnen een minuut niet opnieuw');
  assert.ok(p2.exchangeStop.orderId);
});

test('exchange-stop: plaatsen mislukt → positie blijft bewaakt, één melding, hooguit elke 10 minuten opnieuw', async () => {
  const { bot, ex, sent } = setupLive();
  ex.failStop = 'Bitvavo: order geweigerd';
  const pos = await openPosition(bot, ex);
  assert.equal(pos.exchangeStop.orderId, null);
  assert.match(pos.exchangeStop.error, /order geweigerd/);
  assert.equal(sent.filter((s) => /Stop-order bij Bitvavo mislukt/.test(s.title)).length, 1);
  assert.equal(bot.safetyStatus().exchangeStop.positions[0].status, 'mislukt');
  const n = stopCalls(ex).length;
  await bot.tick();
  assert.equal(stopCalls(ex).length, n, 'binnen 10 minuten geen nieuwe poging');
  pos.exchangeStop.attemptAt = new Date(Date.now() - 11 * 60000).toISOString();
  await bot.tick();
  assert.equal(stopCalls(ex).length, n + 1, 'na 10 minuten één nieuwe poging');
  assert.equal(sent.filter((s) => /Stop-order bij Bitvavo mislukt/.test(s.title)).length, 1, 'melding maar één keer per positie');
  // Lukt het later wel, dan staat hij actief.
  ex.failStop = null;
  pos.exchangeStop.attemptAt = new Date(Date.now() - 11 * 60000).toISOString();
  await bot.tick();
  assert.equal(bot.safetyStatus().exchangeStop.positions[0].status, 'actief');
  // De eigen noodstop van de bot werkt gewoon door.
  assert.ok(bot.store.state.positions['BTC/EUR']);
});

test('exchange-stop: onder het minimum van Bitvavo niet plaatsen, wel loggen', async () => {
  const { bot, ex } = setupLive();
  ex.markets['BTC/EUR'].limits.amount.min = 1000;
  const pos = await openPosition(bot, ex);
  assert.equal(stopCalls(ex).length, 0);
  assert.match(pos.exchangeStop.skipped, /onder het minimum/);
  assert.ok(bot.activity.some((a) => /Geen stop-order bij Bitvavo gezet/.test(a.message)));
  assert.equal(bot.safetyStatus().exchangeStop.positions[0].status, 'geen');
});

test('exchange-stop: in paper niets bij Bitvavo; instelling uit of geen stop-loss → geen stop-order', async () => {
  const paper = setupLive({ mode: 'paper' });
  await openPosition(paper.bot, paper.ex);
  assert.equal(stopCalls(paper.ex).length, 0);
  assert.equal(paper.bot.store.state.positions['BTC/EUR'].exchangeStop, undefined);
  const ps = paper.bot.safetyStatus();
  assert.equal(ps.exchangeStop.enabled, false);
  assert.equal(ps.exchangeStop.positions[0].status, 'n.v.t.');
  assert.equal(ps.reconcile, null);
  assert.equal(ps.nextReconcileAt, null);
  assert.equal(await paper.bot.reconcile(), null, 'saldocontrole alleen live');

  const off = setupLive();
  assert.equal(off.bot.settings.risk.exchangeStop, 1, 'staat standaard aan');
  await off.bot.setRisk({ exchangeStop: 0 });
  await openPosition(off.bot, off.ex);
  assert.equal(stopCalls(off.ex).length, 0);
  assert.equal(off.bot.safetyStatus().exchangeStop.enabled, false);
  assert.equal(off.bot.safetyStatus().exchangeStop.positions[0].status, 'geen');
  assert.throws(() => off.bot.settings.setRisk({ exchangeStop: 2 }), /Stop-loss ook bij Bitvavo zetten \(live\) moet tussen 0 en 1/);

  const none = setupLive({ risk: { stopLossPct: 0 } });
  await openPosition(none.bot, none.ex);
  assert.equal(stopCalls(none.ex).length, 0, 'zonder stop-loss ook geen stop bij Bitvavo');
});

test('saldocontrole: mist, extra en stop-mist melden, niets automatisch verhandelen; uitgevoerde stop met lege coin → afsluiten', async () => {
  const { bot, ex, sent } = setupLive();
  const pos = await openPosition(bot, ex);
  assert.equal(bot.store.state.reconcile.ok, true);
  // Handmatig de helft verkocht bij Bitvavo, eigen ETH erbij en de stop-order weg.
  ex.holdings.BTC = pos.amount / 2;
  ex.extraBalance = { ETH: 0.01, DOGE: 0.000001 };
  ex.markets['ETH/EUR'] = { symbol: 'ETH/EUR', base: 'ETH', quote: 'EUR', spot: true };
  ex.markets['DOGE/EUR'] = { symbol: 'DOGE/EUR', base: 'DOGE', quote: 'EUR', spot: true };
  pos.exchangeStop = { orderId: null, stopPrice: 1, placedAt: null, error: 'geweigerd', attemptAt: new Date().toISOString() };
  ex.calls.length = 0;
  sent.length = 0;
  const r = await bot.reconcile();
  assert.equal(r.ok, false);
  const kinds = r.issues.map((i) => `${i.pair}:${i.kind}`).sort();
  assert.deepEqual(kinds, ['BTC/EUR:mist', 'BTC/EUR:stop-mist', 'ETH/EUR:extra'], 'DOGE onder € 1 niet');
  const mist = r.issues.find((i) => i.kind === 'mist');
  assert.equal(mist.botAmount, +pos.amount.toPrecision(8));
  assert.equal(mist.exchangeAmount, +(pos.amount / 2).toPrecision(8));
  assert.ok(mist.note);
  assert.deepEqual(ex.calls.filter((c) => c.op !== 'fetch'), [], 'geen orders geplaatst of geannuleerd');
  assert.ok(bot.store.state.positions['BTC/EUR'], 'positie niet automatisch gesloten');
  assert.deepEqual(bot.store.state.reconcile, r);
  assert.equal(sent.filter((s) => /Saldocontrole/.test(s.title)).length, 1);
  // Dezelfde afwijkingen nog eens: geen nieuwe melding.
  await bot.reconcile();
  assert.equal(sent.filter((s) => /Saldocontrole/.test(s.title)).length, 1, 'alleen melden wat nieuw is');
  // Binnen 24 uur doet de check zelf geen nieuwe saldocontrole.
  const at = bot.store.state.reconcile.at;
  await bot.tick();
  assert.equal(bot.store.state.reconcile.at, at);

  // Coin helemaal weg én de stop-order aantoonbaar uitgevoerd → afsluiten met die uitvoering.
  const b = setupLive();
  const p2 = await openPosition(b.bot, b.ex);
  b.ex.trigger(p2.exchangeStop.orderId);
  b.bot.stopCheckedAt = { 'BTC/EUR': Date.now() }; // de check per minuut nog niet aan de beurt
  const r2 = await b.bot.reconcile();
  assert.equal(b.bot.store.state.positions['BTC/EUR'], undefined);
  assert.deepEqual(r2.closed, ['BTC/EUR']);
  assert.equal(r2.ok, true);
  assert.equal(b.bot.store.state.trades[0].exitReason, 'Stop-loss bij Bitvavo');
  assert.equal(marketSells(b.ex).length, 0);
  // Coin weg zonder uitgevoerde stop (handmatig verkocht): alleen melden.
  const c = setupLive();
  await openPosition(c.bot, c.ex);
  c.ex.holdings.BTC = 0;
  const r3 = await c.bot.reconcile();
  assert.ok(c.bot.store.state.positions['BTC/EUR']);
  assert.match(r3.issues.find((i) => i.kind === 'mist').note, /niet \(meer\) op Bitvavo/);
});

test('saldocontrole: zonder keys of bij een fout een uitkomst met de fout, één melding', async () => {
  const { bot, ex, sent } = setupLive();
  ex.fetchBalance = async () => { throw new Error('rate limit'); };
  const r = await bot.reconcile();
  assert.equal(r.ok, false);
  assert.match(r.error, /rate limit/);
  await bot.reconcile();
  assert.equal(sent.filter((s) => s.title === 'Saldocontrole bij Bitvavo mislukt').length, 1);
});

test('compareBalances en exchangeStopPrice: tolerantie, precisie en de soort stop', () => {
  const positions = { 'BTC/EUR': { pair: 'BTC/EUR', amount: 0.1, exchangeStop: { orderId: 'x' } } };
  const markets = { 'BTC/EUR': { precision: { amount: 1e-8 } } };
  const ok = compareBalances({ positions, balance: { total: { BTC: 0.0995, EUR: 3 } }, markets, precisionMode: 4, openStops: new Set(['x']) });
  assert.deepEqual(ok, [], 'binnen 1% (fees/afronding)');
  const miss = compareBalances({ positions, balance: { total: { BTC: 0.098 } }, markets, precisionMode: 4, openStops: new Set(['x']) });
  assert.equal(miss[0].kind, 'mist');
  assert.equal(miss[0].gone, false);
  const gone = compareBalances({ positions, balance: { BTC: { total: 0 } }, markets, openStops: new Set() });
  assert.deepEqual(gone.map((i) => i.kind), ['mist', 'stop-mist'], 'stop-order staat niet meer open');
  assert.equal(gone[0].gone, true);
  assert.deepEqual(compareBalances({ positions, balance: { total: { BTC: 0.1 } }, openStops: null, stopOn: false }), []);
  assert.equal(amountUnit({ precision: { amount: 1e-8 } }, 4), 1e-8);
  assert.equal(amountUnit({ precision: { amount: 3 } }, 2), 0.001);
  assert.equal(exchangeStopPrice({ entryPrice: 100, plan: { stopLossPct: 10 } }, { stopLossPct: 3 }), 90);
  assert.equal(exchangeStopPrice({ entryPrice: 100, atrAtEntry: 2 }, { stopLossPct: 3, atrStopMult: 2 }), 96);
  assert.equal(exchangeStopPrice({ entryPrice: 100 }, { stopLossPct: 3 }), 97);
  assert.equal(exchangeStopPrice({ entryPrice: 100 }, { stopLossPct: 0 }), null);
  assert.equal(exchangeStopPrice({ entryPrice: 100, plan: { stopLossPct: 0 } }, { stopLossPct: 3 }), null);
});

test('LiveBroker: stop-order plaatsen, annuleren en uitgevoerd ophalen', async () => {
  const ex = fakeBitvavo();
  const b = new LiveBroker(ex);
  const r = await b.placeStop('BTC/EUR', 0.123456789, 91.23456);
  assert.deepEqual(r, { orderId: 'o1', stopPrice: 91.2346, amount: 0.12345678 });
  assert.deepEqual(ex.calls[0], { op: 'create', pair: 'BTC/EUR', type: 'stopLoss', side: 'sell', amount: 0.12345678, price: undefined,
    params: { triggerPrice: 91.2346, triggerType: 'price', triggerReference: 'lastTrade', operatorId: OPERATOR_ID } });
  assert.deepEqual(await b.fetchStop('BTC/EUR', 'o1'), { state: 'open', filled: 0, fill: null });
  assert.equal((await b.cancelStop('BTC/EUR', 'o1')).state, 'canceled');
  const r2 = await b.placeStop('BTC/EUR', 0.1, 90);
  ex.trigger(r2.orderId);
  const st = await b.cancelStop('BTC/EUR', r2.orderId);
  assert.equal(st.state, 'filled');
  assert.equal(st.filled, 0.1);
  assert.ok(Math.abs(st.fill.price - 90 * 0.998) < 1e-9);
  assert.ok(st.fill.feeEur > 0 && st.fill.costEur < 0.1 * 90);
  assert.deepEqual(await b.placeStop('BTC/EUR', 0.00001, 90), { skipped: 'hoeveelheid 0.00001 ligt onder het minimum van Bitvavo (0.0001)' });
  // Onder de minimale orderwaarde van Bitvavo (€ 5): niet plaatsen, geen eindeloze nieuwe pogingen.
  const before = ex.calls.length;
  const small = await b.placeStop('BTC/EUR', 0.05, 90);
  assert.match(small.skipped, /onder het minimum van Bitvavo \(€ 5\.00\)/);
  assert.equal(ex.calls.length, before, 'geen order naar Bitvavo');
});

// ---------- Strategy Agent: volatiliteit ----------
const agentFx = () => JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
const losing = { hoog: { trades: 40, avgPct: -0.3 }, normaal: { trades: 40, avgPct: -0.3 }, laag: { trades: 40, avgPct: -0.3 } };
const winning = { hoog: { trades: 40, avgPct: 0.2 }, normaal: { trades: 40, avgPct: 0.2 }, laag: { trades: 40, avgPct: 0.2 } };
function greedy(extra = {}) {
  const fx = agentFx();
  return { ...fx.agent, stage: 'getest', recipeKey: 'R', entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 },
    exit: { ...fx.agent.exit, init: fx.agent.exit.init + 50 }, regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } }, ...extra };
}
async function agentRun(agent, strategy = {}) {
  const { bot, ex } = setupLive({ mode: 'paper', strategy: { agentMode: 1, agentVeto: 0, agentExplore: 0, ...strategy } });
  bot.getAgent = () => agent;
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  return bot;
}

test('Strategy Agent: recept verloor in deze volatiliteit → niet kopen (stage pauze); uit of zonder volStats → zoals nu', async () => {
  const blocked = await agentRun(greedy({ volStats: losing }));
  assert.equal(blocked.store.state.positions['BTC/EUR'], undefined);
  assert.match(blocked.pairStatus['BTC/EUR'].reason, /^Strategy Agent: in (hoge|normale|lage) volatiliteit verloor dit recept \(40 trades, gem\. −0,30%\)$/);
  const row = blocked.journal.db.prepare("SELECT stage, kind, vol_regime FROM decisions ORDER BY id DESC").get();
  assert.equal(row.stage, 'pauze');
  assert.equal(row.kind, 'agent');
  assert.ok(row.vol_regime);
  assert.equal(blocked.store.state.agentChats[0].outcome, 'blocked');
  // Te weinig trades in dat regime, of geen volStats: gewoon kopen.
  assert.ok((await agentRun(greedy({ volStats: { hoog: { trades: 29, avgPct: -1 }, normaal: { trades: 29, avgPct: -1 }, laag: { trades: 29, avgPct: -1 } } }))).store.state.positions['BTC/EUR']);
  assert.ok((await agentRun(greedy())).store.state.positions['BTC/EUR'], 'oude leerserver zonder volStats');
  assert.ok((await agentRun(greedy({ volStats: losing }), { agentVolGuard: 0 })).store.state.positions['BTC/EUR'], 'instelling uit');
});

test('Strategy Agent: ander toegestaan recept dat in deze volatiliteit niet verliest → dat recept, met uitleg', async () => {
  const alt = { ...greedy({ recipeKey: 'R2', volStats: winning }), regimes: undefined };
  const main = greedy({ volStats: losing, regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' }, extra: { key: 'R2', agent: alt } } });
  const bot = await agentRun(main);
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, bot.pairStatus['BTC/EUR']?.reason);
  assert.equal(pos.agent.recipe, 'R2');
  const talk = bot.store.state.agentChats.find((c) => c.talk.some((m) => /ik gebruik recept R2, dat daar niet verliest/.test(m.text)));
  assert.ok(talk, 'uitleg in het overleg');
  // Het andere recept mag niet (geblokkeerd): dan niet kopen.
  const altBad = { ...alt, stage: 'geblokkeerd' };
  const bot2 = await agentRun({ ...main, regimes: { ...main.regimes, extra: { key: 'R2', agent: altBad } } });
  assert.equal(bot2.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot2.pairStatus['BTC/EUR'].reason, /verloor dit recept/);
});

test('bot: gelabelde afgewezen kansen sturen de verwachting bij (pas vanaf genoeg, alleen vastgestelde labels)', async () => {
  const { bot } = setupLive({ mode: 'paper' });
  const j = bot.journal;
  const now = Date.now();
  const add = (n, settledAt) => {
    for (let i = 0; i < n; i++) {
      const id = j.record({ at: now - 2 * 86400000 + i * 60000, mode: 'paper', pair: 'BTC/EUR', price: 100, kind: 'agent', outcome: 'rejected', stage: 'risk',
        recipe: 'R', expectedPct: 0.3, rule: { type: 'ai-trader', expectedPct: 0.3 } });
      j.db.prepare('INSERT INTO labels (decision_id, horizon_min, ret_pct, mfe_pct, mae_pct, settled_at) VALUES (?, 240, 1.3, 0, 0, ?)').run(id, settledAt);
    }
  };
  add(20, now - 3600000);
  add(20, now + 3600000); // label "uit de toekomst": telt nu nog niet mee
  await bot.tick();
  assert.equal(bot.agentTeam().learning.rejected, 0, '20 vastgestelde labels: te weinig');
  add(15, now - 3600000);
  bot.rejCache = null;
  await bot.tick();
  const l = bot.agentTeam().learning;
  assert.equal(l.rejected, 35);
  assert.ok(l.bins.some((b) => b.adj > 0), 'gemiste kansen sturen omhoog');
});

// ---------- Melding bij automatisch terugvallen ----------
test('notice van de leerserver: model teruggedraaid → één melding per notice.at, ook na een herstart', async () => {
  const { bot, ex, sent, dir } = setupLive({ mode: 'paper' });
  const notice = { kind: 'probation-failed', version: 'v7', restoredVersion: 'v6', reason: 'Proefperiode: −0,4% per trade over 25 trades', at: '2026-11-20T10:00:00Z' };
  bot.getAgent = () => ({ ...greedy(), notice });
  await bot.tick();
  await bot.tick();
  const m = sent.filter((s) => s.title === 'AI-trader: nieuw model teruggedraaid');
  assert.equal(m.length, 1);
  assert.equal(m[0].event, 'strategy');
  assert.match(m[0].message, /Proefperiode: −0,4% per trade/);
  assert.match(m[0].message, /v6/);
  assert.ok(bot.activity.some((a) => a.level === 'warn' && /nieuw model teruggedraaid/.test(a.message)));
  // Herstart: nieuwe bot op dezelfde map meldt niet opnieuw.
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const bot2 = new Bot({ config: bot.config, exchange: ex, settings: bot.settings, stores, log: quiet, brokers: bot.brokers });
  const sent2 = [];
  bot2.notifier = { send: async (event, payload) => { sent2.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  bot2.getAgent = () => ({ ...greedy(), notice });
  await bot2.tick();
  assert.equal(sent2.filter((s) => s.title === 'AI-trader: nieuw model teruggedraaid').length, 0);
  // Een nieuwe notice wel.
  bot2.getAgent = () => ({ ...greedy(), notice: { ...notice, at: '2026-11-24T10:00:00Z' } });
  await bot2.tick();
  assert.equal(sent2.filter((s) => s.title === 'AI-trader: nieuw model teruggedraaid').length, 1);
  // Andere soort notice of zonder at: niets.
  bot2.getAgent = () => ({ ...greedy(), notice: { kind: 'iets-anders', at: '2026-11-25T10:00:00Z' } });
  await bot2.tick();
  assert.equal(sent2.filter((s) => s.title === 'AI-trader: nieuw model teruggedraaid').length, 1);
});
