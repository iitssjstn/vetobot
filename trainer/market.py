"""Market Agent: herkent de marktomstandigheden per coin.

De marktfase (stijgend, zijwaarts, dalend) wordt altijd op 1h-candles bepaald, wat de candle-tijd
van een recept ook is. Zo betekent "stijgende markt" voor elk recept hetzelfde en kan de Strategy
Agent recepten per fase eerlijk vergelijken. Dezelfde berekening zit in de bot
(src/mlmodel.js regimeOf, op 1h-candles).
"""
import bisect

from features import WARMUP, features_at, series
from train import REGIMES, regime_of

REF_TF = '1h'
REF_MS = 3600 * 1000


class RegimeLookup:
    """Marktfase per coin door de tijd: voor elk gesloten 1h-candle de fase."""

    def __init__(self):
        self.ts = {}
        self.reg = {}

    def add(self, pair, candles):
        s = series(candles)
        ts, reg = [], []
        for i in range(WARMUP, len(candles)):
            f = features_at(candles, s, i, None)
            if f is None:
                continue
            ts.append(int(candles[i][0]))
            reg.append(regime_of(f))
        if ts:
            self.ts[pair], self.reg[pair] = ts, reg

    def at(self, pair, decision_ms):
        """Fase op het moment van beslissen: van het laatste 1h-candle dat toen al gesloten was."""
        ts = self.ts.get(pair)
        if not ts:
            return None
        j = bisect.bisect_right(ts, decision_ms - REF_MS) - 1
        return self.reg[pair][j] if j >= 0 else None


def build(fetch, pairs, days, log=print):
    look = RegimeLookup()
    for pair in pairs:
        try:
            look.add(pair, fetch(pair, REF_TF, days))
        except Exception as e:
            log(f'Market Agent: {pair} 1h ophalen mislukt: {e}')
    return look


__all__ = ['REGIMES', 'REF_TF', 'RegimeLookup', 'build']
