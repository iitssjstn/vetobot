import { ema, rsi, last } from './indicators.js';

// Regelgebaseerde strategie: EMA-crossover met een RSI-filter.
// Werkt alleen op gesloten candles, zodat er geen look-ahead in zit.
//
// candles: [[timestamp, open, high, low, close, volume], ...] (alleen gesloten candles)
// lookback: over hoeveel van de laatste candles een kruising mag zijn gebeurd. Checkt de bot
// minder vaak dan er candles bijkomen, dan mist hij anders kruisingen tussen twee checks.
// Een kruising telt alleen als de trend nog steeds die kant op staat.
export function evaluate(candles, params, lookback = 1) {
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

  const n = closes.length;
  const above = last(fast) > last(slow);
  const window = Math.max(1, Math.min(lookback, n - params.emaSlow - 1));
  let cross = null; // { dir, ago, at }
  for (let ago = 0; ago < window; ago++) {
    const i = n - 1 - ago;
    if (fast[i - 1] == null || slow[i - 1] == null) break;
    const up = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const down = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    if (up || down) {
      cross = { dir: up ? 'up' : 'down', ago, at: candles[i][0] };
      break;
    }
  }
  const when = (c) => (c.ago === 0 ? 'op de laatste candle' : `${c.ago} candle${c.ago > 1 ? 's' : ''} geleden`);

  if (cross?.dir === 'up' && above) {
    if (indicators.rsi < params.rsiMaxEntry) {
      return { signal: 'buy', reason: `EMA fast kruist boven EMA slow (${when(cross)})`, indicators, crossAt: cross.at };
    }
    return { signal: 'none', reason: `Crossover, maar RSI ${indicators.rsi.toFixed(1)} is te hoog`, indicators, crossAt: cross.at };
  }
  if (cross?.dir === 'down' && !above) {
    return { signal: 'sell', reason: `EMA fast kruist onder EMA slow (${when(cross)})`, indicators, crossAt: cross.at };
  }
  return { signal: 'none', reason: `Geen crossover, trend ${above ? 'omhoog' : 'omlaag'}`, indicators };
}

function changePct(closes, n) {
  if (closes.length <= n) return null;
  const from = closes[closes.length - 1 - n];
  return ((last(closes) - from) / from) * 100;
}
