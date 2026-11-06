"""Kenmerken (features) voor het voorspelmodel.

Deze berekeningen zijn exact dezelfde als in src/mlmodel.js van de bot. Wijzig je hier iets,
pas het daar dan ook aan (en de test test/mlmodel.test.js controleert of ze gelijk zijn).

Candles: lijst van [ts, open, high, low, close, volume], oud -> nieuw.
"""
import math

FEATURES = [
    'rsi14', 'adx14', 'atrPct', 'volRatio', 'distEma20Atr', 'distEma50Atr', 'emaSpreadPct',
    'ret1', 'ret3', 'ret12', 'er24', 'greens', 'toHigh48Atr', 'fromLow48Atr', 'upperWick', 'volTrend',
    # Het grotere plaatje: trend over een ~20x langere periode (zonder EMA, zodat bot en trainer
    # exact hetzelfde uitrekenen, ook al heeft de bot minder geschiedenis).
    'ret48', 'htfTrendPct', 'htfRet96', 'htfPos240',
    # Wat Bitcoin doet (de hele markt beweegt vaak mee) en hoe de coin het doet ten opzichte van BTC.
    'btcRet3', 'btcRet12', 'btcRet48', 'btcTrendPct', 'relRet12', 'relRet48',
    # Tijd (UTC): de markt gedraagt zich 's nachts anders dan rond de opening van de VS.
    'hourUtc', 'dowUtc',
]
WARMUP = 250  # zoveel candles minimaal voordat de kenmerken betrouwbaar zijn
HTF = 240     # lengte van het "grotere plaatje" in candles


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


def _rolling(values, n, fn):
    """fn (max/min) over de n waarden vóór index i (i zelf niet), met een deque: O(len)."""
    from collections import deque
    out = [None] * len(values)
    dq = deque()
    better = (lambda a, b: a >= b) if fn is max else (lambda a, b: a <= b)
    for i in range(len(values)):
        while dq and dq[0] < i - n:
            dq.popleft()
        if i >= n:
            out[i] = values[dq[0]]
        while dq and better(values[i], values[dq[-1]]):
            dq.pop()
        dq.append(i)
    return out


def series(c):
    """Alle hulpreeksen in één keer, voor de hele candle-lijst."""
    closes = [x[4] for x in c]
    return {
        'closes': closes, 'vol': [x[5] for x in c],
        'hi240': _rolling([x[2] for x in c], HTF, max), 'lo240': _rolling([x[3] for x in c], HTF, min),
        'sma240': _sma(closes, HTF),
        'ema9': ema(closes, 9), 'ema20': ema(closes, 20), 'ema21': ema(closes, 21), 'ema50': ema(closes, 50),
        'rsi14': rsi(closes, 14), 'atr14': atr(c, 14), 'adx14': adx(c, 14),
    }


def _sma(values, n):
    """Voortschrijdend gemiddelde over de n waarden t/m i, per index opnieuw opgeteld (geen
    lopende som, die verloopt op lange reeksen). Alleen uitgerekend voor de candles die echt
    gebruikt worden (lazy), zodat het snel blijft."""
    return _LazySma(values, n)


class _LazySma:
    def __init__(self, values, n):
        self.v, self.n, self.cache = values, n, {}

    def __getitem__(self, i):
        if i < self.n - 1:
            return None
        r = self.cache.get(i)
        if r is None:
            r = self.cache[i] = math.fsum(self.v[i - self.n + 1:i + 1]) / self.n
        return r


def context(btc):
    """Hulpgegevens van BTC/EUR (zelfde timeframe), om op tijdstip op te zoeken."""
    if not btc:
        return None
    closes = [x[4] for x in btc]
    return {'idx': {x[0]: j for j, x in enumerate(btc)}, 'closes': closes, 'sma240': _sma(closes, HTF)}


def features_at(c, s, i, ctx=None):
    """Kenmerken op candle i. Geeft None als er nog te weinig geschiedenis is.
    ctx: context(btc_candles), of None (dan zijn de BTC-kenmerken leeg en vult het model ze aan)."""
    if i < WARMUP or i >= len(c):
        return None
    x = c[i]
    close = x[4]
    a = s['atr14'][i]
    if not a or close <= 0:
        return None
    closes = s['closes']
    vol = s['vol']
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
    sma = s['sma240'][i]
    hi, lo = s['hi240'][i], s['lo240'][i]
    ts = int(x[0])
    btc = {'btcRet3': None, 'btcRet12': None, 'btcRet48': None, 'btcTrendPct': None}
    if ctx:
        j = ctx['idx'].get(ts)
        if j is not None and j >= WARMUP:
            bc = ctx['closes']
            bsma = ctx['sma240'][j]
            btc = {'btcRet3': pct(bc[j], bc[j - 3]), 'btcRet12': pct(bc[j], bc[j - 12]),
                   'btcRet48': pct(bc[j], bc[j - 48]), 'btcTrendPct': pct(bc[j], bsma)}
    ret12 = pct(close, closes[i - 12])
    ret48 = pct(close, closes[i - 48])
    extra = {
        'ret48': ret48,
        'htfTrendPct': pct(close, sma),
        'htfRet96': pct(close, closes[i - 96]),
        'htfPos240': (close - lo) / (hi - lo) if hi is not None and hi > lo else 0.5,
        **btc,
        'relRet12': ret12 - btc['btcRet12'] if btc['btcRet12'] is not None else None,
        'relRet48': ret48 - btc['btcRet48'] if btc['btcRet48'] is not None else None,
        'hourUtc': float((ts // 3_600_000) % 24),
        'dowUtc': float((ts // 86_400_000 + 3) % 7),  # 0 = maandag
    }
    return {
        **extra,
        'rsi14': s['rsi14'][i],
        'adx14': s['adx14'][i],
        'atrPct': a / close * 100,
        'volRatio': vol[i] / prev20 if prev20 > 0 else None,
        'distEma20Atr': (close - s['ema20'][i]) / a,
        'distEma50Atr': (close - s['ema50'][i]) / a,
        'emaSpreadPct': (s['ema9'][i] - s['ema21'][i]) / close * 100,
        'ret1': pct(close, closes[i - 1]),
        'ret3': pct(close, closes[i - 3]),
        'ret12': ret12,
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
