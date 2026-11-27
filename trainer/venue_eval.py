"""Leren op een andere beurs (fase 3): de actieve recepten óók testen op koersen van Bybit.

De modellen worden op Bitvavo getraind en daar gekozen en gepromoot (dat verandert niet). Hier
spelen we hetzelfde geëxporteerde model (dezelfde JSON-bomen die de bot uitrekent) na op de candles
van Bybit, met de kosten van Bybit, vanaf het begin van de eindtest van dat model tot nu: een periode
die het model nooit zag. De kenmerken zijn relatief (rendementen, ATR in %, RSI, ...), dus hetzelfde
model werkt op X/USDT. De uitkomst (venueStats.bybit) is alleen informatie voor de eigenaar en de bot:
geen invloed op training, promotie, proefperiode of terugzetten op Bitvavo.
"""
import calendar
import math
import time

import numpy as np

import agent as agent_mod
import venues
from features import WARMUP, context


class JsonReg:
    """Een geëxporteerd model (agent.export_reg) met .predict(X) zoals scikit-learn, voor agent.backtest.
    Rekent precies als src/mlmodel.js predictRaw (X is al aangevuld met de medianen)."""

    def __init__(self, m):
        self.init = float(m['init'])
        self.rate = float(m.get('learningRate', 1.0))
        self.trees = [{k: np.asarray(t[k]) for k in ('f', 't', 'l', 'r', 'v')} for t in m['trees']]
        self.medians = [float(x) for x in m['medians']]

    def predict(self, X):
        X = np.asarray(X, dtype=float)
        rows = np.arange(len(X))
        total = np.zeros(len(X))
        for t in self.trees:
            node = np.zeros(len(X), dtype=np.int64)
            while True:
                inner = t['l'][node] != -1
                if not inner.any():
                    break
                idx = np.nonzero(inner)[0]
                nd = node[idx]
                go_left = X[rows[idx], t['f'][nd]] <= t['t'][nd]
                node[idx] = np.where(go_left, t['l'][nd], t['r'][nd])
            total += t['v'][node]
        return self.init + self.rate * total


def _utc_ms(text):
    """'YYYY-MM-DD HH:MM' (UTC, zoals agent.train_agent de periodes schrijft) -> ms, of None."""
    try:
        return calendar.timegm(time.strptime(str(text), '%Y-%m-%d %H:%M')) * 1000
    except (TypeError, ValueError):
        return None


def test_start_ms(part, now_ms):
    """Begin van de eindtest van dit model; onbekend: de laatste 15% van 60 dagen."""
    per = (((part.get('meta') or {}).get('report') or {}).get('periods') or {}).get('eindtest') or []
    t = _utc_ms(per[0]) if per else None
    return t if t and t < now_ms else now_ms - int(0.15 * 60 * 86_400_000)


def evaluate_part(part, fetch, venue, costs, default_cost, slots=2, cache_dir=None, pairs=None, now_ms=None, log=print):
    """Het model van één recept (agent.json-onderdeel) naspelen op de koersen van `venue`.
    fetch(pair_op_beurs, timeframe, days) -> candles. costs: {X/EUR: kosten %} voor deze beurs.
    pairs: alleen deze coins (X/EUR); None = de coins van het recept.
    Geeft {'trades', 'avgPct', ...} of {'trades': 0, 'reason': ...}."""
    now = now_ms or int(time.time() * 1000)
    tf = part['timeframe']
    tf_ms = agent_mod.TF_MIN.get(tf, 15) * 60_000
    H = int(part['maxHoldCandles'])
    thr = float(part['threshold'])
    safety = float(part.get('safetyStopPct') or 10)
    pol = (max(1, int(part.get('minHoldCandles') or 1)), max(0.0, float(part.get('exitMarginPct') or 0.0)))
    coins = [venues.to_base_pair(c) for c in (part.get('coins') or [])]
    if pairs:
        allowed = {venues.to_base_pair(p) for p in pairs}
        coins = [c for c in coins if c in allowed]
    start = test_start_ms(part, now)
    base = {'venue': venues.venue_of(venue), 'since': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(start / 1000)),
            'threshold': thr, 'timeframe': tf}
    if not coins:
        return {**base, 'trades': 0, 'reason': f'geen coins van dit recept op {venues.label(venue)}'}
    # Genoeg dagen voor de eindtest plus de aanloop van de kenmerken.
    days = max(7, min(400, math.ceil((now - start + (WARMUP + 50) * tf_ms) / 86_400_000) + 1))
    vp = lambda p: venues.to_venue_pair(p, venue)
    try:
        ctx = context(fetch(vp('BTC/EUR'), tf, days))
    except Exception as e:
        log(f'{venues.label(venue)}: BTC {tf} ophalen mislukt: {e}')
        ctx = None
    entry, exit_ = JsonReg(part['entry']), JsonReg(part['exit'])
    markets, missing = [], []
    for pair in coins:
        try:
            c = fetch(vp(pair), tf, days)
        except Exception as e:
            log(f'{venues.label(venue)}: {vp(pair)} {tf} ophalen mislukt: {e}')
            missing.append(pair)
            continue
        if len(c) < WARMUP + 20:
            missing.append(pair)
            continue
        mk = agent_mod.Market(pair, c, ctx, tf, cache_dir)
        mk.cost = float((costs or {}).get(pair, default_cost))
        ts = agent_mod._times(mk)
        a = max(WARMUP, int(np.searchsorted(ts, start, side='left')))
        if len(c) - a < 10:
            missing.append(pair)
            continue
        mk.split = ((WARMUP, a), (a, a), (a, len(c)))
        markets.append(mk)
    if not markets:
        return {**base, 'trades': 0, 'reason': f'geen koersen van {venues.label(venue)} voor de coins van dit recept', 'missing': missing}
    res = agent_mod.backtest(markets, 2, entry, entry.medians, exit_, exit_.medians, H, default_cost, safety, (thr,),
                             bench=markets, slots=slots, pol=pol)[thr]
    used = [m.cost for m in markets]
    r = lambda v, d=4: None if v is None else round(float(v), d)
    return {**base, 'trades': res['trades'], 'avgPct': r(res['avgPct']), 'totalPct': r(res['totalPct']), 'winRate': r(res['winRate'], 2),
            'edgePct': r(res['edgePct']), 'maxDrawdownPct': r(res['maxDrawdownPct'], 3), 'profitFactor': r(res.get('profitFactor'), 3),
            'costPct': r(sum(used) / len(used)), 'coins': [m.pair for m in markets], 'missing': missing,
            'days': round((now - start) / 86_400_000, 1),
            'byPair': {p: {'trades': x['trades'], 'totalPct': r(x['totalPct'])} for p, x in (res.get('byPair') or {}).items()}}
