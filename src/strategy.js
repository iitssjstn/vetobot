import { ema, rsi, last, atr, adx, volumeRatio } from './indicators.js';

// Regelgebaseerde strategie: EMA-crossover met een RSI-filter, plus optionele filters
// (0 = uit) die alleen koopsignalen tegenhouden:
//   trendEma   alleen kopen als de koers boven de EMA van zoveel candles ligt
//   adxMin     alleen kopen als de ADX (trendsterkte) minstens zo hoog is
//   volumeMult alleen kopen als het volume op de kruising minstens zoveel × het gemiddelde is
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

  const trendEma = params.trendEma > 0 ? ema(closes, params.trendEma) : null;
  const atrArr = atr(candles, 14);
  const adxArr = adx(candles, 14);
  const lastAtr = last(atrArr);
  const indicators = {
    close: last(closes),
    emaFast: last(fast),
    emaSlow: last(slow),
    rsi: last(r),
    change24: changePct(closes, 24),
    emaTrend: trendEma ? last(trendEma) : null,
    adx: last(adxArr),
    atr: lastAtr,
    atrPct: lastAtr != null ? (lastAtr / last(closes)) * 100 : null,
    volumeRatio: volumeRatio(candles, 20),
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
    const blocked = (reason) => ({ signal: 'none', reason: `Kruising, maar ${reason}`, indicators, crossAt: cross.at, filtered: true });
    if (indicators.rsi >= params.rsiMaxEntry) return blocked(`RSI ${indicators.rsi.toFixed(1)} is te hoog`);
    if (trendEma) {
      if (indicators.emaTrend == null) return blocked(`te weinig data voor de trend-EMA ${params.trendEma}`);
      if (indicators.close <= indicators.emaTrend) return blocked(`koers onder de trend-EMA ${params.trendEma} (dalende trend)`);
    }
    if (params.adxMin > 0) {
      if (indicators.adx == null) return blocked('te weinig data voor de ADX');
      if (indicators.adx < params.adxMin) return blocked(`ADX ${indicators.adx.toFixed(1)} onder ${params.adxMin} (geen duidelijke trend)`);
    }
    if (params.volumeMult > 0) {
      const i = candles.findIndex((c) => c[0] === cross.at);
      const vr = volumeRatio(candles.slice(0, i + 1), 20);
      indicators.volumeRatio = vr;
      if (vr == null) return blocked('te weinig data voor het volume');
      if (vr < params.volumeMult) return blocked(`volume ${vr.toFixed(1)}× normaal, minder dan ${params.volumeMult}×`);
    }
    return { signal: 'buy', reason: `EMA fast kruist boven EMA slow (${when(cross)})`, indicators, crossAt: cross.at };
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
