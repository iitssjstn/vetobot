import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const src = '/home/claude/vetobot/src/';
const { Users } = await import(src + 'users.js');
const { BotManager } = await import(src + 'manager.js');
const { SharedMarket } = await import(src + 'exchange.js');
const { createApp } = await import(src + 'server.js');
const H = 3600000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-e2e-'));
const config = { dataDir: dir, liveTrading: false, pairs: ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
  paper: { startBalanceEur: 500 },
  risk: { stakeEur: 25, maxOpenTrades: 3, stopLossPct: 3, takeProfitPct: 6, maxDailyLossEur: 20, feePct: 0.25, cooldownMinutes: 0, slippagePct: 0.1 },
  strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 },
  ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 } };
const prices = [...Array(40)].map((_, i) => 100 - i * 0.5).concat([82, 85, 89]);
const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'];
const ex = { markets: Object.fromEntries(syms.map((b) => [`${b}/EUR`, { symbol: `${b}/EUR`, base: b, quote: 'EUR', spot: true }])),
  parseTimeframe: () => 3600, async loadMarkets() { return this.markets; },
  async fetchOHLCV(_p, _t, _s, limit) { const base = Math.floor(Date.now() / H) * H - prices.length * H; return prices.map((c, i) => [base + i * H, c, c + .2, c - .2, c, 100]).slice(-limit); },
  async fetchTicker() { return { last: 89.5, percentage: 1.2, quoteVolume: 1e6 }; },
  async fetchTickers(ps) { return Object.fromEntries(ps.map((p, i) => [p, { last: 89.5 / (i + 1), percentage: (i - 2) * 1.3, quoteVolume: 1e7 / (i + 1) }])); } };
const users = new Users(dir);
const PW = 'lang-genoeg-123';
const { user: admin } = users.setup({ username: 'justin', password: PW, code: users.setupCode }, 'x');
const { user: piet } = users.register({ code: users.createInvite(admin.id, 'Piet').code, username: 'piet', password: PW }, 'y');
users.createInvite(admin.id, 'Klaas');
const quiet = { info() {}, warn() {}, error() {} };
const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket(ex), makePrivateExchange: () => ({}) });
manager.startAll(); for (const c of manager.contexts.values()) { c.bot.store.addTrade({ pair: 'ETH/EUR', pnlEur: 18, pnlPct: 4, closedAt: new Date().toISOString() }); }
manager.get(piet.id).settings.setFollow(true);
await new Promise((r) => setTimeout(r, 300));
await manager.get(admin.id).bot.tick();
await new Promise((r) => setTimeout(r, 300));
createApp({ users, manager, log: quiet }).listen(4790, () => console.log('ready', dir));
