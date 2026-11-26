import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ccxt from 'ccxt';
import { Health, HEALTH, alertMessage } from '../src/health.js';
import { openRunState } from '../src/runstate.js';
import { Bot } from '../src/bot.js';
import { PaperBroker, LiveBroker, orderTiming, isNetworkError } from '../src/exchange.js';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';

// Gezondheid en meldingen bij stille uitval. Alleen nep-exchanges en een nagebootste klok; geen netwerk.
orderTiming.sleep = async () => {};
orderTiming.pollMs = 0;
const MIN = 60000;
const quiet = { info() {}, warn() {}, error() {} };

const clock = (t0 = Date.parse('2026-11-26T10:00:00Z')) => {
  const c = { t: t0, now: () => c.t, add: (ms) => { c.t += ms; } };
  return c;
};
const BASE = { mode: 'live', intervalMs: MIN, watchSeconds: 10, running: false, scheduled: true, halted: null, openPositions: [], buyBlock: null };
const base = BASE;

// ---------- Health: beoordelen ----------
test('health: gezond na een geslaagde check; opstarten is geen storing', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  assert.equal(h.assess(base).level, 'healthy', 'vlak na de start, nog geen check: geen alarm');
  h.tickStarted(); c.add(2000); h.tickFinished(0);
  const r = h.assess(base);
  assert.equal(r.level, 'healthy');
  assert.equal(r.emoji, '🟢');
  assert.ok(r.lastTickOkAt);
});

test('health: hangende handelsronde → kritiek (ook al "draait" de bot nog)', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted();
  c.add(4 * MIN);
  assert.equal(h.assess({ ...base, running: true }).level, 'healthy', 'binnen de grens: nog geen alarm');
  c.add(2 * MIN);
  const r = h.assess({ ...base, running: true });
  assert.equal(r.level, 'critical');
  assert.ok(r.problems.some((p) => p.key === 'loop-hang'));
  assert.equal(r.positionsWatched, false, 'tijdens een hangende check worden posities niet bewaakt');
  assert.equal(r.liveTrading, false);
});

test('health: planner loopt niet meer (geen check meer, niets hangt) → kritiek', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted(); h.tickFinished(0);
  c.add(MIN * HEALTH.staleFactor + HEALTH.staleExtraMs - 1000);
  assert.equal(h.assess(base).level, 'healthy');
  c.add(2000);
  assert.ok(h.assess(base).problems.some((p) => p.key === 'scheduler' && p.level === 'critical'));
});

test('health: fouten op rij: 3 = probleem, 10 = kritiek; één geslaagde check en het is weg', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  for (let i = 0; i < 3; i++) { h.tickStarted(); h.tickFinished(1, 'BTC/EUR: kapot'); }
  let r = h.assess(base);
  assert.equal(r.problems.find((p) => p.key === 'tick-errors')?.level, 'degraded');
  assert.equal(r.lastError.message, 'BTC/EUR: kapot');
  for (let i = 0; i < 7; i++) { h.tickStarted(); h.tickFinished(1); }
  r = h.assess(base);
  assert.equal(r.problems.find((p) => p.key === 'tick-errors')?.level, 'critical');
  h.tickStarted(); h.tickFinished(0);
  assert.equal(h.assess(base).level, 'healthy');
});

test('health: live positie die niet meer gecontroleerd wordt → kritiek; paper → probleem', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted(); h.tickFinished(0);
  h.positionChecked('BTC/EUR');
  const pos = (live, stop = 'actief') => [{ pair: 'BTC/EUR', live, stop, openedAt: c.t - 10 * MIN }];
  c.add(MIN);
  assert.equal(h.assess({ ...base, openPositions: pos(true) }).level, 'healthy');
  h.tickStarted(); h.tickFinished(0); // checks lopen nog, maar de koers van deze positie lukt niet meer
  h.positionFailed('BTC/EUR', new ccxt.RequestTimeout('timed out'));
  c.add(3 * MIN);
  h.tickStarted(); h.tickFinished(0);
  const r = h.assess({ ...base, openPositions: pos(true) });
  const p = r.problems.find((x) => x.key === 'positions');
  assert.equal(p.level, 'critical');
  assert.match(p.detail, /Stop bij Bitvavo actief voor 1 van 1/);
  assert.match(p.detail, /timed out/);
  assert.equal(p.manual, false, 'stop bij Bitvavo staat: geen handmatige actie nodig');
  assert.equal(r.positionsWatched, false);
  assert.equal(h.assess({ ...base, mode: 'paper', openPositions: pos(false) }).problems.find((x) => x.key === 'positions').level, 'degraded');
  assert.equal(h.assess({ ...base, openPositions: pos(true, 'mislukt') }).problems.find((x) => x.key === 'positions').manual, true,
    'zonder stop bij Bitvavo: actie nodig');
});

test('health: Bitvavo onbereikbaar in live: met open positie kritiek, zonder probleem; stop niet bevestigd = kritiek', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted(); h.tickFinished(0);
  h.exchangeOk();
  h.exchangeFailed(new ccxt.ExchangeNotAvailable('onderhoud'));
  c.add(HEALTH.exchangeStaleMs + 1000);
  h.tickStarted(); h.tickFinished(1);
  h.positionChecked('BTC/EUR');
  assert.equal(h.assess(base).problems.find((p) => p.key === 'exchange').level, 'degraded');
  const open = [{ pair: 'BTC/EUR', live: true, stop: 'mislukt', openedAt: c.t }];
  const r = h.assess({ ...base, openPositions: open });
  assert.equal(r.problems.find((p) => p.key === 'exchange').level, 'critical');
  assert.equal(r.problems.find((p) => p.key === 'stops').level, 'critical');
  assert.equal(h.assess({ ...base, mode: 'paper' }).problems.some((p) => p.key === 'exchange'), false, 'paper: geen Bitvavo-alarm');
});

test('health: gepauzeerd en gestopt zijn eigen toestanden; nieuwe aankopen geblokkeerd = probleem', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted(); h.tickFinished(0);
  assert.equal(h.assess({ ...base, halted: { reason: 'Daglimiet' } }).level, 'paused');
  assert.equal(h.assess({ ...base, scheduled: false }).level, 'stopped');
  assert.equal(h.assess({ ...base, buyBlock: { blocked: true, reasons: ['Saldo ophalen mislukt'] } }).level, 'degraded');
});

// ---------- Health: meldingen ----------
test('meldingen: kritiek direct, niet herhalen (geen spam), wel na een uur, wel bij erger, en één keer "opgelost"', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  const base = { ...BASE, intervalMs: 60 * MIN }; // checks elk uur: de planner is in deze test niet "te laat"
  for (let i = 0; i < 3; i++) { h.tickStarted(); h.tickFinished(1, 'kapot'); }
  // Probleem (oranje): pas na 5 minuten aanhouden.
  assert.equal(h.alerts(h.assess(base)).length, 0);
  c.add(HEALTH.degradedAfterMs);
  let a = h.alerts(h.assess(base));
  assert.equal(a.length, 1);
  assert.equal(a[0].problem.level, 'degraded');
  c.add(MIN);
  assert.equal(h.alerts(h.assess(base)).length, 0, 'niet opnieuw');
  // Erger: kritiek → meteen opnieuw.
  for (let i = 0; i < 7; i++) { h.tickStarted(); h.tickFinished(1); }
  a = h.alerts(h.assess(base));
  assert.equal(a.length, 1);
  assert.equal(a[0].problem.level, 'critical');
  assert.equal(a[0].repeat, false);
  c.add(30 * MIN);
  assert.equal(h.alerts(h.assess(base)).length, 0);
  c.add(31 * MIN);
  a = h.alerts(h.assess(base));
  assert.equal(a.length, 1, 'houdt aan: na een uur opnieuw');
  assert.equal(a[0].repeat, true);
  assert.match(alertMessage(a[0]).title, /houdt aan/);
  // Opgelost.
  h.tickStarted(); h.tickFinished(0);
  a = h.alerts(h.assess(base));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'resolved');
  assert.match(alertMessage(a[0], { now: c.t }).title, /Opgelost/);
  assert.equal(h.alerts(h.assess(base)).length, 0);
});

test('meldingen: een kort probleem dat vanzelf weggaat geeft geen melding en geen "opgelost"', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  for (let i = 0; i < 3; i++) { h.tickStarted(); h.tickFinished(1); }
  assert.equal(h.alerts(h.assess(base)).length, 0);
  h.tickStarted(); h.tickFinished(0);
  assert.equal(h.alerts(h.assess(base)).length, 0);
});

test('meldingen: tekst zegt wat er mis is, wat getroffen is, of live en bewaking nog lopen, en of actie nodig is', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted();
  c.add(10 * MIN);
  const r = h.assess({ ...base, running: true, openPositions: [{ pair: 'BTC/EUR', live: true, stop: 'actief', openedAt: c.t - 20 * MIN }] });
  const m = alertMessage(h.alerts(r)[0]);
  assert.match(m.title, /Kritiek: De handelsronde hangt/);
  const f = Object.fromEntries(m.fields.map((x) => [x.name, x.value]));
  assert.equal(f['Live trading actief'], 'nee');
  assert.equal(f['Open posities bewaakt'], 'NEE');
  assert.match(f['Wat de bot deed'], /dubbele orders/);
  assert.match(f['Actie nodig'], /ja/);
});

// ---------- Bot: echte checks met een nep-Bitvavo ----------
function fakeEx() {
  const ex = {
    apiKey: 'k', secret: 's', has: {}, prices: [...Array(40)].map((_, i) => 100 - i), fail: null, holdings: { EUR: 1000 },
    markets: { 'BTC/EUR': { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true, precision: { amount: 1e-8, price: 1e-5 }, limits: { amount: { min: 0.0001 } } } },
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    amountToPrecision: (_p, v) => String(Math.floor(v * 1e8) / 1e8),
    priceToPrecision: (_p, v) => String(+Number(v).toPrecision(6)),
    async fetchOHLCV(_p, _tf, _s, limit) {
      if (this.fail) throw this.fail;
      const b = Math.floor(Date.now() / 3600000) * 3600000 - 1000 * 3600000;
      return this.prices.map((c, i) => [b + i * 3600000, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { if (this.fail) throw this.fail; return { last: this.prices.at(-1) }; },
    async fetchTickers(ps) { if (this.fail) throw this.fail; return Object.fromEntries(ps.map((p) => [p, { last: this.prices.at(-1) }])); },
    async fetchOrderBook() { const p = this.prices.at(-1); return { bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] }; },
    async fetchBalance() { if (this.fail) throw this.fail; return { total: { ...this.holdings }, EUR: { free: this.holdings.EUR, total: this.holdings.EUR } }; },
    async fetchOpenOrders() { return []; },
    async fetchOrder(id) { return { id, status: 'open', filled: 0 }; },
    async createOrder(pair, type, side, amount) { return { id: `o${Math.random()}`, status: type === 'market' ? 'closed' : 'open', amount, filled: type === 'market' ? amount : 0, average: this.prices.at(-1), cost: amount * this.prices.at(-1), fee: { currency: 'EUR', cost: 0 } }; },
    async cancelOrder() { return {}; },
    async createMarketOrder(pair, side, amount) { return this.createOrder(pair, 'market', side, amount); },
  };
  return ex;
}

function setupBot({ mode = 'paper' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-health-'));
  const ex = fakeEx();
  const risk = { stakeEur: 25, maxOpenTrades: 3, stopLossPct: 5, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25, cooldownMinutes: 0, aiExitMinPct: 0, watchSeconds: 10 };
  const strategy = {};
  const settings = new Settings(dir, { liveTrading: mode === 'live', pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 1, risk, strategy, ai: { provider: 'none', model: '', baseUrl: '' } });
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const bot = new Bot({ config: { timeframe: '1h', strategy, risk, ai: { provider: 'none', failMode: 'reject' } }, exchange: ex, settings, stores, log: quiet,
    brokers: { paper: new PaperBroker(ex, 0.25), live: new LiveBroker(ex) } });
  const sent = [];
  const beats = [];
  bot.notifier = { secrets: { get: () => 'https://discord.example/webhook' }, lastFailure: null,
    send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async (ok) => { beats.push(ok); return null; } };
  bot.notifyRetryMs = 0;
  const c = clock(Date.now());
  bot.health = new Health({ now: c.now });
  return { bot, ex, sent, beats, c, dir };
}

const openPos = (bot, pair = 'BTC/EUR') => {
  const p = bot.ex.prices.at(-1); // op de huidige koers: geen stop of take-profit die meteen afgaat
  bot.store.state.positions[pair] = { pair, openedAt: new Date().toISOString(), entryPrice: p, amount: 0.3, costEur: 0.3 * p, highest: p, lowest: p, reason: 'test' };
};

test('bot: dubbele planner-aanroep start maar één check', async () => {
  const { bot } = setupBot();
  let started = 0;
  const orig = bot.health.tickStarted.bind(bot.health);
  bot.health.tickStarted = () => { started++; orig(); };
  await Promise.all([bot.tick(), bot.tick(), bot.tick()]);
  assert.equal(started, 1);
  assert.ok(bot.health.s.tickOkAt);
});

test('bot: check die onverwacht crasht (opslag niet beschikbaar) wordt vastgelegd, niet alleen in de console', async () => {
  const { bot, c } = setupBot();
  bot.store.save = () => { throw new Error('EROFS: read-only file system'); };
  await assert.rejects(bot.tick(), /EROFS/);
  assert.equal(bot.running, false, 'niet blijven hangen in "bezig"');
  assert.match(bot.health.s.lastError.message, /EROFS/);
  assert.match(bot.lastError.message, /EROFS/);
  assert.ok(bot.activity.some((e) => /Check mislukt: EROFS/.test(e.message)), 'zichtbaar in het activiteitenlog');
  for (let i = 0; i < 2; i++) await bot.tick().catch(() => {});
  c.add(HEALTH.degradedAfterMs);
  const r = await bot.healthCheck();
  assert.equal(r.problems.find((p) => p.key === 'tick-errors')?.level, 'degraded');
});

test('bot: Bitvavo time-out bij het bewaken van een live positie → kritiek, melding, heartbeat "fout"; daarna herstel en "opgelost"', async () => {
  const { bot, ex, sent, beats, c } = setupBot({ mode: 'live' });
  openPos(bot);
  await bot.watchPositions();
  assert.ok(bot.health.s.positions['BTC/EUR'].okAt, JSON.stringify(bot.health.s));
  assert.equal(bot.health.s.consecutiveWatchErrors, 0, JSON.stringify(bot.health.s.lastError));
  ex.fail = new ccxt.RequestTimeout('bitvavo GET https://api.bitvavo.com/v2/ticker/price request timed out');
  for (let i = 0; i < 3; i++) await bot.watchPositions();
  assert.equal(bot.health.s.consecutiveWatchErrors, 3);
  bot.health.tickStarted(); bot.health.tickFinished(0);
  c.add(11 * MIN);
  bot.health.tickStarted(); bot.health.tickFinished(0);
  const r = await bot.healthCheck();
  assert.equal(r.level, 'critical');
  assert.ok(r.problems.some((p) => p.key === 'positions'));
  assert.ok(r.problems.some((p) => p.key === 'exchange'));
  const alerts = sent.filter((x) => x.event === 'health');
  assert.ok(alerts.some((a) => /Kritiek: Open posities worden niet bewaakt/.test(a.title)));
  assert.ok(alerts.some((a) => /Kritiek: Bitvavo niet bereikbaar/.test(a.title)));
  assert.deepEqual(beats, [false], 'heartbeat op fout, zodat een externe monitor het ook ziet');
  const n = sent.length;
  await bot.healthCheck();
  assert.equal(sent.length, n, 'geen spam bij de volgende controle');
  ex.fail = null;
  await bot.watchPositions();
  const ok = await bot.healthCheck();
  // Bewaking en Bitvavo weer in orde. (Nieuwe aankopen blijven stil tot er een stop bij Bitvavo staat: terecht.)
  assert.equal(ok.problems.some((p) => ['positions', 'exchange'].includes(p.key)), false, JSON.stringify(ok.problems));
  assert.equal(ok.positionsWatched, true);
  assert.ok(sent.slice(n).some((a) => /Opgelost: Open posities/.test(a.title)));
});

test('bot: Discord onbereikbaar → 3 pogingen, daarna zichtbaar op het dashboard (via Discord kan dat niet)', async () => {
  const { bot, c } = setupBot();
  let tries = 0;
  bot.notifier.send = async () => { tries++; bot.notifier.lastFailure = { at: new Date().toISOString(), error: 'fetch failed' }; return false; };
  bot.health.tickStarted();
  bot.running = true;
  c.add(10 * MIN);
  const r1 = await bot.healthCheck();
  assert.equal(r1.problems[0].key, 'loop-hang');
  assert.equal(tries, 3);
  const r2 = bot.healthStatus();
  const p = r2.problems.find((x) => x.key === 'notify');
  assert.ok(p, 'probleem "meldingen komen niet aan"');
  assert.match(p.detail, /fetch failed/);
  bot.running = false;
});

test('bot: melding die niet aan staat telt niet als Discord-storing', async () => {
  const { bot, c } = setupBot();
  bot.notifier.send = async () => false; // uitgezet of geen webhook: geen fout
  bot.health.tickStarted(); bot.running = true;
  c.add(10 * MIN);
  await bot.healthCheck();
  assert.equal(bot.healthStatus().problems.some((x) => x.key === 'notify'), false);
  bot.running = false;
});

test('bot: herkent verbindingsfouten van Bitvavo', () => {
  assert.equal(isNetworkError(new ccxt.RequestTimeout('x')), true);
  assert.equal(isNetworkError(new ccxt.ExchangeNotAvailable('x')), true);
  assert.equal(isNetworkError(new Error('fetch failed')), true);
  assert.equal(isNetworkError(new ccxt.InsufficientFunds('x')), false);
  assert.equal(isNetworkError(new Error('Ongeldige stopprijs')), false);
});

// ---------- Herstart en planner ----------
test('herstart: onverwacht gestopt wordt herkend, een nette stop niet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-run-'));
  const first = openRunState(dir);
  assert.equal(first.unclean, null, 'eerste start');
  first.alive();
  // Geen clean(): proces "crasht".
  const second = openRunState(dir);
  assert.ok(second.unclean, 'onverwacht gestopt');
  assert.ok(second.unclean.lastAlive);
  second.clean();
  assert.equal(openRunState(dir).unclean, null, 'na een nette stop niet');
});

test('planner: loopt hij niet meer, dan start de bewaking hem opnieuw (veilig: geen dubbele check)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-sched-'));
  const users = new Users(dir);
  const { user } = users.setup({ username: 'justin', password: 'lang-genoeg-123', code: users.setupCode }, 'x');
  const ex = fakeEx();
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: {}, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket(ex), makePrivateExchange: () => ({}) });
  try {
    const ctx = manager.start(user);
    await ctx.bot.tickPromise;
    const c = clock(Date.now());
    ctx.bot.health = new Health({ now: c.now });
    ctx.bot.health.tickStarted(); ctx.bot.health.tickFinished(0);
    ctx.bot.notifier = { secrets: { get: () => null }, send: async () => false, heartbeat: async () => null };
    // De planner "valt weg".
    clearTimeout(ctx.timer);
    c.add(15 * MIN * HEALTH.staleFactor + HEALTH.staleExtraMs + 1000);
    let ticks = 0;
    const orig = ctx.bot.tick.bind(ctx.bot);
    ctx.bot.tick = () => { ticks++; return orig(); };
    await manager.checkHealth();
    assert.equal(ticks, 1, 'één nieuwe check');
    assert.match(ctx.bot.health.s.lastRecovery.what, /planner opnieuw gestart/);
    assert.ok(ctx.bot.nextTickAt, 'weer ingepland');
  } finally {
    manager.stopAll();
  }
});

test('bot: check die in de wachtrij hangt (achter een hangende handmatige verkoop) → "handelsronde hangt", niet "geen checks meer"', async () => {
  const { bot, c } = setupBot();
  openPos(bot);
  bot.brokers.paper.sell = () => new Promise(() => {}); // verkoop komt nooit terug
  bot.closeManual('BTC/EUR').catch(() => {});
  bot.tick().catch(() => {});
  await new Promise((r) => setImmediate(r));
  c.add(10 * 60000);
  const r = bot.healthStatus();
  const keys = r.problems.map((p) => p.key);
  assert.ok(!keys.includes('scheduler'), `geen planner-herstart: ${keys}`);
  assert.ok(keys.includes('loop-hang'), `hangende ronde gemeld: ${keys}`);
});

test('bot: AI-trader schrijft eens per uur een samenvatting in het log', () => {
  const { bot } = setupBot();
  bot.settings.setStrategy?.({ agentMode: 1 });
  bot.strategy.agentMode = 1;
  const t0 = Date.parse('2026-11-26T10:00:00Z');
  assert.equal(bot.agentHourlyLog(t0), null); // start van het eerste uur
  bot.agentWhy = [
    { at: t0 + 60000, kind: 'drempel', q: 0.31, thr: 0.5 },
    { at: t0 + 120000, kind: 'drempel', q: 0.12, thr: 0.5 },
    { at: t0 + 180000, kind: 'toelating', q: 0.62, thr: 0.5 },
  ];
  assert.equal(bot.agentHourlyLog(t0 + 30 * 60000), null); // nog geen uur om
  const text = bot.agentHourlyLog(t0 + 60 * 60000);
  assert.match(text, /3 candles beoordeeld/);
  assert.match(text, /2× onder de koopdrempel/);
  assert.match(text, /1× mocht niet/);
  assert.match(text, /hoogste verwachting \+0,62%/);
  assert.equal(bot.activity[0].message, text);
  // Een uur waarin hij niets beoordeelde: waarschuwing.
  const none = bot.agentHourlyLog(t0 + 120 * 60000);
  assert.match(none, /geen enkele candle beoordeeld/);
  assert.equal(bot.activity[0].level, 'warn');
});
