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

// ---------- Eigen model van de trainer ----------
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));

test('eigen model: ophalen met de code van de admin, ETag, en het vorige model blijft bij een storing', async () => {
  const { admin, piet, manager } = setup();
  const a = manager.ensure(admin);
  const p = manager.ensure(piet);
  assert.equal(manager.trainerAccess(), null);
  await manager.refreshModel(); // zonder instellingen: niets
  assert.equal(manager.ml.model, null);
  a.secrets.update({ trainerUrl: 'http://10.0.0.5:8787', trainerToken: 'geheim' });
  const calls = [];
  let mode = 'ok';
  const model = { ...fixture.model, meta: { trainedAt: '2026-11-06T03:00:00Z', timeframe: '1h' } };
  manager.fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, etag: opts.headers['If-None-Match'] });
    if (mode === 'down') throw new Error('fetch failed');
    if (opts.headers['If-None-Match'] === '"v1"') return { status: 304, ok: false, headers: new Map(), json: async () => ({}) };
    return { status: 200, ok: true, headers: new Map([['etag', '"v1"']]), json: async () => model };
  };
  await manager.refreshModel();
  assert.equal(calls[0].url, 'http://10.0.0.5:8787/model.json');
  assert.equal(calls[0].auth, 'Bearer geheim');
  assert.equal(manager.ml.model.meta.trainedAt, '2026-11-06T03:00:00Z');
  // Elke bot (ook van andere gebruikers) gebruikt hetzelfde model
  assert.equal(p.bot.getModel(), manager.ml.model);
  // Niet veranderd → 304, model blijft
  await manager.refreshModel();
  const modelCalls = calls.filter((c) => c.url.endsWith('/model.json'));
  assert.equal(modelCalls[1].etag, '"v1"');
  // Ook het scorebord van AI + model wordt opgehaald
  assert.ok(calls.some((c) => c.url === 'http://10.0.0.5:8787/teamwork'));
  assert.ok(manager.ml.model);
  // Trainer onbereikbaar → leesbare fout, vorige model blijft in gebruik
  mode = 'down';
  await manager.refreshModel();
  assert.match(manager.ml.error, /Kan de trainer niet bereiken/);
  assert.ok(manager.ml.model);
  // Na een herstart staat het model er nog (bewaard op schijf)
  manager.stopAll();
  const again = new BotManager({ config: manager.config, users: manager.users, log: quiet, shared: manager.shared });
  assert.equal(again.ml.model.meta.trainedAt, '2026-11-06T03:00:00Z');
});

test('eigen model: een model met andere kenmerken wordt geweigerd', async () => {
  const { admin, manager } = setup();
  manager.ensure(admin).secrets.update({ trainerUrl: 'http://10.0.0.5:8787', trainerToken: 'geheim' });
  manager.fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), json: async () => ({ ...fixture.model, features: ['iets'] }) });
  await manager.refreshModel();
  assert.equal(manager.ml.model, null);
  assert.match(manager.ml.error, /andere kenmerken/);
  manager.stopAll();
});

test('feedback: echte trades gaan naar de trainer, en wachten als hij onbereikbaar is', async () => {
  const { admin, manager } = setup();
  const a = manager.ensure(admin);
  const sent = [];
  let up = false;
  manager.fetchImpl = async (url, opts) => {
    if (!up) throw new Error('fetch failed');
    sent.push({ url, body: JSON.parse(opts.body) });
    return { status: 200, ok: true, headers: new Map(), json: async () => ({ ok: true }) };
  };
  // Zonder trainer-instellingen: alleen in de wachtrij
  a.bot.onFeedback({ pair: 'ETH/EUR', ts: 1, timeframe: '5m', features: { rsi14: 40 }, returnPct: 1.2 });
  await manager.flushFeedback();
  assert.equal(manager.feedbackQueue.length, 1);
  a.secrets.update({ trainerUrl: 'http://10.0.0.5:8787', trainerToken: 'geheim' });
  await manager.queueFeedback({ pair: 'SOL/EUR', ts: 2, timeframe: '5m', features: { rsi14: 60 }, returnPct: -0.8 });
  assert.equal(manager.feedbackQueue.length, 2, 'trainer onbereikbaar: blijft wachten');
  assert.match(manager.ml.feedbackError, /Kan de trainer niet bereiken/);
  up = true;
  await manager.flushFeedback();
  assert.equal(manager.feedbackQueue.length, 0);
  assert.equal(sent[0].url, 'http://10.0.0.5:8787/feedback');
  assert.deepEqual(sent[0].body.trades.map((t) => t.pair), ['ETH/EUR', 'SOL/EUR']);
  manager.stopAll();
});

test('automatisch overstappen: nieuwe beste strategie van de trainer wordt één keer overgenomen', async () => {
  const { admin, manager } = setup();
  const a = manager.ensure(admin);
  a.secrets.update({ trainerUrl: 'http://10.0.0.5:8787', trainerToken: 'geheim' });
  let version = 1;
  const strategy = { key: '15m|4|2|480', timeframe: '15m', targetPct: 4, stopPct: 2, holdMinutes: 480, minProb: 0.6, autoApply: true };
  manager.fetchImpl = async () => ({
    status: 200, ok: true, headers: new Map([['etag', `"v${version}"`]]),
    json: async () => ({ ...fixture.model, meta: { timeframe: '15m', strategy, metrics: { best: { minProb: 0.62 } } } }),
  });
  await manager.refreshModel();
  assert.equal(a.bot.timeframe, '15m');
  assert.equal(a.bot.risk.takeProfitPct, 4);
  assert.equal(a.bot.risk.stopLossPct, 2);
  assert.equal(a.bot.risk.maxHoldMinutes, 480);
  assert.equal(a.settings.strategy.mlMinProb, 62);
  // Zelf aangepast; een nieuw model met dezelfde strategie zet het niet terug
  await a.bot.setRisk({ stopLossPct: 3 });
  version = 2;
  await manager.refreshModel();
  assert.equal(a.bot.risk.stopLossPct, 3);
  // Zonder autoApply: niets overnemen
  strategy.key = '1h|3|2|720';
  strategy.autoApply = false;
  version = 3;
  await manager.refreshModel();
  assert.equal(a.bot.timeframe, '15m');
  manager.stopAll();
});
