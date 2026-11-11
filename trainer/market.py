"""Market Agent: herkent de marktomstandigheden per coin.

De marktfase (stijgend, zijwaarts, dalend) wordt altijd op 1h-candles bepaald, wat de candle-tijd
van een recept ook is. Zo betekent "stijgende markt" voor elk recept hetzelfde en kan de Strategy
Agent recepten per fase eerlijk vergelijken. Dezelfde berekening zit in de bot
(src/mlmodel.js regimeOf, op 1h-candles).
"""
import bisect

import numpy as np

import featcache
from features import FEATURES, WARMUP
from train import REGIMES, regime_of

REF_TF = '1h'
REF_MS = 3600 * 1000
_HTF, _ATR = FEATURES.index('htfTrendPct'), FEATURES.index('atrPct')


class RegimeLookup:
    """Marktfase per coin door de tijd: voor elk gesloten 1h-candle de fase."""

    def __init__(self):
        self.ts = {}
        self.reg = {}

    def add(self, pair, candles, cache_dir=None):
        X = featcache.matrix(pair, REF_TF, candles, None, cache_dir, tag='noctx')
        ts, reg = [], []
        for i in range(WARMUP, len(candles)):
            row = X[i]
            if np.isnan(row[0]):
                continue
            t, a = row[_HTF], row[_ATR]
            ts.append(int(candles[i][0]))
            reg.append(regime_of({'htfTrendPct': None if np.isnan(t) else float(t), 'atrPct': None if np.isnan(a) else float(a)}))
        if ts:
            self.ts[pair], self.reg[pair] = ts, reg

    def at(self, pair, decision_ms):
        """Fase op het moment van beslissen: van het laatste 1h-candle dat toen al gesloten was."""
        ts = self.ts.get(pair)
        if not ts:
            return None
        j = bisect.bisect_right(ts, decision_ms - REF_MS) - 1
        return self.reg[pair][j] if j >= 0 else None


def build(fetch, pairs, days, log=print, cache_dir=None):
    look = RegimeLookup()
    for pair in pairs:
        try:
            look.add(pair, fetch(pair, REF_TF, days), cache_dir)
        except Exception as e:
            log(f'Market Agent: {pair} 1h ophalen mislukt: {e}')
    return look


__all__ = ['REGIMES', 'REF_TF', 'RegimeLookup', 'build']
