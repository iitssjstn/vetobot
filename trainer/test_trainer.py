import json
import os
import random
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import train
from features import FEATURES, features_at, label_at, series

M5 = 300_000


def market(n, seed, momentum=0.0):
    """Nep-koersen. Met momentum > 0 zetten stijgingen vaker door (dan valt er iets te leren)."""
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


CFG = {'timeframe': '5m', 'days': 60, 'targetPct': 1.0, 'stopPct': 1.0, 'horizon': 24, 'costPct': 0.2, 'pairs': ['A/EUR', 'B/EUR', 'C/EUR'], 'topN': 3}


class Labels(unittest.TestCase):
    def test_target_first(self):
        c = [[0, 100, 100, 100, 100, 1], [1, 100, 101.5, 99.5, 101, 1]]
        self.assertEqual(train.label_at(c, 0, 1, 1, 5, 0.2)[0], 1)

    def test_stop_first_and_both_in_one_candle_counts_as_loss(self):
        c = [[0, 100, 100, 100, 100, 1], [1, 100, 101.5, 98.5, 100, 1]]
        lab, r = label_at(c, 0, 1, 1, 5, 0.2)
        self.assertEqual(lab, 0)
        self.assertAlmostEqual(r, -1.2)

    def test_timeout(self):
        c = [[i, 100, 100.2, 99.8, 100.1, 1] for i in range(10)]
        lab, r = label_at(c, 0, 1, 1, 3, 0.2)
        self.assertEqual(lab, 0)
        self.assertAlmostEqual(r, -0.2, places=6)  # koers gelijk gebleven: alleen de kosten


class Training(unittest.TestCase):
    def test_learns_momentum_market_and_export_matches(self):
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        self._phases = []
        model, report = train.train(CFG, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'],
                                    progress=lambda ph, d, t, txt: self._phases.append(ph))
        self.assertTrue(report['published'], report.get('reason'))
        self.assertEqual(self._phases[:1], ['fetch'])
        self.assertIn('train', self._phases)
        self.assertEqual(self._phases[-1], 'test')
        self.assertGreater(report['metrics']['auc'], 0.55)
        self.assertEqual(model['features'], FEATURES)
        self.assertIn('suggestedMinProb', model['meta'])
        json.dumps(model)

    def test_random_market_is_not_published(self):
        fake = {p: market(9000, 100 + i, momentum=0.0) for i, p in enumerate(CFG['pairs'])}
        model, report = train.train(CFG, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'])
        self.assertIsNone(model)
        self.assertFalse(report['published'])

    def test_bitvavo_unreachable(self):
        def boom(*a):
            raise OSError('geen internet')
        model, report = train.train(CFG, log=lambda *_: None, fetch=boom, markets=lambda n: CFG['pairs'])
        self.assertIsNone(model)
        self.assertIn('Kon bij geen enkele coin', report['reason'])

    def test_too_little_data(self):
        model, report = train.train({**CFG, 'pairs': ['A/EUR']}, log=lambda *_: None, fetch=lambda p, tf, d: market(600, 1), markets=lambda n: [])
        self.assertIsNone(model)
        self.assertIn('Te weinig', report['reason'])


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        os.environ['DATA_DIR'] = cls.dir
        import importlib
        import server
        importlib.reload(server)
        cls.server = server
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, method, p, body=None, tok=True):
        h = {'Content-Type': 'application/json'}
        if tok:
            h['Authorization'] = f'Bearer {self.server.token()}'
        r = urllib.request.Request(self.base + p, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def test_auth_and_config(self):
        self.assertEqual(self.req('GET', '/health', tok=False)[0], 200)
        self.assertEqual(self.req('GET', '/status', tok=False)[0], 401)
        self.assertEqual(self.req('GET', '/model.json')[0], 404)
        code, body = self.req('POST', '/config', {'timeframe': '5m', 'targetPct': 4, 'stopPct': 2.5, 'pairs': ['BTC/EUR', 'ETH/EUR']})
        self.assertEqual(code, 200, body)
        self.assertEqual(body['config']['targetPct'], 4)
        self.assertEqual(self.req('POST', '/config', {'targetPct': 0.3, 'costPct': 0.5})[0], 400)
        self.assertEqual(self.req('POST', '/config', {'timeframe': '7m'})[0], 400)
        code, st = self.req('GET', '/status')
        self.assertEqual(st['config']['pairs'], ['BTC/EUR', 'ETH/EUR'])

    def test_model_served_with_etag(self):
        self.server.write_json('model.json', {'version': 1})
        h = {'Authorization': f'Bearer {self.server.token()}'}
        with urllib.request.urlopen(urllib.request.Request(self.base + '/model.json', headers=h)) as r:
            etag = r.headers['ETag']
            self.assertEqual(json.loads(r.read())['version'], 1)
        try:
            urllib.request.urlopen(urllib.request.Request(self.base + '/model.json', headers={**h, 'If-None-Match': etag}))
            self.fail('verwacht 304')
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 304)


if __name__ == '__main__':
    unittest.main()


class Schedule(unittest.TestCase):
    def setUp(self):
        import server
        self.s = server
        self.now = __import__('datetime').datetime(2026, 11, 6, 14, 30)

    def test_fixed_hours(self):
        nr = self.s.next_run(self.now, {'mode': 'times', 'hours': [3, 15], 'everyHours': 6, 'pauseMinutes': 30}, None)
        self.assertEqual((nr.day, nr.hour), (6, 15))
        nr = self.s.next_run(self.now.replace(hour=16), {'mode': 'times', 'hours': [3, 15], 'everyHours': 6, 'pauseMinutes': 30}, None)
        self.assertEqual((nr.day, nr.hour), (7, 3))

    def test_interval_and_continuous(self):
        from datetime import timedelta
        last = self.now - timedelta(hours=1)
        nr = self.s.next_run(self.now, {'mode': 'interval', 'hours': [3], 'everyHours': 4, 'pauseMinutes': 30}, last)
        self.assertEqual(nr, last + timedelta(hours=4))
        nr = self.s.next_run(self.now, {'mode': 'continuous', 'hours': [3], 'everyHours': 4, 'pauseMinutes': 30}, self.now - timedelta(minutes=10))
        self.assertEqual(nr, self.now + timedelta(minutes=20))
        nr = self.s.next_run(self.now, {'mode': 'continuous', 'hours': [3], 'everyHours': 4, 'pauseMinutes': 30}, self.now - timedelta(hours=2))
        self.assertEqual(nr, self.now, 'pauze voorbij: meteen')

    def test_validation(self):
        cur = self.s.DEFAULTS['schedule']
        self.assertEqual(self.s.validate_schedule({'mode': 'times', 'hours': [15, 3, 3]}, cur)['hours'], [3, 15])
        for bad in ({'mode': 'times', 'hours': [25]}, {'mode': 'x'}, {'mode': 'interval', 'everyHours': 0.5}, {'mode': 'continuous', 'pauseMinutes': 5}):
            with self.assertRaises(ValueError):
                self.s.validate_schedule(bad, cur)


class CandleCache(unittest.TestCase):
    def test_only_new_and_missing_older_candles_are_fetched(self):
        cache = tempfile.mkdtemp()
        H = 3_600_000
        calls = []
        def fake(pair, tf, start, end):
            calls.append((start, end))
            first = (start // H + 1) * H
            return [[t, 1, 1, 1, 1, 1] for t in range(first, end, H)]
        now = 1_000 * H + 10
        c1 = train.fetch_candles('A/EUR', '1h', 10, cache_dir=cache, now_ms=now, fetch=fake)
        self.assertEqual(len(calls), 1)
        self.assertAlmostEqual(len(c1), 240, delta=2)
        # 5 uur later, zelfde periode: alleen het nieuwe stuk ophalen
        calls.clear()
        c2 = train.fetch_candles('A/EUR', '1h', 10, cache_dir=cache, now_ms=now + 5 * H, fetch=fake)
        self.assertEqual(len(calls), 1)
        self.assertGreaterEqual(calls[0][0], now - 3 * H, 'alleen recent stuk (plus één candle overlap)')
        self.assertEqual(c2[-1][0], c1[-1][0] + 5 * H)
        # Meer dagen gevraagd: alleen het oudere stuk aanvullen
        calls.clear()
        c3 = train.fetch_candles('A/EUR', '1h', 20, cache_dir=cache, now_ms=now + 5 * H, fetch=fake)
        self.assertEqual(len(calls), 2)
        self.assertLess(calls[0][1], c1[0][0], 'ouder stuk')
        self.assertAlmostEqual(len(c3), 480, delta=3)

    def test_max_samples_spreads_over_the_period(self):
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        _, report = train.train({**CFG, 'maxSamples': 20_000}, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'])
        self.assertLessEqual(report['trainSamples'] + report['testSamples'], 3 * 4500)
