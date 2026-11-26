import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Health } from '../src/health.js';
import { SecretStore } from '../src/secrets.js';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';

// Regressietests uit de review van de gezondheidsbewaking. Geen netwerk, geen echte orders.
const MIN = 60000;
const quiet = { info() {}, warn() {}, error() {} };
const clock = (t0 = Date.parse('2026-11-26T10:00:00Z')) => {
  const c = { t: t0, now: () => c.t, add: (ms) => { c.t += ms; } };
  return c;
};
const BASE = { mode: 'live', intervalMs: 15 * MIN, watchSeconds: 0, running: false, scheduled: true, halted: null, openPositions: [], buyBlock: null };

test('health: nieuwe positie op een coin met een oude (gesloten) positie geeft geen vals alarm "niet bewaakt"', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  h.tickStarted(); h.tickFinished(0);
  // Eerdere positie op BTC/EUR, laatst gecontroleerd en daarna gesloten.
  h.positionChecked('BTC/EUR');
  c.add(3 * 60 * MIN);
  h.tickStarted(); h.tickFinished(0);
  // Nu net een nieuwe live positie geopend; de volgende controle moet nog komen.
  const open = [{ pair: 'BTC/EUR', live: true, stop: 'actief', openedAt: c.t - 1000 }];
  const r = h.assess({ ...BASE, openPositions: open });
  assert.equal(r.problems.some((p) => p.key === 'positions'), false, JSON.stringify(r.problems));
  // Blijft hij echt onbewaakt, dan wel alarm.
  c.add(46 * MIN);
  h.tickStarted(); h.tickFinished(0);
  assert.ok(h.assess({ ...BASE, openPositions: open }).problems.some((p) => p.key === 'positions'));
});

test('secrets: een ongeldige waarde in een update verandert niets (ook niet in het geheugen)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-sec-'));
  const s = new SecretStore(dir);
  s.update({ bitvavoApiKey: 'OUD' });
  assert.throws(() => s.update({ bitvavoApiKey: 'NIEUW', discordWebhook: 'https://example.com/niet-discord' }));
  assert.equal(s.get('bitvavoApiKey'), 'OUD', 'afgewezen update mag niet half doorgevoerd zijn');
  s.update({ aiApiKey: 'ai' });
  assert.equal(new SecretStore(dir).get('bitvavoApiKey'), 'OUD', 'ook niet later alsnog opgeslagen');
});

test('manager: gezondheidscontrole start de planner niet opnieuw voor een bot die intussen gestopt is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-zombie-'));
  const users = new Users(dir);
  const { user } = users.setup({ username: 'justin', password: 'lang-genoeg-123', code: users.setupCode }, 'x');
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 }, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket({}), makePrivateExchange: () => ({}) });
  const ctx = manager.ensure(user);
  let ticks = 0;
  ctx.bot.tick = async () => { ticks++; };
  // Terwijl de controle loopt (bijv. Discord-pogingen) wordt de gebruiker uitgeschakeld.
  ctx.bot.healthCheck = async () => {
    manager.stop(user.id);
    return { problems: [{ key: 'scheduler', level: 'critical' }] };
  };
  try {
    await manager.checkHealth();
    assert.equal(ticks, 0, 'geen check voor een gestopte bot');
    assert.equal(manager.get(user.id), null);
  } finally {
    clearTimeout(ctx.timer);
    clearTimeout(ctx.watchTimer);
    manager.stopAll();
  }
});


test('health: probleem dat kritiek → probleem → weer kritiek wordt, wordt opnieuw gemeld', () => {
  const c = clock();
  const h = new Health({ now: c.now });
  const res = (level) => ({ problems: [{ key: 'exchange', level, title: 'Bitvavo' }] });
  assert.equal(h.alerts(res('critical')).length, 1);
  c.add(MIN);
  assert.equal(h.alerts(res('degraded')).length, 0);
  c.add(MIN);
  const again = h.alerts(res('critical'));
  assert.equal(again.length, 1);
  assert.equal(again[0].repeat, false);
});
