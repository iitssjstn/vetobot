"""Kenmerken (features) voor het voorspelmodel.

Deze berekeningen zijn exact dezelfde als in src/mlmodel.js van de bot. Wijzig je hier iets,
pas het daar dan ook aan (en de test test/mlmodel.test.js controleert of ze gelijk zijn).

Candles: lijst van [ts, open, high, low, close, volume], oud -> nieuw.
"""
import math

FEATURES = [
    'rsi14', 'adx14', 'atrPct', 'volRatio', 'distEma20Atr', 'distEma50Atr', 'emaSpreadPct',
    'ret1', 'ret3', 'ret12', 'er24', 'greens', 'toHigh48Atr', 'fromLow48Atr', 'upperWick', 'volTrend',
]
WARMUP = 120  # zoveel candles minimaal voordat de kenmerken betrouwbaar zijn


def ema(values, period):
    out = [None] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values, period=14):
    out = [None] * len(values)
    if len(values) <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    avg_gain, avg_loss = gain / period, loss / period

    def calc():
        return 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    out[period] = calc()
    for i in range(period + 1, len(values)):
        d = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0)) / period
        out[i] = calc()
    return out


def true_ranges(c):
    out = []
    for i, x in enumerate(c):
        if i == 0:
            out.append(x[2] - x[3])
        else:
            pc = c[i - 1][4]
            out.append(max(x[2] - x[3], abs(x[2] - pc), abs(x[3] - pc)))
    return out


def wilder(values, period, start_at=0):
    out = [None] * len(values)
    if len(values) - start_at < period:
        return out
    prev = sum(values[start_at:start_at + period]) / period
    out[start_at + period - 1] = prev
    for i in range(start_at + period, len(values)):
        prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def atr(c, period=14):
    return wilder(true_ranges(c), period, 1)


def adx(c, period=14):
    n = len(c)
    out = [None] * n
    if n < period * 2 + 1:
        return out
    plus_dm, minus_dm = [0.0], [0.0]
    for i in range(1, n):
        up = c[i][2] - c[i - 1][2]
        down = c[i - 1][3] - c[i][3]
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)
    tr = true_ranges(c)
    s_tr, s_plus, s_minus = wilder(tr, period, 1), wilder(plus_dm, period, 1), wilder(minus_dm, period, 1)
    dx = [None] * n
    for i in range(n):
        if s_tr[i] is None or s_tr[i] == 0:
            continue
        pdi = 100 * s_plus[i] / s_tr[i]
        mdi = 100 * s_minus[i] / s_tr[i]
        dx[i] = 0.0 if pdi + mdi == 0 else 100 * abs(pdi - mdi) / (pdi + mdi)
    first = next((i for i, v in enumerate(dx) if v is not None), -1)
    if first < 0:
        return out
    sm = wilder([v if v is not None else 0.0 for v in dx], period, first)
    return sm


def series(c):
    """Alle hulpreeksen in één keer, voor de hele candle-lijst."""
    closes = [x[4] for x in c]
    return {
        'closes': closes,
        'ema9': ema(closes, 9), 'ema20': ema(closes, 20), 'ema21': ema(closes, 21), 'ema50': ema(closes, 50),
        'rsi14': rsi(closes, 14), 'atr14': atr(c, 14), 'adx14': adx(c, 14),
    }


def features_at(c, s, i):
    """Kenmerken op candle i. Geeft None als er nog te weinig geschiedenis is."""
    if i < WARMUP or i >= len(c):
        return None
    x = c[i]
    close = x[4]
    a = s['atr14'][i]
    if not a or close <= 0:
        return None
    closes = s['closes']
    vol = [y[5] for y in c]
    prev20 = sum(vol[i - 20:i]) / 20
    path = sum(abs(closes[k] - closes[k - 1]) for k in range(i - 23, i + 1))
    greens = 0
    k = i
    while k >= 0 and c[k][4] > c[k][1] and greens < 10:
        greens += 1
        k -= 1
    hi48 = max(y[2] for y in c[i - 48:i])
    lo48 = min(y[3] for y in c[i - 48:i])
    rng = x[2] - x[3]
    v3 = sum(vol[i - 2:i + 1]) / 3
    v20 = sum(vol[i - 22:i - 2]) / 20
    pct = lambda p, q: (p / q - 1) * 100 if q else 0.0
    return {
        'rsi14': s['rsi14'][i],
        'adx14': s['adx14'][i],
        'atrPct': a / close * 100,
        'volRatio': vol[i] / prev20 if prev20 > 0 else None,
        'distEma20Atr': (close - s['ema20'][i]) / a,
        'distEma50Atr': (close - s['ema50'][i]) / a,
        'emaSpreadPct': (s['ema9'][i] - s['ema21'][i]) / close * 100,
        'ret1': pct(close, closes[i - 1]),
        'ret3': pct(close, closes[i - 3]),
        'ret12': pct(close, closes[i - 12]),
        'er24': abs(closes[i] - closes[i - 24]) / path if path > 0 else 0.0,
        'greens': float(greens),
        'toHigh48Atr': (hi48 - close) / a,
        'fromLow48Atr': (close - lo48) / a,
        'upperWick': (x[2] - max(x[1], x[4])) / rng if rng > 0 else 0.0,
        'volTrend': v3 / v20 if v20 > 0 else None,
    }


def label_at(c, i, target_pct, stop_pct, horizon, cost_pct):
    """Uitkomst als je op de slotkoers van candle i koopt.

    Geeft (label, rendement%): label 1 als eerst +target_pct geraakt wordt, 0 bij eerst -stop_pct
    of als de tijd (horizon candles) om is. Raakt één candle beide, dan tellen we het als verlies
    (voorzichtig). Rendement is na kosten (cost_pct per volledige ronde).
    """
    entry = c[i][4]
    tp = entry * (1 + target_pct / 100)
    sl = entry * (1 - stop_pct / 100)
    end = min(len(c) - 1, i + horizon)
    for j in range(i + 1, end + 1):
        if c[j][3] <= sl:
            return 0, -stop_pct - cost_pct
        if c[j][2] >= tp:
            return 1, target_pct - cost_pct
    return 0, (c[end][4] / entry - 1) * 100 - cost_pct
