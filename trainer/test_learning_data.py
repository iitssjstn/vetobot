"""Betrouwbaarheid van de leerdata: geen lekken uit de toekomst, eerlijke splitsing in de tijd,
kosten in labels en backtest, en robuust bij NaN/inf/extreme waarden.

Draaien: cd trainer && python -m unittest test_learning_data
"""
import math
import random
import unittest

import numpy as np

import agent
import featcache
import market as market_agent
from features import FEATURES, WARMUP

M5 = 300_000
M15 = 900_000


def market(n, seed, momentum=0.0, step=M15, t0=0):
    """Nep-koersen (zelfde soort als in test_trainer)."""
    rnd = random.Random(seed)
    c, price, drift = [], 100.0, 0.0
    for i in range(n):
        drift = momentum * drift + rnd.gauss(0, 0.0025)
        o = price
        price = max(0.01, price * (1 + drift))
        hi = max(o, price) * (1 + abs(rnd.gauss(0, 0.001)))
        lo = min(o, price) * (1 - abs(rnd.gauss(0, 0.001)))
        c.append([t0 + i * step, o, hi, lo, price, 1000 + rnd.random() * 500])
    return c


def same(a, b):
    """Gelijk, waarbij NaN gelijk is aan NaN."""
    return np.array_equal(np.asarray(a, dtype=float), np.asarray(b, dtype=float), equal_nan=True)


class FeaturesOnlyPast(unittest.TestCase):
    def test_future_candles_do_not_change_earlier_features(self):
        c = market(1200, 1)
        X = featcache.matrix('A/EUR', '15m', c, None)
        k = 900
        # De toekomst na candle k compleet anders (crash, ander volume).
        fut = [row[:] for row in c]
        for row in fut[k + 1:]:
            row[1:5] = [x * 0.5 for x in row[1:5]]
            row[5] *= 10
        Y = featcache.matrix('A/EUR', '15m', fut, None)
        self.assertTrue(same(X[:k + 1], Y[:k + 1]), 'kenmerken t/m candle k gebruiken niets van na k')
        self.assertFalse(same(X[k + 1:], Y[k + 1:]))

    def test_vol_ratio_ignores_future(self):
        atr = [1.0 + 0.01 * (i % 7) for i in range(800)]
        r = agent.vol_ratio(atr, 600)
        changed = atr[:601] + [99.0] * 199
        self.assertEqual(agent.vol_ratio(changed, 600), r)

    def test_regime_only_from_closed_1h_candle(self):
        H1 = 3_600_000
        c = market(400, 3, step=H1)
        look = market_agent.RegimeLookup()
        look.add('A/EUR', c)
        i = 300
        # Beslissen op het moment dat candle i sluit: fase van candle i (net gesloten).
        at_close = look.at('A/EUR', c[i][0] + H1)
        just_before = look.at('A/EUR', c[i][0] + H1 - 1)
        ref = market_agent.RegimeLookup()
        ref.add('A/EUR', c[:i + 1])
        self.assertEqual(at_close, ref.reg['A/EUR'][-1])
        self.assertEqual(just_before, ref.reg['A/EUR'][-2], 'een nog open candle telt niet mee')


def _mk(pair, candles, H, ctx=None):
    mk = agent.Market(pair, candles, ctx)
    mk.split = agent._split(len(candles), H)
    return mk


class TrainingUsesOnlyTrainingPeriod(unittest.TestCase):
    def test_changing_validation_and_test_does_not_change_models(self):
        """Labels/Q-doelen en medianen van het leren komen alleen uit de leerperiode: de koersen in de
        validatie en de eindtest veranderen laat de modellen exact gelijk (embargo werkt)."""
        H = 24
        c = market(5000, 5, momentum=0.5)
        mk = _mk('A/EUR', c, H)
        hi = mk.split[0][1]
        fut = [row[:] for row in c]
        for row in fut[hi:]:
            row[1:5] = [x * 3 for x in row[1:5]]
        mk2 = _mk('A/EUR', fut, H)
        out = []
        for m in (mk, mk2):
            em, emed = agent.learn_exit([m], H, random.Random(1), lambda k: None, iters=2)
            en, enmed = agent.learn_entry([m], em, emed, H, 0.2, 10.0)
            rows = agent._impute(m.X[WARMUP + 10:WARMUP + 200], enmed)
            out.append((emed, enmed, en.predict(rows)))
        self.assertEqual(out[0][0], out[1][0], 'medianen verkopen alleen uit de leerperiode')
        self.assertEqual(out[0][1], out[1][1], 'medianen kopen alleen uit de leerperiode')
        self.assertTrue(np.allclose(out[0][2], out[1][2]), 'zelfde model, ook als de toekomst anders is')


class CalendarSplit(unittest.TestCase):
    """Coins met minder geschiedenis (nieuw genoteerd): de splitsing moet op dezelfde KALENDERTIJD
    liggen als bij de andere coins. Anders leert hij van een korte coin in de periode die voor de
    lange coins de validatie of zelfs de eindtest is (de hele markt beweegt samen: lek)."""

    def _run(self, folds):
        pairs = ['A/EUR', 'B/EUR']
        n = 6000
        data = {'A/EUR': market(n, 1, momentum=0.6), 'B/EUR': market(n, 2, momentum=0.6)[3500:],
                'BTC/EUR': market(n, 99)}
        calls = []
        orig = agent.learn_exit

        def spy(markets, H, *a, **k):
            ref = max(markets, key=lambda m: len(m.c))
            val_start = int(ref.c[ref.split[1][0]][0])
            calls.append([(m.pair, int(m.c[m.split[0][1] - 1][0]) if m.split[0][1] - 1 >= m.split[0][0] else None, val_start, H)
                          for m in markets])
            return orig(markets, H, *a, **k)

        agent.learn_exit = spy
        try:
            agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}, 'folds': folds}, {'timeframe': '15m', 'holdDays': 0.5, 'look': 2},
                              lambda p, tf, d: data[p], pairs, log=lambda *a: None)
        finally:
            agent.learn_exit = orig
        return calls

    def test_short_coin_trains_only_before_validation(self):
        calls = self._run(False)
        self.assertTrue(calls)
        for call in calls:
            for pair, train_end, val_start, H in call:
                if train_end is not None:
                    self.assertLess(train_end, val_start, f'{pair}: leerperiode loopt door in de validatie van de andere coins')

    def test_time_split_equal_markets_unchanged(self):
        """Coins met dezelfde candles: precies dezelfde splitsing als voorheen (_split)."""
        c = market(3000, 1)
        mks = [agent.Market(p, c, None) for p in ('A/EUR', 'B/EUR')]
        agent._time_split(mks, 48)
        for m in mks:
            self.assertEqual(m.split, agent._split(3000, 48))

    def test_time_split_short_coin(self):
        a = market(3000, 1)
        b = market(3000, 2)[2000:]   # begint pas na de leerperiode van A
        mks = [agent.Market('A/EUR', a, None), agent.Market('B/EUR', b, None)]
        agent._time_split(mks, 48)
        ta = int(a[mks[0].split[1][0] - 48][0])   # grens leren/validatie (kalendertijd)
        tb = int(a[mks[0].split[2][0] - 48][0])   # grens validatie/eindtest
        mb = mks[1]
        lo, hi = mb.split[0]
        self.assertTrue(hi <= lo or b[hi - 1][0] < ta, 'korte coin leert niets na de grens')
        self.assertGreaterEqual(b[mb.split[1][0]][0], ta)
        self.assertGreaterEqual(b[mb.split[2][0]][0], tb)
        for part in mb.split:
            self.assertLessEqual(part[1], len(b))
            self.assertLessEqual(part[0], len(b))
        # Eerdere periode (walk-forward): leren tot 0,55, testen op 0,55 + buffer .. 0,70, geen eindtest.
        b2 = market(3000, 2)[1000:]
        mks = [agent.Market('A/EUR', a, None), agent.Market('B/EUR', b2, None)]
        agent._time_split(mks, 48, 0.55, 0.70, test=False)
        self.assertEqual(mks[0].split, ((WARMUP, 1650), (1698, 2100), (2100, 2100)))
        lo, hi = mks[1].split[0]
        self.assertLess(b2[hi - 1][0], a[1650][0], 'korte coin leert alleen vóór de grens van de periode')
        self.assertEqual(b2[mks[1].split[1][0]][0], a[1698][0])


class _Const:
    def __init__(self, v):
        self.v = v

    def predict(self, X):
        return np.full(len(X), self.v, dtype=float)


class CostsAndBaseline(unittest.TestCase):
    def test_backtest_costs_per_coin_and_same_window_as_market(self):
        """Altijd kopen, na 1 candle verkopen: rendement = koersverandering - kosten van die coin;
        de markt wordt over precies hetzelfde venster gemeten; kopen-en-vasthouden ook na kosten."""
        H = 12
        a, b = market(3000, 1), market(3000, 2)
        ma, mb = _mk('A/EUR', a, H), _mk('B/EUR', b, H)
        ma.cost, mb.cost = 0.3, 1.0
        nmed = [0.0] * (len(FEATURES) + 4)
        res = agent.backtest([ma, mb], 2, _Const(1.0), [0.0] * len(FEATURES), _Const(-1.0), nmed, H, 0.2, 50.0, (0.0,))[0.0]
        self.assertGreater(res['trades'], 100)
        lo, hi = ma.split[2]
        exp_bh = ((a[hi - 1][4] / a[lo][4] - 1) * 100 - 0.3 + (b[hi - 1][4] / b[lo][4] - 1) * 100 - 1.0) / 2
        self.assertAlmostEqual(res['buyHoldPct'], exp_bh)
        # Eerste trade van A nagerekend.
        i = next(k for k in range(lo, hi) if ma.valid[k])
        ret_a = (a[i + 1][4] / a[i][4] - 1) * 100 - 0.3
        self.assertAlmostEqual(res['byPair']['A/EUR']['totalPct'] / res['byPair']['A/EUR']['trades'],
                               np.mean([(a[k + 1][4] / a[k][4] - 1) * 100 - 0.3 for k in range(i, hi - 1)]), places=6)
        mkt = agent.market_move([ma, mb], a[i][0], a[i + 1][0])
        self.assertAlmostEqual(mkt, ((a[i + 1][4] / a[i][4] - 1) * 100 + (b[i + 1][4] / b[i][4] - 1) * 100) / 2)
        self.assertLess(ret_a, (a[i + 1][4] / a[i][4] - 1) * 100, 'kosten afgetrokken')


class BadValues(unittest.TestCase):
    def test_learn_entry_ignores_nan_and_inf_from_real_trades(self):
        """Echte trades (feedback) met een NaN/inf-resultaat of inf in de kenmerken mogen de training
        niet laten vastlopen of het model vergiftigen."""
        rnd = np.random.default_rng(1)
        n = len(FEATURES)
        extra = [(list(rnd.normal(size=n)), float(rnd.normal())) for _ in range(1600)]
        extra.append((list(rnd.normal(size=n)), float('nan')))
        extra.append((list(rnd.normal(size=n)), float('inf'), 3.0))
        bad_row = list(rnd.normal(size=n))
        bad_row[0] = float('inf')
        extra.append((bad_row, 0.5))
        extra.append(([1.0] * (n - 1), 0.5))   # verkeerde lengte
        model, med = agent.learn_entry([], None, None, 12, 0.2, 10.0, extra=extra)
        self.assertIsNotNone(model)
        self.assertTrue(all(math.isfinite(m) for m in med))
        self.assertTrue(np.isfinite(model.predict(np.zeros((3, n)))).all())


if __name__ == '__main__':
    unittest.main()
