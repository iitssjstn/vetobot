import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { SecretStore } from '../src/secrets.js';

const H = 3600000;
const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };

// Nep-Bitvavo: één koersreeks voor alle coins, instelbaar.
function fakeMarket() {
  let calls = 0;
  const ex = {
    prices: [...Array(40)].map((_, i) => 100 - i),
    markets: {},
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV(_p, _tf, _s, limit) {
      calls++;
      const base = Math.floor(Date.now() / H) * H - this.prices.length * H;
      return this.prices.map((c, i) => [base + i * H, c, c + 0.2, c - 0.2, c, 100]).slice(-limit);
    },
    async fetchTicker() { calls++; return { last: this.prices.at(-1) }; },
    async fetchTickers(ps) { calls++; return Object.fromEntries(ps.map((p) => [p, { last: this.prices.at(-1) }])); },
  };
  return { ex, shared: new SharedMarket(ex), calls: () => calls };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 },
    ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const users = new Users(dir);
  const { user: admin } = users.setup({ username: 'justin', password: PW, code: users.setupCode }, 'x');
  const { user: piet } = users.register({ code: users.createInvite(admin.id).code, username: 'piet', password: PW }, 'y');
  const m = fakeMarket();
  const manager = new BotManager({ config, users, log: quiet, shared: m.shared, makePrivateExchange: (secrets) => ({
    get apiKey() { return secrets.get('bitvavoApiKey') || undefined; },
    get secret() { return secrets.get('bitvavoApiSecret') || undefined; },
  }) });
  return { dir, config, users, admin, piet, manager, market: m };
}

test('elke gebruiker heeft eigen map, eigen keys en eigen trades', () => {
  const { dir, admin, piet, manager } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  a.secrets.update({ bitvavoApiKey: 'ADMIN-KEY' });
  p.secrets.update({ bitvavoApiKey: 'PIET-KEY' });
  assert.notEqual(a.dir, p.dir);
  assert.equal(a.exchange.apiKey, 'ADMIN-KEY');
  assert.equal(p.exchange.apiKey, 'PIET-KEY');
  // Met elkaars sleutel niet te openen
  const pietFile = path.join(p.dir, 'secrets.enc');
  assert.ok(!fs.readFileSync(pietFile, 'utf8').includes('PIET'));
  assert.throws(() => new SecretStore(p.dir, { keyDir: dir, scope: admin.id }));
  assert.equal(new SecretStore(p.dir, { keyDir: dir, scope: piet.id }).get('bitvavoApiKey'), 'PIET-KEY');
  // Trades gescheiden
  a.bot.store.addTrade({ pair: 'BTC/EUR', pnlEur: 1, closedAt: new Date().toISOString() });
  assert.equal(p.bot.store.state.trades.length, 0);
  manager.stopAll();
});

test('nieuwe gebruikers beginnen in paper, ook met LIVE_TRADING aan', () => {
  const { admin, piet, manager, config } = setup();
  config.liveTrading = true;
  assert.equal(manager.ensure(admin).settings.mode, 'live');
  assert.equal(manager.ensure(piet).settings.mode, 'paper');
  manager.stopAll();
});

test('volgen: koopt en verkoopt mee met eigen inzet, en houdt zich aan eigen limieten', async () => {
  const { admin, piet, manager, market } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  p.settings.setFollow(true);
  await p.bot.setRisk({ stakeEur: 10, maxOpenTrades: 1 });
  assert.equal(p.bot.following, true);
  assert.deepEqual(p.bot.pairs, a.bot.pairs);

  // Admin koopt op een kruising
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]);
  for (let n = 41; n <= 44 && !a.bot.store.state.positions['BTC/EUR']; n++) {
    market.ex.prices = seq.slice(0, n);
    market.shared.cache.clear(); // nieuwe koersen direct zichtbaar (normaal 5 sec cache)
    await a.bot.tick();
  }
  assert.ok(a.bot.store.state.positions['BTC/EUR'], 'admin heeft gekocht');
  await p.bot.queue;
  const pp = p.bot.store.state.positions['BTC/EUR'];
  assert.ok(pp, 'volger kocht mee');
  assert.equal(pp.costEur, 10, 'met eigen inzet');
  assert.equal(pp.followed, true);
  assert.match(pp.reason, /^Gevolgd:/);

  // Admin verkoopt handmatig: volger verkoopt mee
  await a.bot.closeManual('BTC/EUR');
  await p.bot.queue;
  assert.deepEqual(p.bot.store.state.positions, {});
  assert.match(p.bot.store.state.trades[0].exitReason, /Gevolgd: Handmatig gesloten/);
  manager.stopAll();
});

test('volgen: eigen limiet blokkeert, en een gemiste verkoop wordt bij de check alsnog gedaan', async () => {
  const { admin, piet, manager, market } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  p.settings.setFollow(true);
  p.bot.store.state.balanceEur = 5; // te weinig voor de inzet van 25
  await p.bot.mirror('open', { pair: 'ETH/EUR', reason: 'test', indicators: null });
  assert.deepEqual(p.bot.store.state.positions, {});
  assert.match(p.bot.store.state.decisions[0].reason, /^Volgen: Paper-saldo/);

  // Gevolgde positie die de leider niet (meer) heeft: bij de volgende check verkopen
  p.bot.store.state.balanceEur = 500;
  p.bot.store.state.positions['BTC/EUR'] = { pair: 'BTC/EUR', entryPrice: 61, amount: 0.4, costEur: 25, followed: true, highest: 61 };
  market.ex.prices = [...Array(60)].map((_, i) => 100 - i * 0.5);
  market.shared.cache.clear();
  await p.bot.tick();
  assert.deepEqual(p.bot.store.state.positions, {});
  assert.match(p.bot.store.state.trades[0].exitReason, /leider heeft deze positie niet meer/);
  manager.stopAll();
});

test('niet-volgers en de admin zelf doen niet mee', async () => {
  const { admin, piet, manager } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  assert.equal(a.bot.following, false);
  assert.equal(p.bot.following, false);
  await p.bot.mirror('open', { pair: 'BTC/EUR', reason: 'x' });
  assert.deepEqual(p.bot.store.state.positions, {});
  manager.stopAll();
});

test('marktdata wordt gedeeld tussen gebruikers', async () => {
  const { admin, piet, manager, market } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  await a.bot.tick();
  const after1 = market.calls();
  await p.bot.tick();
  assert.equal(market.calls(), after1, 'tweede bot haalde alles uit de cache');
  manager.stopAll();
});

test('oude data uit data/ gaat naar de map van de admin, inclusief keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'paper', pairs: ['SOL/EUR'] }));
  fs.writeFileSync(path.join(dir, 'state-paper.json'), JSON.stringify({ mode: 'paper', balanceEur: 321, startBalanceEur: 500, positions: {}, trades: [{ pair: 'SOL/EUR', pnlEur: 2 }], decisions: [] }));
  new SecretStore(dir).update({ bitvavoApiKey: 'OUD' });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ username: 'justin', salt: 's', hash: 'h' }));
  const users = new Users(dir);
  const config = { dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 }, risk: {}, strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 70 }, ai: { provider: 'none' } };
  const manager = new BotManager({ config, users, log: quiet, shared: fakeMarket().shared, makePrivateExchange: (s) => ({ get apiKey() { return s.get('bitvavoApiKey'); } }) });
  assert.equal(manager.migrateLegacy(users.admin.id), true);
  const ctx = manager.ensure(users.admin);
  assert.deepEqual(ctx.settings.pairs, ['SOL/EUR']);
  assert.equal(ctx.bot.store.state.balanceEur, 321);
  assert.equal(ctx.bot.store.state.trades.length, 1);
  assert.equal(ctx.secrets.get('bitvavoApiKey'), 'OUD');
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
  assert.equal(manager.migrateLegacy(users.admin.id), false, 'maar één keer');
  manager.stopAll();
});

test('dagoverzicht: elke gebruiker één keer per dag na zijn eigen tijd', () => {
  const { admin, piet, manager } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  a.settings.setNotify({ summaryTime: '08:00' });
  p.settings.setNotify({ summaryTime: '09:30' });
  a.bot.dailySummary = async () => {};
  p.bot.dailySummary = async () => {};
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assert.deepEqual(manager.checkSummaries(at(7, 59)), []);
  assert.deepEqual(manager.checkSummaries(at(8, 0)), [admin.id]);
  assert.deepEqual(manager.checkSummaries(at(8, 1)), [], 'niet nog een keer');
  assert.deepEqual(manager.checkSummaries(at(9, 30)), [piet.id]);
  manager.stopAll();
});
