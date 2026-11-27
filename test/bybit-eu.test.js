import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket, PaperBroker } from '../src/exchange.js';
import { BybitLiveBroker } from '../src/bybit-broker.js';
import { Settings } from '../src/settings.js';
import { quoteFor, quoteOf, toVenuePair, toBasePair, venueAgent, QuoteRate, BYBIT_QUOTES, venueCostPct } from '../src/venue.js';

// Bybit EU en Bybit NL: geen USDT-paren (MiCA), daar handelt de bot in USDC. bybit.com blijft USDT.
// Geen netwerk: nep-beurzen per website.

const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };
const H = 3600000;

function fakeVenue(prices) {
  const pairs = Object.keys(prices);
  return {
    calls: [],
    markets: Object.fromEntries(pairs.map((p) => [p, { symbol: p, base: p.split('/')[0], quote: p.split('/')[1], spot: true, active: true }])),
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV(p, _tf, _s, limit) {
      this.calls.push(['ohlcv', p]);
      if (!(p in prices)) throw new Error(`bybit does not have market symbol ${p}`);
      const c = prices[p];
      const base = Math.floor(Date.now() / H) * H - 50 * H;
      return [...Array(50)].map((_, i) => [base + i * H, c, c, c, c, 10]).slice(-limit);
    },
    async fetchTicker(p) {
      this.calls.push(['ticker', p]);
      if (!(p in prices)) throw new Error(`bybit does not have market symbol ${p}`);
      return { last: prices[p] };
    },
    async fetchTickers(ps) { return Object.fromEntries(ps.filter((p) => p in prices).map((p) => [p, { last: prices[p], quoteVolume: 1000, percentage: 1 }])); },
  };
}

function config(dir) {
  return {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR', 'SOL/EUR', 'PEPE/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25, makerFeePct: 0.15, cooldownMinutes: 0, slippagePct: 0 },
    strategy: {},
    ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
}

// bybit.com: USDT-paren (PEPE ook); Bybit EU: alleen USDC- en EUR-paren, en geen PEPE.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-eu-'));
  const users = new Users(dir);
  const { user: admin } = users.setup({ username: 'justin', password: PW, code: users.setupCode }, 'x');
  const bitvavo = fakeVenue({ 'BTC/EUR': 90000, 'SOL/EUR': 150, 'PEPE/EUR': 0.00001 });
  const com = fakeVenue({ 'BTC/USDT': 100000, 'SOL/USDT': 200, 'PEPE/USDT': 0.00001, 'USDT/EUR': 0.9, 'BTC/USDC': 100010 });
  const eu = fakeVenue({ 'BTC/USDC': 100000, 'SOL/USDC': 200, 'ETH/USDC': 4000, 'EUR/USDC': 1.25, 'BTC/EUR': 80000 });
  const balances = { bybit: { USDT: { free: 1, total: 1 }, USDC: { free: 20, total: 20 }, EUR: { free: 3, total: 3 } } };
  const manager = new BotManager({
    config: config(dir), users, log: quiet, shared: new SharedMarket(bitvavo),
    sharedVenues: { bybit: new SharedMarket(com), 'bybit|bybit.eu': new SharedMarket(eu), 'bybit|bybit.nl': new SharedMarket(eu) },
    makePrivateExchange: (secrets, venue) => {
      const k = venue === 'bybit' ? 'bybit' : 'bitvavo';
      return {
        get apiKey() { return secrets.get(`${k}ApiKey`) || undefined; },
        get secret() { return secrets.get(`${k}ApiSecret`) || undefined; },
        async loadMarkets() { return {}; },
        async fetchBalance() { return venue === 'bybit' ? balances.bybit : { EUR: { free: 40, total: 40 } }; },
        async createOrder() { throw new Error(`createOrder op ${venue} aangeroepen`); },
      };
    },
  });
  return { dir, users, admin, manager, bitvavo, com, eu };
}

test('quote per website: bybit.com USDT, Bybit EU/NL USDC, Bitvavo EUR', () => {
  assert.deepEqual(BYBIT_QUOTES, { 'bybit.com': 'USDT', 'bybit.eu': 'USDC', 'bybit.nl': 'USDC' });
  assert.equal(quoteFor('bitvavo'), 'EUR');
  assert.equal(quoteFor('bitvavo', 'bybit.eu'), 'EUR', 'host telt alleen op Bybit');
  assert.equal(quoteFor('bybit'), 'USDT');
  assert.equal(quoteFor('bybit', 'bybit.com'), 'USDT');
  assert.equal(quoteFor('bybit', 'bybit.eu'), 'USDC');
  assert.equal(quoteFor('bybit', 'bybit.nl'), 'USDC');
  assert.equal(quoteFor('bybit', 'onzin'), 'USDT');
  assert.equal(quoteOf('bybit'), 'USDT', 'oude naam zonder host: zoals altijd');
});

test('paar-vertaling met USDC: X/EUR ↔ X/USDC op Bybit EU, terug naar X/EUR; bybit.com ongewijzigd', () => {
  assert.equal(toVenuePair('SOL/EUR', 'bybit', 'bybit.eu'), 'SOL/USDC');
  assert.equal(toVenuePair('SOL/USDT', 'bybit', 'bybit.eu'), 'SOL/USDC', 'opgeslagen USDT-coin op EU');
  assert.equal(toVenuePair('SOL/USDC', 'bybit', 'bybit.nl'), 'SOL/USDC');
  assert.equal(toVenuePair('SOL/PLN', 'bybit', 'bybit.eu'), 'SOL/PLN', 'onbekende quote blijft');
  // bybit.com: precies zoals altijd (BTC/USDC is daar een eigen markt).
  assert.equal(toVenuePair('SOL/EUR', 'bybit', 'bybit.com'), 'SOL/USDT');
  assert.equal(toVenuePair('BTC/USDC', 'bybit', 'bybit.com'), 'BTC/USDC');
  assert.equal(toVenuePair('BTC/USDC', 'bybit'), 'BTC/USDC');
  // Terug naar de naam van de leerserver: elke bekende quote.
  assert.equal(toBasePair('SOL/USDC'), 'SOL/EUR');
  assert.equal(toBasePair('SOL/USDT'), 'SOL/EUR');
  assert.equal(toBasePair('SOL/EUR'), 'SOL/EUR');
  assert.equal(toVenuePair('SOL/USDC', 'bitvavo'), 'SOL/EUR');
  // Kosten per coin van de leerserver (X/EUR) vinden ook bij X/USDC.
  const agent = { venueCosts: { bybit: { costs: { 'SOL/EUR': 0.33 }, default: 0.2 } } };
  assert.equal(venueCostPct(agent, 'SOL/USDC', 'bybit'), 0.33);
});

test('AI-trader-coins: X/EUR wordt X/USDC op Bybit EU (ook recepten per fase en extra recepten)', () => {
  const extra = { recipeKey: 'b', coins: ['ETH/EUR'] };
  const agent = { recipeKey: 'a', coins: ['SOL/EUR', 'BTC/EUR'], regimes: { bull: { agent: extra, coins: ['SOL/EUR'] } }, extras: [extra] };
  const eu = venueAgent(agent, 'bybit', 'bybit.eu');
  assert.deepEqual(eu.coins, ['SOL/USDC', 'BTC/USDC']);
  assert.deepEqual(eu.regimes.bull.coins, ['SOL/USDC']);
  assert.deepEqual(eu.regimes.bull.agent.coins, ['ETH/USDC']);
  assert.equal(eu.regimes.bull.agent, eu.extras[0], 'zelfde object, zelfde kopie');
  assert.deepEqual(venueAgent(agent, 'bybit').coins, ['SOL/USDT', 'BTC/USDT']);
  assert.equal(venueAgent(agent, 'bitvavo', 'bybit.eu'), agent);
});

test('USDC/EUR-koers: omgekeerd uit EUR/USDC op Bybit EU', async () => {
  const eu = fakeVenue({ 'EUR/USDC': 1.25 });
  const r = new QuoteRate(eu, 'bybit', { host: 'bybit.eu' });
  assert.equal(r.quote, 'USDC');
  assert.ok(Math.abs((await r.eurPerQuote()) - 0.8) < 1e-12);
  assert.equal(r.info().source, 'EUR/USDC');
  assert.equal(new QuoteRate(eu, 'bybit').quote, 'USDT', 'zonder host: bybit.com');
});

test('paper op Bybit EU: koop en verkoop in USDC, geboekt in euro', async () => {
  let price = 200;
  const rate = 0.8;
  const ex = { async fetchTicker() { return { last: price }; } };
  const b = new PaperBroker(ex, 0.1, 0, 0.1, { quote: 'USDC', async eurPerQuote() { return rate; } });
  const buy = await b.buy('SOL/USDC', 80);
  // € 80 = 100 USDC; fee 0,1 USDC; 99,9 / 200 SOL.
  assert.equal(buy.quote, 'USDC');
  assert.equal(buy.costEur, 80);
  assert.ok(Math.abs(buy.costQuote - 100) < 1e-9);
  assert.ok(Math.abs(buy.amount - 0.4995) < 1e-12);
  price = 220;
  const sell = await b.sell('SOL/USDC', buy.amount);
  assert.equal(sell.quote, 'USDC');
  assert.ok(Math.abs(sell.costEur - 0.4995 * 220 * 0.999 * 0.8) < 1e-9);
});

test('Bybit EU in de bot: USDC-paren, BTC/USDC, coinlijst, opgeslagen USDT-lijst wordt USDC, paper-trade in euro', async () => {
  const { admin, manager, com, eu } = setup();
  const ctx = manager.ensure(admin);
  const { bot } = ctx;
  await bot.switchVenue('bybit');
  // Eerst op bybit.com een eigen lijst kiezen (USDT), daarna naar Bybit EU.
  await bot.setPairs(['SOL/USDT', 'PEPE/USDT']);
  assert.deepEqual(bot.pairs, ['SOL/USDT', 'PEPE/USDT']);
  assert.equal(bot.quote, 'USDT');
  manager.setBybitHost(admin.id, 'bybit.eu');
  assert.equal(bot.quote, 'USDC');
  assert.equal(bot.btcPair, 'BTC/USDC');
  assert.deepEqual(bot.pairs, ['SOL/USDC', 'PEPE/USDC'], 'opgeslagen USDT-lijst vertaald naar USDC');
  assert.deepEqual(ctx.settings.data.venuePairs.bybit, ['SOL/USDT', 'PEPE/USDT'], 'bestand ongewijzigd');
  assert.deepEqual(new Settings(ctx.dir, config(ctx.dir)).pairsFor('bybit'), ['SOL/USDC', 'PEPE/USDC']);

  // Coinlijst: alleen USDC-markten van Bybit EU, volume in euro (1 USDC = € 0,80).
  const markets = await bot.listMarkets();
  assert.deepEqual(markets.map((m) => m.pair).sort(), ['BTC/USDC', 'ETH/USDC', 'SOL/USDC']);
  assert.ok(markets.every((m) => m.quote === 'USDC'));
  assert.ok(Math.abs(markets[0].volumeEur - 800) < 1e-9);
  assert.equal(bot.fx.quote, 'USDC');
  assert.equal(bot.broker.fx.quote, 'USDC');
  assert.equal(bot.brokers.live.quote, 'USDC');

  // Paper-aankoop in USDC, waarde en verkoop in euro.
  const fill = await bot.broker.buy('SOL/USDC', 80);
  assert.equal(fill.quote, 'USDC');
  assert.ok(Math.abs(fill.costQuote - 100) < 1e-9);
  bot.store.state.balanceEur -= fill.costEur;
  bot.store.state.positions['SOL/USDC'] = { pair: 'SOL/USDC', openedAt: new Date().toISOString(), entryPrice: fill.price, amount: fill.amount, costEur: fill.costEur,
    entryFeeEur: fill.feeEur, reason: 'test', highest: fill.price, lowest: fill.price, venue: 'bybit', quote: 'USDC', costQuote: fill.costQuote, entryEurRate: fill.eurRate };
  assert.throws(() => manager.setBybitHost(admin.id, 'bybit.com'), /posities open op Bybit/);
  const trade = await bot.closeManual('SOL/USDC');
  assert.equal(trade.quote, 'USDC');
  assert.ok(Math.abs(trade.pnlEur - (fill.amount * 200 * 0.999 * 0.8 - 80)) < 1e-9);

  // Er ging niets naar bybit.com sinds de wissel naar EU.
  com.calls.length = 0;
  await bot.tick();
  assert.equal(com.calls.length, 0, 'geen verzoeken naar bybit.com');
  assert.ok(eu.calls.some((c) => c[1] === 'SOL/USDC'));
  manager.stopAll();
});

test('check op Bybit EU: coins zonder USDC-markt overgeslagen met één melding; positie blijft bewaakt', async () => {
  const { admin, manager, eu } = setup();
  const ctx = manager.ensure(admin);
  const { bot } = ctx;
  manager.setBybitHost(admin.id, 'bybit.eu');
  await bot.switchVenue('bybit');
  assert.deepEqual(bot.pairs, ['BTC/USDC', 'SOL/USDC', 'PEPE/USDC'], 'Bitvavo-lijst vertaald');
  await bot.tick();
  assert.equal(bot.lastError, null, 'geen fout per coin');
  assert.ok(!eu.calls.some((c) => c[1] === 'PEPE/USDC'), 'PEPE niet opgevraagd');
  assert.ok(bot.pairStatus['SOL/USDC'] && bot.pairStatus['BTC/USDC']);
  const notes = () => bot.activity.filter((a) => /bestaa?t(?:n)? niet op Bybit/.test(a.message));
  assert.equal(notes().length, 1);
  assert.match(notes()[0].message, /Deze coin bestaat niet op Bybit \(bybit\.eu\) \(paren in USDC\) en wordt overgeslagen: PEPE\/USDC\./);
  await bot.tick();
  assert.equal(notes().length, 1, 'maar één keer gemeld');

  // AI-trader-coins worden op EU X/USDC en vallen onder dezelfde filter.
  manager.ml.agent = { recipeKey: 'a', timeframe: '1h', coins: ['ETH/EUR', 'DOGE/EUR'], regimes: {} };
  assert.deepEqual(bot.getAgent().coins, ['ETH/USDC', 'DOGE/USDC']);
  ctx.settings.setStrategy({ agentMode: 1 });
  await bot.tick();
  assert.ok(!eu.calls.some((c) => c[1] === 'DOGE/USDC'), 'DOGE niet opgevraagd');
  assert.equal(notes().length, 2);
  assert.match(notes()[0].message, /DOGE\/USDC/);
  assert.doesNotMatch(notes()[0].message, /PEPE/, 'PEPE niet opnieuw gemeld');

  // Een positie in een coin zonder markt wordt nooit uit de check gefilterd.
  bot.store.state.positions['PEPE/USDC'] = { pair: 'PEPE/USDC', amount: 1, entryPrice: 1, costEur: 1, openedAt: new Date().toISOString(), highest: 1, lowest: 1 };
  eu.calls.length = 0;
  await bot.tick();
  assert.ok(eu.calls.some((c) => c[1] === 'PEPE/USDC'), 'positie blijft behandeld');
  manager.stopAll();
});

test('saldo op Bybit EU in USDC (omgerekend naar euro), keys-test toont USDC en euro', async () => {
  const { admin, manager } = setup();
  const ctx = manager.ensure(admin);
  const { bot } = ctx;
  manager.setBybitHost(admin.id, 'bybit.eu');
  await bot.switchVenue('bybit');
  ctx.secrets.update({ bybitApiKey: 'K', bybitApiSecret: 'S' });
  const t = await manager.testKeys(admin.id, 'bybit');
  assert.equal(t.quote, 'USDC');
  assert.equal(t.balances.USDC.free, 20);
  assert.equal(t.balances.USDT.free, 1, 'USDT blijft erbij');
  assert.ok(Math.abs(t.quoteFreeEur - 16) < 1e-9);
  // refreshLiveBalance (alleen met eigen-risico-akkoord; hier alleen lezen, geen order).
  ctx.settings.setVenueLive('bybit', 50);
  const lb = await bot.refreshLiveBalance();
  assert.equal(lb.quote, 'USDC');
  assert.equal(lb.quoteFree, 20);
  assert.ok(Math.abs(lb.eurFree - 16) < 1e-9);
  // bybit.com: zoals altijd USDT.
  ctx.settings.setVenueLive('bybit', null);
  manager.setBybitHost(admin.id, 'bybit.com');
  const t2 = await manager.testKeys(admin.id, 'bybit');
  assert.equal(t2.quote, 'USDT');
  assert.equal('USDC' in t2.balances, false);
  manager.stopAll();
});

test('BybitLiveBroker: quote en meldingen volgen de website (USDC op EU)', async () => {
  const fx = { quote: 'USDC', async eurPerQuote() { return 0.8; } };
  const ex = { apiKey: 'k', secret: 's', markets: { 'SOL/USDC': { symbol: 'SOL/USDC', limits: { cost: { min: 5 } } } }, async loadMarkets() {},
    async createOrder() { throw new Error('mag niet'); } };
  const b = new BybitLiveBroker(ex, fx, { allowed: () => ({ ok: true }) });
  assert.equal(b.quote, 'USDC');
  await assert.rejects(b.buy('SOL/USDC', 2), /inzet 2\.50 USDC \(€ 2\.00\) ligt onder het minimum van SOL\/USDC \(5 USDC\)/);
  assert.equal(new BybitLiveBroker(ex, { eurPerQuote: async () => 1 }).quote, 'USDT', 'zonder quote: USDT');
});

test('volger op Bybit EU volgt een leider op Bitvavo met USDC-paren; feedback X/USDC', async () => {
  const { users, admin, manager } = setup();
  const { user: piet } = users.register({ code: users.createInvite(admin.id).code, username: 'piet', password: PW }, 'y');
  manager.ensure(admin);
  const p = manager.ensure(piet);
  manager.setBybitHost(piet.id, 'bybit.eu');
  await p.bot.switchVenue('bybit');
  p.settings.setFollow(true);
  assert.deepEqual(p.bot.pairs, ['BTC/USDC', 'SOL/USDC', 'PEPE/USDC']);
  p.bot.onFeedback({ kind: 'agentTrade', pair: 'SOL/USDC', pct: 1 });
  const fb = manager.feedbackQueue.at(-1);
  assert.equal(fb.venue, 'bybit');
  manager.stopAll();
});
