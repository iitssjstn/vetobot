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
      // Vaste tijdlijn: een prijs die erbij komt is een nieuwe candle, net als in het echt.
      const base = Math.floor(Date.now() / H) * H - 1000 * H;
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
  await assert.rejects(bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 0 }), /10 seconden/);
  await assert.rejects(bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 5 / 60 }), /10 seconden/);
  assert.equal(rescheduled, 1);
  // Onder de minuut mag, afgerond op hele seconden
  await bot.setSchedule({ timeframe: '1m', checkIntervalMinutes: 10 / 60 });
  assert.equal(bot.settings.checkIntervalMinutes * 60, 10);
  await bot.setSchedule({ timeframe: '1m', checkIntervalMinutes: 2.5 });
  assert.equal(bot.settings.checkIntervalMinutes, 2.5);
});

test('risico-instellingen worden gevalideerd en gelden direct voor de inzet', async () => {
  const { bot, ex } = setup({});
  await assert.rejects(bot.setRisk({ stakeEur: 0.05, maxOpenTrades: 2, stopLossPct: 3, takeProfitPct: 6, maxDailyLossEur: 20, feePct: 0.25 }), /Inzet per trade/);
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

test('voorstel overnemen past alleen de aangevinkte instellingen toe', async () => {
  const { bot } = setup({});
  await bot.setSchedule({ timeframe: '5m', checkIntervalMinutes: 5 });
  bot.store.state.lastSummary = {
    suggestions: [
      { key: 'stopLossPct', label: 'Stop-loss (%)', group: 'risk', from: 50, to: 4.5 },
      { key: 'timeframe', label: 'Candle-tijd', group: 'schedule', from: '5m', to: '15m' },
    ],
  };
  const stakeBefore = bot.risk.stakeEur;
  const applied = await bot.applySummarySuggestions(['stopLossPct']);
  assert.deepEqual(applied.map((x) => x.key), ['stopLossPct']);
  assert.equal(bot.risk.stopLossPct, 4.5);
  assert.equal(bot.settings.timeframe, '5m', 'niet aangevinkt blijft gelijk');
  assert.equal(bot.risk.stakeEur, stakeBefore);
  assert.ok(bot.store.state.lastSummary.appliedAt);
  await assert.rejects(bot.applySummarySuggestions(['stopLossPct']), /staan al zo|Kies minimaal/);
});

test('AI-volgorde: keys per model en hergebruik bij dezelfde provider', () => {
  const { bot } = setup({});
  const keys = { aiApiKey: 'gem-key', aiApiKey3: 'groq-key' };
  bot.secrets = { get: (n) => keys[n] ?? '' };
  bot.settings.setAi({
    provider: 'gemini', model: 'g1', failMode: 'reject',
    fallbacks: [
      { provider: 'gemini', model: 'g2' },                                        // geen key: hergebruikt model 1
      { provider: 'openai', model: 'l1', baseUrl: 'https://api.groq.com/openai/v1' },  // eigen key
      { provider: 'openai', model: 'l2', baseUrl: 'https://api.groq.com/openai/v1' },  // hergebruikt model 3
      { provider: 'openai', model: 'x', baseUrl: 'https://openrouter.ai/api/v1' },     // andere provider: geen key
    ],
  });
  const chain = bot.aiChain();
  assert.deepEqual(chain.map((c) => [c.slot, c.apiKey, c.keyFrom]),
    [[1, 'gem-key', 1], [2, 'gem-key', 1], [3, 'groq-key', 3], [4, 'groq-key', 3], [5, '', null]]);
  assert.throws(() => bot.settings.setAi({ provider: 'gemini', fallbacks: [1, 2, 3, 4, 5].map(() => ({ provider: 'gemini' })) }), /Maximaal 4/);
  bot.settings.setAi({ provider: 'none', fallbacks: [{ provider: 'gemini' }] });
  assert.deepEqual(bot.aiChain(), [], 'model 1 op geen AI = AI uit');
});

test('modellen ophalen vraagt om een key, en gebruikt anders die van hetzelfde type', async () => {
  const { bot } = setup({});
  await assert.rejects(bot.listAiModels({ provider: 'none' }), /provider/);
  await assert.rejects(bot.listAiModels({ provider: 'gemini', fromSlot: null, newKey: '' }), /API-key/);
});

test('open posities: waarde en P/L met live koers en verkoopfee, koersen gecachet', async () => {
  const { bot } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0.25 });
  bot.store.state.positions = {
    'BTC/EUR': { pair: 'BTC/EUR', entryPrice: 100, amount: 0.25, costEur: 25 },
    'ETH/EUR': { pair: 'ETH/EUR', entryPrice: 50, amount: 0.5, costEur: 25 },
  };
  let calls = 0;
  bot.ex.fetchTickers = async (pairs) => { calls++; return Object.fromEntries(pairs.map((p) => [p, { last: p === 'BTC/EUR' ? 110 : 45 }])); };
  await bot.refreshPrices(['BTC/EUR', 'ETH/EUR']);
  await bot.refreshPrices(['BTC/EUR', 'ETH/EUR']);
  assert.equal(calls, 1, 'tweede keer uit de cache');

  const v = bot.openPositionsValue();
  const btc = v.positions.find((p) => p.pair === 'BTC/EUR');
  // 0,25 × 110 = 27,50, min 0,25% fee = 27,43125; P/L = +2,43125
  assert.ok(Math.abs(btc.valueEur - 27.43125) < 1e-9);
  assert.ok(Math.abs(btc.pnlEur - 2.43125) < 1e-9);
  // ETH: 0,5 × 45 = 22,50 × 0,9975 = 22,44375; P/L = −2,55625
  assert.ok(Math.abs(v.pnlEur - (2.43125 - 2.55625)) < 1e-9);
  assert.equal(v.costEur, 50);
  assert.equal(v.complete, true);
});

test('afkoelperiode en daglimiet met open verlies blokkeren nieuwe aankopen', async () => {
  const { checkEntry } = await import('../src/risk.js');
  const { bot } = setup({});
  const risk = { ...bot.risk, maxOpenTrades: 5, maxDailyLossEur: 20, cooldownMinutes: 30 };
  bot.store.state.lastExit = { 'BTC/EUR': new Date(Date.now() - 10 * 60000).toISOString() };
  assert.match(checkEntry(bot.store, { risk }, 'paper', bot.ex, null, { pair: 'BTC/EUR' }), /Afkoelperiode: nog 20 min/);
  assert.equal(checkEntry(bot.store, { risk }, 'paper', bot.ex, null, { pair: 'ETH/EUR' }), null, 'andere coin mag wel');
  assert.equal(checkEntry(bot.store, { risk: { ...risk, cooldownMinutes: 0 } }, 'paper', bot.ex, null, { pair: 'BTC/EUR' }), null);
  // Geen gesloten verlies, maar € 25 open verlies: limiet van € 20 is bereikt
  assert.match(checkEntry(bot.store, { risk }, 'paper', bot.ex, null, { pair: 'ETH/EUR', openPnlEur: -25 }), /Daglimiet.*open -25/);
  // Open winst telt niet als buffer
  assert.equal(checkEntry(bot.store, { risk }, 'paper', bot.ex, null, { pair: 'ETH/EUR', openPnlEur: 50 }), null);
});

test('na een verkoop wordt de verkooptijd per coin bewaard', async () => {
  const { bot, ex } = setup({});
  await openPaperPosition(bot, ex);
  await bot.closeManual('BTC/EUR');
  assert.ok(bot.store.state.lastExit['BTC/EUR']);
});

test('paper-slippage maakt kopen duurder en verkopen goedkoper', async () => {
  const ex = { fetchTicker: async () => ({ last: 100 }) };
  const b = new PaperBroker(ex, 0, () => 0.5);
  const buy = await b.buy('BTC/EUR', 100);
  assert.ok(Math.abs(buy.price - 100.5) < 1e-9);
  const sell = await b.sell('BTC/EUR', 1);
  assert.ok(Math.abs(sell.price - 99.5) < 1e-9);
});

test('een herstart koopt niet opnieuw op dezelfde kruising', async () => {
  const { bot, ex, dir, settings, stores } = setup({});
  await bot.setRisk({ ...bot.settings.risk, cooldownMinutes: 0 });
  await openPaperPosition(bot, ex);
  await bot.closeManual('BTC/EUR');
  // Nieuwe bot op dezelfde opslag, alsof de container herstart
  const reloaded = { paper: new Store(dir, 'paper', 500), live: new Store(dir, 'live', 500) };
  assert.ok(reloaded.paper.state.seenSignals['BTC/EUR'], 'kruising staat in het state-bestand');
  const bot2 = new Bot({
    config: bot.config, exchange: ex, settings, stores: reloaded, log: quiet,
    brokers: { paper: new PaperBroker(ex, 0.25), live: bot.brokers.live },
  });
  await bot2.tick();
  assert.deepEqual(bot2.store.state.positions, {}, 'geen dubbele aankoop');
  void stores;
});

test('bij checks onder de minuut worden rustige checks maar eens per minuut gelogd', async () => {
  const { bot, ex } = setup({});
  ex.prices = [...Array(40)].map((_, i) => 100 - i);
  await bot.setSchedule({ timeframe: '1m', checkIntervalMinutes: 10 / 60 });
  const before = bot.activity.length;
  await bot.tick(); await bot.tick(); await bot.tick();
  assert.equal(bot.activity.filter((a) => a.message.startsWith('Check klaar')).length, 1);
  assert.ok(bot.activity.length - before <= 1);
});

test('onder de € 5 kan alleen in paper', async () => {
  const { bot, ex } = setup({ keys: true });
  await bot.setRisk({ stakeEur: 1, maxOpenTrades: 2 });
  await openPaperPosition(bot, ex);
  assert.equal(bot.store.state.positions['BTC/EUR'].costEur, 1);
  await bot.closeManual('BTC/EUR');
  await assert.rejects(bot.switchMode('live'), /minimaal € 5/);
  await bot.setRisk({ stakeEur: 5, maxOpenTrades: 2 });
  await bot.switchMode('live');
  await assert.rejects(bot.setRisk({ stakeEur: 2 }), /minimaal € 5/);
});

test('live budgetplafond begrenst de totale inzet', async () => {
  const { checkEntry } = await import('../src/risk.js');
  const { bot } = setup({ keys: true });
  const risk = { ...bot.risk, stakeEur: 10, maxOpenTrades: 10, maxDailyLossEur: 0, cooldownMinutes: 0, liveBudgetEur: 25 };
  bot.stores.live.state.positions = { 'A/EUR': { costEur: 10 }, 'B/EUR': { costEur: 10 } };
  assert.match(checkEntry(bot.stores.live, { risk }, 'live', bot.ex, null, { pair: 'C/EUR' }), /Budgetplafond: 20.00 van 25.00/);
  assert.equal(checkEntry(bot.stores.live, { risk: { ...risk, stakeEur: 5 } }, 'live', bot.ex, null, { pair: 'C/EUR' }), null, 'precies op 25 mag');
  assert.equal(checkEntry(bot.stores.live, { risk: { ...risk, liveBudgetEur: 0 } }, 'live', bot.ex, null, { pair: 'C/EUR' }), null, '0 = uit');
  // Geldt niet in paper
  bot.stores.paper.state.positions = { 'A/EUR': { costEur: 10 }, 'B/EUR': { costEur: 10 } };
  assert.equal(checkEntry(bot.stores.paper, { risk }, 'paper', bot.ex, null, { pair: 'C/EUR' }), null);
});

test('trailing stop verkoopt na een terugval vanaf de top', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, trailingStopPct: 5, cooldownMinutes: 0 });
  await openPaperPosition(bot, ex);
  const entry = bot.store.state.positions['BTC/EUR'].entryPrice;
  ex.fetchTicker = async () => ({ last: entry * 1.2 });   // stijgt 20%: nieuwe top
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'nog open op de top');
  assert.ok(Math.abs(bot.store.state.positions['BTC/EUR'].highest - entry * 1.2) < 1e-9);
  ex.fetchTicker = async () => ({ last: entry * 1.2 * 0.94 }); // 6% onder de top
  await bot.tick();
  assert.match(bot.store.state.trades[0].exitReason, /Trailing stop/);
  assert.ok(bot.store.state.trades[0].pnlEur > 0, 'met winst eruit');
});

test('ATR-stop vervangt de vaste stop-loss', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, stopLossPct: 1, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, atrStopMult: 3, cooldownMinutes: 0 });
  await openPaperPosition(bot, ex);
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos.atrAtEntry > 0, 'ATR bij aankoop bewaard');
  // 2% daling: vaste stop van 1% zou verkopen, maar de ATR-stop ligt lager
  ex.fetchTicker = async () => ({ last: pos.entryPrice * 0.98 });
  await bot.tick();
  if (pos.entryPrice - 3 * pos.atrAtEntry < pos.entryPrice * 0.98) assert.ok(bot.store.state.positions['BTC/EUR'], 'ATR-stop nog niet geraakt');
  ex.fetchTicker = async () => ({ last: pos.entryPrice - 3 * pos.atrAtEntry - 0.01 });
  await bot.tick();
  assert.match(bot.store.state.trades[0].exitReason, /ATR-stop/);
});

test('BTC-filter blokkeert altcoins als BTC daalt', async () => {
  // De nep-exchange geeft voor elk pair dezelfde koersen, dus ook BTC daalt lang en veert kort op.
  const run = async (btcFilter) => {
    const { bot, ex } = setup({});
    await bot.setStrategy({ ...bot.settings.strategy, btcFilter });
    bot.settings.data.pairs = ['ETH/EUR'];
    ex.prices = [...Array(120)].map((_, i) => 300 - i);
    await bot.tick();
    for (const extra of [180, 182, 184, 186]) { ex.prices = ex.prices.concat([extra]); await bot.tick(); }
    return bot;
  };
  const without = await run(0);
  assert.ok(without.store.state.positions['ETH/EUR'], 'zonder filter wordt er gekocht');
  const withF = await run(1);
  assert.equal(withF.btcTrend.up, false);
  assert.deepEqual(withF.store.state.positions, {}, 'met filter niet');
  assert.match(withF.pairStatus['ETH/EUR'].reason, /BTC-filter/);
});

test('alle posities bezet: signalen stil overslaan, geen AI en geen regel bij AI-signalen', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 1, cooldownMinutes: 0, stopLossPct: 0, takeProfitPct: 0 });
  // Net gekocht en minimaal 500 candles vasthouden: blijft staan, zodat alle posities bezet blijven.
  await bot.setStrategy({ minHoldCandles: 500 });
  bot.store.state.positions = { 'X/EUR': { pair: 'X/EUR', entryPrice: 1, amount: 1, costEur: 25, openedAt: new Date().toISOString() } };
  let aiAsked = 0;
  bot.settings.setAi({ provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:9', failMode: 'reject' });
  bot.secrets = { get: () => { aiAsked++; return 'k'; } };
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]);
  // De kruising valt op de 43e candle; daarna is hij niet meer vers.
  for (let n = 41; n <= 43; n++) { ex.prices = seq.slice(0, n); await bot.tick(); }
  assert.equal(bot.store.state.decisions.length, 0, 'geen beslissingen');
  assert.equal(aiAsked, 0, 'AI niet gevraagd');
  assert.match(bot.pairStatus['BTC/EUR'].reason, /alle 1 posities zijn bezet/);
  assert.ok(bot.activity.some((a) => /overgeslagen \(alle posities bezet\)/.test(a.message)));
});

test('posities in coins die niet (meer) in de lijst staan worden ook bewaakt', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stopLossPct: 5, takeProfitPct: 0 });
  bot.store.state.positions = { 'OUD/EUR': { pair: 'OUD/EUR', entryPrice: 100, amount: 0.25, costEur: 25, highest: 100 } };
  ex.fetchTicker = async () => ({ last: 90 });
  await bot.tick();
  assert.equal(bot.store.state.positions['OUD/EUR'], undefined);
  assert.match(bot.store.state.trades.find((x) => x.pair === 'OUD/EUR').exitReason, /Stop-loss/);
});

test('alleen verse kruisingen: na een herstart niet kopen op een oude kruising', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]);
  // Kruising op candle 43, de bot "start" pas bij candle 44.
  ex.prices = seq;
  await bot.tick();
  assert.equal(Object.keys(bot.store.state.positions).length, 0);
  assert.doesNotMatch(bot.pairStatus['BTC/EUR'].reason, /kruist boven/);
});

test('kruisingen tussen twee checks worden niet gemist', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]);
  ex.prices = seq.slice(0, 41);
  await bot.tick();
  // Drie candles later pas weer een check: de kruising van twee candles terug telt nog.
  ex.prices = seq;
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'gekocht');
});

test('niet achter de koers aan: overslaan als de koers sinds het signaal te ver is gestegen', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  await bot.setStrategy({ maxChasePct: 1 });
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66]);
  ex.prices = seq.slice(0, 42);
  await bot.tick();
  ex.prices = seq;
  ex.fetchTicker = async () => ({ last: 66 * 1.03 });
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.pairStatus['BTC/EUR'].reason, /al 3\.00% gestegen \(max 1%\)/);
  // Binnen de marge wel kopen
  ex.fetchTicker = async () => ({ last: 66 * 1.005 });
  bot.lastCandleSeen['BTC/EUR'] = null;
  ex.prices = seq;
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR']);
});

test('lopende candle meenemen geeft het signaal een candle eerder', async () => {
  const run = async (useOpenCandle) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ useOpenCandle });
    // De laatste candle loopt nog (tijdstempel van nu).
    const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66]);
    ex.fetchOHLCV = async (_p, _tf, _s, limit) => {
      const end = Math.floor(Date.now() / H) * H;
      return seq.map((c, i) => [end - (seq.length - 1 - i) * H, c, c, c, c, 1]).slice(-limit);
    };
    ex.fetchTicker = async () => ({ last: 66 });
    await bot.tick();
    return Boolean(bot.store.state.positions['BTC/EUR']);
  };
  assert.equal(await run(0), false, 'zonder lopende candle nog geen kruising');
  assert.equal(await run(1), true, 'met lopende candle al wel');
});

// ---------- Snelle bewaking en AI-winstcheck ----------
import http from 'node:http';

// Nep-AI (OpenAI-compatibel) die antwoordt met wat er in aiAnswer staat.
let aiAnswer = 'hold';
let aiCalls = 0;
let lastAiPrompt = '';
const aiServer = http.createServer((req, res) => {
  aiCalls++;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { lastAiPrompt = JSON.parse(body).messages.at(-1).content; } catch {}
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: aiAnswer, reason: aiAnswer === 'sell' ? 'momentum neemt af' : 'stijging zet door' }) } }] }));
  });
});
await new Promise((r) => aiServer.listen(0, r));
test.after(() => aiServer.close());

function withAi(bot) {
  bot.settings.setAi({ provider: 'openai', model: 'm', baseUrl: `http://127.0.0.1:${aiServer.address().port}/v1`, failMode: 'approve' });
  bot.secrets = { get: (n) => (n === 'aiApiKey' ? 'k' : '') };
}

test('bewaking tussen checks door: take-profit direct, zonder te wachten op de volgende check', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ takeProfitPct: 2, stopLossPct: 5, aiExitMinPct: 0 });
  await openPaperPosition(bot, ex);
  const entry = bot.store.state.positions['BTC/EUR'].entryPrice;
  ex.fetchTicker = async () => ({ last: entry * 1.01 });
  assert.equal(await bot.watchPositions(), 0, '1% winst: nog vasthouden');
  ex.fetchTicker = async () => ({ last: entry * 1.025 });
  assert.equal(await bot.watchPositions(), 1);
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /Take-profit/);
});

test('AI-winstcheck: AI kan de winst eerder nemen dan de take-profit', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ takeProfitPct: 0, stopLossPct: 5, trailingStopPct: 0, aiExitMinPct: 1, aiExitEveryMin: 3 });
  await openPaperPosition(bot, ex);
  withAi(bot);
  const entry = bot.store.state.positions['BTC/EUR'].entryPrice;
  aiCalls = 0;
  // Onder de drempel: AI wordt niet gevraagd
  ex.fetchTicker = async () => ({ last: entry * 1.005 });
  await bot.watchPositions();
  assert.equal(aiCalls, 0);
  // Boven de drempel, AI houdt vast
  aiAnswer = 'hold';
  ex.fetchTicker = async () => ({ last: entry * 1.015 });
  await bot.watchPositions();
  assert.equal(aiCalls, 1);
  assert.ok(bot.store.state.positions['BTC/EUR']);
  assert.ok(bot.activity.some((a) => /AI houdt vast bij 1\.50% winst/.test(a.message)));
  // Binnen 3 minuten niet opnieuw vragen
  aiAnswer = 'sell';
  await bot.watchPositions();
  assert.equal(aiCalls, 1);
  // Na de wachttijd wel, en dan verkopen
  bot.store.state.positions['BTC/EUR'].aiExit.at = new Date(Date.now() - 4 * 60000).toISOString();
  await bot.watchPositions();
  assert.equal(aiCalls, 2);
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /AI neemt winst \(1\.50%\): momentum neemt af/);
});

test('AI-winstcheck staat uit zonder AI-key of met drempel 0', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ takeProfitPct: 0, aiExitMinPct: 1 });
  await openPaperPosition(bot, ex);
  aiCalls = 0;
  const entry = bot.store.state.positions['BTC/EUR'].entryPrice;
  ex.fetchTicker = async () => ({ last: entry * 1.05 });
  await bot.watchPositions();
  assert.equal(aiCalls, 0, 'geen AI ingesteld');
  withAi(bot);
  await bot.setRisk({ aiExitMinPct: 0 });
  await bot.watchPositions();
  assert.equal(aiCalls, 0, 'drempel 0 = uit');
  assert.ok(bot.store.state.positions['BTC/EUR']);
});

test('winst herinvesteren: inzet groeit mee met de winst, nooit onder je eigen inzet', async () => {
  const { bot } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 2, reinvestPct: 50, maxStakeEur: 0 });
  const trade = (pnlEur) => bot.store.addTrade({ pair: 'BTC/EUR', pnlEur, closedAt: new Date().toISOString() });
  assert.equal(bot.stakeInfo().effective, 25);
  trade(10); // € 10 winst × 50% ÷ 2 trades = € 2,50 extra
  assert.equal(bot.stakeInfo().effective, 27.5);
  assert.equal(bot.entryRisk().stakeEur, 27.5);
  trade(-30); // netto € 20 verlies: terug naar de eigen inzet, niet eronder
  assert.equal(bot.stakeInfo().effective, 25);
  trade(100); // netto € 80 winst → € 20 extra, maar maximaal € 40
  await bot.setRisk({ maxStakeEur: 40 });
  assert.equal(bot.stakeInfo().effective, 40);
  assert.equal(bot.stakeInfo().capped, true);
  await bot.setRisk({ reinvestPct: 0 });
  assert.equal(bot.stakeInfo().effective, 25, 'uit = vaste inzet');
});

test('winst herinvesteren: de grotere inzet wordt ook echt gebruikt bij kopen', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ stakeEur: 25, maxOpenTrades: 2, reinvestPct: 100, cooldownMinutes: 0 });
  bot.store.addTrade({ pair: 'ETH/EUR', pnlEur: 10, closedAt: new Date().toISOString() });
  await openPaperPosition(bot, ex);
  assert.equal(bot.store.state.positions['BTC/EUR'].costEur, 30);
  assert.ok(bot.activity.some((a) => /waarvan € 5,00 herinvesteerde winst/.test(a.message)));
});

test('whipsaw-bescherming: pas verkopen na bevestiging en minimale tijd in de positie', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, stopLossPct: 50, takeProfitPct: 0, aiExitMinPct: 0 });
  await bot.setStrategy({ sellConfirmCandles: 2, minHoldCandles: 3 });
  await openPaperPosition(bot, ex);
  const pos = bot.store.state.positions['BTC/EUR'];
  const up = ex.prices.slice();
  // Eén candle omlaag: EMA fast zakt onder EMA slow, maar nog niet bevestigd
  ex.prices = up.concat([60]);
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'na 1 candle nog niet verkopen');
  assert.match(bot.pairStatus['BTC/EUR'].reason, /wacht op bevestiging/);
  // Tweede candle omlaag: bevestigd, maar de positie staat pas net open
  ex.prices = up.concat([60, 58]);
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'te kort in de positie');
  assert.match(bot.pairStatus['BTC/EUR'].reason, /minimaal 3 candles/);
  // Na 3 uur (3 candles van 1 uur): nu wel verkopen
  pos.openedAt = new Date(Date.now() - 3 * H - 1000).toISOString();
  ex.prices = up.concat([60, 58, 57]);
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /Trend omlaag: EMA fast \d+ candles onder EMA slow/);
});

test('whipsaw-bescherming: herstelt de trend binnen de bevestiging, dan geen verkoop', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, stopLossPct: 50, takeProfitPct: 0, aiExitMinPct: 0 });
  await bot.setStrategy({ sellConfirmCandles: 2, minHoldCandles: 0 });
  await openPaperPosition(bot, ex);
  const up = ex.prices.slice();
  ex.prices = up.concat([60]);
  await bot.tick();
  ex.prices = up.concat([60, 75]);
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'dip hersteld: positie blijft');
});

test('limietorders: niet gevulde koop wordt overgeslagen, stop-loss verkoopt altijd market', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, limitOrders: 1, limitWaitSec: 5, stopLossPct: 5, takeProfitPct: 0, aiExitMinPct: 0 });
  const calls = [];
  bot.brokers.paper.buy = async (pair, stake, opts) => { calls.push(['buy', opts]); return null; };
  for (let n = 41; n <= 44; n++) { ex.prices = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]).slice(0, n); await bot.tick(); }
  assert.equal(Object.keys(bot.store.state.positions).length, 0);
  assert.deepEqual(calls[0], ['buy', { limit: true, waitSec: 5 }]);
  assert.ok(bot.activity.some((a) => /Limietorder niet gevuld binnen 5 sec/.test(a.message)));
  // Stop-loss: sell zonder limiet
  const sells = [];
  bot.brokers.paper.sell = async (pair, amount, opts) => { sells.push(opts); return { amount, price: 60, costEur: 20, feeEur: 0.05 }; };
  bot.store.state.positions['BTC/EUR'] = { pair: 'BTC/EUR', entryPrice: 70, amount: 0.35, costEur: 25, highest: 70, openedAt: new Date().toISOString() };
  ex.fetchTicker = async () => ({ last: 60 });
  await bot.watchPositions();
  assert.deepEqual(sells[0], {});
  assert.match(bot.store.state.trades[0].exitReason, /^Stop-loss/);
});

test('AI krijgt stop, kosten, strengheid en eigen strategiegrenzen mee', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, stopLossPct: 3, feePct: 0.25, slippagePct: 0.1, limitOrders: 0 });
  await bot.setStrategy({ rsiMaxEntry: 80, aiStrictness: 2, adxMin: 0, volumeMult: 0, btcFilter: 0, maxChasePct: 0 });
  withAi(bot);
  aiAnswer = 'reject';
  lastAiPrompt = '';
  const seq = [...Array(40)].map((_, i) => 100 - i).concat([62, 64, 66, 68]);
  for (let n = 41; n <= 44; n++) { ex.prices = seq.slice(0, n); await bot.tick(); }
  assert.ok(lastAiPrompt, 'AI gevraagd');
  assert.match(lastAiPrompt, /strengheid: soepel/);
  assert.match(lastAiPrompt, /RSI [\d.]+ \(max\. 80:/, 'max RSI volgt de strategie');
  assert.match(lastAiPrompt, /ADX [\d.onbekend]+ \(min\. 15:/, 'ADX volgt de strengheid');
  assert.match(lastAiPrompt, /1R \(verlies tot stop\): 3\.00%/);
  assert.match(lastAiPrompt, /Kosten per ronde: 0\.70% = 0\.23R/);
  assert.match(lastAiPrompt, /Minimale verwachte winst: positief/);
  // Met limietorders rekent hij met de maker-fee (nieuwe bot, want dit signaal is al beoordeeld)
  const b2 = setup({});
  await b2.bot.setRisk({ cooldownMinutes: 0, stopLossPct: 3, feePct: 0.25, slippagePct: 0.1, limitOrders: 1, makerFeePct: 0.15 });
  await b2.bot.setStrategy({ maxChasePct: 0, rsiMaxEntry: 100 });
  withAi(b2.bot);
  lastAiPrompt = '';
  for (let n = 41; n <= 44; n++) { b2.ex.prices = seq.slice(0, n); await b2.bot.tick(); }
  assert.match(lastAiPrompt, /Kosten per ronde: 0\.50%/);
});

test('tijdslimiet: positie wordt na de maximale tijd verkocht', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ takeProfitPct: 0, stopLossPct: 10, aiExitMinPct: 0, maxHoldMinutes: 30 });
  await openPaperPosition(bot, ex);
  const pos = bot.store.state.positions['BTC/EUR'];
  ex.fetchTicker = async () => ({ last: pos.entryPrice * 1.004 });
  await bot.watchPositions();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'nog binnen de tijd');
  pos.openedAt = new Date(Date.now() - 31 * 60000).toISOString();
  await bot.watchPositions();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /^Tijdslimiet: 31 min in de positie/);
});

test('limietorders stand 2: kopen direct (market), winst nemen met limiet', async () => {
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, limitOrders: 2, limitWaitSec: 5, takeProfitPct: 2, stopLossPct: 5, aiExitMinPct: 0 });
  const buys = [], sells = [];
  const b = bot.brokers.paper;
  const origBuy = b.buy.bind(b), origSell = b.sell.bind(b);
  b.buy = async (pair, stake, opts) => { buys.push(opts); return origBuy(pair, stake, {}); };
  b.sell = async (pair, amount, opts) => { sells.push(opts); return origSell(pair, amount, {}); };
  await openPaperPosition(bot, ex);
  assert.deepEqual(buys[0], {});
  const pos = bot.store.state.positions['BTC/EUR'];
  ex.fetchTicker = async () => ({ last: pos.entryPrice * 1.03 });
  await bot.watchPositions();
  assert.deepEqual(sells[0], { limit: true, waitSec: 5 });
});

test('check haalt candles van alle coins vooraf op, maximaal 8 tegelijk', async () => {
  const pairs = Array.from({ length: 20 }, (_, i) => `C${i}/EUR`);
  const { bot, ex } = setup({});
  bot.settings.data.pairs = pairs;
  let active = 0, maxActive = 0;
  const orig = ex.fetchOHLCV.bind(ex);
  const seen = new Set();
  ex.fetchOHLCV = async (...a) => { seen.add(a[0]); active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 2)); active--; return orig(...a); };
  ex.prices = [...Array(60)].map((_, i) => 100 + i * 0.1);
  await bot.tick();
  assert.equal(seen.size, 20);
  assert.ok(maxActive > 1 && maxActive <= 8, `tegelijk: ${maxActive}`);
});

test('eigen model: winstkans bij het signaal, minimale kans filtert, AI krijgt de kans mee', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));
  const run = async (minProb, initShift) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ mlMinProb: minProb, maxChasePct: 0 });
    // init verschuiven = kans hoog of laag forceren
    const model = { ...fixture.model, init: fixture.model.init + initShift, meta: { timeframe: '1h', days: 60, targetPct: 3, stopPct: 2, metrics: { base: { winRate: 40 } } } };
    bot.getModel = () => model;
    bot.getTeamwork = () => ({ total: 40, modelThreshold: 60, approved: { n: 20, winRate: 30, avgReturnPct: -0.2 }, rejected: { n: 20, winRate: 50, avgReturnPct: 0.3 },
      modelYesAiNo: { n: 10, winRate: 60, avgReturnPct: 0.5 }, modelNoAiYes: { n: 0 }, bothYes: { n: 5, winRate: 60, avgReturnPct: 0.4 } });
    bot.fb = [];
    bot.onFeedback = (t) => bot.fb.push(t);
    withAi(bot);
    aiAnswer = 'approve';
    lastAiPrompt = '';
    const seq = [...Array(100)].map((_, i) => 100 + Math.sin(i) * 0.5).concat([...Array(160)].map((_, i) => 100 - i * 0.2), [68, 70, 72, 74]);
    bot.reasons = [];
    for (let n = 261; n <= seq.length; n++) { ex.prices = seq.slice(0, n); await bot.tick(); bot.reasons.push(bot.pairStatus['BTC/EUR']?.reason); }
    return bot;
  };
  const high = await run(50, 10);
  assert.ok(high.store.state.decisions[0]?.indicators?.mlProb > 99, 'kans in de beslissing');
  assert.match(lastAiPrompt, /Winstkans volgens het model: 100%/);
  assert.match(lastAiPrompt, /zomaar kopen won op de testperiode 40%/);
  // Feedback: de kenmerken van het signaal gaan mee in de positie, en bij het sluiten met de uitkomst naar de trainer
  const pos = high.store.state.positions['BTC/EUR'];
  assert.ok(pos?.ml, 'kenmerken bewaard in de positie');
  assert.ok(Number.isFinite(pos.ml.features.htfTrendPct));
  assert.ok(Number.isFinite(pos.ml.features.btcRet12), 'BTC-kenmerken (BTC/EUR zelf)');
  let fb = null;
  high.onFeedback = (t) => { fb = t; };
  await high.closeManual('BTC/EUR');
  assert.equal(fb.pair, 'BTC/EUR');
  assert.equal(fb.timeframe, '1h');
  assert.ok(fb.prob > 99);
  assert.ok(Number.isFinite(fb.returnPct));
  assert.equal(fb.exitReason, 'Handmatig gesloten');
  assert.equal(fb.ts, pos.ml.ts);
  const low = await run(50, -10);
  assert.equal(low.store.state.decisions.length, 0, 'onder de minimale kans: AI niet gevraagd');
  assert.ok(low.reasons.some((r) => /eigen model geeft maar 0% winstkans \(minimaal 50%\)/.test(r ?? '')), low.reasons.join(' | '));
  // Model voor een andere candle-tijd wordt niet gebruikt
  const { bot } = setup({});
  bot.getModel = () => ({ ...fixture.model, meta: { timeframe: '5m' } });
  assert.equal(bot.store.state.decisions.length, 0);
});

test('eigen model: marktfase waarin het model verliest → AI gewaarschuwd, of overslaan', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));
  const bad = { n: 500, nSelected: 120, avgReturnPct: -0.4, baseAvgReturnPct: -0.5 };
  const run = async (skip) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ mlMinProb: 0, maxChasePct: 0, mlSkipBadRegime: skip });
    const model = { ...fixture.model, meta: { timeframe: '1h', days: 60, targetPct: 3, stopPct: 2, metrics: { regimes: { stijgend: bad, zijwaarts: bad, dalend: bad } } } };
    bot.getModel = () => model;
    bot.getTeamwork = () => ({ total: 40, modelThreshold: 60, approved: { n: 20, winRate: 30, avgReturnPct: -0.2 }, rejected: { n: 20, winRate: 50, avgReturnPct: 0.3 },
      modelYesAiNo: { n: 10, winRate: 60, avgReturnPct: 0.5 }, modelNoAiYes: { n: 0 }, bothYes: { n: 5, winRate: 60, avgReturnPct: 0.4 } });
    bot.fb = [];
    bot.onFeedback = (t) => bot.fb.push(t);
    withAi(bot);
    aiAnswer = 'approve';
    lastAiPrompt = '';
    const seq = [...Array(100)].map((_, i) => 100 + Math.sin(i) * 0.5).concat([...Array(160)].map((_, i) => 100 - i * 0.2), [68, 70, 72, 74]);
    bot.reasons = [];
    for (let n = 261; n <= seq.length; n++) { ex.prices = seq.slice(0, n); await bot.tick(); bot.reasons.push(bot.pairStatus['BTC/EUR']?.reason); }
    return bot;
  };
  const warn = await run(0);
  assert.match(lastAiPrompt, /Soort markt nu: \w+ markt\. In dit soort markt maakten de trades die het model zou nemen op de test gemiddeld -0.40% per trade \(120 trades\)\. Het model scoort in dit soort markt dus slecht/);
  assert.ok(warn.store.state.decisions[0]?.indicators?.mlRegime);
  // Samenwerking: het model legt uit waarom, de AI krijgt het scorebord, en het oordeel gaat terug naar de trainer
  assert.match(lastAiPrompt, /Waarom het model dit zegt/);
  assert.match(lastAiPrompt, /procentpunt/);
  assert.match(lastAiPrompt, /wie had gelijk\? \(laatste 40 signalen\)/);
  assert.match(lastAiPrompt, /Je wijst te vaak goede trades af/);
  assert.match(lastAiPrompt, /Als het model ja zei en jij nee, had het model vaak gelijk/);
  assert.ok(warn.store.state.decisions[0].indicators.mlWhy.length > 0);
  const sig = warn.fb.find((t) => t.kind === 'signal');
  assert.equal(sig.aiDecision, 'approve');
  assert.equal(sig.pair, 'BTC/EUR');
  assert.ok(sig.prob > 0);
  const skip = await run(1);
  assert.equal(skip.store.state.decisions.length, 0);
  assert.ok(skip.reasons.some((r) => /maakte het eigen model op de test verlies \(gem\. -0\.40% per trade\)/.test(r ?? '')), skip.reasons.join(' | '));
});

test('zelflerend kiezen: strategieën op elke candle-tijd bepalen zelf de aankoop; beloning na het sluiten', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0, stopLossPct: 9, takeProfitPct: 9 });
  await bot.setStrategy({ mlMinProb: 0, maxChasePct: 0, mlBandit: 1 });
  const arm = (key, init, target, stop) => ({ key, timeframe: key.split('|')[0], targetPct: target, stopPct: stop, holdMinutes: 240, minProb: 0.5,
    model: { ...fixture.model, init: fixture.model.init + init, meta: { timeframe: key.split('|')[0], targetPct: target, stopPct: stop } } });
  // '15m' ziet altijd een kans (~100%), '1h' nooit (~0%); de bot zelf staat op 1h
  bot.getArms = () => [arm('15m|2|1|240', 10, 2, 1), arm('1h|5|3|240', -10, 5, 3)];
  withAi(bot);
  aiAnswer = 'approve';
  lastAiPrompt = '';
  // Zijwaartse koers, geen EMA-kruising: toch kopen, want een strategie ziet een kans
  const seq = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  ex.prices = seq;
  await bot.tick();
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, `gekocht: ${bot.pairStatus['BTC/EUR']?.reason}`);
  assert.deepEqual(pos.plan, { key: '15m|2|1|240', stopLossPct: 1, takeProfitPct: 2, maxHoldMinutes: 240 });
  assert.equal(pos.ml.timeframe, '15m', 'kenmerken van de candle-tijd van de strategie, voor de feedback');
  assert.match(bot.store.state.decisions[0].reason ?? '', /./);
  assert.match(lastAiPrompt, /Zelflerend: strategie 15m \+2% \/ −1%, max 4 uur ziet 100% kans/);
  assert.match(lastAiPrompt, /1R \(verlies tot stop\): 1\.00%/, 'AI krijgt het plan van de gekozen strategie');
  assert.equal(bot.banditSummary().arms, 2);
  assert.equal(bot.bandit.openShadows(), 1, 'de strategie die wilde kopen kreeg een schaduwtrade');
  assert.ok(bot.thoughts.some((t) => /Eén strategie wil kopen: 15m \+2% \/ −1%, max 4 uur, 100% kans/.test(t.text) && t.pair === 'BTC/EUR'), JSON.stringify(bot.thoughts));
  assert.ok(bot.thoughts.some((t) => /De AI is het met me eens/.test(t.text)));
  // EMA-verkoopsignaal telt niet voor een strategie-positie; take-profit (2%) wel
  ex.prices = [...seq, seq.at(-1) * 1.025];
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /Take-profit/);
  const st = bot.bandit.stats('15m|2|1|240');
  assert.equal(st.trades, 1);
  assert.equal(st.shadowTrades, 1, 'schaduwtrade ook afgerekend (doel gehaald)');
  assert.ok(bot.thoughts.some((t) => /Schaduwtrade afgelopen \(doel gehaald\)/.test(t.text)));
  assert.ok(st.total > 0, 'beloning = de winst');
  assert.ok(bot.activity.some((a) => /Beloning voor strategie/.test(JSON.stringify(a))));
  assert.ok(bot.thoughts.some((t) => /Trade gesloten met \+\d+,\d+%.*Dat is een beloning: ik ga strategie 15m · 2 · 1 · 240 vaker kiezen/.test(t.text)), JSON.stringify(bot.thoughts.map((t) => t.text)));
  // Nieuwe candle: mag opnieuw; daarna dezelfde candle nog eens: niet nog een keer beoordelen
  await bot.tick();
  if (bot.store.state.positions['BTC/EUR']) await bot.closeManual('BTC/EUR');
  const n = bot.store.state.decisions.length;
  await bot.tick();
  assert.equal(bot.store.state.decisions.length, n);
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.equal(bot.bandit.stats('15m|2|1|240').trades, 1, 'handmatig sluiten telt niet als beloning');
  assert.ok(bot.thoughts.some((t) => /geen enkele ziet nu genoeg kans|strategie wil kopen/.test(t.text)));
});

test('orderboek-check: te groot verschil bied/laat → niet kopen; info gaat naar de AI', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));
  const run = async (spread) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0, maxSpreadPct: 0.5, maxBookCostPct: 0.3 });
    await bot.setStrategy({ mlMinProb: 0, maxChasePct: 0, mlBandit: 1 });
    bot.getArms = () => [{ key: '15m|2|1|240', timeframe: '15m', targetPct: 2, stopPct: 1, holdMinutes: 240, minProb: 0.5,
      model: { ...fixture.model, init: fixture.model.init + 10, meta: { timeframe: '15m' } } }];
    ex.fetchOrderBook = async () => {
      const p = ex.prices.at(-1);
      return { bids: [[p * (1 - spread / 200), 1000], [p * 0.98, 1000]], asks: [[p * (1 + spread / 200), 1000], [p * 1.02, 1000]] };
    };
    withAi(bot);
    aiAnswer = 'approve';
    lastAiPrompt = '';
    ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
    await bot.tick();
    return bot;
  };
  const wide = await run(2);
  assert.equal(wide.store.state.positions['BTC/EUR'], undefined);
  assert.match(wide.store.state.decisions[0].reason, /verschil tussen bied en laat is 2.00% \(max 0.5%\)/);
  assert.equal(lastAiPrompt, '', 'geen AI-vraag nodig');
  const ok = await run(0.1);
  assert.ok(ok.store.state.positions['BTC/EUR']);
  assert.match(lastAiPrompt, /Orderboek nu: verschil bied\/laat 0.10%, deze aankoop wordt ~0.05% boven de middenprijs gevuld, binnen 1% van de prijs 50% kopers/);
  assert.equal(ok.store.state.decisions[0].indicators.book.spreadPct, 0.1);
});

test('zelflerend zonder bevestigde strategie: verkenning alleen schaduw, proef traded in paper, resultaten naar de trainer', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ml-parity.json', import.meta.url), 'utf8'));
  const arm = (key, stage) => ({ key, stage, timeframe: '15m', targetPct: 2, stopPct: 1, holdMinutes: 240, minProb: 0.5,
    model: { ...fixture.model, init: fixture.model.init + 10, meta: { timeframe: '15m' } } });
  const run = async (arms, trial = 1) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ mlMinProb: 0, maxChasePct: 0, mlBandit: 1, mlTrialPaper: trial });
    bot.getArms = () => arms;
    bot.fb = [];
    bot.onFeedback = (t) => bot.fb.push(t);
    withAi(bot);
    aiAnswer = 'approve';
    ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
    await bot.tick();
    return { bot, ex };
  };
  // Alleen verkenning: niet kopen, wel een schaduwtrade
  const v = await run([arm('15m|2|1|240', 'verkenning')]);
  assert.equal(v.bot.store.state.positions['BTC/EUR'], undefined);
  assert.equal(v.bot.bandit.openShadows(), 1);
  assert.match(v.bot.pairStatus['BTC/EUR'].reason, /alleen als oefening/);
  assert.ok(v.bot.thoughts.some((t) => /kandidaat-strategie ziet een kans/.test(t.text)));
  // Schaduwtrade loopt af (doel gehaald) → resultaat naar de trainer
  v.ex.prices = [...v.ex.prices, v.ex.prices.at(-1) * 1.03];
  await v.bot.tick();
  const armFb = v.bot.fb.find((t) => t.kind === 'arm');
  assert.equal(armFb.key, '15m|2|1|240');
  assert.equal(armFb.shadow, true);
  assert.ok(armFb.pct > 0);
  // Proef in paper: echt kopen
  const p = await run([arm('15m|2|1|240', 'proef')]);
  assert.ok(p.bot.store.state.positions['BTC/EUR']);
  assert.equal(p.bot.banditSummary().rows[0].stage, 'proef');
  // Proef, maar "alleen schaduwtrades" gekozen: niet kopen
  const ps = await run([arm('15m|2|1|240', 'proef')], 0);
  assert.equal(ps.bot.store.state.positions['BTC/EUR'], undefined);
});

test('AI-trader: koopt en verkoopt zelf, uitkomst naar de trainer; live pas na bewijs', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  const mkAgent = (stage, sell) => ({ ...fx.agent, stage, threshold: 0.2,
    entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 },
    exit: { ...fx.agent.exit, init: fx.agent.exit.init + (sell ? -50 : 50) } });
  const run = async (agent, mode = 'paper') => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ maxChasePct: 0, agentMode: 1, agentVeto: 1 });
    if (mode === 'live') bot.settings.data.mode = 'live';
    bot.getAgent = () => agent;
    bot.fb = [];
    bot.onFeedback = (t) => bot.fb.push(t);
    withAi(bot);
    aiAnswer = 'approve';
    lastAiPrompt = '';
    ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
    await bot.tick();
    return { bot, ex };
  };
  // Koopt zonder EMA-kruising, alleen omdat hij winst verwacht
  const { bot, ex } = await run(mkAgent('getest', false));
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, bot.pairStatus['BTC/EUR']?.reason);
  assert.equal(pos.agent.timeframe, '15m');
  assert.equal(pos.plan.takeProfitPct, 0, 'geen vast winstdoel');
  assert.equal(pos.plan.stopLossPct, 10, 'alleen de noodstop');
  assert.match(lastAiPrompt, /de AI-trader beslist zelf wanneer hij verkoopt/);
  assert.ok(bot.thoughts.some((t) => /Ik koop BTC\/EUR: ik verwacht \+\d/.test(t.text)));
  // Vasthouden zolang hij er nog iets van verwacht
  ex.prices = [...ex.prices, 100.5];
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR']);
  assert.match(bot.pairStatus['BTC/EUR'].reason, /AI-trader houdt vast/);
  // Nu verwacht hij niets meer van vasthouden: zelf verkopen
  bot.getAgent = () => mkAgent('getest', true);
  ex.prices = [...ex.prices, 101];
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.store.state.trades[0].exitReason, /AI-trader verkoopt/);
  const fb = bot.fb.find((t) => t.kind === 'agentTrade');
  assert.equal(fb.timeframe, '15m');
  assert.ok(fb.pct > 0);
  assert.ok(fb.features && Number.isFinite(fb.features.rsi14), 'kenmerken bij aankoop, om van te leren');
  assert.ok(bot.thoughts.some((t) => /Ik verkoop BTC\/EUR/.test(t.text)));
  // Live: alleen als alle eisen gehaald zijn én de eigenaar het recept zelf live toestond
  const live = await run({ ...mkAgent('getest', false), recipeKey: 'R' }, 'live');
  assert.equal(live.bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(live.bot.pairStatus['BTC/EUR'].reason, /live handel ik pas als ik alle eisen voor live haal/);
  const ready = { ...mkAgent('bewezen', false), recipeKey: 'R', liveCheck: { allMet: true, checks: [] } };
  const notYet = await run(ready, 'live');
  assert.match(notYet.bot.pairStatus['BTC/EUR'].reason, /als je dit recept zelf live toestaat/);
  assert.equal(notYet.bot.agentAllowed(ready), false, 'eisen gehaald, maar nog geen akkoord');
  notYet.bot.settings.setAgentLive('R', true);
  assert.equal(notYet.bot.agentAllowed(ready), true);
  assert.equal(notYet.bot.agentAllowed({ ...ready, liveCheck: { allMet: false } }), false, 'eis weggevallen');
});

test('AI-trader live: kleinste inzet in het begin, en terug uit live als een eis wegvalt', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  const { bot, ex } = setup({});
  const sent = [];
  bot.notifier = { send: async (event, payload) => { sent.push({ event, ...payload }); return true; }, heartbeat: async () => null };
  await bot.setRisk({ cooldownMinutes: 0, stakeEur: 20 });
  await bot.setStrategy({ maxChasePct: 0, agentMode: 1, agentVeto: 0 });
  bot.settings.data.mode = 'live';
  bot.liveBalance = { eurFree: 1000 };
  ex.apiKey = 'k'; ex.secret = 's';
  const pb = new PaperBroker(ex, 0.25);
  Object.assign(bot.brokers.live, { buy: (...a) => pb.buy(...a), sell: (...a) => pb.sell(...a) });
  let agent = { ...fx.agent, stage: 'bewezen', recipeKey: 'R', liveCheck: { allMet: true, checks: [] }, entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 },
    regimes: { stijgend: { key: 'R', why: 'best' }, zijwaarts: { key: 'R', why: 'best' }, dalend: { key: 'R', why: 'best' } } };
  bot.getAgent = () => agent;
  bot.settings.setAgentLive('R', true);
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  const pos = bot.store.state.positions['BTC/EUR'];
  assert.ok(pos, bot.pairStatus['BTC/EUR']?.reason);
  assert.ok(pos.costEur <= 5.5, `live begint met de kleinste inzet: ${pos.costEur}`);
  // Een eis valt weg: akkoord ingetrokken en een melding.
  agent = { ...agent, liveCheck: { allMet: false, checks: [{ ok: false, label: 'Beter dan de markt', now: '-0,1%' }] } };
  await bot.tick();
  assert.deepEqual(bot.settings.agentLive.approved, []);
  const m = sent.find((x) => x.title === 'AI-trader handelt niet meer live');
  assert.ok(m, 'melding');
  assert.match(m.message, /Beter dan de markt \(nu: -0,1%\)/);
});

test('AI-trader: handelt alleen de coins die hij zelf gekozen heeft, ook buiten je eigen lijst', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  await bot.setStrategy({ maxChasePct: 0, agentMode: 1 });
  const agent = { ...fx.agent, stage: 'getest', recipeKey: '15m|1|4|200|5', coins: ['ETH/EUR'], entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 } };
  bot.getAgent = () => agent;
  withAi(bot);
  aiAnswer = 'approve';
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.pairStatus['BTC/EUR'].reason, /handelt deze coin niet/);
  assert.ok(bot.store.state.positions['ETH/EUR'], 'zelf gekozen coin, niet in de eigen lijst');
  assert.equal(bot.store.state.positions['ETH/EUR'].agent.recipe, '15m|1|4|200|5');
});

test('AI-trader zonder AI-controleur: geen AI-vraag, de AI-trader beslist zelf', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  await bot.setStrategy({ maxChasePct: 0, agentMode: 1, agentVeto: 0 });
  bot.getAgent = () => ({ ...fx.agent, stage: 'getest', entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 } });
  withAi(bot);
  aiAnswer = 'reject';
  lastAiPrompt = '';
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  assert.ok(bot.store.state.positions['BTC/EUR'], 'gekocht ondanks dat de AI nee zou zeggen');
  assert.equal(lastAiPrompt, '', 'AI-controleur niet gevraagd');
  assert.match(bot.store.state.decisions[0].reason, /De AI-trader beslist zelf/);
});

test('AI-trader-team: Strategy Agent per marktfase, Risk Agent inzet, Execution Agent meet', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
  const base = { ...fx.agent, stage: 'getest', recipeKey: 'A', entry: { ...fx.agent.entry, init: fx.agent.entry.init + 50 } };
  const run = async (agent) => {
    const { bot, ex } = setup({});
    await bot.setRisk({ cooldownMinutes: 0 });
    await bot.setStrategy({ maxChasePct: 0, agentMode: 1, agentVeto: 0 });
    bot.getAgent = () => agent;
    ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
    await bot.tick();
    return bot;
  };
  // Geen plan per fase: hoofdrecept, maar halve inzet (weinig bewijs).
  const b1 = await run(base);
  const p1 = b1.store.state.positions['BTC/EUR'];
  assert.ok(p1, b1.pairStatus['BTC/EUR']?.reason);
  const regime = b1.agentTeam().market['BTC/EUR'];
  assert.ok(['stijgend', 'zijwaarts', 'dalend'].includes(regime), 'Market Agent heeft een fase');
  assert.equal(p1.agent.marketRegime, regime);
  assert.ok(Math.abs(p1.costEur - b1.stakeInfo().effective / 2) < 0.6, `halve inzet: ${p1.costEur}`);
  assert.ok(b1.store.state.execLog.length >= 1 && b1.store.state.execLog[0].side === 'buy', 'Execution Agent meet de aankoop');
  // In deze fase niet handelen: niets kopen.
  const all = (p) => ({ stijgend: p, zijwaarts: p, dalend: p });
  const b2 = await run({ ...base, regimes: all({ key: null, why: 'pauze', edge: -0.3, trades: 40 }) });
  assert.equal(b2.store.state.positions['BTC/EUR'], undefined);
  assert.match(b2.pairStatus['BTC/EUR'].reason, /Strategy Agent: in een .* handel ik niet/);
  // Ander recept het best in deze fase: dat recept koopt, met volle inzet.
  const other = { ...base, recipeKey: 'B', threshold: base.threshold };
  const b3 = await run({ ...base, regimes: all({ key: 'B', why: 'best', edge: 0.3, trades: 40, agent: other }) });
  const p3 = b3.store.state.positions['BTC/EUR'];
  assert.ok(p3, b3.pairStatus['BTC/EUR']?.reason);
  assert.equal(p3.agent.recipe, 'B');
  assert.ok(Math.abs(p3.costEur - b3.stakeInfo().effective) < 0.6, 'volle inzet');
  // Risk Agent: na 3 verliezen op rij geen nieuwe aankoop.
  const { bot, ex } = setup({});
  await bot.setRisk({ cooldownMinutes: 0 });
  await bot.setStrategy({ maxChasePct: 0, agentMode: 1, agentVeto: 0 });
  bot.getAgent = () => base;
  const now = new Date().toISOString();
  bot.store.state.trades = [1, 2, 3].map(() => ({ pair: 'ETH/EUR', pnlEur: -1, pnlPct: -1, closedAt: now, agent: { recipe: 'A' } }));
  ex.prices = [...Array(300)].map((_, i) => 100 + Math.sin(i / 3) * 0.3);
  await bot.tick();
  assert.equal(bot.store.state.positions['BTC/EUR'], undefined);
  assert.match(bot.pairStatus['BTC/EUR'].reason, /Risk Agent: 3 verliezen op rij/);
});

test('dagoverzicht met de AI-trader: geen ongeteste voorstellen, AI-trader in de data, model zichtbaar', async () => {
  let prompt = '';
  let system = '';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = JSON.parse(body).messages;
      prompt = msgs.at(-1).content;
      system = msgs[0].content;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ analyse: 'Rustige dag.', voorstel: { stopLossPct: 4, emaFast: 5 }, toelichting: 'gok' }) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-parity.json', import.meta.url), 'utf8'));
    const { bot } = setup({});
    bot.notifier = { send: async () => true, heartbeat: async () => null };
    bot.settings.setAi({ provider: 'openai', model: 'samenvatter', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, failMode: 'reject' });
    bot.secrets = { get: (n) => (n === 'aiApiKey' ? 'k' : '') };
    // Zonder AI-trader: voorstel mag, maar het model staat erbij.
    let sum = await bot.dailySummary();
    assert.equal(sum.suggestions.length, 2);
    assert.match(sum.model, /samenvatter/);
    assert.match(system, /Een voorstel is NIET getest/);
    // Met de AI-trader: geen voorstellen, wel zijn gegevens.
    await bot.setStrategy({ agentMode: 1 });
    bot.getAgent = () => ({ ...fx.agent, stage: 'getest', recipeKey: '15m|1|4|200|5', regimes: { dalend: { key: null, why: 'pauze', edge: -0.2, trades: 30 } } });
    sum = await bot.dailySummary();
    assert.equal(sum.suggestions.length, 0, 'de AI-trader test zijn eigen instellingen');
    assert.equal(sum.aiTrader, true);
    assert.match(system, /Doe GEEN voorstel voor instellingen/);
    const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
    assert.equal(data.aiTrader.recept, '15m|1|4|200|5');
    assert.equal(data.aiTrader.receptPerMarktfase.dalend.recept, 'niet handelen');
    assert.equal(data.instellingen.emaFast, undefined, 'geen klassieke instellingen die hij niet gebruikt');
  } finally {
    srv.close();
  }
});
