import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket, PaperBroker, BlockedLiveBroker } from '../src/exchange.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { VENUES, venueOf, toVenuePair, toBasePair, liveAllowedOnVenue, venueAgent, QuoteRate, EUR_RATE } from '../src/venue.js';

// Bybit fase 1: alleen paper, paren in USDT, bedragen in euro. Geen netwerk: nep-beurzen.

const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };
const H = 3600000;
// Fase 2: live op Bybit kan alleen met een eigen-risico-akkoord; zonder akkoord blijft alles geweigerd.
const LIVE_TEXT = /Live op Bybit kan alleen op eigen risico/;

// Nep-beurs met een vaste koers per paar. USDT/EUR (Bybit) is de omrekenkoers.
function fakeVenue(quote, prices) {
  const pairs = Object.keys(prices);
  return {
    calls: [],
    markets: Object.fromEntries(pairs.map((p) => [p, { symbol: p, base: p.split('/')[0], quote: p.split('/')[1], spot: true, active: true }])),
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV(p, _tf, _s, limit) {
      this.calls.push(['ohlcv', p]);
      const c = prices[p] ?? 1;
      const base = Math.floor(Date.now() / H) * H - 50 * H;
      return [...Array(50)].map((_, i) => [base + i * H, c, c, c, c, 10]).slice(-limit);
    },
    async fetchTicker(p) {
      this.calls.push(['ticker', p]);
      if (!(p in prices)) throw new Error(`geen markt ${p}`);
      return { last: prices[p] };
    },
    async fetchTickers(ps) { return Object.fromEntries(ps.filter((p) => p in prices).map((p) => [p, { last: prices[p], quoteVolume: 1000, percentage: 1 }])); },
  };
}

function config(dir, extra = {}) {
  return {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR', 'SOL/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25, makerFeePct: 0.15, cooldownMinutes: 0, slippagePct: 0 },
    strategy: {},
    ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
    ...extra,
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-'));
  const users = new Users(dir);
  const { user: admin } = users.setup({ username: 'justin', password: PW, code: users.setupCode }, 'x');
  const bitvavo = fakeVenue('EUR', { 'BTC/EUR': 90000, 'SOL/EUR': 150 });
  const bybit = fakeVenue('USDT', { 'BTC/USDT': 100000, 'SOL/USDT': 200, 'USDT/EUR': 0.9 });
  const made = [];
  const manager = new BotManager({
    config: config(dir), users, log: quiet, shared: new SharedMarket(bitvavo), sharedVenues: { bybit: new SharedMarket(bybit) },
    makePrivateExchange: (secrets, venue) => {
      made.push(venue);
      const k = venue === 'bybit' ? 'bybit' : 'bitvavo';
      return {
        get apiKey() { return secrets.get(`${k}ApiKey`) || undefined; },
        get secret() { return secrets.get(`${k}ApiSecret`) || undefined; },
        async loadMarkets() { return {}; },
        async fetchBalance() { return venue === 'bybit' ? { USDT: { free: 12.5, total: 12.5 }, EUR: { free: 3, total: 3 } } : { EUR: { free: 40, total: 40 } }; },
        // Een echte order mag in fase 1 nooit naar Bybit gaan.
        async createOrder() { throw new Error(`createOrder op ${venue} aangeroepen`); },
      };
    },
  });
  return { dir, users, admin, manager, bitvavo, bybit, made };
}

// ---------- Paar-vertaling en keuze ----------
test('paar-vertaling: X/EUR ↔ X/USDT, andere quotes blijven, standaard Bitvavo', () => {
  assert.equal(toVenuePair('SOL/EUR', 'bybit'), 'SOL/USDT');
  assert.equal(toVenuePair('SOL/USDT', 'bitvavo'), 'SOL/EUR');
  assert.equal(toVenuePair('SOL/EUR', 'bitvavo'), 'SOL/EUR');
  assert.equal(toVenuePair('BTC/USDC', 'bybit'), 'BTC/USDC');
  assert.equal(toBasePair('ETH/USDT'), 'ETH/EUR');
  assert.equal(venueOf(undefined), 'bitvavo');
  assert.equal(venueOf('kraken'), 'bitvavo');
  assert.equal(venueOf('bybit'), 'bybit');
  assert.equal(VENUES.bybit.fees.feePct, 0.1);
});

test('AI-trader: coins van de leerserver (X/EUR) worden op Bybit X/USDT; Bitvavo krijgt hetzelfde object', () => {
  const sub = { recipeKey: 'b', coins: ['ETH/EUR'] };
  const agent = { recipeKey: 'a', coins: ['SOL/EUR', 'BTC/EUR'], regimes: { stijgend: { key: 'b', agent: sub } }, extras: [sub], extrasAll: [sub] };
  assert.equal(venueAgent(agent, 'bitvavo'), agent);
  const b = venueAgent(agent, 'bybit');
  assert.deepEqual(b.coins, ['SOL/USDT', 'BTC/USDT']);
  assert.deepEqual(b.regimes.stijgend.agent.coins, ['ETH/USDT']);
  // Zelfde recept overal hetzelfde object (identiteit blijft), origineel onaangeroerd.
  assert.equal(b.regimes.stijgend.agent, b.extras[0]);
  assert.equal(b.extras[0], b.extrasAll[0]);
  assert.deepEqual(agent.coins, ['SOL/EUR', 'BTC/EUR']);
});

test('instelling: standaard Bitvavo; oude settings.json → Bitvavo en blijft zonder exchange-veld', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-s-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'paper', pairs: ['ADA/EUR'], risk: { stakeEur: 10, feePct: 0.25, makerFeePct: 0.15 } }));
  const s = new Settings(dir, config(dir));
  assert.equal(s.exchange, 'bitvavo');
  assert.deepEqual(s.pairs, ['ADA/EUR']);
  s.setRisk({ stakeEur: 12 });
  assert.equal('exchange' in JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), false);
  // Bybit kiezen: fee van de Bitvavo-standaard naar de Bybit-standaard, coins vertaald.
  const notice = s.setExchange('bybit');
  assert.match(notice, /standaard van Bybit: 0,1% \(taker\)/);
  assert.equal(s.risk.feePct, 0.1);
  assert.equal(s.risk.makerFeePct, 0.1);
  assert.deepEqual(s.pairs, ['ADA/USDT']);
  assert.deepEqual(s.data.pairs, ['ADA/EUR'], 'Bitvavo-lijst blijft staan');
  // Terug naar Bitvavo: weer de Bitvavo-standaard.
  s.setExchange('bitvavo');
  assert.equal(s.risk.feePct, 0.25);
  assert.equal(s.risk.makerFeePct, 0.15);
  // Eigen fee blijft staan.
  s.setRisk({ feePct: 0.2 });
  assert.match(s.setExchange('bybit'), /Je eigen fee \(0,2% taker/);
  assert.equal(s.risk.feePct, 0.2);
  assert.throws(() => s.setExchange('kraken'), /Onbekende beurs/);
  // Eigen coinlijst per beurs.
  s.setPairs(['SOL/USDT'], new Set(['SOL/USDT']));
  assert.deepEqual(s.pairs, ['SOL/USDT']);
  assert.deepEqual(s.data.pairs, ['ADA/EUR']);
  assert.throws(() => s.setPairs(['SOL/EUR'], new Set(['SOL/USDT'])), /Onbekend op Bybit/);
});

test('live geblokkeerd op Bybit: centrale check, instellingen, ook bij een bestand dat live zegt', () => {
  assert.deepEqual(liveAllowedOnVenue('bitvavo'), { ok: true, reason: null });
  const r = liveAllowedOnVenue('bybit');
  assert.equal(r.ok, false);
  assert.match(r.reason, LIVE_TEXT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-l-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'live', exchange: 'bybit' }));
  const s = new Settings(dir, config(dir, { liveTrading: true }));
  assert.equal(s.mode, 'paper', 'live + Bybit uit een bestand: toch paper');
  assert.throws(() => s.setMode('live'), LIVE_TEXT);
  s.setExchange('bitvavo');
  s.setMode('live');
  assert.throws(() => s.setExchange('bybit'), LIVE_TEXT);
});

// ---------- Omrekenkoers ----------
test('USDT/EUR-koers: direct of omgekeerd, met cache, duidelijke fout als hij ontbreekt', async () => {
  let t = 0;
  const m = fakeVenue('USDT', { 'USDT/EUR': 0.9 });
  const r = new QuoteRate(m, 'bybit', { now: () => t });
  assert.equal(await r.eurPerQuote(), 0.9);
  await r.eurPerQuote();
  assert.equal(m.calls.filter((c) => c[0] === 'ticker').length, 1, 'binnen een minuut uit de cache');
  // Alleen EUR/USDT: omgekeerd.
  const inv = new QuoteRate(fakeVenue('USDT', { 'EUR/USDT': 1.25 }), 'bybit');
  assert.equal(await inv.eurPerQuote(), 0.8);
  // Geen koers: fout bij kopen; na een bekende koers mag verkopen met de laatst bekende.
  const none = new QuoteRate(fakeVenue('USDT', {}), 'bybit');
  await assert.rejects(none.eurPerQuote(), /Geen USDT\/EUR-koers van Bybit/);
  const prices = { 'USDT/EUR': 0.9 };
  const gone = new QuoteRate(fakeVenue('USDT', prices), 'bybit', { now: () => t });
  t = 0; await gone.eurPerQuote();
  delete prices['USDT/EUR'];
  t = 30 * 60000;
  await assert.rejects(gone.eurPerQuote(), /Geen USDT\/EUR-koers/);
  assert.equal(await gone.eurPerQuote({ allowStale: true }), 0.9);
  assert.equal(await EUR_RATE.eurPerQuote(), 1);
});

// ---------- Paper in euro ----------
test('paper op Bybit: rekent in USDT, boekt in euro (koop, verkoop, winst)', async () => {
  let rate = 0.9;
  const ex = { async fetchTicker(p) { return { last: p === 'SOL/USDT' ? price : 1 }; } };
  let price = 200;
  const fx = { quote: 'USDT', async eurPerQuote() { return rate; } };
  const b = new PaperBroker(ex, 0.1, 0, 0.1, fx);
  const buy = await b.buy('SOL/USDT', 90);
  // € 90 = 100 USDT; fee 0,1 USDT; 99,9 USDT / 200 = 0,4995 SOL.
  assert.equal(buy.costEur, 90);
  assert.ok(Math.abs(buy.costQuote - 100) < 1e-9);
  assert.ok(Math.abs(buy.feeQuote - 0.1) < 1e-9);
  assert.ok(Math.abs(buy.feeEur - 0.09) < 1e-9);
  assert.ok(Math.abs(buy.amount - 0.4995) < 1e-12);
  assert.equal(buy.price, 200);
  assert.equal(buy.quote, 'USDT');
  assert.equal(buy.eurRate, 0.9);
  // Koers +10%, euro iets sterker (1 USDT = € 0,88).
  price = 220;
  rate = 0.88;
  const sell = await b.sell('SOL/USDT', buy.amount);
  const gross = 0.4995 * 220;
  assert.ok(Math.abs(sell.costQuote - gross * 0.999) < 1e-9);
  assert.ok(Math.abs(sell.costEur - gross * 0.999 * 0.88) < 1e-9);
  assert.ok(Math.abs(sell.feeEur - gross * 0.001 * 0.88) < 1e-9);
  const pnlEur = sell.costEur - buy.costEur;
  assert.ok(Math.abs(pnlEur - (gross * 0.999 * 0.88 - 90)) < 1e-9);
});

test('Bitvavo-paper ongewijzigd: zelfde getallen, geen extra velden', async () => {
  const ex = { async fetchTicker() { return { last: 100 }; } };
  const b = new PaperBroker(ex, 0.25, 0, 0.15);
  assert.deepEqual(await b.buy('BTC/EUR', 25), { amount: (25 - 0.0625) / 100, price: 100, costEur: 25, feeEur: 0.0625 });
  assert.deepEqual(await b.sell('BTC/EUR', 0.5), { amount: 0.5, price: 100, costEur: 50 - 0.125, feeEur: 0.125 });
  // Store-bestanden van Bitvavo houden hun naam; Bybit krijgt eigen bestanden.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-bybit-st-'));
  assert.equal(path.basename(new Store(dir, 'paper', 500).file), 'state-paper.json');
  assert.equal(path.basename(new Store(dir, 'live', 500, 'bitvavo').file), 'state-live.json');
  assert.equal(path.basename(new Store(dir, 'paper', 500, 'bybit').file), 'state-paper-bybit.json');
  assert.equal('venue' in new Store(dir, 'live', 500).state, false);
});

test('live-broker op Bybit weigert elke order', async () => {
  const b = new BlockedLiveBroker('bybit');
  await assert.rejects(b.buy('BTC/USDT', 10), LIVE_TEXT);
  await assert.rejects(b.sell('BTC/USDT', 1), LIVE_TEXT);
  await assert.rejects(b.placeStop('BTC/USDT', 1, 1), LIVE_TEXT);
});

// ---------- Bot + manager ----------
test('wisselen naar Bybit: eigen stores, USDT-paren, euro-waarde, Bitvavo-geschiedenis intact', async () => {
  const { admin, manager, made } = setup();
  const ctx = manager.ensure(admin);
  const { bot } = ctx;
  assert.equal(bot.venue, 'bitvavo');
  assert.deepEqual(made, ['bitvavo']);
  bot.store.addTrade({ pair: 'BTC/EUR', pnlEur: 1.5, closedAt: new Date().toISOString() });
  bot.store.save();
  const bvFile = bot.store.file;

  const r = await bot.switchVenue('bybit');
  assert.match(r.notice, /standaard van Bybit/);
  assert.equal(bot.venue, 'bybit');
  assert.equal(bot.quote, 'USDT');
  assert.equal(bot.btcPair, 'BTC/USDT');
  assert.deepEqual(bot.pairs, ['BTC/USDT', 'SOL/USDT']);
  assert.equal(path.basename(bot.store.file), 'state-paper-bybit.json');
  assert.equal(bot.store.state.trades.length, 0);
  assert.equal(bot.store.state.balanceEur, 500);
  assert.equal(bot.risk.feePct, 0.1);
  assert.ok(made.includes('bybit'));
  // Bitvavo-bestand onaangeroerd, en ctx.stores blijven die van Bitvavo.
  assert.equal(JSON.parse(fs.readFileSync(bvFile, 'utf8')).trades.length, 1);
  assert.equal(ctx.stores.paper.file, bvFile);

  // Markten in USDT.
  const markets = await bot.listMarkets();
  assert.deepEqual(markets.map((m) => m.pair).sort(), ['BTC/USDT', 'SOL/USDT']);
  assert.equal(markets[0].quote, 'USDT');
  assert.ok(Math.abs(markets[0].volumeEur - 900) < 1e-9, 'volume omgerekend naar euro');

  // Een positie in USDT: waarde in euro.
  const fill = await bot.broker.buy('SOL/USDT', 90);
  bot.store.state.balanceEur -= fill.costEur;
  bot.store.state.positions['SOL/USDT'] = { pair: 'SOL/USDT', openedAt: new Date().toISOString(), entryPrice: fill.price, amount: fill.amount, costEur: fill.costEur,
    entryFeeEur: fill.feeEur, reason: 'test', highest: fill.price, lowest: fill.price, venue: 'bybit', quote: 'USDT', costQuote: fill.costQuote, entryEurRate: fill.eurRate };
  await bot.refreshPrices(['SOL/USDT'], 0);
  const v = bot.openPositionsValue();
  assert.ok(Math.abs(v.valueEur - fill.amount * 200 * 0.9 * (1 - 0.001)) < 1e-9);
  assert.match(bot.fmtQ(200), /200,00 USDT/);

  // Wisselen met een open positie: geweigerd.
  await assert.rejects(bot.switchVenue('bitvavo'), /positie\(s\) open op Bybit.*SOL\/USDT/);

  // Verkopen: winst in euro, USDT-bedragen bewaard.
  const trade = await bot.closeManual('SOL/USDT');
  assert.equal(trade.venue, 'bybit');
  assert.equal(trade.quote, 'USDT');
  assert.ok(Math.abs(trade.costQuote - 100) < 1e-9);
  assert.ok(Math.abs(trade.proceedsQuote - fill.amount * 200 * 0.999) < 1e-9);
  assert.ok(Math.abs(trade.pnlEur - (fill.amount * 200 * 0.999 * 0.9 - 90)) < 1e-9);
  assert.ok(Math.abs(bot.store.state.balanceEur - (500 + trade.pnlEur)) < 1e-9);

  // Terug naar Bitvavo: zijn eigen geschiedenis en fee terug; Bybit-bestand bestaat apart.
  await bot.switchVenue('bitvavo');
  assert.equal(bot.store.file, bvFile);
  assert.equal(bot.store.state.trades.length, 1);
  assert.equal(bot.risk.feePct, 0.25);
  assert.deepEqual(bot.pairs, ['BTC/EUR', 'SOL/EUR']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'state-paper-bybit.json'), 'utf8')).trades.length, 1);
  // Na een herstart (nieuwe manager) start de bot op de opgeslagen beurs.
  await bot.switchVenue('bybit');
  manager.stopAll();
  const m2 = new BotManager({ config: manager.config, users: manager.users, log: quiet, shared: manager.shared, sharedVenues: { bybit: manager.sharedVenues.bybit }, makePrivateExchange: manager.makePrivateExchange });
  const c2 = m2.ensure(admin);
  assert.equal(c2.bot.venue, 'bybit');
  assert.equal(c2.bot.store.state.trades.length, 1);
  assert.equal(c2.bot.broker.fx.quote, 'USDT');
  m2.stopAll();
});

test('live op Bybit geblokkeerd in de bot; geen echte order; feedback met venue bybit', async () => {
  const { admin, manager } = setup();
  const { bot } = manager.ensure(admin);
  await bot.switchVenue('bybit');
  await assert.rejects(bot.switchMode('live'), LIVE_TEXT);
  assert.equal(bot.mode, 'paper');
  await assert.rejects(bot.refreshLiveBalance(), LIVE_TEXT);
  await assert.rejects(bot.brokers.live.buy('BTC/USDT', 10), LIVE_TEXT);
  // Fase 3: trades van een Bybit-bot gaan wel naar de leerserver, gemarkeerd met venue 'bybit' (apart bewaard).
  bot.onFeedback({ kind: 'agentTrade', pair: 'SOL/USDT', pct: 1 });
  assert.equal(manager.feedbackQueue.length, 1);
  assert.equal(manager.feedbackQueue[0].venue, 'bybit');
  // Orderboek-kenmerken (van Bitvavo) niet gebruiken op Bybit.
  manager.ml.micro = { features: { 'SOL/USDT': { x: 1 }, 'SOL/EUR': { x: 1 } }, at: Date.now() };
  assert.equal(bot.getMicro('SOL/USDT'), null);
  // AI-trader-coins van de leerserver vertaald.
  manager.ml.agent = { recipeKey: 'a', timeframe: '1h', coins: ['SOL/EUR'], regimes: {} };
  assert.deepEqual(bot.getAgent().coins, ['SOL/USDT']);
  await bot.switchVenue('bitvavo');
  assert.deepEqual(bot.getAgent().coins, ['SOL/EUR']);
  bot.onFeedback({ kind: 'agentTrade', pair: 'SOL/EUR', pct: 1 });
  assert.equal(manager.feedbackQueue.length, 2, 'Bitvavo stuurt gewoon feedback');
  assert.equal('venue' in manager.feedbackQueue[1], false, 'Bitvavo-feedback zonder venue, zoals altijd');
  // Live op Bitvavo, dan niet naar Bybit wisselen.
  bot.settings.setMode('live');
  await assert.rejects(bot.switchVenue('bybit'), LIVE_TEXT);
  manager.stopAll();
});

test('volger op Bybit volgt een leider op Bitvavo met USDT-paren', async () => {
  const { users, admin, manager } = setup();
  const { user: piet } = users.register({ code: users.createInvite(admin.id).code, username: 'piet', password: PW }, 'y');
  const leader = manager.ensure(admin).bot;
  const p = manager.ensure(piet);
  await p.bot.switchVenue('bybit');
  p.settings.setFollow(true);
  assert.equal(p.bot.following, true);
  assert.deepEqual(p.bot.pairs, ['BTC/USDT', 'SOL/USDT']);
  assert.deepEqual(leader.pairs, ['BTC/EUR', 'SOL/EUR']);
  manager.stopAll();
});

// ---------- Server en dashboard ----------
async function serve() {
  const s = setup();
  const app = createApp({ users: s.users, manager: s.manager, log: quiet }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  // De admin is al aangemaakt in setup(): inloggen.
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const post = (u, b = {}) => call('POST', u, b);
  const get = (u) => call('GET', u);
  assert.equal((await post('/api/auth/login', { username: 'justin', password: PW })).status, 200);
  return { ...s, post, get, close: () => { s.manager.stopAll(); app.close(); } };
}

test('server: beurs kiezen, live op Bybit geweigerd, Bybit-keys testen zonder orders', async () => {
  const { post, get, close, manager, admin } = await serve();
  try {
    let st = (await get('/api/state')).body;
    assert.equal(st.exchange, 'bitvavo');
    assert.equal(st.quote, 'EUR');
    assert.equal(st.liveAllowed.ok, true);
    assert.equal(st.fx, null);
    assert.equal(st.bybitKeysSet, false);
    assert.equal((await post('/api/settings/exchange', { exchange: 'kraken' })).status, 400);
    const sw = await post('/api/settings/exchange', { exchange: 'bybit' });
    assert.equal(sw.status, 200);
    assert.match(sw.body.notice, /Bybit/);
    st = (await get('/api/state')).body;
    assert.equal(st.exchange, 'bybit');
    assert.equal(st.exchangeLabel, 'Bybit');
    assert.equal(st.quote, 'USDT');
    assert.deepEqual(st.pairs, ['BTC/USDT', 'SOL/USDT']);
    assert.equal(st.liveAllowed.ok, false);
    assert.match(st.liveAllowed.reason, LIVE_TEXT);
    assert.equal(st.venues.find((v) => v.id === 'bybit').live.ok, false);
    // Live (server-side), ook met wachtwoord en LIVE: geweigerd (Bybit vraagt het eigen-risico-akkoord).
    const live = await post('/api/settings/mode', { mode: 'live', password: PW, confirm: 'LIVE' });
    assert.equal(live.status, 400);
    assert.match(live.body.error, /Typ EIGEN RISICO om live op Bybit te bevestigen/);
    assert.equal(manager.get(admin.id).settings.mode, 'paper');
    // Bybit-keys: versleuteld opgeslagen, testen haalt alleen het saldo op.
    assert.equal((await post('/api/settings/keys/test', { venue: 'bybit' })).status, 400);
    await post('/api/settings/keys', { bybitApiKey: 'BYBIT-KEY', bybitApiSecret: 'BYBIT-SECRET' });
    const keys = (await get('/api/settings/keys')).body;
    assert.equal(keys.bybitApiKey.set, true);
    assert.equal(keys.bybitApiKey.hint, '…-KEY');
    assert.ok(!fs.readFileSync(path.join(manager.get(admin.id).dir, 'secrets.enc'), 'utf8').includes('BYBIT'));
    const t = await post('/api/settings/keys/test', { venue: 'bybit' });
    assert.equal(t.status, 200);
    assert.equal(t.body.balances.USDT.free, 12.5);
    assert.equal((await get('/api/state')).body.bybitKeysSet, true);
    // Coins kiezen op Bybit: USDT-markten.
    assert.equal((await post('/api/settings/pairs', { pairs: ['SOL/USDT'] })).status, 200);
    assert.deepEqual((await get('/api/state')).body.pairs, ['SOL/USDT']);
    const bad = await post('/api/settings/pairs', { pairs: ['SOL/EUR'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Onbekend op Bybit/);
    // Terug naar Bitvavo: de Bitvavo-coins zijn ongewijzigd.
    assert.equal((await post('/api/settings/exchange', { exchange: 'bitvavo' })).status, 200);
    assert.deepEqual((await get('/api/state')).body.pairs, ['BTC/EUR', 'SOL/EUR']);
  } finally {
    close();
  }
});

test('dashboard: beurskeuze, badge met beurs en live op Bybit ook in de browser geblokkeerd', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<option value="bybit">Bybit \(paper/);
  assert.match(html, /api\/settings\/exchange/);
  assert.match(html, /\$\('mode-badge'\)\.textContent = `\$\{live \? 'LIVE' : 'PAPER'\} · \$\{xname\(\)\}`/);
  // Overschakelen naar live: eerst de centrale check van de server (liveAllowed), dan pas de dialoog.
  const sw = html.slice(html.indexOf("$('mc-switch').onclick"), html.indexOf("$('mode-dialog').showModal()"));
  // Fase 2: een beurs met eigen-risico-akkoord (Bybit) opent de dialoog met EIGEN RISICO; anders melding en stoppen.
  assert.match(sw, /const risky = toLive && Boolean\(s\.liveAllowed\?\.accord\);/);
  assert.match(sw, /if \(toLive && s\.liveAllowed && !s\.liveAllowed\.ok && !risky\) \{[\s\S]*?return;/);
  assert.match(html, /data-name="bybitApiKey"/);
  assert.match(html, /data-name="bybitApiSecret"/);
});

test('een check op Bybit haalt alleen USDT-paren van Bybit op (marktdata per beurs)', async () => {
  const { admin, manager, bitvavo, bybit } = setup();
  const { bot } = manager.ensure(admin);
  await bot.switchVenue('bybit');
  bitvavo.calls.length = 0;
  bybit.calls.length = 0;
  await bot.tick();
  assert.equal(bitvavo.calls.length, 0, 'geen verzoeken naar Bitvavo');
  const pairs = new Set(bybit.calls.map((c) => c[1]));
  assert.ok(pairs.has('BTC/USDT') && pairs.has('SOL/USDT'));
  assert.ok([...pairs].every((p) => p.endsWith('/USDT') || p === 'USDT/EUR'));
  assert.equal(bot.lastError, null);
  assert.ok(bot.pairStatus['SOL/USDT']);
  manager.stopAll();
});

test('wisselen tijdens een lopende check: de check maakt eerst af op de oude beurs, geen X/EUR op Bybit', async () => {
  const { admin, manager, bitvavo, bybit } = setup();
  const { bot } = manager.ensure(admin);
  // Bitvavo-candles traag, zodat de check loopt terwijl er gewisseld wordt.
  const orig = bitvavo.fetchOHLCV.bind(bitvavo);
  bitvavo.fetchOHLCV = async (...a) => { await new Promise((r) => setTimeout(r, 20)); return orig(...a); };
  const tick = bot.tick();
  await new Promise((r) => setTimeout(r, 5));
  const sw = bot.switchVenue('bybit');
  await Promise.all([tick, sw]);
  assert.equal(bot.venue, 'bybit');
  assert.deepEqual(bybit.calls.filter((c) => /\/EUR$/.test(c[1]) && c[1] !== 'USDT/EUR'), [], 'geen Bitvavo-coin naar Bybit');
  assert.equal(bot.lastError, null);
});

test('Bybit-website: keys van Bybit EU gaan naar api.bybit.eu; wisselen alleen zonder posities en niet live', async () => {
  const { createExchange } = await import('../src/exchange.js');
  const { BYBIT_HOSTS } = await import('../src/settings.js');
  assert.deepEqual(BYBIT_HOSTS, ['bybit.com', 'bybit.eu', 'bybit.nl']);
  let host = 'bybit.com';
  const fakeSecrets = { get: () => '', onChange() {} };
  const bx = createExchange(fakeSecrets, 'bybit', { hostname: () => host });
  assert.equal(bx.implodeHostname('https://api.{hostname}'), 'https://api.bybit.com');
  host = 'bybit.eu';
  assert.equal(bx.implodeHostname('https://api.{hostname}'), 'https://api.bybit.eu', 'volgt de instelling bij elk verzoek');

  const { admin, manager } = setup();
  const ctx = manager.ensure(admin);
  assert.equal(ctx.settings.bybitHost, 'bybit.com');
  assert.throws(() => manager.setBybitHost(admin.id, 'bybit.xyz'), /Onbekende Bybit-website/);
  assert.equal(manager.setBybitHost(admin.id, 'bybit.eu'), 'bybit.eu');
  assert.equal(new Settings(ctx.dir, config(ctx.dir)).bybitHost, 'bybit.eu', 'bewaard');
  // Met een open Bybit-positie niet wisselen.
  await ctx.bot.switchVenue('bybit');
  ctx.bot.store.state.positions['SOL/USDT'] = { pair: 'SOL/USDT', amount: 1, entryPrice: 200, costEur: 180, openedAt: new Date().toISOString() };
  assert.throws(() => manager.setBybitHost(admin.id, 'bybit.nl'), /posities open op Bybit/);
});
