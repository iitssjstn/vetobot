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
  const settings = new Settings(dir, { liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15, ai: { provider: 'none', model: '', baseUrl: '' } });
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
