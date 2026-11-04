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
  constructor({ config, exchange, broker, store, log = console }) {
    this.config = config;
    this.ex = exchange;
    this.broker = broker;
    this.store = store;
    this.log = log;
    this.lastSignalCandle = {};
    this.lastTickAt = null;
    this.lastError = null;
    this.running = false;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.#resetHaltIfNewDay();
      for (const pair of this.config.pairs) {
        try {
          await this.#handlePair(pair);
        } catch (err) {
          this.log.error(`[${pair}] ${err.message}`);
          this.lastError = { at: new Date().toISOString(), pair, message: err.message };
        }
      }
      this.lastTickAt = new Date().toISOString();
      this.store.save();
    } finally {
      this.running = false;
    }
  }

  #resetHaltIfNewDay() {
    const h = this.store.state.halted;
    if (h && !h.manual && new Date(h.at).toDateString() !== new Date().toDateString()) {
      this.log.info('Nieuwe dag, dagelijkse verlieslimiet gereset.');
      this.store.state.halted = null;
    }
  }

  async #handlePair(pair) {
    const { strategy, risk, timeframe } = this.config;
    const position = this.store.state.positions[pair];

    // 1. Open positie beheren
    if (position) {
      const price = await fetchPrice(this.ex, pair);
      const changePct = ((price - position.entryPrice) / position.entryPrice) * 100;
      if (changePct <= -risk.stopLossPct) return this.#close(pair, `Stop-loss (${changePct.toFixed(2)}%)`);
      if (changePct >= risk.takeProfitPct) return this.#close(pair, `Take-profit (${changePct.toFixed(2)}%)`);
    }

    const candles = await fetchClosedCandles(this.ex, pair, timeframe, Math.max(200, strategy.emaSlow * 4));
    const lastCandleTs = candles.at(-1)?.[0];
    const result = evaluate(candles, strategy);

    if (position) {
      if (result.signal === 'sell') return this.#close(pair, result.reason);
      return;
    }

    if (result.signal !== 'buy') return;
    // Zelfde candle niet twee keer beoordelen.
    if (this.lastSignalCandle[pair] === lastCandleTs) return;
    this.lastSignalCandle[pair] = lastCandleTs;

    const blocked = checkEntry(this.store, this.config, this.broker.mode);
    if (blocked) {
      this.store.addDecision({ pair, signal: 'buy', outcome: 'blocked', reason: blocked, indicators: result.indicators });
      this.log.info(`[${pair}] Koopsignaal geblokkeerd door risicoregels: ${blocked}`);
      return;
    }

    const veto = await askVeto(this.config.ai, {
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
    this.log.info(`[${pair}] AI (${veto.provider}): ${veto.decision} - ${veto.reason}`);

    if (veto.decision === 'approve') await this.#open(pair, result.reason);
  }

  async #open(pair, reason) {
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
    this.log.info(`[${pair}] GEKOCHT ${fill.amount} @ ${fill.price} (${this.broker.mode})`);
  }

  async #close(pair, reason) {
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
    this.log.info(`[${pair}] VERKOCHT @ ${fill.price}, resultaat ${pnlEur.toFixed(2)} EUR (${reason})`);

    const today = this.store.realizedTodayEur();
    if (today <= -this.config.risk.maxDailyLossEur && !this.store.state.halted) {
      this.store.state.halted = { at: new Date().toISOString(), reason: `Dagverlies ${today.toFixed(2)} EUR` };
      this.log.warn(`Dagelijkse verlieslimiet bereikt. Geen nieuwe trades tot morgen.`);
    }
  }
}
