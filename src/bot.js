import { evaluate } from './strategy.js';
import { askVeto } from './ai.js';
import { fetchClosedCandles, fetchPrice } from './exchange.js';
import { checkEntry } from './risk.js';

// Eén "tick": loopt alle pairs langs, beheert open posities en beoordeelt nieuwe signalen.
//
// Volgorde per pair:
//   1. Open positie? Dan eerst stop-loss / take-profit / verkoopsignaal. Verkopen gaat
//      NOOIT langs de AI, zodat een AI-fout een stop-loss niet kan blokkeren.
//   2. Geen positie en een koopsignaal? Dan eerst de harde risicoregels, daarna de AI-veto.

export class Bot {
  constructor({ config, exchange, broker, store, secrets, log = console }) {
    this.config = config;
    this.ex = exchange;
    this.broker = broker;
    this.store = store;
    this.secrets = secrets;
    this.log = log;
    this.lastSignalCandle = {};
    this.lastTickAt = null;
    this.lastError = null;
    this.running = false;
    // Live status voor het dashboard
    this.currentStep = null;
    this.nextTickAt = null;
    this.pairStatus = {};
    this.activity = [];
  }

  // Logt een gebeurtenis én bewaart hem voor het activiteitenlog in het dashboard.
  #event(level, pair, message) {
    const text = pair ? `[${pair}] ${message}` : message;
    (this.log[level] ?? this.log.info).call(this.log, text);
    this.activity.unshift({ at: new Date().toISOString(), level, pair, message });
    this.activity.length = Math.min(this.activity.length, 100);
  }

  #step(text) {
    this.currentStep = text;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    let errors = 0;
    try {
      this.#resetHaltIfNewDay();
      for (const pair of this.config.pairs) {
        try {
          await this.#handlePair(pair);
        } catch (err) {
          errors++;
          this.#event('error', pair, err.message);
          this.lastError = { at: new Date().toISOString(), pair, message: err.message };
          this.pairStatus[pair] = { ...this.pairStatus[pair], at: new Date().toISOString(), error: err.message };
        }
      }
      this.lastTickAt = new Date().toISOString();
      if (!errors) this.lastError = null;
      this.store.save();
      this.#event('info', null, `Check klaar in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (errors ? ` met ${errors} fout(en)` : ''));
    } finally {
      this.running = false;
      this.#step(null);
    }
  }

  #resetHaltIfNewDay() {
    const h = this.store.state.halted;
    if (h && !h.manual && new Date(h.at).toDateString() !== new Date().toDateString()) {
      this.#event('info', null, 'Nieuwe dag, dagelijkse verlieslimiet gereset.');
      this.store.state.halted = null;
    }
  }

  async #handlePair(pair) {
    const { strategy, risk, timeframe } = this.config;
    const position = this.store.state.positions[pair];

    // 1. Open positie beheren
    let positionChangePct = null;
    if (position) {
      this.#step(`${pair}: positie controleren`);
      const price = await fetchPrice(this.ex, pair);
      const changePct = ((price - position.entryPrice) / position.entryPrice) * 100;
      positionChangePct = changePct;
      const exit = changePct <= -risk.stopLossPct ? `Stop-loss (${changePct.toFixed(2)}%)`
        : changePct >= risk.takeProfitPct ? `Take-profit (${changePct.toFixed(2)}%)` : null;
      if (exit) {
        await this.#close(pair, exit);
        this.pairStatus[pair] = {
          ...this.pairStatus[pair], at: new Date().toISOString(), price, signal: 'sell',
          reason: exit, inPosition: false, positionChangePct: null, error: null,
        };
        return;
      }
    }

    this.#step(`${pair}: candles ophalen`);
    const candles = await fetchClosedCandles(this.ex, pair, timeframe, Math.max(200, strategy.emaSlow * 4));
    const lastCandleTs = candles.at(-1)?.[0];
    const result = evaluate(candles, strategy);
    const ind = result.indicators;
    this.pairStatus[pair] = {
      at: new Date().toISOString(),
      price: ind?.close ?? null,
      rsi: ind?.rsi ?? null,
      trend: ind ? (ind.emaFast > ind.emaSlow ? 'up' : 'down') : null,
      change24: ind?.change24 ?? null,
      signal: result.signal,
      reason: result.reason,
      candleAt: lastCandleTs ? new Date(lastCandleTs).toISOString() : null,
      inPosition: Boolean(position),
      positionChangePct,
      error: null,
    };

    if (position) {
      if (result.signal === 'sell') {
        await this.#close(pair, result.reason);
        this.pairStatus[pair].inPosition = false;
      }
      return;
    }

    if (result.signal !== 'buy') return;
    // Zelfde candle niet twee keer beoordelen.
    if (this.lastSignalCandle[pair] === lastCandleTs) return;
    this.lastSignalCandle[pair] = lastCandleTs;
    this.#event('info', pair, `Koopsignaal: ${result.reason}`);

    const blocked = checkEntry(this.store, this.config, this.broker.mode, this.ex);
    if (blocked) {
      this.store.addDecision({ pair, signal: 'buy', outcome: 'blocked', reason: blocked, indicators: result.indicators });
      this.#event('warn', pair, `Geblokkeerd door risicoregels: ${blocked}`);
      return;
    }

    this.#step(`${pair}: AI om oordeel vragen`);
    const veto = await askVeto({ ...this.config.ai, apiKey: this.secrets?.get('aiApiKey') }, {
      pair,
      timeframe,
      indicators: result.indicators,
      recentCandles: candles.slice(-24),
    });

    this.store.addDecision({
      pair,
      signal: 'buy',
      outcome: veto.decision === 'approve' ? 'approved' : 'vetoed',
      reason: veto.reason,
      provider: veto.provider,
      aiError: Boolean(veto.error),
      strategyReason: result.reason,
      indicators: result.indicators,
    });
    this.#event(veto.decision === 'approve' ? 'info' : 'warn', pair,
      `AI (${veto.provider}) ${veto.decision === 'approve' ? 'keurt goed' : 'wijst af'}: ${veto.reason}`);

    if (veto.decision === 'approve') await this.#open(pair, result.reason);
  }

  async #open(pair, reason) {
    this.#step(`${pair}: kopen`);
    const stake = this.config.risk.stakeEur;
    const fill = await this.broker.buy(pair, stake);
    if (this.broker.mode === 'paper') this.store.state.balanceEur -= fill.costEur;
    this.store.state.positions[pair] = {
      pair,
      openedAt: new Date().toISOString(),
      entryPrice: fill.price,
      amount: fill.amount,
      costEur: fill.costEur,
      entryFeeEur: fill.feeEur,
      reason,
    };
    this.#event('info', pair, `Gekocht: ${fill.amount} @ ${fill.price} (${this.broker.mode})`);
  }

  async #close(pair, reason) {
    this.#step(`${pair}: verkopen`);
    const pos = this.store.state.positions[pair];
    const fill = await this.broker.sell(pair, pos.amount);
    const pnlEur = fill.costEur - pos.costEur;
    if (this.broker.mode === 'paper') this.store.state.balanceEur += fill.costEur;
    delete this.store.state.positions[pair];
    this.store.addTrade({
      pair,
      mode: this.broker.mode,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice: fill.price,
      amount: pos.amount,
      pnlEur,
      pnlPct: (pnlEur / pos.costEur) * 100,
      entryReason: pos.reason,
      exitReason: reason,
    });
    this.#event(pnlEur >= 0 ? 'info' : 'warn', pair, `Verkocht @ ${fill.price}, resultaat ${pnlEur.toFixed(2)} EUR (${reason})`);

    const today = this.store.realizedTodayEur();
    if (today <= -this.config.risk.maxDailyLossEur && !this.store.state.halted) {
      this.store.state.halted = { at: new Date().toISOString(), reason: `Dagverlies ${today.toFixed(2)} EUR` };
      this.#event('warn', null, 'Dagelijkse verlieslimiet bereikt. Geen nieuwe trades tot morgen.');
    }
  }
}
