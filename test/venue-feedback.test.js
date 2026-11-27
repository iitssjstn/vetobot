import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';
import { BotManager, feedbackFor } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { venueCostShift, venueCostPct } from '../src/venue.js';
import { evaluate } from '../src/learncheck.js';

// Fase 3: Bybit in de leerserver. Feedback met de beurs, Bybit-kosten in de verwachting, "Leert hij echt?"
// per beurs. Geen netwerk: nep-beurzen en een nep-leerserver.

const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };
const H = 3600000;

function fakeVenue(prices) {
  return {
    markets: Object.fromEntries(Object.keys(prices).map((p) => [p, { symbol: p, base: p.split('/')[0], quote: p.split('/')[1], spot: true, active: true }])),
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV(p, _tf, _s, limit) {
      const c = prices[p] ?? 1;
      const base = Math.floor(Date.now() / H) * H - 50 * H;
      return [...Array(50)].map((_, i) => [base + i * H, c, c, c, c, 10]).slice(-limit);
    },
    async fetchTicker(p) {
      if (!(p in prices)) throw new Error(`geen markt ${p}`);
      return { last: prices[p] };
    },
    async fetchTickers(ps) { return Object.fromEntries(ps.filter((p) => p in prices).map((p) => [p, { last: prices[p], quoteVolume: 1000, percentage: 1 }])); },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-venue-fb-'));
  const users = new Users(dir);
  const { user: admin } = users.setup({ username: 'justin', password: PW, code: users.setupCode }, 'x');
  const manager = new BotManager({
    config: {
      dataDir: dir, liveTrading: false, pairs: ['BTC/EUR', 'SOL/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
      paper: { startBalanceEur: 500 },
      risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25, makerFeePct: 0.15, cooldownMinutes: 0, slippagePct: 0.05 },
      strategy: {}, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
    },
    users, log: quiet,
    shared: new SharedMarket(fakeVenue({ 'BTC/EUR': 90000, 'SOL/EUR': 150 })),
    sharedVenues: { bybit: new SharedMarket(fakeVenue({ 'BTC/USDT': 100000, 'SOL/USDT': 200, 'USDT/EUR': 0.9 })) },
    makePrivateExchange: () => ({ async loadMarkets() { return {}; }, async createOrder() { throw new Error('geen echte orders'); } }),
  });
  const ctx = manager.ensure(admin);
  return { dir, admin, manager, ctx };
}

// Leerserver-nep: onthoudt welke adressen gevraagd worden en welke feedback binnenkomt.
function fakeTrainer({ stats = {}, registry = { versions: [], active: null } } = {}) {
  const seen = [];
  const posted = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (u.pathname === '/feedback') {
      posted.push(...JSON.parse(opts.body).trades);
      return { status: 200, ok: true, headers: new Map(), json: async () => ({ ok: true }) };
    }
    const v = u.searchParams.get('venue');
    const body = u.pathname === '/learnstats' ? stats[v ?? 'bitvavo'] : u.pathname === '/registry' ? registry : null;
    if (!body) return { status: 404, ok: false, headers: new Map(), json: async () => ({ error: 'Niet gevonden' }) };
    return { status: 200, ok: true, headers: new Map(), json: async () => body };
  };
  return Object.assign(fn, { seen, posted });
}

const statsFor = (recent, venue) => ({
  enabled: true, learningNow: true, rounds: { windowHours: 24, lastDay: 3, lastAt: new Date().toISOString(), ageHours: 1 },
  agentTrades: { windowDays: 3, total: recent, recent, recentReal: recent, lastAt: new Date().toISOString(), ageHours: 1 },
  ...(venue ? { venue } : {}),
});

test('feedbackFor: Bitvavo onveranderd (zelfde object, geen venue), andere beurs met venue', () => {
  const t = { kind: 'agentTrade', pair: 'SOL/EUR', pct: 1 };
  assert.equal(feedbackFor(t, 'bitvavo'), t);
  assert.equal(feedbackFor(t, undefined), t, 'onbekend = Bitvavo');
  assert.deepEqual(feedbackFor({ kind: 'agentTrade', pair: 'SOL/USDT', pct: 1 }, 'bybit'), { kind: 'agentTrade', pair: 'SOL/USDT', pct: 1, venue: 'bybit' });
});

test('bot op Bybit stuurt feedback met venue bybit naar de leerserver; Bitvavo zonder venue', async () => {
  const { manager, ctx } = setup();
  ctx.secrets.update({ trainerUrl: 'http://leerserver.test', trainerToken: 'geheim' });
  const tr = fakeTrainer();
  manager.fetchImpl = tr;
  const { bot } = ctx;
  await bot.switchVenue('bybit');
  bot.onFeedback({ kind: 'agentTrade', pair: 'SOL/USDT', timeframe: '1h', recipe: 'r1', pct: 0.4, mode: 'paper', costPct: 0.22 });
  await bot.switchVenue('bitvavo');
  bot.onFeedback({ kind: 'agentTrade', pair: 'SOL/EUR', timeframe: '1h', recipe: 'r1', pct: 0.3, mode: 'paper', costPct: 0.55 });
  await manager.flushFeedback();
  assert.equal(tr.posted.length, 2);
  assert.equal(tr.posted[0].venue, 'bybit');
  assert.equal(tr.posted[0].pair, 'SOL/USDT');
  assert.equal('venue' in tr.posted[1], false);
  manager.stopAll();
});

test('venueCostShift: Bitvavo 0; Bybit met de kosten van de leerserver per coin, anders 2 × fee + slippage', () => {
  const agent = { costPct: 0.6, costs: { 'SOL/EUR': 0.7 }, venueCosts: { bybit: { costPct: 0.25, costs: { 'SOL/EUR': 0.3 }, default: 0.22 } } };
  assert.equal(venueCostShift(agent, 'SOL/EUR', 'bitvavo'), 0);
  assert.equal(venueCostPct(agent, 'SOL/EUR', 'bitvavo'), null);
  assert.ok(Math.abs(venueCostShift(agent, 'SOL/USDT', 'bybit') - (0.7 - 0.3)) < 1e-12, 'eigen coin: Bitvavo 0,7 → Bybit 0,3');
  assert.ok(Math.abs(venueCostShift(agent, 'BTC/USDT', 'bybit') - (0.6 - 0.22)) < 1e-12, 'andere coin: standaard van de leerserver');
  // Oudere leerserver zonder venueCosts: 2 × 0,1% Bybit-fee plus de eigen slippage.
  const old = { costPct: 0.5 };
  assert.ok(Math.abs(venueCostPct(old, 'BTC/USDT', 'bybit', 0.05) - 0.25) < 1e-12);
  assert.ok(Math.abs(venueCostShift(old, 'BTC/USDT', 'bybit', 0.05) - 0.25) < 1e-12);
  assert.equal(venueCostShift({}, 'BTC/USDT', 'bybit'), 0, 'onbekende geleerde kosten: niets verschuiven');
});

test('bot gebruikt op Bybit de Bybit-kosten in de verwachting, op Bitvavo niet', async () => {
  const { manager, ctx } = setup();
  const { bot } = ctx;
  const agent = { costPct: 0.5, venueCosts: { bybit: { costPct: 0.2, costs: {}, default: 0.2 } } };
  assert.equal(bot.venueCostShift(agent, 'SOL/EUR'), 0);
  await bot.switchVenue('bybit');
  assert.ok(Math.abs(bot.venueCostShift(agent, 'SOL/USDT') - 0.3) < 1e-12);
  // Server stuurt de Bybit-cijfers per recept naar het dashboard.
  manager.ml.agent = { version: 2, kind: 'agent', recipeKey: 'r1', timeframe: '1h', coins: ['SOL/EUR'], stage: 'getest', regimes: {}, costPct: 0.5,
    venueStats: { bybit: { trades: 40, avgPct: 0.21, practice: { trades: 3, avgPct: 0.1 } } }, venueCosts: { bybit: { costPct: 0.2 } } };
  assert.deepEqual(bot.getAgent().venueStats.bybit.trades, 40);
  await bot.switchVenue('bitvavo');
  manager.stopAll();
});

test('learncheck per beurs: Bitvavo-teksten ongewijzigd, Bybit met beurs en uitleg', () => {
  const now = Date.now();
  const trainer = { configured: true, stats: statsFor(2), registry: { versions: [], active: null } };
  const trades = [{ pair: 'SOL/EUR', pnlPct: 0.5, closedAt: new Date(now - 5 * H).toISOString(), openedAt: new Date(now - 6 * H).toISOString(), agent: { recipe: 'r1', expectedPct: 0.3 } }];
  const bv = evaluate({ now, trainer, trades });
  const bv2 = evaluate({ now, trainer, trades, venue: 'bitvavo' });
  assert.deepEqual(bv2, bv, 'venue bitvavo = zoals vroeger');
  assert.equal('venue' in bv, false);
  const fb = bv.checks.find((c) => c.key === 'feedback');
  assert.equal(fb.text, 'Je bot sloot 1 trade van de AI-trader in de laatste 3 dagen. De leerserver ontving er 2 in de laatste 3 dagen (alle bots samen; laatste 1 uur geleden).');
  const by = evaluate({ now, trainer, trades, venue: 'bybit' });
  assert.equal(by.venue, 'bybit');
  assert.match(by.venueNote, /Je handelt nu op Bybit/);
  assert.match(by.checks.find((c) => c.key === 'feedback').text, /AI-trader op Bybit in de laatste 3 dagen\. De leerserver ontving er 2 op Bybit/);
});

test('manager.learnCheck per actieve beurs: Bybit-trades en /learnstats?venue=bybit', async () => {
  const { manager, ctx } = setup();
  ctx.secrets.update({ trainerUrl: 'http://leerserver.test', trainerToken: 'geheim' });
  const now = Date.now();
  const trade = (pair, h) => ({ pair, pnlPct: 0.4, closedAt: new Date(now - h * H).toISOString(), openedAt: new Date(now - h * H - H).toISOString(), agent: { recipe: 'r1', expectedPct: 0.2 } });
  ctx.stores.paper.state.trades.push(trade('SOL/EUR', 5), trade('BTC/EUR', 6));
  const tr = fakeTrainer({ stats: { bitvavo: statsFor(7), bybit: statsFor(1, 'bybit') } });
  manager.fetchImpl = tr;
  const bv = await manager.learnCheck(ctx.user.id, now);
  assert.equal('venue' in bv, false);
  assert.match(bv.checks.find((c) => c.key === 'feedback').text, /^Je bot sloot 2 trades .* ontving er 7 in/);
  assert.ok(tr.seen.includes('/learnstats'));
  await ctx.bot.switchVenue('bybit');
  ctx.venues.bybit.stores.paper.state.trades.push(trade('SOL/USDT', 4));
  manager.learnCheckCache = null;
  const by = await manager.learnCheck(ctx.user.id, now);
  assert.equal(by.venue, 'bybit');
  assert.ok(tr.seen.includes('/learnstats?venue=bybit'));
  assert.match(by.checks.find((c) => c.key === 'feedback').text, /^Je bot sloot 1 trade van de AI-trader op Bybit .* ontving er 1 op Bybit/);
  // Oudere leerserver (zonder telling per beurs): geen telling, met uitleg; nooit de Bitvavo-telling gebruiken.
  manager.fetchImpl = fakeTrainer({ stats: { bitvavo: statsFor(7), bybit: statsFor(7) } });
  manager.learnCheckCache = null;
  const old = await manager.learnCheck(ctx.user.id, now);
  assert.equal(old.checks.find((c) => c.key === 'feedback').status, 'warn');
  assert.match(old.checks.find((c) => c.key === 'feedback').text, /telt nog geen trades per beurs/);
  await ctx.bot.switchVenue('bitvavo');
  manager.stopAll();
});
