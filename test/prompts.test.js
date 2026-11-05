import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildExitPrompt } from '../src/ai.js';

const now = Date.now(), M = 300000;
// Rustig stijgende reeks: [ts, open, high, low, close, volume]
// Elke derde candle een kleine terugval, zoals in een echte trend.
const trend = (n = 24, step = 0.2, vol = 1000) => Array.from({ length: n }, (_, i) => {
  const o = 100 + i * step, c = i % 3 === 2 ? o - step / 2 : o + step;
  return [now - (n - i) * M, o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c, vol];
});

test('koopprompt: harde filters vooraf uitgerekend', () => {
  const p = buildPrompt({ pair: 'ADA/EUR', timeframe: '5m', recentCandles: trend(),
    indicators: { close: 104.8, emaFast: 104, emaSlow: 102, rsi: 78, adx: 15, atr: 0.5, atrPct: 0.48, volumeRatio: 0.6, change24: 5 },
    extra: { btcTrend: { up: false, close: 1, ema50: 2 }, risk: { stopLossPct: 2, feePct: 0.25, slippagePct: 0.1 } } });
  assert.match(p, /✗ ADX 15\.0/);
  assert.match(p, /✗ volume 0\.6×/);
  assert.match(p, /✗ RSI 78\.0/);
  assert.match(p, /✗ koers 5\.6 ATR boven EMA slow/);
  assert.match(p, /✗ Bitcoin-trend omlaag/);
  assert.match(p, /1R \(verlies tot stop\): 2\.00%/);
  assert.match(p, /Kosten per ronde: 0\.70% = 0\.35R/);
});

test('koopprompt: goede setup heeft geen ✗, feedback met winrate en R', () => {
  const p = buildPrompt({ pair: 'SOL/EUR', timeframe: '5m', recentCandles: trend(24, 0.2, 1000),
    indicators: { close: 104.8, emaFast: 104.4, emaSlow: 103.9, rsi: 62, adx: 28, atr: 0.6, atrPct: 0.57, volumeRatio: 1.5, change24: 4 },
    extra: { btcTrend: { up: true, close: 2, ema50: 1 }, risk: { stopLossPct: 3, feePct: 0.25 },
      recentTrades: [{ pnlPct: 3, exit: 'Take-profit (3%)' }, { pnlPct: -3, exit: 'Stop-loss (-3%)' }, { pnlPct: 1.5, exit: 'AI neemt winst (1.5%): x' }],
      aiHistory: [{ decision: 'approve', outcome: 'winst', resultPct: 3, reason: 'sterke trend' }] } });
  assert.doesNotMatch(p, /^✗/m);
  assert.match(p, /Regime: trend/);
  assert.match(p, /3 trades: winrate 67%, gemiddeld \+0\.50% = \+0\.17R/);
  assert.match(p, /goedgekeurd → winst \(\+3\.0%\): sterke trend/);
});

test('koopprompt: werkt ook zonder candles en zonder extra (onbekend in plaats van fout)', () => {
  const p = buildPrompt({ pair: 'BTC/EUR', timeframe: '1h', recentCandles: [], indicators: { close: 1, emaFast: 1, emaSlow: 1, rsi: 50, change24: 0 } });
  assert.match(p, /Regime: onbekend/);
  assert.match(p, /dit is BTC zelf/);
  assert.doesNotMatch(p, /NaN|undefined/);
});

test('winstcheck: zwaktesignalen en teruggegeven winst', () => {
  const c = trend(9).concat([
    [now - 2 * M, 101.8, 102.6, 101.5, 101.6, 900],
    [now - M, 101.6, 102.4, 101.3, 101.4, 700],
    [now, 101.4, 102.0, 101.2, 101.3, 500],
  ]);
  const e = buildExitPrompt({ pair: 'SOL/EUR', timeframe: '5m', price: 101.3, recentCandles: c,
    indicators: { rsi: 72, emaFast: 101.5, emaSlow: 101, adx: 24, atrPct: 0.5, volumeRatio: 0.6 },
    position: { entryPrice: 100, highest: 102.6, openedAt: new Date(now - 30 * 60000).toISOString() },
    risk: { stopLossPct: 2, feePct: 0.25 } });
  assert.match(e, /⚠ lagere highs/);
  assert.match(e, /⚠ lange bovenwieken/);
  assert.match(e, /⚠ \d rode candle\(s\) op rij/);
  assert.match(e, /⚠ volume daalt/);
  assert.match(e, /⚠ RSI 72\.0/);
  assert.match(e, /teruggegeven: 50%/);
  assert.match(e, /= \+0\.65R \(1R = 2\.00%\)/);
  assert.doesNotMatch(e, /NaN|undefined/);
});
