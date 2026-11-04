import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrades, exitKind } from '../src/analysis.js';

const t = (pnlEur, exitReason, holdMin = 60, extra = {}) => {
  const closed = Date.now();
  return { pair: 'BTC/EUR', pnlEur, pnlPct: pnlEur * 4, costEur: 25, exitReason,
    openedAt: new Date(closed - holdMin * 60000).toISOString(), closedAt: new Date(closed).toISOString(), ...extra };
};

test('verkoopredenen worden ingedeeld', () => {
  assert.equal(exitKind('Stop-loss (-3.10%)'), 'stoploss');
  assert.equal(exitKind('ATR-stop (-2%, stop op 1)'), 'stoploss');
  assert.equal(exitKind('Trailing stop (-2% vanaf top)'), 'trailing');
  assert.equal(exitKind('Take-profit (6.00%)'), 'takeprofit');
  assert.equal(exitKind('AI neemt winst (1.50%): momentum'), 'ai');
  assert.equal(exitKind('EMA fast kruist onder EMA slow (op de laatste candle)'), 'signal');
  assert.equal(exitKind('Trend omlaag: EMA fast 2 candles onder EMA slow'), 'signal');
  assert.equal(exitKind('Handmatig gesloten'), 'manual');
  assert.equal(exitKind('Gevolgd: leider heeft deze positie niet meer'), 'follow');
  assert.equal(exitKind('iets anders'), 'other');
});

test('whipsaw-patroon: veel snelle verliezen op verkoopsignalen geven gerichte tips', () => {
  const trades = [
    ...Array.from({ length: 10 }, () => t(-0.3, 'EMA fast kruist onder EMA slow (op de laatste candle)', 6)),
    t(-0.6, 'Stop-loss (-2.40%)', 30),
    ...Array.from({ length: 4 }, () => t(0.2, 'AI neemt winst (1.20%): momentum neemt af', 20)),
  ];
  const a = analyzeTrades(trades);
  assert.equal(a.trades, 15);
  assert.equal(a.wins, 4);
  assert.ok(Math.abs(a.pnlEur - (-3.6 + 0.8)) < 1e-9);
  assert.equal(a.byExit.find((b) => b.key === 'signal').count, 10);
  assert.equal(a.quickLosses, 10);
  assert.ok(a.payoff < 1);
  assert.ok(a.feesEur > 0, 'fees geschat voor trades zonder feesEur');
  assert.ok(a.advice.some((x) => /whipsaw/.test(x)));
  assert.ok(a.advice.some((x) => /binnen 15 minuten/.test(x)));
  assert.ok(a.advice.some((x) => /gemiddelde winst/.test(x)));
});

test('weinig trades: cijfers wel, nog geen tips', () => {
  const a = analyzeTrades([t(1, 'Take-profit (6%)'), t(-0.5, 'Stop-loss (-3%)')]);
  assert.equal(a.trades, 2);
  assert.equal(a.winRate, 50);
  assert.equal(a.payoff, 2);
  assert.deepEqual(a.advice, []);
  assert.deepEqual(analyzeTrades([]), { trades: 0 });
});
