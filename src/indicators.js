// Indicatoren in puur JavaScript, zonder NumPy of native code.

export function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI volgens Wilder's smoothing.
export function rsi(values, period = 14) {
  if (values.length <= period) return [];
  const out = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const calc = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

export const last = (arr, n = 1) => arr[arr.length - n];

// True range per candle: [ts, open, high, low, close, volume]
function trueRanges(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c[2] - c[3];
    const prevClose = candles[i - 1][4];
    return Math.max(c[2] - c[3], Math.abs(c[2] - prevClose), Math.abs(c[3] - prevClose));
  });
}

// Wilder-smoothing: eerste waarde is het gemiddelde, daarna (vorige × (n−1) + nieuw) / n.
function wilder(values, period, startAt = 0) {
  const out = new Array(values.length).fill(null);
  if (values.length - startAt < period) return out;
  let prev = 0;
  for (let i = startAt; i < startAt + period; i++) prev += values[i];
  prev /= period;
  out[startAt + period - 1] = prev;
  for (let i = startAt + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Average True Range: hoe ver de koers gemiddeld per candle beweegt (beweeglijkheid).
export function atr(candles, period = 14) {
  return wilder(trueRanges(candles), period, 1);
}

// Average Directional Index (0–100): hoe sterk de trend is, ongeacht de richting.
// Onder ~20 = zijwaarts, boven ~25 = duidelijke trend.
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i][2] - candles[i - 1][2];
    const down = candles[i - 1][3] - candles[i][3];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = trueRanges(candles);
  const sTR = wilder(tr, period, 1);
  const sPlus = wilder(plusDM, period, 1);
  const sMinus = wilder(minusDM, period, 1);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (sTR[i] == null || sTR[i] === 0) continue;
    const pdi = (100 * sPlus[i]) / sTR[i];
    const mdi = (100 * sMinus[i]) / sTR[i];
    dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  }
  const first = dx.findIndex((v) => v != null);
  if (first < 0) return out;
  const smoothed = wilder(dx.map((v) => v ?? 0), period, first);
  for (let i = 0; i < n; i++) out[i] = smoothed[i];
  return out;
}

// Volume van de laatste candle ten opzichte van het gemiddelde van de `period` candles ervoor.
export function volumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const prev = candles.slice(-period - 1, -1).reduce((a, c) => a + c[5], 0) / period;
  return prev > 0 ? candles.at(-1)[5] / prev : null;
}
