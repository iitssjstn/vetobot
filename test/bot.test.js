import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { PaperBroker } from '../src/exchange.js';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';

const H = 3600000;
const quiet = { info() {}, warn() {}, error() {} };

// Nep-exchange: alle candles gesloten, koersen instelbaar.
function fakeExchange(prices, { keys = false, balanceFails = false } = {}) {
  return {
    apiKey: keys ? 'k' : undefined,
    secret: keys ? 's' : undefined,
    prices,
    parseTimeframe: () => 3600,
    async fetchOHLCV(_p, _tf, _s, limit) {
      const base = Math.floor(Date.now() / H) * H - this.prices.length * H;
      return this.prices.map((c, i) => [base + i * H, c, c, c, c, 1]).slice(-limit);
    },
    async fetchTicker() { return { last: this.prices.at(-1) }; },
    async fetchBalance() {
      if (balanceFails) throw new Error('invalid key');
      return { EUR: { free: 123, total: 150 } };
    },
  };
}

function setup(exOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  const down = [...Array(40)].map((_, i) => 100 - i);
  const ex = fakeExchange(down.concat([62, 64, 66, 68]), exOpts);
  const config = {
    timeframe: '1h',
    strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 50, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25 },
    ai: { provider: 'none', failMode: 'reject' },
  };
  const settings = new Settings(dir, { liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 50, takeProfitPct: 50, maxDailyLossEur: 100, feePct: 0.25 }, strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 }, ai: { provider: 'none', model: '', baseUrl: '' } });
  const stores = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  const live = { mode: 'live', buy: async () => { throw new Error('geen echte orders in tests'); } };
  const bot = new Bot({
    config, exchange: ex, settings, stores, log: quiet,
    brokers: { paper: new PaperBroker(ex, 0.25), live },
  });
  return { bot, ex, dir, settings, stores };
}

async function openPaperPosition(bot, ex) {
  for (let n = 41; n <= 44 && !bot.store.state.positions['BTC/EUR']; n++) {
    ex.prices = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]).slice(0, n);
    await bot.tick();
  }
  assert.ok(bot.store.state.positions['BTC/EUR'], 'paper-positie geopend');
}

test('wisselen naar live wordt geweigerd zolang er posities open staan', async () => {
  const { bot, ex } = setup({ keys: true });
  await openPaperPosition(bot, ex);
  await assert.rejects(bot.switchMode('live'), /open/);
  assert.equal(bot.mode, 'paper');
});

test('handmatig sluiten werkt en daarna kan naar live, met saldo', async () => {
  const { bot, ex, dir } = setup({ keys: true });
  await openPaperPosition(bot, ex);
  await bot.closeManual('BTC/EUR');
  assert.equal(bot.store.state.trades[0].exitReason, 'Handmatig gesloten');
  await assert.rejects(bot.closeManual('BTC/EUR'), /Geen open positie/);

  await bot.switchMode('live');
  assert.equal(bot.mode, 'live');
  assert.equal(bot.liveBalance.eurFree, 123);
  assert.equal(bot.store.state.trades.length, 0, 'live heeft een eigen state');
  // Modus blijft bewaard na herstart
  assert.equal(new Settings(dir, { liveTrading: false, ai: {} }).mode, 'live');

  await bot.switchMode('paper');
  assert.equal(bot.store.state.trades.length, 1, 'paper-historie is er nog');
});

test('wisselen naar live wordt geweigerd zonder keys of met kapotte keys', async () => {
  const a = setup({ keys: false });
  await assert.rejects(a.bot.switchMode('live'), /keys/);
  assert.equal(a.bot.mode, 'paper');
  const b = setup({ keys: true, balanceFails: true });
  await assert.rejects(b.bot.switchMode('live'), /werken niet/);
  assert.equal(b.bot.mode, 'paper');
});

test('ticks lopen nooit tegelijk', async () => {
  const { bot } = setup({});
  await Promise.all([bot.tick(), bot.tick(), bot.tick()]);
  assert.equal(bot.activity.filter((a) => a.message.startsWith('Check klaar')).length, 1);
});

test('coins wijzigen valideert tegen Bitvavo en beschermt open posities', async () => {
  const { bot, ex } = setup({});
  ex.markets = {
    'BTC/EUR': { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true },
    'SOL/EUR': { symbol: 'SOL/EUR', base: 'SOL', quote: 'EUR', spot: true, active: true },
    'ETH/BTC': { symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true },
  };
  ex.loadMarkets = async () => ex.markets;
  ex.fetchTickers = async () => ({ 'SOL/EUR': { last: 150, quoteVolume: 9e6 }, 'BTC/EUR': { last: 60000, quoteVolume: 5e6 } });

  const list = await bot.listMarkets();
  assert.deepEqual(list.map((m) => m.pair), ['SOL/EUR', 'BTC/EUR'], 'alleen EUR, op volume gesorteerd');

  await assert.rejects(bot.setPairs(['DOGE/EUR']), /Onbekend/);
  await assert.rejects(bot.setPairs([]), /minimaal/);
  await bot.setPairs(['sol/eur', 'BTC/EUR']);
  assert.deepEqual(bot.settings.pairs, ['SOL/EUR', 'BTC/EUR']);

  await openPaperPosition(bot, ex);
  await assert.rejects(bot.setPairs(['SOL/EUR']), /positie open/);
});

test('planning aanpassen valideert en roept de herplanning aan', async () => {
  const { bot } = setup({});
  let rescheduled = 0;
  bot.onScheduleChange = () => rescheduled++;
  await bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 2 });
  assert.equal(bot.settings.timeframe, '5m');
  assert.equal(bot.settings.checkIntervalMinutes, 2);
  assert.equal(rescheduled, 1);
  await assert.rejects(bot.setSchedule({ timeframe: '3m', checkIntervalMinutes: 5 }), /candle-tijd/);
  await assert.rejects(bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 0 }), /tussen 1 en 240/);
  await assert.rejects(bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 2.5 }), /tussen 1 en 240/);
  assert.equal(rescheduled, 1);
});

test('risico-instellingen worden gevalideerd en gelden direct voor de inzet', async () => {
  const { bot, ex } = setup({});
  await assert.rejects(bot.setRisk({ stakeEur: 2, maxOpenTrades: 2, stopLossPct: 3, takeProfitPct: 6, maxDailyLossEur: 20, feePct: 0.25 }), /Inzet per trade/);
  await assert.rejects(bot.setRisk({ stakeEur: 10, maxOpenTrades: 0, stopLossPct: 3, takeProfitPct: 6, maxDailyLossEur: 20, feePct: 0.25 }), /open trades/);
  await bot.setRisk({ stakeEur: 10, maxOpenTrades: 1, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25 });
  await openPaperPosition(bot, ex);
  assert.equal(bot.store.state.positions['BTC/EUR'].costEur, 10, 'inzet komt uit de instelling');
  assert.equal(bot.store.state.balanceEur, 490);
});

test('stop-loss 0 = uit: een grote daling sluit de positie niet', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0 });
  await openPaperPosition(bot, ex);
  // Alleen de actuele koers zakt 85%; de candles blijven gelijk (geen verkoopsignaal).
  ex.fetchTicker = async () => ({ last: 10 });
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'positie staat nog open');

  // Met stop-loss aan gaat hij wel dicht.
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 5, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0 });
  await bot.tick();
  assert.match(bot.store.state.trades[0].exitReason, /Stop-loss/);
});

test('strategie aanpassen en paper opnieuw beginnen', async () => {
  const { bot, ex } = setup({});
  await assert.rejects(bot.setStrategy({ emaFast: 20, emaSlow: 10, rsiPeriod: 14, rsiMaxEntry: 70 }), /kleiner/);
  await bot.setStrategy({ emaFast: 5, emaSlow: 9, rsiPeriod: 7, rsiMaxEntry: 100 });
  assert.equal(bot.strategy.emaFast, 5);
  await openPaperPosition(bot, ex);
  await bot.resetPaper(1000);
  assert.equal(bot.store.state.balanceEur, 1000);
  assert.deepEqual(bot.store.state.positions, {});
  await assert.rejects(bot.resetPaper(1), /Startsaldo/);
});

test('de bot stuurt meldingen bij kopen, stop-loss en een heartbeat na elke check', async () => {
  const { bot, ex } = setup({});
  const sent = [];
  const beats = [];
  bot.notifier = {
    send: async (event, payload) => { sent.push({ event, title: payload.title }); return true; },
    heartbeat: async (ok) => { beats.push(ok); return { ok }; },
  };
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 5, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0 });
  await openPaperPosition(bot, ex);
  ex.fetchTicker = async () => ({ last: 10 });
  await bot.tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((s) => s.event === 'trades' && s.title.startsWith('Gekocht')));
  assert.ok(sent.some((s) => s.event === 'stoploss'));
  assert.ok(beats.length >= 2 && beats.every((b) => b === true));
});

test('na elke check staat er een samenvatting in het log', async () => {
  const { bot, ex } = setup({});
  ex.prices = [...Array(40)].map((_, i) => 100 - i); // alleen daling: geen signaal
  await bot.tick();
  assert.match(bot.activity[0].message, /1 coin bekeken, geen koopsignaal, AI niet nodig/);
  await openPaperPosition(bot, ex);
  assert.ok(bot.activity.some((a) => /1 koopsignaal/.test(a.message) && /1 gekocht/.test(a.message)));
});

test('dagoverzicht: cijfers van 24 uur, verstuurd ook als de AI faalt', async () => {
  const { bot, ex } = setup({});
  const sent = [];
  bot.notifier = { send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 5, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0 });
  await openPaperPosition(bot, ex);
  ex.fetchTicker = async () => ({ last: 10 });
  await bot.tick(); // stop-loss

  // Zonder AI: alleen de cijfers
  let sum = await bot.dailySummary();
  assert.equal(sum.trades, 1);
  assert.ok(sum.pnlEur < 0);
  assert.equal(sum.analysis, null);
  const msg = sent.find((s) => s.event === 'dailySummary');
  assert.match(msg.title, /Dagoverzicht/);
  assert.match(msg.message, /Geen AI ingesteld/);
  assert.equal(bot.store.state.lastSummary.trades, 1);

  // Met een AI die faalt: overzicht komt er toch, met de reden
  bot.settings.setAi({ provider: 'openai', model: 'x', baseUrl: 'http://127.0.0.1:9', failMode: 'reject' });
  bot.secrets = { get: () => 'key' };
  bot.config.ai = { ...bot.config.ai, timeoutMs: 500 };
  sum = await bot.dailySummary();
  assert.ok(sum.aiError);
  assert.match(sent.at(-1).message, /Geen AI-analyse/);
});

test('tijd voor het dagoverzicht wordt gevalideerd', () => {
  const { settings } = setup({});
  assert.throws(() => settings.setNotify({ summaryTime: '25:00' }), /UU:MM/);
  settings.setNotify({ summaryTime: '07:30' });
  assert.equal(settings.notify.summaryTime, '07:30');
  assert.equal(settings.notify.events.trades, true, 'andere keuzes blijven staan');
});
