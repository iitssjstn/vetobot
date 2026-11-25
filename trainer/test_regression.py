"""Regressietests voor de leerserver: kort het belangrijkste gedrag vastleggen (training, promotie,
terugzetten, proefperiode, configuratie, imports voor de Docker-image). Uitgebreide statistiek staat in
test_trainer.py. Helpers zijn daaruit gekopieerd, zodat dat bestand ongewijzigd blijft. Geen netwerk.
"""
import ast
import json
import os
import random
import sys
import tempfile
import time
import unittest
from datetime import datetime
from unittest import mock

os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())

import train  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
M5 = 300_000
CFG = {'timeframe': '5m', 'days': 60, 'targetPct': 1.0, 'stopPct': 1.0, 'horizon': 24, 'costPct': 0.2, 'pairs': ['A/EUR', 'B/EUR'], 'topN': 2}


def market(n, seed, momentum=0.0):
    rnd = random.Random(seed)
    c, price, drift = [], 100.0, 0.0
    for i in range(n):
        drift = momentum * drift + rnd.gauss(0, 0.0025)
        o = price
        price = max(0.01, price * (1 + drift))
        hi = max(o, price) * (1 + abs(rnd.gauss(0, 0.001)))
        lo = min(o, price) * (1 - abs(rnd.gauss(0, 0.001)))
        c.append([i * M5, o, hi, lo, price, 1000 + rnd.random() * 500])
    return c


RA = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
RB = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}


def RP(edge=0.2, dd=4.0, tdd=None, win=30.0, loss=12.0, trades=60, avg=0.3):
    part = lambda d: {'trades': trades, 'avgPct': avg, 'totalPct': avg * trades, 'winRate': 55, 'edgePct': edge, 'maxDrawdownPct': d,
                      'grossWinPct': win, 'grossLossPct': loss, 'profitFactor': win / loss if loss else None, 'avgHeld': 4}
    return {'ok': True, 'validation': part(dd), 'test': part(dd if tdd is None else tdd), 'pairs': ['A/EUR'], 'coins': ['A/EUR'],
            'periods': {'leren': ['a', 'b'], 'validatie': ['b', 'c'], 'eindtest': ['2026-01-01 00:00', '2026-01-10 00:00']},
            'testDays': 9.0, 'threshold': 0.2, 'maxHold': 96}


def fake_agent(recipe, tag):
    import agent
    return {'version': 2, 'kind': 'agent', 'timeframe': recipe['timeframe'], 'threshold': 0.2, 'coins': ['A/EUR'], 'costPct': 0.2,
            'recipe': recipe, 'entry': {'features': agent.FEATURES, 'trees': [], 'tag': tag},
            'exit': {'features': agent.FEATURES + agent.POS_FEATURES, 'trees': []}, 'meta': {'report': {'test': {'maxDrawdownPct': 4}}}}


def A_key(r):
    import agent_search
    return agent_search.key_of(r)


def AT(recipe, pct, offset=60, **kw):
    t0 = time.time() + offset
    iso = lambda ts: datetime.fromtimestamp(ts).isoformat(timespec='seconds')
    return {'kind': 'agentTrade', 'timeframe': recipe['timeframe'], 'recipe': A_key(recipe), 'pct': pct, 'mode': 'paper',
            'explore': False, 'virtual': False, 'openedAt': iso(t0), 'closedAt': iso(t0 + 600), **kw}


def trades_around(recipe, mean, n=30, spread=0.05):
    return [AT(recipe, mean + (spread if i % 2 else -spread), offset=60 + i) for i in range(n)]


class GateBase(unittest.TestCase):
    """Eigen DATA-map per test (zoals in test_trainer.py)."""

    def setUp(self):
        import server
        self.s = server
        self.dir = tempfile.mkdtemp()
        self.said, self.logs = [], []
        self.patches = [mock.patch.object(server, 'DATA', self.dir),
                        mock.patch.object(server, 'think', lambda t, kind='info': self.said.append(t)),
                        mock.patch.object(server, 'log', lambda m: self.logs.append(m))]
        for p in self.patches:
            p.start()
        server.write_json('agents.json', {'version': server.AGENTS_VERSION, 'recipes': {}, 'published': None, 'live': {}, 'round': 0})
        server.write_json('config.json', {'pairs': ['A/EUR'], 'costPct': 0.2, 'agent': {'enabled': True, 'timeframes': ['15m']}})

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def finish(self, recipe, tag, report):
        return self.s.finish_round(recipe, fake_agent(recipe, tag) if tag else None, {**report, 'recipe': recipe, 'timeframe': recipe['timeframe']})

    def published(self):
        a = self.s.read_json('agent.json', None)
        return a['recipeKey'], a['entry']['tag']


class Imports(unittest.TestCase):
    """De trainer-image installeert alleen numpy en scikit-learn en kopieert *.py."""

    def test_server_and_modules_import(self):
        import server  # noqa: F401
        for mod in ('train', 'features', 'agent', 'agent_search', 'registry', 'probation', 'stats', 'search', 'market', 'micro', 'thoughts',
                    'featcache', 'resources', 'livecheck', 'helper', 'bench'):
            __import__(mod)

    def test_third_party_only_numpy_and_sklearn(self):
        local = {f[:-3] for f in os.listdir(HERE) if f.endswith('.py')}
        # threadpoolctl komt mee als dependency van scikit-learn.
        allowed = set(sys.stdlib_module_names) | local | {'numpy', 'sklearn', 'threadpoolctl'}
        for f in sorted(os.listdir(HERE)):
            if not f.endswith('.py') or f.startswith('test_'):
                continue
            with open(os.path.join(HERE, f), encoding='utf8') as fh:
                tree = ast.parse(fh.read())
            for node in ast.walk(tree):
                names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module else []
                for n in names:
                    self.assertTrue(n.split('.')[0] in allowed, f'{f} importeert {n}, niet in de Docker-image')


class Training(unittest.TestCase):
    def test_label_target_stop_timeout(self):
        up = [[0, 100, 100, 100, 100, 1], [1, 100, 101.5, 99.5, 101, 1]]
        self.assertEqual(train.label_at(up, 0, 1, 1, 5, 0.2)[0], 1)
        both = [[0, 100, 100, 100, 100, 1], [1, 100, 101.5, 98.5, 100, 1]]
        lab, r = train.label_at(both, 0, 1, 1, 5, 0.2)
        self.assertEqual((lab, round(r, 6)), (0, -1.2), 'doel en stop in één candle telt als verlies')

    def test_no_model_on_errors_or_too_little_data(self):
        def boom(*a):
            raise OSError('geen internet')
        model, report = train.train(CFG, log=lambda *_: None, fetch=boom, markets=lambda n: CFG['pairs'])
        self.assertIsNone(model)
        self.assertFalse(report.get('published'))
        model, report = train.train({**CFG, 'pairs': ['A/EUR']}, log=lambda *_: None, fetch=lambda p, tf, d: market(600, 1), markets=lambda n: [])
        self.assertIsNone(model)
        self.assertIn('Te weinig', report['reason'])


class Config(GateBase):
    def test_defaults_limits_and_unknown_keys(self):
        s = self.s
        cfg = s.validate_config({})
        self.assertEqual(cfg['agent']['safetyStopPct'], 10)
        self.assertTrue(cfg['agent']['enabled'])
        self.assertEqual(cfg['agent']['probationTrades'], 30)
        out = s.validate_config({'onbekend': 1, 'targetPct': 4, 'stopPct': 2})
        self.assertNotIn('onbekend', out, 'onbekende sleutels worden genegeerd')
        self.assertEqual((out['targetPct'], out['stopPct']), (4, 2))
        for bad in ({'timeframe': '7m'}, {'days': 1}, {'targetPct': 0.3, 'costPct': 0.5}, {'pairs': ['BTC/USD']},
                    {'agent': {'safetyStopPct': 50}}, {'agent': {'timeframes': ['7m']}}):
            with self.assertRaises(ValueError, msg=str(bad)):
                s.validate_config(bad)


class PromotionAndRollback(GateBase):
    def test_promote_keep_rollback_unpin(self):
        s = self.s
        d, _ = self.finish(RA, 'a1', RP())
        self.assertEqual(d, 'promoted', 'eerste model')
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        d, _ = self.finish(RA, 'a2', RP(edge=0.05, avg=0.05))
        self.assertEqual(d, 'kept', 'hetzelfde recept maar slechter: vorige blijft')
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.finish(RB, 'b1', RP(edge=0.4))
        d, why = self.finish(RB, 'b2', RP(edge=0.4))
        self.assertEqual(d, 'promoted', why)
        reg = s.registry()
        active = reg.active()
        self.assertEqual(self.published()[0], A_key(RB))
        # Terugzetten via de publieke functie.
        self.assertEqual(s.registry_rollback({})[0], 400)
        self.assertEqual(s.registry_rollback({'version': 999})[0], 404)
        self.assertEqual(s.registry_rollback({'version': 2})[0], 400, 'kept: geen snapshot')
        code, out = s.registry_rollback({'version': 1})
        self.assertEqual((code, out['active'], out['pinned']), (200, 1, 1))
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.assertEqual(reg.pinned(), 1)
        code, out = s.registry_unpin()
        self.assertEqual((code, out['pinned'], out['was']), (200, None, 1))
        self.assertNotEqual(active, 1)
        json.dumps(s.registry_info(), allow_nan=False)


class ProbationShort(GateBase):
    def test_failed_probation_rolls_back(self):
        s = self.s
        self.finish(RA, 'a1', RP())
        self.finish(RA, 'a2', RP())
        self.finish(RB, 'b1', RP(edge=0.4))
        self.assertEqual(self.finish(RB, 'b2', RP(edge=0.4))[0], 'promoted')
        reg = s.registry()
        self.assertEqual(reg.get(4)['probation']['status'], 'proef')
        s.add_agent_trades(trades_around(RB, -0.3))
        self.assertEqual(reg.get(4)['probation']['status'], 'mislukt')
        self.assertEqual(reg.active(), 2)
        self.assertEqual(self.published(), (A_key(RA), 'a2'))
        self.assertEqual(s.read_json('agent.json', {})['notice']['kind'], 'probation-failed')

    def test_passed_probation_keeps_model(self):
        s = self.s
        self.finish(RA, 'a1', RP())
        s.add_agent_trades(trades_around(RA, 0.3))
        reg = s.registry()
        self.assertEqual(reg.get(1)['probation']['status'], 'geslaagd')
        self.assertEqual(reg.active(), 1)


if __name__ == '__main__':
    unittest.main()
