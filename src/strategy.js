import { ema, rsi, last } from './indicators.js';

// Regelgebaseerde strategie: EMA-crossover met een RSI-filter.
// Werkt alleen op gesloten candles, zodat er geen look-ahead in zit.
//
// candles: [[timestamp, open, high, low, close, volume], ...] (alleen gesloten candles)
export function evaluate(candles, params) {
  const closes = candles.map((c) => c[4]);
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  const r = rsi(closes, params.rsiPeriod);

  if (closes.length < params.emaSlow + 2 || last(slow, 2) == null || last(r) == null) {
    return { signal: 'none', reason: 'Te weinig data', indicators: null };
  }

  const indicators = {
    close: last(closes),
    emaFast: last(fast),
    emaSlow: last(slow),
    rsi: last(r),
    change24: changePct(closes, 24),
  };

  const crossedUp = last(fast, 2) <= last(slow, 2) && last(fast) > last(slow);
  const crossedDown = last(fast, 2) >= last(slow, 2) && last(fast) < last(slow);

  if (crossedUp && indicators.rsi < params.rsiMaxEntry) {
    return { signal: 'buy', reason: 'EMA fast kruist boven EMA slow', indicators };
  }
  if (crossedUp) {
    return { signal: 'none', reason: `Crossover, maar RSI ${indicators.rsi.toFixed(1)} is te hoog`, indicators };
  }
  if (crossedDown) {
    return { signal: 'sell', reason: 'EMA fast kruist onder EMA slow', indicators };
  }
  return { signal: 'none', reason: 'Geen crossover', indicators };
}

function changePct(closes, n) {
  if (closes.length <= n) return null;
  const from = closes[closes.length - 1 - n];
  return ((last(closes) - from) / from) * 100;
}
