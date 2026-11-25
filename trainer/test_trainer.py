import json
import os
import math
import random
import re
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import numpy as np

import train
from features import FEATURES, label_at

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
    def test_btc_context_and_feedback_from_own_trades(self):
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        fake['BTC/EUR'] = market(9000, 99, momentum=0.3)
        # Echte trades: kenmerken + uitkomst, verspreid over de hele periode (oud = leren, nieuw = controle)
        X, y, ret, ts = train.build_dataset(fake['A/EUR'], CFG, step=40)
        fb = [{'pair': 'A/EUR', 'timeframe': '5m', 'ts': ts[k], 'features': dict(zip(FEATURES, X[k])), 'returnPct': ret[k]}
              for k in range(len(X))]
        fb.append({'pair': 'A/EUR', 'timeframe': '1h', 'ts': 1, 'features': {}, 'returnPct': 1})  # andere timeframe: genegeerd
        logs = []
        model, report = train.train(CFG, log=logs.append, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'], feedback=fb)
        self.assertTrue(report['published'], report.get('reason'))
        self.assertEqual(report['feedback']['total'], len(X))
        self.assertGreater(report['feedback']['train'], 0)
        self.assertGreater(report['feedback']['test'], 0)
        live = report['metrics']['live']
        self.assertEqual(live['n'], report['feedback']['test'])
        self.assertTrue(any('Eigen trades van de bot' in l for l in logs))
        # BTC-kenmerken zijn gevuld (anders zouden alle medianen voor BTC 0 zijn)
        self.assertNotEqual(model['medians'][FEATURES.index('btcTrendPct')], 0.0)

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


class FetchRange(unittest.TestCase):
    def test_pages_back_and_keeps_partial_on_error(self):
        import train
        calls = []
        def fake_get(url, tries=3):
            calls.append(url)
            self.assertNotIn('start=', url)  # alleen end + limit, geen groot bereik
            if len(calls) == 3:
                raise train.BitvavoError('HTTP 400 van Bitvavo: test')
            end = int(url.split('end=')[1])
            return [[end - i * 60_000, '1', '1', '1', '1', '1'] for i in range(1440)]
        orig, orig_sleep = train._get, train.time.sleep
        train._get = fake_get
        train.time.sleep = lambda s: None
        try:
            now = 10_000 * 86_400_000
            rows = train.fetch_range('DOGE/EUR', '1m', now - 5 * 86_400_000, now)
        finally:
            train._get, train.time.sleep = orig, orig_sleep
        self.assertEqual(len(rows), 2 * 1440)  # twee pagina's binnen, derde mislukt -> houden wat er is
        self.assertEqual([r[0] for r in rows], sorted(r[0] for r in rows))


class CacheShortHistory(unittest.TestCase):
    def test_remembers_that_bitvavo_has_no_older_candles(self):
        M = 60_000
        now = 100_000 * M
        listed = now - 40 * 1440 * M  # coin heeft maar 40 dagen geschiedenis
        calls = []

        def fake(pair, tf, start, end):
            calls.append((start, end))
            s = max(start, listed)
            return [[t, 1, 1, 1, 1, 1] for t in range(s - s % M, end, M)]
        d = tempfile.mkdtemp()
        logs = []
        train.fetch_candles('X/EUR', '1m', 60, cache_dir=d, now_ms=now, fetch=fake)
        calls.clear()
        out = train.fetch_candles('X/EUR', '1m', 60, cache_dir=d, now_ms=now + 30 * M, fetch=fake, log=logs.append)
        self.assertEqual(len(calls), 1, 'alleen de nieuwe candles, niet steeds opnieuw het oudere stuk')
        self.assertEqual(len(out), 40 * 1440 + 30)
        self.assertEqual(logs, ['X/EUR 1m: 30 nieuw opgehaald, 57.600 uit opslag'])

    def test_new_part_must_connect(self):
        M = 60_000
        now = 100_000 * M
        d = tempfile.mkdtemp()
        full = lambda p, tf, s, e: [[t, 1, 1, 1, 1, 1] for t in range(s - s % M, e, M)]
        train.fetch_candles('Y/EUR', '1m', 2, cache_dir=d, now_ms=now, fetch=full)
        # Halverwege mislukt: alleen het nieuwste stuk kwam binnen -> niet gebruiken (geen gat)
        gap = lambda p, tf, s, e: [[t, 1, 1, 1, 1, 1] for t in range(e - 100 * M, e, M)]
        out = train.fetch_candles('Y/EUR', '1m', 2, cache_dir=d, now_ms=now + 500 * M, fetch=gap)
        self.assertEqual(out[-1][0], now - M)


class StrategySearch(unittest.TestCase):
    def test_round_leaderboard_and_strictness(self):
        import search
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        fake['BTC/EUR'] = market(9000, 99, momentum=0.3)
        cfg = {**CFG, 'search': {'enabled': True, 'timeframes': ['5m'], 'perRound': 3}, 'maxSamples': 60000}
        results, phases = {}, []
        tested = search.run_round(cfg, results, log=lambda *_: None, fetch=lambda p, tf, d: fake[p],
                                  markets=lambda n: CFG['pairs'], progress=lambda ph, *a: phases.append(ph), rnd=random.Random(1))
        self.assertEqual(len(tested), 3)
        self.assertEqual(set(phases), {'search'})
        for k in tested:
            r = results[k]
            self.assertIn(r['status'], ('bevestigd', 'niet bevestigd', 'niet goed genoeg', 'geen bruikbare drempel', 'te weinig data'))
            self.assertEqual(r['timeframe'], '5m')
            self.assertEqual(r['horizon'], r['holdMinutes'] // 5)
        # Volgende ronde: eerst andere (nog niet geteste) strategieën
        tested2 = search.run_round(cfg, results, log=lambda *_: None, fetch=lambda p, tf, d: fake[p],
                                   markets=lambda n: CFG['pairs'], rnd=random.Random(2))
        self.assertFalse(set(tested) & set(tested2))
        # Op een momentum-markt moet er iets bruikbaars uitkomen
        self.assertTrue(any(r.get('val', {}).get('best') for r in results.values()))
        # Strenger naarmate er meer getest is
        self.assertLess(search.required_edge(1), search.required_edge(100))
        board = search.leaderboard(results)
        self.assertEqual(len(board), 6)

    def test_candidates_respect_costs_and_judge(self):
        import search
        cands = search.all_candidates(['1m', '15m'], 0.5)
        self.assertTrue(all(c['targetPct'] >= 1.0 for c in cands))
        self.assertTrue(all(4 <= c['horizon'] <= 500 for c in cands))
        base = {'n': 1000, 'winRate': 40, 'avgReturnPct': -0.2}
        good = {'score': 1.0, 'val': {'auc': 0.6, 'best': {'avgReturnPct': 0.8, 'minProb': 0.6}, 'base': base},
                'holdout': {'n': 80, 'avgReturnPct': 0.5, 'base': -0.1}}
        lucky = {'score': 1.0, 'val': {'auc': 0.6, 'best': {'avgReturnPct': 0.8, 'minProb': 0.6}, 'base': base},
                 'holdout': {'n': 80, 'avgReturnPct': -0.3, 'base': -0.1}}
        weak = {'score': 0.05, 'val': {'auc': 0.6, 'best': {'avgReturnPct': 0.05, 'minProb': 0.6}, 'base': base}}
        res = {'a': good, 'b': lucky, 'c': weak}
        search.judge(res)
        self.assertEqual(good['status'], 'bevestigd')
        self.assertEqual(lucky['status'], 'niet bevestigd')
        self.assertEqual(weak['status'], 'niet goed genoeg')
        self.assertEqual(search.leaderboard(res)[0], good)


class BuildOnBest(unittest.TestCase):
    def test_pick_explores_near_the_best_and_retests_it(self):
        import search
        cands = search.all_candidates(['15m', '1h'], 0.5)
        best = next(c for c in cands if c['timeframe'] == '15m' and c['targetPct'] == 4.0 and c['stopPct'] == 2.0 and c['holdMinutes'] == 480)
        results = {search.key_of(best): {**best, 'key': search.key_of(best), 'score': 0.3, 'status': 'niet bevestigd', 'testedAt': '2020-01-01T00:00:00Z'}}
        chosen = search.pick(cands, results, 6, random.Random(1))
        keys = [search.key_of(c) for c in chosen]
        self.assertEqual(keys[0], search.key_of(best), 'de beste wordt opnieuw getest')
        near = {search.key_of(c) for c in search.neighbours(best, {search.key_of(c): c for c in cands})}
        self.assertGreaterEqual(len(set(keys[1:]) & near), 3, 'ongeveer de helft bouwt verder op de beste')
        self.assertEqual(len(keys), 6)

    def test_learns_which_timeframes_work_and_builds_on_confirmed(self):
        import search
        cands = search.all_candidates(['1m', '30m'], 0.5)
        results = {}
        mk = lambda c, v, st='niet goed genoeg': {**c, 'key': search.key_of(c), 'score': v, 'status': st, 'testedAt': '2099-01-01T00:00:00Z',
                                                  'val': {'best': {'avgReturnPct': v}} if v is not None else {}}
        ones = [c for c in cands if c['timeframe'] == '1m'][:15]
        for i, c in enumerate(ones):
            results[search.key_of(c)] = mk(c, -0.3) if i % 2 else {**mk(c, None), 'status': 'geen bruikbare drempel'}
        good = next(c for c in cands if c['timeframe'] == '30m' and c['targetPct'] == 4.0 and c['stopPct'] == 2.0 and c['holdMinutes'] == 720)
        results[search.key_of(good)] = mk(good, 0.8, 'bevestigd')
        self.assertEqual(search.tf_weight(search.tf_stats(results)['1m']), 0.05)
        n1m = 0
        for seed in range(20):
            chosen = search.pick(cands, results, 9, random.Random(seed))
            whys = [c['_why'] for c in chosen]
            self.assertEqual(whys.count('near'), 6, 'met een bevestigde strategie: 2/3 verder bouwen')
            n1m += sum(1 for c in chosen if c['_why'] == 'fresh' and c['timeframe'] == '1m')
        self.assertLess(n1m, 12, f'1m (alles verlies) bijna niet meer geprobeerd: {n1m} van 60')
        from thoughts import search_insights
        txt = search_insights(results, 0.3, 16)
        self.assertIn('1m-candles probeer ik voortaan bijna niet meer', txt)
        self.assertIn('Ik bouw nu vooral verder op 30m-candles', txt)

    def test_champion_switching(self):
        import search
        r = lambda k, score, st: {'key': k, 'score': score, 'status': st}
        res = {'a': r('a', 0.4, 'bevestigd'), 'b': r('b', 0.42, 'bevestigd'), 'c': r('c', 0.9, 'niet bevestigd')}
        self.assertEqual(search.choose_champion(res, None), 'b')
        self.assertIsNone(search.choose_champion(res, 'a'), 'net iets beter is geen reden om over te stappen')
        res['b']['score'] = 0.6
        self.assertEqual(search.choose_champion(res, 'a'), 'b')
        res['b']['status'] = 'niet bevestigd'
        res['a']['status'] = 'niet bevestigd'
        self.assertIsNone(search.choose_champion(res, 'a'))


class AutoApply(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        self.s = server
        server.write_json('search.json', {'results': {}})

    def test_new_champion_switches_trainer_config_and_trains(self):
        s = self.s
        s.write_json('config.json', {**s.config(), 'search': {'enabled': True, 'timeframes': ['15m'], 'perRound': 2, 'pauseMinutes': 1, 'autoApply': True}})
        found = {'key': '15m|4|2|480', 'timeframe': '15m', 'targetPct': 4.0, 'stopPct': 2.0, 'holdMinutes': 480, 'horizon': 32,
                 'score': 0.5, 'status': 'bevestigd', 'val': {'best': {'avgReturnPct': 0.5, 'minProb': 0.6}}, 'holdout': {'avgReturnPct': 0.3}}
        started = []
        orig_round, orig_train = s.searcher.run_round, s.run_training
        def fake_round(cfg, results, **kw):
            results[found['key']] = dict(found)
            return [found['key']]
        s.searcher.run_round, s.run_training = fake_round, lambda reason: started.append(reason)
        try:
            s.search_round()
        finally:
            s.searcher.run_round, s.run_training = orig_round, orig_train
        cfg = s.config()
        self.assertEqual((cfg['timeframe'], cfg['targetPct'], cfg['stopPct'], cfg['horizon']), ('15m', 4.0, 2.0, 32))
        self.assertEqual(cfg['strategy']['key'], found['key'])
        self.assertTrue(cfg['strategy']['autoApply'])
        self.assertEqual(started, ['nieuwe beste strategie'])
        self.assertEqual(s.load_search()['champion']['key'], found['key'])
        self.assertEqual(s.search_info()['rounds'], 1)
        # Zelf andere instellingen kiezen: dan is het niet meer de strategie van de zoeker
        self.assertIsNone(s.validate_config({'targetPct': 3})['strategy'])


class Thoughts(unittest.TestCase):
    def test_model_explains_what_it_does(self):
        import search
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        fake['BTC/EUR'] = market(9000, 99, momentum=0.3)
        said = []
        think = lambda text, kind='info': said.append((kind, text))
        model, report = train.train(CFG, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'], think=think)
        texts = ' '.join(t for _, t in said)
        self.assertIn('Ik ga een nieuw model trainen op 5m-candles', texts)
        self.assertIn('Waar ik het meest op let', texts)
        self.assertIn('Op de testperiode', texts)
        self.assertIn('ik ga dit model gebruiken' if report['published'] else 'vorige model', texts)
        said.clear()
        cfg = {**CFG, 'search': {'enabled': True, 'timeframes': ['5m'], 'perRound': 2}, 'maxSamples': 60000}
        search.run_round(cfg, {}, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'],
                         rnd=random.Random(3), think=think)
        kinds = [k for k, _ in said]
        self.assertEqual(kinds.count('doing'), 2)
        self.assertIn('iets nieuws dat ik nog nooit geprobeerd heb', said[0][1])
        self.assertEqual(kinds[-1], 'insight')
        self.assertIn('eis ik minstens', said[-1][1])
        self.assertIsNone(re.search(r'\d\.\d+%', ' '.join(t for _, t in said)), 'Nederlandse komma, geen punt')


class Micro(unittest.TestCase):
    def test_collect_and_features(self):
        import micro
        root = tempfile.mkdtemp()
        t1 = 1_000_000 * 60_000
        calls = []

        def fake_get(url):
            calls.append(url)
            if '/book' in url:
                return {'bids': [['99.9', '10'], ['99.5', '10'], ['90', '100']], 'asks': [['100.1', '5'], ['100.6', '5'], ['110', '100']]}
            return [{'timestamp': t1 - 30_000, 'amount': '2', 'price': '100', 'side': 'buy'},
                    {'timestamp': t1 - 10_000, 'amount': '1', 'price': '100', 'side': 'sell'},
                    {'timestamp': t1 + 5_000, 'amount': '9', 'price': '100', 'side': 'buy'}]  # volgende minuut: niet meetellen
        col = micro.Collector(root, get=fake_get, log=lambda *_: None)
        self.assertEqual(col.collect(['X/EUR'], now_ms=t1 + 1000), 1)
        rows = micro.load(root, 'X/EUR')
        r = rows[t1 - 60_000]
        self.assertAlmostEqual(r['spread'], 0.2, places=6)
        self.assertEqual((r['buy'], r['sell'], r['n'], r['big']), (200.0, 100.0, 2, 200.0))
        self.assertAlmostEqual(r['bid1'], 999 + 995)
        self.assertEqual(micro.coverage(root)[0]['pair'], 'X/EUR')

    def test_series_matches_naive_and_needs_enough_data(self):
        import micro
        rnd = random.Random(1)
        t0 = 500_000 * 60_000
        rows = {}
        for k in range(3000):
            if rnd.random() < 0.05:
                continue  # af en toe een gemiste minuut
            rows[t0 + k * 60_000] = {'t': t0 + k * 60_000, 'spread': 0.1, 'bid1': rnd.random() * 100, 'ask1': rnd.random() * 100,
                                     'buy': rnd.random() * 50, 'sell': rnd.random() * 50, 'n': rnd.randint(0, 20), 'big': 1}
        ser = micro.Series(rows)
        close = t0 + 2900 * 60_000
        f = ser.at(close)
        last = close - 60_000
        hour = [rows[last - k * 60_000] for k in range(60) if last - k * 60_000 in rows]
        day = [rows[last - k * 60_000] for k in range(1440) if last - k * 60_000 in rows]
        b, sl = sum(r['buy'] for r in hour), sum(r['sell'] for r in hour)
        self.assertAlmostEqual(f['microBuyRatio60'], b / (b + sl))
        vol_day = sum(r['buy'] + r['sell'] for r in day) / len(day) * 60
        self.assertAlmostEqual(f['microFlow60'], (b - sl) / vol_day)
        n_day = sum(r['n'] for r in day) / len(day) * 60
        self.assertAlmostEqual(f['microIntensity'], sum(r['n'] for r in hour) / len(hour) * 60 / n_day)
        snap = rows.get(last) or rows.get(last - 60_000)
        self.assertAlmostEqual(f['microBookImb'], snap['bid1'] / (snap['bid1'] + snap['ask1']))
        # Begin van de opname: nog geen 24 uur -> die kenmerken leeg
        early = ser.at(t0 + 100 * 60_000)
        self.assertIsNotNone(early['microBuyRatio60'])
        self.assertIsNone(early['microFlow60'])
        self.assertTrue(all(v is None for v in ser.at(t0 - 86_400_000).values()))

    def test_experiment_detects_useful_orderbook_data(self):
        import micro
        root = tempfile.mkdtemp()
        # Koers waarbij de koopdruk van het afgelopen uur voorspelt of het de komende candles stijgt.
        rnd = random.Random(5)
        days = 20
        n = days * 288
        c, price = [], 100.0
        buyers = []
        for i in range(n):
            pressure = rnd.random()
            buyers.append(pressure)
            o = price
            price = price * (1 + rnd.gauss(0, 0.002) + (0.003 if pressure > 0.6 else -0.003 if pressure < 0.4 else 0))
            c.append([i * M5, o, max(o, price) * 1.0005, min(o, price) * 0.9995, price, 1000])
        # Opname: per minuut, koopdruk zoals hierboven, vooruitlopend op de candle die erna komt
        for pair in ('A/EUR', 'B/EUR'):
            os.makedirs(os.path.join(root, pair.replace('/', '-')), exist_ok=True)
            with open(os.path.join(root, pair.replace('/', '-'), '1970-01-01.jsonl'), 'w') as f:
                for i in range(n - 1):
                    p = buyers[i + 1]  # druk die in de minuten vóór het sluiten van candle i zichtbaar is
                    for m in range(5):
                        t = i * M5 + m * 60_000
                        f.write(json.dumps({'t': t, 'spread': 0.1, 'bid1': 100 * p, 'ask1': 100 * (1 - p), 'buy': 100 * p, 'sell': 100 * (1 - p), 'n': 10, 'big': 5}) + '\n')
        cfg = {**CFG, 'pairs': ['A/EUR', 'B/EUR'], 'horizon': 3, 'targetPct': 0.3, 'stopPct': 0.3, 'costPct': 0.05}
        said = []
        r = micro.experiment(cfg, root, lambda p, tf, d: c, log=lambda *_: None, think=lambda t, kind='info': said.append(t))
        self.assertTrue(r['ran'], r)
        self.assertTrue(r['better'], r)
        self.assertGreater(r['with']['auc'], r['without']['auc'])
        self.assertIn('Experiment orderboek-data', said[0])
        # Met useMicro traint de gewone training ook met deze kenmerken
        model, report = train.train({**cfg, 'useMicro': True}, log=lambda *_: None, fetch=lambda p, tf, d: c,
                                    markets=lambda n: cfg['pairs'], micro=micro.rows_fn(root))
        self.assertTrue(report['published'], report.get('reason'))
        self.assertEqual(model['features'][-5:], micro.MICRO_FEATURES)
        self.assertTrue(model['meta']['micro'])


class AgentTrader(unittest.TestCase):
    def test_learns_on_momentum_and_not_on_random(self):
        import agent
        pairs = ['A/EUR', 'B/EUR', 'C/EUR']
        good = {p: market(9000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(9000, 99, momentum=0.3)
        a, r = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, '15m', lambda p, tf, d: good[p], pairs)
        self.assertTrue(r['ok'], r)
        self.assertGreater(r['test']['avgPct'], 0)
        self.assertIsNotNone(r['test']['marketPct'], 'vergeleken met de markt tijdens de trades')
        self.assertGreater(r['test']['edgePct'], 0)
        by = r['test']['byRegime']
        self.assertTrue(by, 'Market Agent: resultaat per marktfase')
        self.assertTrue(set(by) <= {'stijgend', 'zijwaarts', 'dalend'})
        self.assertEqual(sum(x['trades'] for x in by.values()), r['test']['trades'])
        self.assertGreater(r['test']['exits']['zelf verkocht'], 0, 'hij verkoopt zelf, zonder vast doel of stop')
        self.assertEqual(a['exit']['features'][-4:], agent.POS_FEATURES)
        # Exportformaat rekent hetzelfde als sklearn (ook getest in Node met de fixture)
        row = [0.0] * len(a['entry']['features'])
        self.assertTrue(math.isfinite(agent.predict_reg_json(a['entry'], row)))
        bad = {p: market(9000, i + 20, momentum=0.0) for i, p in enumerate(pairs)}
        bad['BTC/EUR'] = market(9000, 98, momentum=0.0)
        _, r2 = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, '15m', lambda p, tf, d: bad[p], pairs)
        self.assertFalse(r2['ok'], 'op een willekeurige markt geen valse winst')
        if r2.get('validation') and r2['validation']['totalPct'] <= 0:
            self.assertIsNone(r2['folds'], 'geen extra periodes voor een recept dat toch al afvalt')

    def test_round_publishes_and_live_proof(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        s = server
        pairs = ['A/EUR', 'B/EUR', 'C/EUR']
        good = {p: market(9000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(9000, 99, momentum=0.3)
        s.write_json('agents.json', {'recipes': {}, 'published': None, 'live': {}, 'round': 0})
        s.write_json('config.json', {'pairs': pairs, 'costPct': 0.2, 'agent': {'enabled': True, 'timeframes': ['15m'], 'coinPool': 'eigen'}})
        orig = s.trainer.fetch_candles
        s.trainer.fetch_candles = lambda p, tf, d, cache_dir=None, **k: good[p]
        said = []
        orig_think = s.think
        s.think = lambda t, kind='info': said.append(t)
        try:
            s.agent_round()
        finally:
            s.trainer.fetch_candles = orig
            s.think = orig_think
        pub = s.read_json('agent.json', None)
        self.assertIsNotNone(pub)
        self.assertEqual(pub['timeframe'], '15m')
        self.assertIn(pub['stage'], ('getest', 'oefenen'))
        self.assertTrue(pub['coins'])
        self.assertTrue(any(t.startswith('Ik probeer nu: 15m-candles') for t in said), said)
        self.assertTrue(any(t.startswith('Resultaat 15m-candles') for t in said), said)
        self.assertTrue(any('Mijn beste manier van traden is nu' in t for t in said))
        self.assertEqual(set(pub['regimes']), {'stijgend', 'zijwaarts', 'dalend'}, 'Strategy Agent: plan per marktfase')
        self.assertIn('liveCheck', pub, 'eisen voor live in agent.json')
        self.assertFalse(pub['liveCheck']['allMet'], 'zonder paper-trades nooit live')
        self.assertTrue(any(t.startswith('Strategy Agent:') for t in said), said)
        info = s.agent_info()
        self.assertEqual(info['published']['timeframe'], '15m')
        self.assertEqual(len(info['recipes']), 1)
        self.assertEqual(info['recipes'][0]['score']['tested'], 1)
        # Echte trades: tellen per recept
        s.add_agent_trades([{'timeframe': '15m', 'recipe': pub['recipeKey'], 'pct': 0.5, 'features': {'rsi14': 40}} for _ in range(20)])
        self.assertEqual(s.load_agents()['live'][pub['recipeKey']]['n'], 20)
        self.assertEqual(len(s.agent_extra('15m')), 20)


def R(ok, part):
    """Rapport van een leerronde met dezelfde cijfers voor validatie en eindtest."""
    return {'ok': ok, 'validation': dict(part), 'test': dict(part)}


class RecipeSearch(unittest.TestCase):
    def test_status_needs_repeated_success(self):
        import agent_search as A
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        recipes = {}
        good = R(True, {'trades': 50, 'avgPct': 0.3, 'totalPct': 15, 'winRate': 55, 'edgePct': 0.2, 'maxDrawdownPct': 4})
        e = A.add_round(recipes, r, good)
        self.assertEqual(e['status'], 'veelbelovend', 'één goede ronde is nog geen bewijs')
        e = A.add_round(recipes, r, good)
        self.assertEqual(e['status'], 'betrouwbaar')
        bad = R(False, {'trades': 50, 'avgPct': -0.6, 'totalPct': -30, 'winRate': 30})
        e = A.add_round(recipes, r, bad)
        self.assertNotEqual(e['status'], 'betrouwbaar', 'laatste ronde slecht: niet meer betrouwbaar')
        for _ in range(2):
            e = A.add_round(recipes, r, bad)
        self.assertEqual(e['status'], 'afgevallen')

    def test_only_edge_over_market_counts(self):
        import agent_search as A
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        recipes = {}
        # Winst, maar de markt steeg tijdens de trades nog harder: dat is meedobberen, geen verdienste.
        rising = R(True, {'trades': 50, 'avgPct': 0.4, 'totalPct': 20, 'winRate': 60, 'marketPct': 0.6, 'edgePct': -0.2, 'maxDrawdownPct': 3})
        for _ in range(3):
            e = A.add_round(recipes, r, rising)
        self.assertNotEqual(e['status'], 'betrouwbaar')
        self.assertLess(e['score']['edge'], 0)

    def test_rank_on_gain_versus_drawdown(self):
        import agent_search as A
        recipes = {}
        calm = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        wild = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        for _ in range(2):
            A.add_round(recipes, calm, R(True, {'trades': 60, 'avgPct': 0.2, 'totalPct': 12, 'edgePct': 0.15, 'maxDrawdownPct': 2}))
            A.add_round(recipes, wild, R(True, {'trades': 60, 'avgPct': 0.5, 'totalPct': 30, 'edgePct': 0.4, 'maxDrawdownPct': 14}))
        board = A.leaderboard(recipes)
        self.assertEqual(board[0]['recipe'], calm, 'meer winst per risico wint van meer winst met diepe dalen')
        self.assertAlmostEqual(A.score(recipes[A.key_of(calm)])['ratio'], 0.15 * 60 / 2)

    def test_too_deep_drawdown_never_used(self):
        import agent_search as A
        recipes = {}
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        deep = R(True, {'trades': 60, 'avgPct': 0.8, 'totalPct': 48, 'edgePct': 0.6, 'maxDrawdownPct': 30})
        e = A.add_round(recipes, r, deep)
        self.assertEqual(e['status'], 'te riskant')
        self.assertFalse(A.usable(e))
        # Ook na genoeg nette rondes (de diepe valt uit de lijst) blijft hij te riskant.
        for _ in range(A.KEEP_ROUNDS + 1):
            e = A.add_round(recipes, r, R(True, {'trades': 60, 'avgPct': 0.3, 'totalPct': 18, 'edgePct': 0.2, 'maxDrawdownPct': 3}))
        self.assertEqual(e['status'], 'te riskant')
        for seed in range(20):
            rec, why = A.pick(recipes, ['15m'], rnd=random.Random(seed), now=time.time() + 7 * 3600)
            self.assertNotIn(why, ('retest', 'old'), 'een te riskant recept wordt niet opnieuw gebruikt')

    def test_market_move_during_trade(self):
        import agent
        class M:
            pass
        a, b = M(), M()
        a.c = [[t * 60000, 0, 0, 0, 0] for t in range(5)]
        a.close = __import__('numpy').array([100, 101, 102, 103, 104.0])
        b.c = [[t * 60000, 0, 0, 0, 0] for t in range(1, 5)]
        b.close = __import__('numpy').array([50, 50, 55, 55.0])
        self.assertAlmostEqual(agent.market_move([a, b], 60000, 180000), ((103 / 101 - 1) * 100 + 10) / 2)
        self.assertAlmostEqual(agent.market_move([a, b], 0, 240000), 4.0, msg='alleen coins met beide candles tellen')
        self.assertIsNone(agent.market_move([b], 0, 60000))

    def test_strategy_agent_per_regime(self):
        import agent_search as A
        import train
        self.assertEqual(A.REGIMES, train.REGIMES)
        recipes = {}
        ra = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        rb = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        def rep(avg, edge, by):
            return R(True, {'trades': 60, 'avgPct': avg, 'totalPct': avg * 60, 'edgePct': edge, 'maxDrawdownPct': 3, 'byRegime': by})
        for _ in range(2):
            A.add_round(recipes, ra, rep(0.3, 0.2, {'stijgend': {'trades': 30, 'avgPct': 0.5, 'edgePct': 0.4},
                                                    'dalend': {'trades': 25, 'avgPct': -0.2, 'edgePct': -0.1},
                                                    'zijwaarts': {'trades': 5, 'avgPct': 0.1, 'edgePct': 0.1}}))
            A.add_round(recipes, rb, rep(0.1, 0.05, {'stijgend': {'trades': 30, 'avgPct': 0.2, 'edgePct': 0.1},
                                                     'zijwaarts': {'trades': 30, 'avgPct': 0.2, 'edgePct': 0.15}}))
        ea, eb = recipes[A.key_of(ra)], recipes[A.key_of(rb)]
        self.assertEqual(A.regime_score(ea)['stijgend']['trades'], 60)
        plan = A.choose_per_regime([ea, eb], ea)
        self.assertEqual(plan['stijgend']['key'], ea['key'], 'het meest beter dan de markt')
        self.assertEqual(plan['zijwaarts']['key'], eb['key'], 'een ander recept doet het daar beter')
        self.assertEqual((plan['dalend']['key'], plan['dalend']['why']), (None, 'pauze'), 'verloor van de markt: niet handelen')
        # Zonder bewijs per fase: het hoofdrecept.
        plan = A.choose_per_regime([], ea)
        self.assertEqual(plan['zijwaarts'], {'key': ea['key'], 'why': 'weinig bewijs', 'edge': 0.1, 'trades': 10})

    def test_market_agent_regime_lookup(self):
        import market as M
        c = market(600, 3, momentum=0.0)
        look = M.RegimeLookup()
        look.add('A/EUR', c)
        self.assertIsNone(look.at('B/EUR', c[-1][0]))
        self.assertIsNone(look.at('A/EUR', c[0][0]), 'te vroeg: nog geen gesloten candle met kenmerken')
        r = look.at('A/EUR', c[-1][0] + M.REF_MS)
        self.assertIn(r, M.REGIMES)
        # Precies op de sluiting van het laatste candle telt dat candle; een milliseconde eerder het vorige.
        self.assertEqual(look.at('A/EUR', look.ts['A/EUR'][-1] + M.REF_MS), look.reg['A/EUR'][-1])
        self.assertEqual(look.at('A/EUR', look.ts['A/EUR'][-1] + M.REF_MS - 1), look.reg['A/EUR'][-2])

    def test_pick_retests_builds_on_best_and_learns_timeframes(self):
        import agent_search as A
        recipes = {}
        good_r = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        A.add_round(recipes, good_r, R(True, {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}))
        rec, why = A.pick(recipes, ['5m', '15m', '30m', '1h', '2h'], rnd=random.Random(1), now=time.time() + 3600)
        self.assertEqual((A.key_of(rec), why), (A.key_of(good_r), 'retest'), 'beste eerst nog eens bewijzen')
        A.add_round(recipes, good_r, R(True, {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}))
        A.add_round(recipes, good_r, R(True, {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}))
        # 5m: alles verlies
        for i, r in enumerate(A.all_recipes(['5m'])[:6]):
            A.add_round(recipes, r, R(False, {'trades': 40, 'avgPct': -0.5, 'totalPct': -20, 'winRate': 30}))
        self.assertEqual(A.tf_weight(recipes, '5m'), 0.1)
        whys, tfs = [], []
        for seed in range(40):
            rec, why = A.pick(recipes, ['5m', '15m', '30m', '1h', '2h'], rnd=random.Random(seed), now=time.time() + 60)
            whys.append(why)
            tfs.append(rec['timeframe'])
        self.assertGreater(whys.count('near'), 10, 'bouwt verder op het beste recept')
        self.assertLess(tfs.count('5m'), 4, '5m (alles verlies) bijna niet meer')


class RoundMessages(unittest.TestCase):
    def test_round_without_test_trades_does_not_crash(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        r = {'timeframe': '15m', 'recipe': {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}, 'ok': False,
             'test': {'trades': 0, 'avgPct': None, 'totalPct': 0, 'winRate': None, 'avgHeld': None, 'maxDrawdownPct': 0, 'worstPct': None}}
        self.assertIn('geen enkele trade', server.agent_mod_say(r))
        # Met trades maar zonder sommige getallen: ook geen crash.
        r['test'] = {'trades': 3, 'avgPct': 0.1, 'winRate': None, 'avgHeld': None, 'buyHoldPct': None, 'maxDrawdownPct': None, 'worstPct': None}
        self.assertIn('Resultaat', server.agent_mod_say(r))


class LiveAdmission(unittest.TestCase):
    def rows(self, n=60, days=25, pct=0.4, mkt=0.1, regimes=('stijgend', 'zijwaarts'), cost=0.5):
        from datetime import datetime, timedelta
        t0 = datetime(2026, 10, 1)
        out = []
        for i in range(n):
            at = t0 + timedelta(days=days * i / max(1, n - 1))
            out.append({'pct': pct + (0.3 if i % 2 else -0.3), 'mkt': mkt, 'closedAt': at.isoformat(), 'openedAt': (at - timedelta(hours=3)).isoformat(),
                        'marketRegime': regimes[i % len(regimes)], 'costPct': cost})
        return out

    def test_all_requirements(self):
        import livecheck as L
        r = L.check(self.rows(), 'betrouwbaar', slots=2, assumed_cost=0.5)
        self.assertTrue(r['allMet'], [c for c in r['checks'] if not c['ok']])
        bad = {
            'status': L.check(self.rows(), 'veelbelovend', 2, 0.5),
            'trades': L.check(self.rows(n=30), 'betrouwbaar', 2, 0.5),
            'trades ': L.check(self.rows(days=10), 'betrouwbaar', 2, 0.5),
            'avg': L.check(self.rows(pct=0.05), 'betrouwbaar', 2, 0.5),
            'market': L.check(self.rows(mkt=0.6), 'betrouwbaar', 2, 0.5),
            'regimes': L.check(self.rows(regimes=('dalend',)), 'betrouwbaar', 2, 0.5),
            'cost': L.check(self.rows(cost=0.9), 'betrouwbaar', 2, 0.5),
        }
        for key, res in bad.items():
            self.assertFalse(res['allMet'], key)
            self.assertFalse(next(c for c in res['checks'] if c['key'] == key.strip())['ok'], key)
        deep = self.rows(pct=0.4)
        for r in deep[10:20]:
            r['pct'] = -4.0
        self.assertFalse(next(c for c in L.check(deep, 'betrouwbaar', 2, 0.5)['checks'] if c['key'] == 'drawdown')['ok'])

    def test_calibration(self):
        import livecheck as L
        rows = [{'pct': 0.5, 'expectedPct': 0.3}, {'pct': -0.1, 'expectedPct': 0.25}, {'pct': 0.4, 'expectedPct': -0.2, 'explore': True}, {'pct': 1.0}]
        cal = {(c['who'], c['from']): c for c in L.calibration(rows)}
        self.assertEqual(cal[('gewoon', 0.2)]['trades'], 2)
        self.assertAlmostEqual(cal[('gewoon', 0.2)]['actual'], 0.2)
        self.assertEqual(cal[('gewoon', 0.2)]['winRate'], 50)
        self.assertAlmostEqual(cal[('verkenner', -0.5)]['actual'], 0.4, msg='verkenner apart')
        self.assertEqual(sum(c['trades'] for c in cal.values()), 3, 'zonder verwachting telt niet')

    def test_market_move_and_weeks(self):
        import livecheck as L
        h = 3600_000
        candles = {'A': [[i * h, 0, 0, 0, 100 + i, 0] for i in range(10)], 'B': [[i * h, 0, 0, 0, 50.0, 0] for i in range(10)]}
        from datetime import datetime, timezone
        iso = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()
        rows = [{'pct': 1.0, 'openedAt': iso(2 * h + 60_000), 'closedAt': iso(5 * h + 60_000)}, {'pct': 1.0, 'mkt': 9.0}]
        self.assertEqual(L.fill_market(rows, candles), 1)
        self.assertAlmostEqual(rows[0]['mkt'], ((105 / 102 - 1) * 100 + 0) / 2)
        self.assertEqual(rows[1]['mkt'], 9.0, 'bestaande waarde blijft')
        wk = L.weeks(self.rows(n=30, days=20))
        self.assertGreaterEqual(len(wk), 3)
        self.assertTrue(all(w['beatMarket'] for w in wk))
        self.assertEqual(sum(w['trades'] for w in wk), 30)


class KeptRecipes(unittest.TestCase):
    def test_live_recipes_always_sent(self):
        from unittest import mock
        import server
        a = {'recipeKey': 'A', 'regimes': {'stijgend': {'key': 'B', 'agent': {'recipeKey': 'B'}}}, 'extras': [{'recipeKey': 'C'}]}
        data = {'recipes': {'D': {'key': 'D'}, 'E': {'key': 'E'}, 'F': {'key': 'F'}}, 'live': {}}
        with mock.patch.object(server, 'read_json', side_effect=lambda f, d=None: None if 'F' in f else {'entry': 1, 'exit': 2}), \
                mock.patch.object(server, 'live_check', return_value={'allMet': False}), \
                mock.patch.object(server, 'agent_stage', return_value='oefenen'), \
                mock.patch.object(server.agent_search, 'status', side_effect=lambda e: 'te riskant' if e['key'] == 'E' else 'veelbelovend'), \
                mock.patch.object(server.agent_search, 'usable', side_effect=lambda e: e['key'] != 'E'):
            server.add_kept(a, ['A', 'B', 'C', 'D', 'E', 'F', 'X'], data)
        # A, B, C zijn er al; D komt erbij (ook als hij nu oefent); E te riskant; F zonder bestand; X onbekend.
        self.assertEqual([p['recipeKey'] for p in a['extras']], ['C', 'D'])
        self.assertTrue(a['extras'][1]['kept'])


class ScheduleOff(unittest.TestCase):
    def test_off_means_no_automatic_training(self):
        import server
        cur = {'mode': 'times', 'hours': [3], 'everyHours': 6, 'pauseMinutes': 30}
        off = server.validate_schedule({'mode': 'off'}, cur)
        self.assertEqual(off['mode'], 'off')
        self.assertIsNone(server.next_run(schedule=off))
        self.assertIsNotNone(server.next_run(schedule=cur))
        with self.assertRaises(ValueError):
            server.validate_schedule({'mode': 'soms'}, cur)


class ExtraRecipes(unittest.TestCase):
    def test_best_other_recipes_go_along(self):
        from unittest import mock
        import server
        board = [{'key': k} for k in ('A', 'B', 'C', 'D', 'E')]
        stages = {'C': 'getest', 'D': 'oefenen', 'E': 'bewezen'}
        with mock.patch.object(server, 'read_json', side_effect=lambda f, d=None: None if 'E' in f else {'entry': 1, 'exit': 2, 'timeframe': '15m', 'secret': 9}), \
                mock.patch.object(server, 'live_check', return_value={'allMet': False}), \
                mock.patch.object(server, 'agent_stage', side_effect=lambda e, lc: stages.get(e['key'], 'getest')), \
                mock.patch.object(server.agent_search, 'status', return_value='betrouwbaar'):
            out = server.extra_recipes(board, board[0], {'stijgend': {'key': 'B'}, 'dalend': {'key': None}}, {'live': {}})
        # A is het hoofdrecept, B zit in het fase-plan, D oefent nog, E heeft geen bestand.
        self.assertEqual([x['recipeKey'] for x in out], ['C'])
        self.assertTrue(out[0]['extra'])
        self.assertNotIn('secret', out[0], 'alleen de onderdelen die de bot nodig heeft')
        with mock.patch.object(server, 'read_json', return_value={'entry': 1}), \
                mock.patch.object(server, 'live_check', return_value={}), \
                mock.patch.object(server, 'agent_stage', return_value='getest'), \
                mock.patch.object(server.agent_search, 'status', return_value='betrouwbaar'):
            many = server.extra_recipes([{'key': str(i)} for i in range(20)], {'key': '0'}, {}, {'live': {}})
        self.assertEqual(len(many), server.EXTRA_RECIPES)


class Explorer(unittest.TestCase):
    def test_virtual_examples_have_lower_weight(self):
        import agent
        from unittest.mock import patch
        row = [0.0] * len(agent.FEATURES)
        examples = [(row, 1.0, 0.75)] * 750 + [(row, 1.0)] * 750
        with patch.object(agent, '_fit') as fit:
            agent.learn_entry([], None, None, 4, 0.5, 10, extra=examples)
        weights = fit.call_args.args[2]
        self.assertTrue(np.all(weights[:750] == 0.75))
        self.assertTrue(np.all(weights[750:] == 3.0))

    def test_explorer_trades_learn_but_do_not_count_for_live(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server as s
        s.write_json('agent_trades.json', [])
        s.write_json('agents.json', {'version': s.AGENTS_VERSION, 'recipes': {}, 'live': {}, 'round': 0})
        base = {'timeframe': '15m', 'recipe': 'R', 'pct': 1.0, 'mode': 'paper', 'features': {'rsi14': 40}, 'entryTs': 1}
        s.add_agent_trades([{**base, 'virtual': True, 'closedAt': '2026-01-01T00:00:00Z'}, {**base, 'pct': 2.0}])
        self.assertEqual([t['pct'] for t in s.paper_rows('R')], [2.0], 'verkenner telt niet voor live')
        self.assertEqual(s.load_agents()['live']['R']['n'], 1, 'en niet als resultaat in de praktijk')
        self.assertEqual(len(s.agent_extra('15m')), 2, 'maar leert wel mee')
        self.assertEqual(s.agent_extra('15m')[0][-1], 0.75)
        self.assertEqual(s.agent_extra('15m')[1][-1], 3.0)
        self.assertTrue(s.read_json('agent_trades.json', [])[0]['virtual'])


class Patience(unittest.TestCase):
    def test_recipe_keys_stay_the_same_and_patience_is_searched(self):
        import agent_search as A
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        self.assertEqual(A.key_of(r), '15m|1|4|200|5', 'oude recepten houden hun sleutel')
        self.assertEqual(A.key_of({**r, 'minHold': 1, 'margin': 0.0}), '15m|1|4|200|5')
        self.assertEqual(A.key_of({**r, 'minHold': 3, 'margin': 0.05}), '15m|1|4|200|5|h3|m0.05')
        allowed = {A.key_of(x): x for x in A.all_recipes(['15m'])}
        keys = [A.key_of(n) for n in A.neighbours(r, allowed)]
        self.assertIn('15m|1|4|200|5|h3', keys)
        self.assertIn('15m|1|4|200|5|m0.05', keys)

    def test_patience_in_backtest_and_export(self):
        import agent
        pairs = ['A/EUR', 'B/EUR']
        good = {p: market(9000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(9000, 99, momentum=0.3)
        fetch = lambda p, tf, d: good[p]
        a1, r1 = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, {'timeframe': '15m', 'holdDays': 1}, fetch, pairs)
        a6, r6 = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, {'timeframe': '15m', 'holdDays': 1, 'minHold': 6, 'margin': 0.05}, fetch, pairs)
        self.assertEqual((a1['minHoldCandles'], a1['exitMarginPct']), (1, 0.0))
        self.assertEqual((a6['minHoldCandles'], a6['exitMarginPct']), (6, 0.05))
        self.assertGreater(r6['test']['avgHeld'], r1['test']['avgHeld'], 'met geduld houdt hij langer vast')
        self.assertGreaterEqual(r6['test']['avgHeld'], 5)
        self.assertIn('minstens 6 candles vasthouden', agent.recipe_text({**agent.RECIPE_DEFAULT, 'minHold': 6}))


class FasterAndWalkForward(unittest.TestCase):
    def test_feature_cache_only_computes_new_candles(self):
        import featcache
        from features import context
        d = tempfile.mkdtemp()
        c = market(3200, 5, momentum=0.4)
        btc = context(market(3200, 6))
        first = featcache.matrix('A/EUR', '5m', c[:3000], btc, d)
        calls = []
        save_rows = featcache.SAVE_ROWS
        featcache.SAVE_ROWS = 1  # in deze test elke keer opslaan (het afknijpen heeft een eigen test)
        orig = featcache._compute
        featcache._compute = lambda cc, ctx, lo: (calls.append((len(cc), lo)), orig(cc, ctx, lo))[1]
        try:
            again = featcache.matrix('A/EUR', '5m', c[:3000], btc, d)
            more = featcache.matrix('A/EUR', '5m', c, btc, d)
            moved = featcache.matrix('A/EUR', '5m', c[100:], btc, d)
        finally:
            featcache._compute = orig
            featcache.SAVE_ROWS = save_rows
        self.assertEqual(calls, [(2200, 2000)], 'niets bij dezelfde candles, alleen de 200 nieuwe bij meer candles')
        np.testing.assert_array_equal(first, again)
        fresh = orig(c, btc, 0)
        np.testing.assert_allclose(more[400:], fresh[400:], rtol=2e-6, atol=1e-6, equal_nan=True)
        self.assertTrue(np.isnan(moved[:featcache.WARMUP]).all(), 'eerste candles van het venster tellen nooit mee')
        np.testing.assert_array_equal(moved[featcache.WARMUP:], more[100 + featcache.WARMUP:])
        np.testing.assert_array_equal(featcache.matrix('A/EUR', '5m', c, btc, None), fresh, 'zonder opslag: precies de oude berekening')

    def test_walk_forward_periods(self):
        import agent
        pairs = ['A/EUR', 'B/EUR', 'C/EUR']
        good = {p: market(12000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(12000, 99, momentum=0.3)
        seen = []
        orig = agent.learn_entry
        def spy(markets, *a, extra=None, **k):
            seen.append((markets[0].split[1][0], [r for _, r, *_ in (extra or [])]))
            return orig(markets, *a, extra=extra, **k)
        agent.learn_entry = spy
        try:
            row = [0.0] * len(agent.FEATURES)
            ts = lambda i: good['A/EUR'][i][0]
            a, r = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, {'timeframe': '15m', 'holdDays': 0.5}, lambda p, tf, d: good[p], pairs,
                                     extra=[(row, 1.0, ts(1000), ts(1010)), (row, 2.0, ts(6000), ts(6010))])
        finally:
            agent.learn_entry = orig
        self.assertEqual(len(r['folds']), 3, 'twee eerdere periodes plus de gewone validatie')
        self.assertEqual(r['folds'][-1]['trades'], r['validation']['trades'])
        self.assertTrue(r['folds'][0]['period'][1] < r['folds'][1]['period'][0] < r['folds'][2]['period'][0] < r['periods']['eindtest'][0])
        self.assertEqual(r['foldsPositive'], 3)
        self.assertTrue(r['ok'])
        # Elke periode leert alleen van echte trades van vóór zijn eigen testperiode.
        by = {start: extra for start, extra in seen}
        starts = sorted(by)
        self.assertEqual([by[s] for s in starts], [[1.0], [1.0, 2.0], [1.0, 2.0]])
        self.assertLess(ts(1010), ts(starts[0]))
        self.assertTrue(ts(starts[0]) < ts(6000) < ts(starts[1]))

    def test_inconsistent_recipe_ranks_lower(self):
        import agent_search as A
        part = {'trades': 60, 'avgPct': 0.3, 'totalPct': 18, 'edgePct': 0.2, 'maxDrawdownPct': 3}
        fold = lambda total: {'period': ['a', 'b'], 'trades': 20, 'avgPct': total / 20, 'totalPct': total}
        recipes = {}
        ra = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        rb = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        A.add_round(recipes, ra, {'ok': True, 'validation': part, 'test': part, 'folds': [fold(5), fold(4), fold(6)], 'foldsPositive': 3})
        A.add_round(recipes, rb, {'ok': False, 'validation': {**part, 'avgPct': 0.4, 'edgePct': 0.3}, 'test': part, 'folds': [fold(-5), fold(-4), fold(9)], 'foldsPositive': 1})
        self.assertEqual(A.leaderboard(recipes)[0]['recipe'], ra, 'werkt in alle periodes: boven het recept dat maar in één periode werkte')
        self.assertEqual(A.score(recipes[A.key_of(rb)])['periods'], {'n': 3, 'positive': 1, 'share': 1 / 3})


class Resources(unittest.TestCase):
    """Minder processor, minder schrijfwerk, nette foutafhandeling (gedeelde VPS)."""

    def test_threads_limited_by_default(self):
        import resources
        self.assertEqual(resources.TRAIN_JOBS, int(os.environ.get('TRAIN_JOBS') or 2))
        for v in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
            self.assertTrue(os.environ.get(v), v)

    def test_sklearn_warning_fixed_not_hidden(self):
        """De oorzaak: scikit-learn's Parallel (zoals HistGradientBoosting die gebruikt) waarschuwt als
        warnings.filters leeg is; threads die tegelijk catch_warnings gebruiken kunnen die lijst leeg
        achterlaten. De oplossing: vóór elke training de goede toestand herstellen (geen filter
        dat de melding verbergt)."""
        import warnings
        import resources
        from sklearn.utils.parallel import Parallel, delayed
        job = lambda: Parallel(n_jobs=2, backend='threading')(delayed(abs)(i) for i in range(4))
        saved = list(warnings.filters)
        self.assertFalse(any('sklearn' in str(f[1] or '') for f in saved), 'geen filter dat de melding verbergt')
        resources.set_warning_baseline()
        try:
            # Zonder bescherming: precies de melding uit de log.
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter('always')
                warnings.filters[:] = []
                job()
            self.assertTrue([x for x in w if 'sklearn.utils.parallel.delayed' in str(x.message)])
            # Met bescherming (zoals elke training in agent._fit): hersteld, geen melding.
            before = resources.repairs['count']
            with warnings.catch_warnings(record=True) as w:
                warnings.filters[:] = []
                with resources.fit_guard():
                    self.assertTrue(warnings.filters, 'hersteld voordat er getraind wordt')
                    job()
            self.assertFalse([x for x in w if 'sklearn.utils.parallel.delayed' in str(x.message)])
            self.assertEqual(resources.repairs['count'], before + 1)
        finally:
            warnings.filters[:] = saved

    def test_quiet_when_client_disconnects(self):
        import io
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        class Gone(io.BytesIO):
            def write(self, b):
                raise BrokenPipeError(32, 'Broken pipe')
        h = server.Handler.__new__(server.Handler)
        h.wfile, h.request_version, h.requestline, h.command, h.close_connection = Gone(), 'HTTP/1.1', 'GET /status HTTP/1.1', 'GET', False
        h.send(200, {'ok': True})  # geen fout
        self.assertTrue(h.close_connection)
        srv = server.QuietHTTPServer.__new__(server.QuietHTTPServer)
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            try:
                raise ConnectionResetError(104, 'reset')
            except ConnectionResetError:
                srv.handle_error(None, ('172.18.0.7', 1234))
        self.assertEqual(buf.getvalue(), '', 'geen traceback in de log')

    def test_agent_hours(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        from datetime import datetime
        self.assertEqual(server.parse_hours('0-2, 22'), [0, 1, 2, 22])
        self.assertEqual(server.parse_hours('23-1'), [0, 1, 23])
        self.assertEqual(server.parse_hours(''), [])
        with self.assertRaises(ValueError):
            server.parse_hours('25')
        cfg = {'agent': {'hours': [1, 2, 3]}}
        self.assertTrue(server.agent_may_learn(cfg, datetime(2026, 1, 1, 2, 30)))
        self.assertFalse(server.agent_may_learn(cfg, datetime(2026, 1, 1, 14, 0)))
        self.assertTrue(server.agent_may_learn({'agent': {'hours': []}}, datetime(2026, 1, 1, 14, 0)), 'leeg = doorlopend')

    def test_candle_cache_not_rewritten_for_every_new_candle(self):
        d = tempfile.mkdtemp()
        step = train.TF_MS['5m']
        base = 1_700_000_000_000
        data = [[base + i * step, 1, 1, 1, 1, 1] for i in range(2000)]
        src = lambda pair, tf, a, b: [c for c in data if a <= c[0] <= b]
        now = base + 1990 * step
        train.fetch_candles('A/EUR', '5m', 6, cache_dir=d, now_ms=now, fetch=src)
        f = os.path.join(d, 'A-EUR_5m.json')
        t0 = os.path.getmtime(f)
        os.utime(f, (t0 - 60, t0 - 60))
        out = train.fetch_candles('A/EUR', '5m', 6, cache_dir=d, now_ms=now + 3 * step, fetch=src)
        self.assertEqual(os.path.getmtime(f), t0 - 60, 'een paar nieuwe candles: niet het hele bestand opnieuw schrijven')
        self.assertEqual(out[-1][0], base + 1992 * step, 'maar de nieuwe candles komen wel mee')
        os.utime(f, (t0 - train.SAVE_EVERY_S - 1, t0 - train.SAVE_EVERY_S - 1))
        train.fetch_candles('A/EUR', '5m', 6, cache_dir=d, now_ms=now + 4 * step, fetch=src)
        self.assertGreater(os.path.getmtime(f), t0 - 60, 'na een half uur wel bijwerken')
        with open(f) as fh:
            self.assertEqual(json.load(fh)[-1][0], base + 1993 * step)

    def test_feature_cache_saved_only_now_and_then(self):
        import featcache
        from features import context
        d = tempfile.mkdtemp()
        c = market(2600, 5)
        btc = context(market(2600, 6))
        featcache.matrix('A/EUR', '5m', c[:2500], btc, d)
        f = os.path.join(d, 'A-EUR_5m_btc.npz')
        old = os.path.getmtime(f) - 60
        os.utime(f, (old, old))
        a = featcache.matrix('A/EUR', '5m', c[:2510], btc, d)
        self.assertEqual(os.path.getmtime(f), old, '10 nieuwe rijen: niet opslaan')
        b = featcache.matrix('A/EUR', '5m', c[:2510], btc, d)
        np.testing.assert_array_equal(a, b)
        os.utime(f, (old - featcache.SAVE_EVERY_S, old - featcache.SAVE_EVERY_S))
        featcache.matrix('A/EUR', '5m', c, btc, d)
        self.assertGreater(os.path.getmtime(f), old, 'na 6 uur wel')

    def test_cleanup_old_files(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server as s
        import agent_search as A
        for sub in ('features', 'candles', 'agents'):
            os.makedirs(os.path.join(s.DATA, sub), exist_ok=True)
        now = time.time()
        def touch(rel, age_days):
            p = os.path.join(s.DATA, rel)
            open(p, 'w').close()
            os.utime(p, (now - age_days * 86400, now - age_days * 86400))
            return p
        old_f, new_f = touch('features/X-EUR_5m_btc.npz', 20), touch('features/A-EUR_5m_btc.npz', 1)
        old_c, tmp = touch('candles/X-EUR_5m.json', 40), touch('candles/A-EUR_5m.json.tmp', 1)
        r = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        recipes = {}
        part = {'trades': 40, 'avgPct': -0.3, 'totalPct': -12, 'edgePct': -0.2, 'maxDrawdownPct': 3}
        for _ in range(3):
            A.add_round(recipes, r, {'ok': False, 'validation': part, 'test': part})
        for x in recipes[A.key_of(r)]['rounds']:
            x['ts'] = now - 30 * 86400
        s.write_json('agents.json', {'version': s.AGENTS_VERSION, 'recipes': recipes, 'live': {}, 'round': 3})
        keep = touch('agents/' + A.key_of(r).replace('|', '_') + '.json', 1)
        gone = touch('agents/weg_recept.json', 1)
        A_lb = A.leaderboard
        A.leaderboard = lambda rec, n=12: []  # dit recept hoort niet bij de beste
        try:
            n = s.cleanup_files(now)
        finally:
            A.leaderboard = A_lb
        self.assertGreaterEqual(n, 4)
        for p in (old_f, old_c, tmp, gone):
            self.assertFalse(os.path.exists(p), p)
        for p in (new_f, keep):
            self.assertTrue(os.path.exists(p), p)
        self.assertEqual(len(s.load_agents()['recipes'][A.key_of(r)]['rounds']), 1, 'oud recept: alleen de laatste ronde')


class Bench(unittest.TestCase):
    def test_bench_runs_and_reports(self):
        import contextlib
        import io
        import bench
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            times = bench.main(['--rounds', '2', '--coins', '2', '--candles', '6000'])
        self.assertEqual(len(times), 2)
        text = out.getvalue()
        for part in ('Werklast : 2 coins × 6.000 candles (5m), 2 rondes', 'Ronde 1:', 'Ronde 2:', 'rondes per uur', 'Geheugen (piek)'):
            self.assertIn(part, text)


class Helpers(unittest.TestCase):
    """Helpers trainen recepten op een ander apparaat; de leerserver blijft de baas."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        cls.s = server
        cls.httpd = server.QuietHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, method, p, body=None, tok=None):
        h = {'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'}
        r = urllib.request.Request(self.base + p, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def test_pick_skips_recipes_in_training(self):
        import agent_search as A
        allowed = A.all_recipes(['15m'])
        busy = frozenset(A.key_of(r) for r in allowed[:-1])
        rec, why = A.pick({}, ['15m'], rnd=random.Random(1), exclude=busy)
        self.assertEqual(A.key_of(rec), A.key_of(allowed[-1]), 'alleen het recept dat nog niemand traint')
        self.assertEqual(A.pick({}, ['15m'], rnd=random.Random(1), exclude=frozenset(A.key_of(r) for r in allowed)), (None, None))

    def test_helper_code_only_for_helper_work(self):
        s = self.s
        ht = s.helper_token()
        self.assertTrue(ht.startswith('h-'))
        self.assertNotEqual(ht, s.token())
        self.assertEqual(self.req('GET', '/status', tok=ht)[0], 401, 'helper-code: geen status')
        self.assertEqual(self.req('POST', '/config', {'days': 30}, tok=ht)[0], 401, 'helper-code: geen instellingen')
        self.assertEqual(self.req('POST', '/helper/claim', {'name': 't', 'protocol': 999}, tok=ht)[0], 200)
        self.assertEqual(self.req('POST', '/helper/claim', {'name': 't'}, tok='fout')[0], 401)
        code, body = self.req('POST', '/helper/result', {'name': 't', 'id': 'bestaat-niet'}, tok=ht)
        self.assertEqual(code, 409)

    def test_helper_trains_a_recipe_end_to_end(self):
        import helper
        s = self.s
        pairs = ['A/EUR', 'B/EUR', 'C/EUR']
        good = {p: market(9000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(9000, 99, momentum=0.3)
        s.write_json('agents.json', {'version': s.AGENTS_VERSION, 'recipes': {}, 'published': None, 'live': {}, 'round': 0})
        s.write_json('config.json', {'pairs': pairs, 'costPct': 0.2, 'days': 60,
                                     'agent': {'enabled': True, 'timeframes': ['15m'], 'coinPool': 'eigen'}})
        s.inflight.clear()
        d = tempfile.mkdtemp()
        st = {'url': self.base, 'token': s.helper_token(), 'data': d, 'name': 'fold4'}
        said = []
        orig = s.think
        s.think = lambda t, kind='info': said.append(t)
        try:
            wait = helper.run_once(st, fetch=lambda p, tf, days: good[p])
        finally:
            s.think = orig
        self.assertEqual(wait, 0)
        data = s.load_agents()
        self.assertEqual(len(data['recipes']), 1, 'de uitkomst is verwerkt alsof de VPS hem trainde')
        self.assertEqual(data['round'], 1)
        pub = s.read_json('agent.json', None)
        self.assertIsNotNone(pub, 'en de bot krijgt de beste manier van traden')
        self.assertTrue(any(t.startswith('Helper fold4 traint nu:') for t in said), said)
        self.assertTrue(any(t.startswith('Helper fold4: Resultaat') for t in said), said)
        self.assertEqual(s.inflight, {}, 'recept weer vrij')
        info = {h['name']: h for h in s.helpers_info()}
        self.assertEqual(info['fold4']['rounds'], 1)
        self.assertTrue(info['fold4']['online'])
        self.assertIsNotNone(info['fold4']['avgSeconds'])

    def test_helper_settings_from_file_and_missing(self):
        import helper
        d = tempfile.mkdtemp()
        with open(os.path.join(d, 'helper-token'), 'w') as f:
            f.write('h-geheim\n')
        old = {k: os.environ.get(k) for k in ('DATA_DIR', 'HELPER_TOKEN', 'TRAINER_URL', 'HELPER_NAME')}
        try:
            os.environ.update({'DATA_DIR': d, 'TRAINER_URL': 'https://trainer.example/', 'HELPER_NAME': 'pi'})
            os.environ.pop('HELPER_TOKEN', None)
            st = helper.settings()
            self.assertEqual((st['url'], st['token'], st['name']), ('https://trainer.example', 'h-geheim', 'pi'))
            os.environ['TRAINER_URL'] = ''
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(helper.main(), 2)
            self.assertIn('TRAINER_URL en de helper-code zijn nodig', out.getvalue())
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_helper_identifies_itself(self):
        import helper
        seen = {}
        orig = urllib.request.urlopen
        def fake(req, timeout=None):
            seen.update(dict(req.header_items()))
            raise urllib.error.URLError('test')
        urllib.request.urlopen = fake
        try:
            with self.assertRaises(urllib.error.URLError):
                helper.call({'url': 'https://x', 'token': 'h-1'}, '/helper/claim', {})
        finally:
            urllib.request.urlopen = orig
        self.assertTrue(seen['User-agent'].startswith('vetobot-helper/'), seen)
        self.assertEqual(seen['Authorization'], 'Bearer h-1')

    def test_pairing_with_short_code(self):
        import helper
        s = self.s
        s.pairing.update({'code': None, 'until': 0.0, 'wrong': 0, 'fails': [], 'blockedUntil': 0.0})
        self.assertEqual(self.req('POST', '/helper/pair-code', {}, tok=s.helper_token())[0], 401, 'helper-code mag geen koppelcode maken')
        code, body = self.req('POST', '/helper/pair-code', {}, tok=s.token())
        self.assertEqual(code, 200)
        self.assertRegex(body['code'], r'^\d{6}$')
        wrong = '000000' if body['code'] != '000000' else '111111'
        self.assertEqual(self.req('POST', '/helper/pair', {'code': wrong})[0], 403)
        # Inwisselen via de helper zelf: de lange code komt in een bestand dat alleen jij kunt lezen.
        d = tempfile.mkdtemp()
        st = {'url': self.base, 'token': '', 'data': d, 'name': 'pi'}
        tok = helper.pair(st, body['code'][:3] + ' ' + body['code'][3:])
        self.assertEqual(tok, s.helper_token())
        p = os.path.join(d, 'helper-token')
        with open(p) as fh:
            self.assertEqual(fh.read(), tok)
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        self.assertEqual(self.req('POST', '/helper/pair', {'code': body['code']})[0], 403, 'maar één keer te gebruiken')
        # Na 5 foute pogingen is een koppelcode ongeldig.
        code2 = self.req('POST', '/helper/pair-code', {}, tok=s.token())[1]['code']
        bad = '000000' if code2 != '000000' else '111111'
        for _ in range(5):
            s.helper_pair({'code': bad})
        self.assertEqual(s.helper_pair({'code': code2})[0], 403)
        s.pairing.update({'code': None, 'until': 0.0, 'wrong': 0, 'fails': [], 'blockedUntil': 0.0})

    def test_helper_stops_on_wrong_code(self):
        import contextlib
        import io
        import helper
        d = tempfile.mkdtemp()
        with open(os.path.join(d, 'helper-token'), 'w') as f:
            f.write('h-verkeerd')
        old = {k: os.environ.get(k) for k in ('DATA_DIR', 'HELPER_TOKEN', 'TRAINER_URL', 'PAIR_CODE')}
        try:
            os.environ.update({'DATA_DIR': d, 'TRAINER_URL': self.base})
            for k in ('HELPER_TOKEN', 'PAIR_CODE'):
                os.environ.pop(k, None)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(helper.main(), 4, 'stopt, zodat het script opnieuw laat koppelen')
            self.assertIn('Koppel opnieuw', out.getvalue())
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_lease_expires_when_helper_disappears(self):
        s = self.s
        s.write_json('config.json', {'pairs': ['A/EUR'], 'costPct': 0.2, 'days': 60,
                                     'agent': {'enabled': True, 'timeframes': ['15m'], 'coinPool': 'eigen'}})
        s.inflight.clear()
        data = s.load_agents()
        rec, why, job = s.choose_recipe(s.config(), data, 'weg')
        key = __import__('agent_search').key_of(rec)
        self.assertIn(key, s.inflight)
        s.inflight[key]['at'] -= s.LEASE_S + 1
        s.choose_recipe(s.config(), data, 'VPS')
        self.assertNotEqual(s.inflight.get(key, {}).get('by'), 'weg', 'verlopen opdracht is vrijgegeven')
        s.inflight.clear()


class HonestTesting(unittest.TestCase):
    def test_split_has_buffer_between_parts(self):
        import agent
        (a0, a1), (b0, b1), (c0, c1) = agent._split(10000, 50)
        self.assertEqual((b0 - a1, c0 - b1), (50, 50), 'buffer van de maximale duur tussen de delen')

    def test_bot_trades_only_from_before_validation(self):
        import agent
        pairs = ['A/EUR', 'B/EUR']
        data = {p: market(6000, i, momentum=0.6) for i, p in enumerate(pairs)}
        data['BTC/EUR'] = market(6000, 99)
        seen = {}
        orig = agent.learn_entry
        def spy(*a, extra=None, **k):
            seen['extra'] = extra
            return orig(*a, extra=extra, **k)
        agent.learn_entry = spy
        try:
            row = [0.0] * len(agent.FEATURES)
            early, late = data['A/EUR'][100][0], data['A/EUR'][-10][0]
            agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}}, {'timeframe': '15m', 'holdDays': 0.5}, lambda p, tf, d: data[p], pairs,
                          extra=[(row, 1.0, early), (row, 2.0, late), (row, 3.0, None), (row, 4.0),
                              (row, 5.0, early, late, 0.75), (row, 6.0, early, early + M5, 0.75),
                              (row, 7.0, early, early - M5, 0.75)])
        finally:
            agent.learn_entry = orig
        self.assertEqual([item[1] for item in seen['extra']], [1.0, 6.0], 'volledig vóór de validatie afgesloten')
        self.assertEqual(seen['extra'][-1][-1], 0.75, 'weging blijft bewaard')

    def test_choose_on_validation_not_on_test(self):
        import agent_search as A
        recipes = {}
        ra = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        rb = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        part = lambda avg, edge: {'trades': 60, 'avgPct': avg, 'totalPct': avg * 60, 'edgePct': edge, 'maxDrawdownPct': 3}
        for _ in range(2):
            # A: beter op de validatie; B: toevallig beter op de eindtest.
            A.add_round(recipes, ra, {'ok': True, 'validation': part(0.4, 0.3), 'test': part(0.2, 0.1)})
            A.add_round(recipes, rb, {'ok': True, 'validation': part(0.15, 0.1), 'test': part(0.6, 0.5)})
        self.assertEqual(A.leaderboard(recipes)[0]['recipe'], ra)
        sc = A.score(recipes[A.key_of(ra)])
        self.assertAlmostEqual(sc['avg'], 0.4)
        self.assertAlmostEqual(sc['test']['avg'], 0.2)
        # De eindtest blijft wel de controle: verlies daar = niet betrouwbaar.
        rc = {'timeframe': '2h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        for _ in range(2):
            e = A.add_round(recipes, rc, {'ok': False, 'validation': part(0.5, 0.4), 'test': part(-0.3, -0.4)})
        self.assertNotEqual(e['status'], 'betrouwbaar')


class Portfolio(unittest.TestCase):
    class M:
        def __init__(self, pair, closes):
            self.pair = pair
            self.close = np.array(closes, dtype=float)
            self.c = [[i * 60000, x, x, x, x, 1] for i, x in enumerate(closes)]

    def test_drawdown_of_a_real_portfolio(self):
        import agent
        a = self.M('A', [100, 100, 100, 100, 110, 110])
        b = self.M('B', [50, 50, 40, 45, 45, 45])
        trades = [{'pair': 'A', 'i': 0, 'held': 4, 'ret': 10.0, 'mkt': 0.0},
                  {'pair': 'B', 'i': 1, 'held': 3, 'ret': -10.0, 'mkt': 0.0}]
        pf = agent.portfolio(trades, [a, b], slots=2)
        # A krijgt de helft; B de andere helft. Op candle 2 staat B op -20%: vermogen 90 van 100.
        self.assertAlmostEqual(pf['maxDrawdownPct'], 10.0)
        self.assertAlmostEqual(pf['returnPct'], 0.0)
        self.assertEqual((pf['taken'], pf['skipped']), (2, 0))
        one = agent.portfolio(trades, [a, b], slots=1)
        self.assertEqual((one['taken'], one['skipped']), (1, 1), 'alles bezet: trade overgeslagen')
        self.assertAlmostEqual(one['returnPct'], 10.0)
        self.assertAlmostEqual(one['excessPct'], 10.0)
        self.assertEqual(agent.portfolio([], [a])['maxDrawdownPct'], 0.0)


class RealCosts(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        self.s = server

    def test_cost_per_coin_from_bot_trades(self):
        s = self.s
        rows = [{'pair': 'A/EUR', 'costPct': c} for c in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)] + \
               [{'pair': 'B/EUR', 'costPct': 0.4}] * 2 + [{'pair': 'C/EUR', 'costPct': 0.6}] * 3
        rows += [{'pair': 'V/EUR', 'costPct': 9.0, 'virtual': True}] * 100
        s.write_json('agent_trades.json', rows)
        per, info, default = s.cost_table({'costPct': 0.5})
        self.assertEqual(set(per), {'A/EUR'}, 'eigen kosten pas na 5 metingen')
        self.assertAlmostEqual(per['A/EUR'], 0.9, msg='voorzichtig: 75e percentiel')
        self.assertEqual(info['B/EUR']['used'], round(default, 4))
        self.assertNotEqual(default, 0.5, 'genoeg metingen: niet meer de ingestelde kosten')
        s.write_json('agent_trades.json', [])
        self.assertEqual(s.cost_table({'costPct': 0.5}), ({}, {}, 0.5))

    def test_costs_used_in_learning(self):
        import agent
        pairs = ['A/EUR', 'B/EUR', 'C/EUR']
        good = {p: market(9000, i, momentum=0.6) for i, p in enumerate(pairs)}
        good['BTC/EUR'] = market(9000, 99, momentum=0.3)
        a, r = agent.train_agent({'costPct': 0.2, 'days': 60, 'agent': {}, 'costs': {'A/EUR': 5.0}}, '15m', lambda p, tf, d: good[p], pairs)
        self.assertNotIn('A/EUR', r.get('coins') or [], 'veel te dure coin valt af')
        self.assertTrue(r['test'].get('portfolio'), 'portefeuille in het rapport')
        self.assertIn('eindtest', r['periods'])

    def test_old_results_are_archived(self):
        s = self.s
        s.write_json('agents.json', {'recipes': {'x': {'key': 'x', 'recipe': {}, 'rounds': []}}, 'published': {'key': 'x'}, 'live': {'x': {'n': 3}}, 'round': 7})
        d = s.load_agents()
        self.assertEqual(d['recipes'], {})
        self.assertEqual(d['live'], {'x': {'n': 3}}, 'resultaten in de praktijk blijven')
        self.assertEqual(s.read_json('agents-archief.json', [])[-1]['recipes'], {'x': {'key': 'x', 'recipe': {}, 'rounds': []}})
        self.assertEqual(s.read_json('agents.json', {})['version'], s.AGENTS_VERSION)


class Arms(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        self.s = server

    def test_models_of_confirmed_strategies_are_served(self):
        import search
        s = self.s
        fake = {p: market(9000, i, momentum=0.6) for i, p in enumerate(CFG['pairs'])}
        fake['BTC/EUR'] = market(9000, 99, momentum=0.3)
        cfg = {**CFG, 'search': {'enabled': True, 'timeframes': ['5m'], 'perRound': 3}, 'maxSamples': 60000}
        results, models = {}, {}
        search.run_round(cfg, results, log=lambda *_: None, fetch=lambda p, tf, d: fake[p], markets=lambda n: CFG['pairs'],
                         rnd=random.Random(1), models_out=models)
        self.assertTrue(models, 'modellen van strategieën met een bruikbare drempel')
        key = next(iter(models))
        results[key]['status'] = 'bevestigd'
        results[key]['score'] = 0.5
        for k in results:
            if k != key:
                results[k]['status'] = 'niet goed genoeg'
        s.write_json('search.json', {'results': results})
        s.save_arms(results, models)
        arms = s.load_arms()
        self.assertEqual(arms[0]['key'], key)
        self.assertEqual(arms[0]['stage'], 'bevestigd')
        self.assertEqual(len(arms), 3, 'altijd minstens 3 strategieën om van te leren')
        self.assertTrue(all(a['stage'] in ('proef', 'verkenning') for a in arms[1:]))
        self.assertEqual(arms[0]['model']['meta']['timeframe'], '5m')
        self.assertEqual(len(arms[0]['model']['features']), len(FEATURES))
        # Live-test: de bot meldt resultaten; een strategie die live verliest valt af
        other = arms[1]['key']
        s.add_arm_results([{'kind': 'arm', 'key': other, 'pct': -1.0, 'shadow': True} for _ in range(30)])
        self.assertEqual(s.load_search()['results'][other]['status'], 'afgevallen')
        self.assertNotIn(other, [a['key'] for a in s.load_arms()])
        # ... en een die live wint wordt bevestigd (als hij op het verleden ook winst gaf)
        cand = next((k for k, r in s.load_search()['results'].items() if r.get('score') and r['score'] > 0 and r['status'] != 'bevestigd'), None)
        if cand:
            s.add_arm_results([{'kind': 'arm', 'key': cand, 'pct': 0.8} for _ in range(20)])
            self.assertEqual(s.load_search()['results'][cand]['status'], 'bevestigd')

    def test_reward_weight(self):
        self.assertEqual(train.reward_weight(3, 3, 0, 45), 1.0)
        self.assertEqual(train.reward_weight(0.1, 3, 0, 45), 0.5)  # rond 0 geëindigd: leert minder
        self.assertEqual(train.reward_weight(9, 3, 0, 45), 2.0)  # grote winst/verlies: leert meer
        self.assertAlmostEqual(train.reward_weight(3, 3, 45, 45), 0.5)  # 45 dagen oud: half zo zwaar
        self.assertEqual(train.reward_weight(3, 3, 400, 45), 0.25)
        self.assertEqual(train.reward_weight(3, 3, 400, 0), 1.0)  # uit


class Feedback(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
        import server
        self.s = server
        server.write_json('feedback.json', [])
        server.write_json('config.json', {})

    def test_search_config_validation(self):
        cfg = self.s.validate_config({'search': {'enabled': True, 'timeframes': ['5m', '15m'], 'perRound': 4}})
        self.assertEqual(cfg['search'], {'enabled': True, 'timeframes': ['5m', '15m'], 'perRound': 4, 'pauseMinutes': 1, 'autoApply': False})
        with self.assertRaises(ValueError):
            self.s.validate_config({'search': {'timeframes': ['3m']}})
        with self.assertRaises(ValueError):
            self.s.validate_config({'search': {'perRound': 99}})
        info = self.s.search_info()
        self.assertIn('requiredEdge', info)
        self.assertGreater(info['possible'], 10)

    def test_teamwork_scoreboard(self):
        s = self.s
        s.write_json('config.json', {'timeframe': '5m', 'targetPct': 1.0, 'stopPct': 1.0, 'horizon': 12, 'costPct': 0.2})
        s.write_json('signals.json', [])
        s.write_json('model.json', {'meta': {'metrics': {'best': {'minProb': 0.6}}}})
        M = 300_000
        # Koers stijgt steeds 0,2% per candle: elk signaal haalt het doel
        c = [[k * M, 100 * 1.002 ** k, 100 * 1.002 ** k * 1.001, 100 * 1.002 ** k * 0.9995, 100 * 1.002 ** (k + 1), 10] for k in range(400)]
        os.makedirs(os.path.join(s.DATA, 'candles'), exist_ok=True)
        s.write_json('candles/X-EUR_5m.json', c)
        items = [{'kind': 'signal', 'pair': 'X/EUR', 'timeframe': '5m', 'ts': k * M, 'prob': 70 if k % 2 else 40,
                  'aiDecision': 'reject' if k % 3 else 'approve', 'features': {}, 'returnPct': 0} for k in range(100, 160)]
        items.append({'kind': 'signal', 'pair': 'X/EUR', 'timeframe': '5m', 'ts': 395 * M, 'prob': 50, 'aiDecision': 'approve'})  # nog bezig
        self.assertEqual(s.add_feedback(items), 0, 'signalen zijn geen trades')
        self.assertEqual(len(s.load_feedback()), 0)
        tw = s.compute_teamwork()
        self.assertEqual(tw['total'], 60)
        self.assertEqual(tw['pending'], 1)
        self.assertEqual(tw['rejected']['n'], 40)
        self.assertEqual(tw['rejected']['winRate'], 100.0)
        self.assertGreater(tw['rejected']['avgReturnPct'], 0)
        self.assertEqual(tw['modelYesAiNo']['n'] + tw['bothYes']['n'], 30)
        self.assertEqual(s.read_json('teamwork.json', {})['total'], 60)

    def test_store_dedupe_and_clean(self):
        t = {'pair': 'DOGE/EUR', 'timeframe': '5m', 'ts': 123, 'returnPct': 1.5, 'features': {'rsi14': 40, 'onzin': 5, 'adx14': 'x'}, 'prob': 61}
        self.assertEqual(self.s.add_feedback([t, dict(t), {'pair': 'X'}, 'rommel']), 1)
        self.assertEqual(self.s.add_feedback([t]), 0)  # al bekend
        rows = self.s.load_feedback()
        self.assertEqual(rows[0]['features'], {'rsi14': 40.0})
        info = self.s.feedback_info()
        self.assertEqual(info['total'], 1)
        self.assertEqual(info['byTimeframe']['5m']['winRate'], 100.0)


class Schedule(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
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


# ---------- Uitgebreidere beoordeling, modelregister, poortwachter, terugzetten, opnieuw trainen ----------

class TradeMetrics(unittest.TestCase):
    def test_profit_factor_sharpe_and_avg_win_loss(self):
        import agent
        m = agent.trade_metrics([2.0, -1.0, 3.0, -1.0])
        self.assertAlmostEqual(m['profitFactor'], 5.0 / 2.0)
        self.assertAlmostEqual(m['avgWinPct'], 2.5)
        self.assertAlmostEqual(m['avgLossPct'], -1.0)
        mean, sd = 0.75, float(np.std([2.0, -1.0, 3.0, -1.0], ddof=1))
        self.assertAlmostEqual(m['sharpe'], mean / sd, msg='per trade, niet op jaarbasis')
        self.assertAlmostEqual(m['netReturnPct'], (1.02 * 0.99 * 1.03 * 0.99 - 1) * 100, msg='samengesteld rendement')
        self.assertEqual((m['grossWinPct'], m['grossLossPct']), (5.0, 2.0))
        only_wins = agent.trade_metrics([1.0, 2.0])
        self.assertIsNone(only_wins['profitFactor'], 'geen verlies: geen winstfactor')
        self.assertIsNone(only_wins['avgLossPct'])
        self.assertIsNone(agent.trade_metrics([1.0])['sharpe'], 'minder dan 2 trades')
        self.assertIsNone(agent.trade_metrics([0.5, 0.5, 0.5])['sharpe'], 'standaardafwijking 0')
        empty = agent.trade_metrics([])
        self.assertEqual((empty['netReturnPct'], empty['profitFactor'], empty['sharpe'], empty['avgWinPct']), (0.0, None, None, None))

    def test_volatility_rule(self):
        import agent
        atr = [1.0] * 600
        self.assertEqual(agent.vol_regime(agent.vol_ratio(atr + [1.6], 600)), 'hoog')
        self.assertEqual(agent.vol_regime(agent.vol_ratio(atr + [0.6], 600)), 'laag')
        self.assertEqual(agent.vol_regime(agent.vol_ratio(atr + [1.5], 600)), 'normaal', 'precies 1,5 is nog normaal')
        self.assertEqual(agent.vol_regime(agent.vol_ratio(atr + [0.67], 600)), 'normaal')
        # Alleen de voorgaande 500 candles: wat daarvoor lag, telt niet.
        atr2 = [100.0] * 100 + [1.0] * 500 + [1.2]
        self.assertAlmostEqual(agent.vol_ratio(atr2, 600), 1.2)
        self.assertIsNone(agent.vol_ratio([1.0] * 99 + [2.0], 99), 'minder dan 100 voorgaande waarden: onbekend')
        self.assertAlmostEqual(agent.vol_ratio([1.0] * 100 + [2.0], 100), 2.0)
        self.assertIsNone(agent.vol_ratio([float('nan')] * 600 + [1.0], 600))
        self.assertIsNone(agent.vol_regime(None))

    def test_volatility_regime_does_not_use_future_candles(self):
        import agent
        c = market(1400, 11, momentum=0.3)
        mk = agent.Market('A/EUR', c, None)
        i = 900
        ratio, reg = agent.vol_ratio(agent._atr_series(mk), i), agent.entry_vol_regime(mk, i)
        self.assertIsNotNone(ratio)
        # De toekomst wild veranderen (enorme candles na het instapmoment) verandert niets aan instapmoment i.
        wild = [list(x) for x in c]
        for x in wild[i + 1:]:
            x[1:5] = [v * 1.2 for v in x[1:5]]
        for x in wild[1280:1301]:  # en vlak voor candle 1300 een paar heel onrustige candles
            x[2], x[3] = x[4] * 1.06, x[4] * 0.94
        mk2 = agent.Market('A/EUR', wild, None)
        self.assertEqual(agent.vol_ratio(agent._atr_series(mk2), i), ratio)
        self.assertEqual(agent.entry_vol_regime(mk2, i), reg)
        # Maar een later instapmoment ziet die drukte wel.
        self.assertEqual(agent.entry_vol_regime(mk2, 1300), 'hoog')

    def test_backtest_reports_new_metrics(self):
        import agent
        c = market(1500, 5, momentum=0.3)
        mk = agent.Market('A/EUR', c, None)
        oc = {800: (1.0, (2.0, 5, 'zelf verkocht')), 900: (1.0, (-1.0, 5, 'zelf verkocht')), 1000: (1.0, (3.0, 5, 'zelf verkocht'))}
        out = agent.backtest([mk], 2, None, None, None, None, 20, 0.0, 10, (0.0,), cache={('A/EUR', 2): (oc, 700, 1400)})[0.0]
        self.assertEqual(out['trades'], 3)
        self.assertAlmostEqual(out['profitFactor'], 5.0)
        self.assertAlmostEqual(out['avgWinPct'], 2.5)
        self.assertAlmostEqual(out['avgLossPct'], -1.0)
        self.assertAlmostEqual(out['netReturnPct'], (1.02 * 0.99 * 1.03 - 1) * 100)
        self.assertIsNotNone(out['sharpe'])
        self.assertTrue(set(out['byVolatility']) <= {'hoog', 'normaal', 'laag'})
        self.assertEqual(sum(x['trades'] for x in out['byVolatility'].values()), 3)
        for x in out['byVolatility'].values():
            self.assertEqual(set(x), {'trades', 'avgPct', 'winRate', 'profitFactor', 'edgePct'})
        # De oude velden blijven.
        for k in ('avgPct', 'totalPct', 'winRate', 'maxDrawdownPct', 'portfolio', 'byRegime', 'exits', 'byPair'):
            self.assertIn(k, out)

    def test_by_regime_has_win_rate_and_profit_factor(self):
        import agent
        by = agent._by_regime([{'reg': 'stijgend', 'ret': 2.0, 'mkt': 1.0}, {'reg': 'stijgend', 'ret': -1.0, 'mkt': None},
                               {'reg': 'dalend', 'ret': 1.0, 'mkt': 0.0}])
        self.assertEqual(by['stijgend']['trades'], 2)
        self.assertAlmostEqual(by['stijgend']['winRate'], 50.0)
        self.assertAlmostEqual(by['stijgend']['profitFactor'], 2.0)
        self.assertIsNone(by['dalend']['profitFactor'])
        self.assertAlmostEqual(by['stijgend']['edgePct'], 1.0)


class Registry(unittest.TestCase):
    def setUp(self):
        import registry
        self.R = registry
        self.dir = tempfile.mkdtemp()
        self.logs = []
        self.reg = registry.Registry(self.dir, log=self.logs.append)

    def rec(self, decision, key='15m|1|4|200|5'):
        return {'by': 'VPS', 'recipeKey': key, 'recipeText': 'tekst', 'dataset': {'pairs': ['A/EUR']}, 'features': ['rsi14'],
                'settings': {'timeframe': '15m'}, 'metrics': {'test': {'profitFactor': float('inf')}}, 'decision': decision,
                'reason': 'omdat', 'comparedTo': None}

    def test_versions_snapshots_and_summary(self):
        r1 = self.reg.record(self.rec('promoted'), snapshot={'recipeKey': 'A', 'entry': 1, 'exit': 2})
        r2 = self.reg.record(self.rec('rejected'))
        r3 = self.reg.record(self.rec('kept'))
        self.assertEqual([r1['version'], r2['version'], r3['version']], [1, 2, 3], 'oplopende versies')
        self.assertEqual(self.reg.active(), 1, 'alleen een gepubliceerde versie wordt de actieve')
        self.assertTrue(os.path.exists(os.path.join(self.dir, 'agents', 'versions', 'v1.json')))
        self.assertFalse(self.reg.has_snapshot(2))
        s = self.reg.summary(thresholds={'x': 1})
        self.assertEqual([v['version'] for v in s['versions']], [3, 2, 1], 'nieuwste eerst')
        self.assertEqual((s['active'], s['pinned'], s['sessions'], s['thresholds']), (1, None, 3, {'x': 1}))
        self.assertEqual(s['lastSession']['version'], 3)
        v1 = s['versions'][-1]
        self.assertTrue(v1['active'] and v1['hasSnapshot'])
        for k in ('version', 'at', 'by', 'recipeKey', 'recipeText', 'dataset', 'features', 'settings', 'metrics', 'decision', 'reason', 'comparedTo'):
            self.assertIn(k, v1)
        self.assertIsNone(v1['metrics']['test']['profitFactor'], 'geen oneindig in JSON')
        json.dumps(s, allow_nan=False)
        with self.assertRaises(ValueError):
            self.reg.record(self.rec('misschien'))

    def test_migration_from_old_schema_is_idempotent(self):
        import sqlite3
        f = os.path.join(self.dir, 'registry.db')
        db = sqlite3.connect(f)
        db.execute('CREATE TABLE schema_version (version INTEGER NOT NULL)')
        db.execute('INSERT INTO schema_version VALUES (1)')
        self.R._m1(db)
        db.execute("INSERT INTO sessions (version, at, by, recipe_key, recipe_text, decision, reason, body) "
                   "VALUES (1, '2026-01-01T00:00:00', 'VPS', 'k', 't', 'rejected', 'oud', '{}')")
        db.commit()
        db.close()
        self.assertEqual(self.reg.get(1)['reason'], 'oud', 'oude sessies blijven')
        self.assertEqual(self.reg.record(self.rec('kept'))['version'], 2)
        db = sqlite3.connect(f)
        self.assertEqual(self.R.schema_version(db), self.R.SCHEMA_VERSION)
        self.assertIn('has_snapshot', {r[1] for r in db.execute('PRAGMA table_info(sessions)')})
        self.assertIn('probation', {r[1] for r in db.execute('PRAGMA table_info(sessions)')}, 'proefperiode per versie')
        self.assertIsNone(self.reg.get(1)['probation'])
        self.assertEqual(self.R.migrate(db), self.R.SCHEMA_VERSION, 'nog een keer migreren doet niets')
        self.assertEqual(db.execute('SELECT COUNT(*) FROM schema_version').fetchone()[0], 1)
        db.close()

    def test_corrupt_database_is_set_aside(self):
        os.makedirs(os.path.join(self.dir, 'agents', 'versions'))
        with open(os.path.join(self.dir, 'agents', 'versions', 'v5.json'), 'w') as f:
            f.write('{"entry": 1, "exit": 2}')
        with open(os.path.join(self.dir, 'registry.db'), 'wb') as f:
            f.write(b'dit is geen database' * 100)
        r = self.reg.record(self.rec('promoted'), snapshot={'entry': 1, 'exit': 2, 'recipeKey': 'B'})
        self.assertEqual(r['version'], 6, 'een bestaande snapshot wordt nooit overschreven')
        self.assertTrue(any(n.startswith('registry.db.corrupt-') for n in os.listdir(self.dir)))
        self.assertTrue(any('onleesbaar' in x for x in self.logs))
        self.assertEqual(self.reg.read_snapshot(5), {'entry': 1, 'exit': 2})
        self.assertEqual(self.reg.summary()['sessions'], 1)

    def test_prune_rejected_never_promoted(self):
        from unittest import mock
        with mock.patch.object(self.R, 'MAX_SESSIONS', 5):
            self.reg.record(self.rec('promoted'), snapshot={'entry': 1, 'exit': 2})
            for _ in range(8):
                self.reg.record(self.rec('rejected'))
            self.reg.record(self.rec('rollback'))
        vs = self.reg.versions()
        self.assertLessEqual(len(vs), 6)
        self.assertIn(1, [v['version'] for v in vs], 'gepubliceerde versie blijft')
        self.assertIn('rollback', [v['decision'] for v in vs])
        self.assertTrue(self.reg.has_snapshot(1))
        self.assertEqual(self.reg.summary()['sessions'], 10, 'totaal aantal sessies telt alles')


RA = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
RB = {'timeframe': '30m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
RC = {'timeframe': '1h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
RD = {'timeframe': '2h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
RE = {'timeframe': '4h', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}


def RP(edge=0.2, dd=4.0, tdd=None, win=30.0, loss=12.0, trades=60, avg=0.3):
    """Rapport van een leerronde voor de poortwachter (terugval dd op de validatie, tdd in de eindtest).
    Score (ratio) = edge x trades / terugval op de validatie; winstfactor = win / loss."""
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


def datetime_iso(ts):
    from datetime import datetime
    return datetime.fromtimestamp(ts).isoformat(timespec='seconds')


class GateBase(unittest.TestCase):
    """Eigen DATA_DIR per test: het register en agent.json van andere tests tellen niet mee."""

    def setUp(self):
        from unittest import mock
        os.environ.setdefault('DATA_DIR', tempfile.mkdtemp())
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


class Baseline(GateBase):
    def test_existing_model_becomes_first_version(self):
        s = self.s
        # Een model dat al in gebruik was voordat het register bestond.
        a = {**fake_agent(RA, 'oud'), 'recipeKey': A_key(RA), 'stage': 'getest'}
        s.write_json('agent.json', a)
        rec = s.ensure_baseline()
        self.assertEqual(rec['decision'], 'promoted')
        self.assertTrue(rec['hasSnapshot'])
        reg = s.registry()
        self.assertEqual(reg.active(), rec['version'])
        self.assertEqual(reg.read_snapshot(rec['version'])['entry']['tag'], 'oud')
        self.assertIsNone(s.ensure_baseline(), 'maar één keer')
        # Het realistische portefeuille-rendement gaat mee naar het register (niet alleen het theoretische samengestelde).
        data = s.load_agents()
        data['recipes'][A_key(RA)] = {'key': A_key(RA), 'recipe': RA, 'rounds': [{'test': {'trades': 10, 'portfolio': {'returnPct': 4.2, 'taken': 8, 'skipped': 2}}}]}
        s.write_json('agents.json', data)
        v = s.registry_info()['versions'][0]
        self.assertEqual(v['metrics']['test']['portfolio']['returnPct'], 4.2)
        # Geblokkeerd of geen model: niets vastleggen.
        s2 = tempfile.mkdtemp()
        from unittest import mock
        with mock.patch.object(s, 'DATA', s2):
            s.write_json('agents.json', {'version': s.AGENTS_VERSION, 'recipes': {}, 'published': None, 'live': {}, 'round': 0})
            self.assertIsNone(s.ensure_baseline())
            s.write_json('agent.json', {**a, 'stage': 'geblokkeerd'})
            self.assertIsNone(s.ensure_baseline())


class PromotionGate(GateBase):
    def test_better_promoted_worse_kept_risky_replaced(self):
        s, k = self.s, A_key
        self.assertEqual(self.finish(RA, 'a1', RP())[0], 'promoted', 'eerste model')
        self.assertEqual(self.finish(RA, 'a2', RP())[0], 'promoted', 'hetzelfde recept, niet slechter: bijwerken')
        self.assertEqual(self.published(), (k(RA), 'a2'))
        # Iets beter (2,5%), en eerst maar één ronde getest: niet genoeg.
        self.assertEqual(self.finish(RB, 'b1', RP(edge=0.205))[0], 'rejected')
        d, why = self.finish(RB, 'b2', RP(edge=0.205))
        self.assertEqual(d, 'kept')
        self.assertIn('niet duidelijk hoger', why)
        # Veel betere score, maar een diepere terugval in de eindtest dan 1,25x die van het actieve model.
        self.finish(RC, 'c1', RP(edge=0.35, tdd=10))
        d, why = self.finish(RC, 'c2', RP(edge=0.35, tdd=10))
        self.assertEqual(d, 'kept')
        self.assertIn('terugval', why)
        # Betere score, maar een lagere winstfactor.
        self.finish(RD, 'd1', RP(edge=0.36, win=20))
        d, why = self.finish(RD, 'd2', RP(edge=0.36, win=20))
        self.assertEqual(d, 'kept')
        self.assertIn('winstfactor', why)
        self.assertEqual(self.published(), (k(RA), 'a2'), 'het actieve model bleef staan')
        # Aantoonbaar beter: pas na twee rondes gepubliceerd.
        self.assertNotEqual(self.finish(RE, 'e1', RP(edge=0.4))[0], 'promoted', 'eerst één ronde: nog geen bewijs')
        d, why = self.finish(RE, 'e2', RP(edge=0.4))
        self.assertEqual(d, 'promoted', why)
        self.assertIn('aantoonbaar beter', why)
        self.assertEqual(self.published(), (k(RE), 'e2'))
        self.assertEqual(s.load_agents()['published']['key'], k(RE))
        # Hetzelfde recept opnieuw, maar slechter: vorige versie blijft, ook het model in agents/.
        d, why = self.finish(RE, 'e3', RP(edge=0.1))
        self.assertEqual(d, 'kept', why)
        self.assertEqual(self.published(), (k(RE), 'e2'))
        self.assertEqual(s.read_json(s.agent_file(k(RE)), None)['entry']['tag'], 'e2')
        # Het actieve recept wordt te riskant: het beste bruikbare recept, zonder de eis (veiligheid).
        d, why = self.finish(RE, 'e4', RP(dd=30))
        self.assertEqual(d, 'promoted')
        self.assertIn('veiligheid', why)
        self.assertEqual(self.published(), (k(RD), 'd2'))
        # Alles staat in het register, met vergelijking ten opzichte van het actieve model.
        reg = s.registry().summary()
        self.assertEqual(reg['sessions'], 12)
        decisions = [v['decision'] for v in reversed(reg['versions'])]
        self.assertEqual(decisions.count('promoted'), 4, decisions)
        last = reg['versions'][0]
        self.assertEqual(reg['active'], last['version'])
        self.assertTrue(last['hasSnapshot'] and last['active'])
        self.assertTrue(os.path.exists(os.path.join(self.dir, 'agents', 'versions', f"v{last['version']}.json")))
        kept = next(v for v in reversed(reg['versions']) if v['decision'] == 'kept' and 'winstfactor' in v['reason'])
        self.assertEqual(kept['comparedTo']['recipeKey'], k(RA))
        self.assertIn('ratio', kept['comparedTo']['deltas'])
        self.assertEqual(kept['dataset']['testPeriod'], ['2026-01-01 00:00', '2026-01-10 00:00'])
        self.assertEqual(kept['settings']['timeframe'], '2h')
        self.assertIn('rsi14', kept['features'])
        self.assertIn('profitFactor', kept['metrics']['test'])
        json.dumps(reg, allow_nan=False)

    def test_thresholds_configurable(self):
        s = self.s
        cfg = s.validate_config({'agent': {'promoteMinGainPct': 0, 'promoteMinRounds': 1, 'retestHours': 2}})
        self.assertEqual((cfg['agent']['promoteMinGainPct'], cfg['agent']['promoteMinRounds'], cfg['agent']['retestHours']), (0.0, 1, 2.0))
        self.assertEqual(cfg['agent']['promoteMaxDdFactor'], 1.25)
        with self.assertRaises(ValueError):
            s.validate_config({'agent': {'promoteMaxDdFactor': 0.5}})
        s.write_json('config.json', {**s.read_json('config.json', {}), 'agent': {**cfg['agent'], 'timeframes': ['15m']}})
        self.finish(RA, 'a1', RP())
        d, why = self.finish(RB, 'b1', RP(edge=0.205))
        self.assertEqual(d, 'promoted', 'met 0% en 1 ronde is een beetje beter genoeg')

    def test_errors_never_break_publishing(self):
        from unittest import mock
        s = self.s

        class Broken:
            def __getattr__(self, name):
                def boom(*a, **k):
                    raise RuntimeError('kapot')
                return boom
        with mock.patch.object(s, 'registry', return_value=Broken()):
            d, _ = self.finish(RA, 'a1', RP())
        self.assertEqual(d, 'promoted', 'register kapot: toch gepubliceerd')
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.assertTrue(any('Modelregister' in m and 'mislukt' in m for m in self.logs))
        with mock.patch.object(s, 'recipe_metrics', side_effect=RuntimeError('rekenfout')):
            d, why = self.finish(RB, 'b1', RP(edge=0.4))
        self.assertEqual(d, 'kept', 'beoordelen mislukt: het actieve model blijft')
        self.assertEqual(self.published(), (A_key(RA), 'a1'))

    def test_write_json_is_atomic(self):
        from unittest import mock
        s = self.s
        s.write_json('agent.json', {'ok': 1})
        with mock.patch.object(s.json, 'dump', side_effect=RuntimeError('schijf vol')):
            with self.assertRaises(RuntimeError):
                s.write_json('agent.json', {'ok': 2})
        self.assertEqual(s.read_json('agent.json', None), {'ok': 1}, 'het oude bestand blijft heel')
        self.assertFalse([n for n in os.listdir(self.dir) if '.tmp' in n], 'geen tijdelijke bestanden achtergelaten')


class HttpGate(GateBase):
    """GateBase met een draaiende HTTP-server (de echte Handler)."""

    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), self.s.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.httpd.server_address[1]}'

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def req(self, method, p, body=None):
        h = {'Content-Type': 'application/json', 'Authorization': f'Bearer {self.s.token()}'}
        r = urllib.request.Request(self.base + p, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')


class Rollback(HttpGate):
    def test_rollback_pin_unpin_and_refuse_risky(self):
        self.finish(RA, 'a1', RP())
        self.finish(RA, 'a2', RP())
        self.finish(RB, 'b1', RP(edge=0.4))
        self.finish(RB, 'b2', RP(edge=0.4))
        code, reg = self.req('GET', '/registry')
        self.assertEqual(code, 200)
        self.assertEqual(set(reg), {'versions', 'active', 'pinned', 'sessions', 'lastSession', 'thresholds', 'cooldowns'})
        self.assertEqual([v['version'] for v in reg['versions']], [4, 3, 2, 1])
        self.assertEqual([v['decision'] for v in reg['versions']], ['promoted', 'rejected', 'promoted', 'promoted'])
        self.assertEqual([v['hasSnapshot'] for v in reg['versions']], [True, False, True, True])
        self.assertEqual((reg['active'], reg['pinned'], reg['sessions']), (4, None, 4))
        self.assertTrue(reg['versions'][0]['active'])
        self.assertEqual(reg['lastSession']['version'], 4)
        self.assertEqual(reg['thresholds']['promoteMinGainPct'], 5)
        self.assertEqual(self.published(), (A_key(RB), 'b2'))
        self.assertEqual(self.req('GET', '/registry', None)[0], 200)
        # Zonder snapshot of onbekend: niet terug te zetten.
        self.assertEqual(self.req('POST', '/registry/rollback', {'version': 3})[0], 400)
        self.assertEqual(self.req('POST', '/registry/rollback', {'version': 999})[0], 404)
        self.assertEqual(self.req('POST', '/registry/rollback', {})[0], 400)
        # Terug naar v1, en vastgezet.
        code, out = self.req('POST', '/registry/rollback', {'version': 1})
        self.assertEqual((code, out.get('pinned')), (200, 1), out)
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.assertEqual(self.s.load_agents()['published']['key'], A_key(RA))
        reg = self.req('GET', '/registry')[1]
        self.assertEqual((reg['active'], reg['pinned']), (1, 1))
        self.assertEqual(reg['versions'][0]['decision'], 'rollback')
        self.assertEqual(reg['versions'][0]['restoredVersion'], 1)
        self.assertTrue(next(v for v in reg['versions'] if v['version'] == 1)['active'])
        # Vastgezet: nieuwe sessies worden vastgelegd, maar er wordt niets gepubliceerd.
        self.finish(RC, 'c1', RP(edge=0.5))
        d, why = self.finish(RC, 'c2', RP(edge=0.5))
        self.assertEqual((d, why), ('kept', 'vastgezet op v1'))
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.assertEqual(self.req('GET', '/registry')[1]['versions'][0]['reason'], 'vastgezet op v1')
        # Losmaken: de poortwachter kiest weer (C is aantoonbaar beter dan A).
        code, out = self.req('POST', '/registry/unpin', {})
        self.assertEqual((code, out['pinned']), (200, None))
        self.assertEqual(self.finish(RC, 'c3', RP(edge=0.5))[0], 'promoted')
        self.assertEqual(self.published(), (A_key(RC), 'c3'))
        # Recept A wordt te riskant: v1 terugzetten wordt geweigerd.
        self.finish(RA, 'a3', RP(dd=30))
        code, out = self.req('POST', '/registry/rollback', {'version': 1})
        self.assertEqual(code, 400)
        self.assertIn('te riskant', out['error'])
        self.assertEqual(self.published(), (A_key(RC), 'c3'))
        self.assertIsNone(self.req('GET', '/registry')[1]['pinned'])

    def test_pinned_recipe_that_becomes_risky_is_released(self):
        self.finish(RA, 'a1', RP())
        self.finish(RB, 'b1', RP())
        self.assertEqual(self.req('POST', '/registry/rollback', {'version': 1})[0], 200)
        d, why = self.finish(RA, 'a2', RP(dd=30))
        self.assertEqual(d, 'promoted', why)
        self.assertEqual(self.published()[0], A_key(RB))
        self.assertIsNone(self.s.registry().pinned())


class RetestRule(GateBase):
    def test_too_fresh_is_skipped_and_waits_quietly(self):
        import agent_search as A
        s = self.s
        now = time.time()
        recipes = {}
        for r in A.all_recipes(['15m']):
            e = A.add_round(recipes, r, R(True, {'trades': 60, 'avgPct': 0.3, 'totalPct': 18, 'edgePct': 0.2, 'maxDrawdownPct': 4}))
            e['rounds'][-1]['ts'] = now - 3600
        rule = s.retest_rule(s.config(), trades=[])
        self.assertEqual(A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=rule), (None, 'te vers'))
        # Zonder regel (oude gedrag) zou hij gewoon een recept opnieuw doen.
        self.assertIsNotNone(A.pick(recipes, ['15m'], rnd=random.Random(1), now=now)[0])
        # Lang genoeg geleden: dat recept mag weer.
        old = A.all_recipes(['15m'])[5]
        recipes[A.key_of(old)]['rounds'][-1]['ts'] = now - 7 * 3600
        rec, why = A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=rule)
        self.assertEqual(A.key_of(rec), A.key_of(old))
        recipes[A.key_of(old)]['rounds'][-1]['ts'] = now - 3600
        # Genoeg nieuwe trades van de bot met een recept: ook dan mag het opnieuw.
        busy = A.all_recipes(['15m'])[9]
        rows = [{'recipe': A.key_of(busy), 'at': datetime_iso(now - 600), 'pct': 0.1}] * 20
        rec, _ = A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=s.retest_rule(s.config(), trades=rows))
        self.assertEqual(A.key_of(rec), A.key_of(busy))
        rec, _ = A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=s.retest_rule(s.config(), trades=rows[:19]))
        self.assertIsNone(rec, '19 trades is te weinig')
        old_rows = [{'recipe': A.key_of(busy), 'at': datetime_iso(now - 7200), 'pct': 0.1}] * 20
        rec, _ = A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=s.retest_rule(s.config(), trades=old_rows))
        self.assertIsNone(rec, 'trades van vóór de vorige test tellen niet')
        # Nieuwe recepten blijven mogelijk.
        new = A.all_recipes(['15m'])[3]
        del recipes[A.key_of(new)]
        rec, why = A.pick(recipes, ['15m'], rnd=random.Random(1), now=now, may_retest=rule)
        self.assertEqual(A.key_of(rec), A.key_of(new))
        e = A.add_round(recipes, new, R(True, {'trades': 60, 'avgPct': 0.3, 'totalPct': 18, 'edgePct': 0.2, 'maxDrawdownPct': 4}))
        e['rounds'][-1]['ts'] = now - 60
        # Via choose_recipe: niets gekozen, en maar één regel in de log, hoe vaak hij ook kijkt.
        s.state['agentWaiting'] = None
        cfg = s.config()
        data = {'recipes': recipes, 'round': 1}
        try:
            for _ in range(3):
                self.assertEqual(s.choose_recipe(cfg, data, 'VPS'), (None, 'te vers', None))
            self.assertEqual(sum('ik wacht' in m for m in self.logs), 1, self.logs)
            s.write_json('agents.json', {'version': s.AGENTS_VERSION, 'recipes': recipes, 'published': None, 'live': {}, 'round': 1})
            out = s.helper_claim({'name': 'h', 'protocol': s.HELPER_PROTOCOL})
            self.assertIsNone(out['job'])
            self.assertIn('nieuwe data', out['reason'])
        finally:
            s.state['agentWaiting'] = None
        # Een candle-tijd die langer is dan de wachttijd: wachten op een hele candle.
        rule1 = s.retest_rule({'agent': {'retestHours': 1, 'retestTrades': 20}}, trades=[])
        e4 = {'key': 'x', 'recipe': {'timeframe': '4h'}, 'rounds': [{'ts': now - 3 * 3600}]}
        self.assertFalse(rule1(e4, now))
        self.assertTrue(rule1(e4, now + 3600 + 1))


def RPS(avg=0.3, std=1.0, edge=0.2, trades=60, vol=None, **kw):
    """RP met de spreiding van de trade-rendementen (stdPct), zodat de statistische toets kan; met vol
    ook het resultaat per volatiliteit in de eindtest."""
    r = RP(edge=edge, trades=trades, avg=avg, **kw)
    for part in ('validation', 'test'):
        r[part] = {**r[part], 'stdPct': std}
    if vol is not None:
        r['test']['byVolatility'] = vol
    return r


def AT(recipe, pct, mode='paper', explore=False, virtual=False, offset=60):
    """Een gesloten trade van de AI-trader zoals de bot hem terugstuurt (na het promotiemoment)."""
    t0 = time.time() + offset
    return {'kind': 'agentTrade', 'timeframe': recipe['timeframe'], 'recipe': A_key(recipe), 'pct': pct, 'mode': mode,
            'explore': explore, 'virtual': virtual, 'openedAt': datetime_iso(t0), 'closedAt': datetime_iso(t0 + 600)}


def trades_around(recipe, mean, n=30, spread=0.05, **kw):
    return [AT(recipe, mean + (spread if i % 2 else -spread), offset=60 + i, **kw) for i in range(n)]


class Probation(GateBase):
    """Proefperiode na een promotie: geslaagd, mislukt (terugzetten, melding, afkoeling), te weinig
    trades, vastgezet en geen vorige versie."""

    def promote_two(self):
        # v1, v2: recept A (de proef van v1 loopt door in v2), v3: B één ronde, v4: B gepromoot (op proef).
        self.finish(RA, 'a1', RP())
        self.finish(RA, 'a2', RP())
        self.finish(RB, 'b1', RP(edge=0.4))
        d, why = self.finish(RB, 'b2', RP(edge=0.4))
        self.assertEqual(d, 'promoted', why)
        reg = self.s.registry()
        self.assertEqual(reg.active(), 4)
        return reg

    def test_new_version_is_on_probation_and_same_recipe_continues(self):
        reg = self.promote_two()
        p4 = reg.get(4)['probation']
        self.assertEqual(p4['status'], 'proef')
        self.assertEqual((p4['startVersion'], p4['recipeKey'], p4['trades']), (4, A_key(RB), 0))
        self.assertAlmostEqual(p4['expectedPct'], 0.3)
        for k in ('status', 'trades', 'avgPct', 'expectedPct', 'upperPct', 'since', 'decidedAt', 'reason'):
            self.assertIn(k, p4)
        self.assertIsNone(reg.get(1)['probation']['status'], 'de proef van v1 liep door in v2')
        self.assertEqual(reg.get(2)['probation']['startVersion'], 1)
        self.assertIn('vervangen door v4', reg.get(2)['probation']['reason'])

    def test_passed(self):
        reg = self.promote_two()
        self.s.add_agent_trades(trades_around(RB, 0.2))
        p = reg.get(4)['probation']
        self.assertEqual(p['status'], 'geslaagd', p)
        self.assertEqual(p['trades'], 30)
        self.assertAlmostEqual(p['avgPct'], 0.2)
        self.assertIsNotNone(p['decidedAt'])
        self.assertEqual(reg.active(), 4)
        self.assertNotIn('notice', self.s.read_json('agent.json', {}))

    def test_failed_rolls_back_with_notice_and_cooldown(self):
        s = self.s
        reg = self.promote_two()
        # Verkenner, virtuele trades en trades van andere recepten tellen niet mee.
        s.add_agent_trades([AT(RB, -5, explore=True), AT(RB, -5, virtual=True), AT(RA, -5)] + trades_around(RB, -0.3, n=29))
        self.assertEqual(reg.get(4)['probation']['status'], 'proef', '29 echte trades: nog niet')
        self.assertEqual(reg.get(4)['probation']['trades'], 29)
        s.add_agent_trades([AT(RB, -0.3, offset=200)])
        p = reg.get(4)['probation']
        self.assertEqual(p['status'], 'mislukt', p)
        self.assertLess(p['upperPct'], p['expectedPct'])
        self.assertEqual(p['restoredVersion'], 2)
        self.assertEqual((reg.active(), reg.pinned()), (2, None), 'teruggezet naar de vorige versie, niet vastgezet')
        self.assertEqual(self.published(), (A_key(RA), 'a2'))
        self.assertEqual(s.load_agents()['published']['key'], A_key(RA))
        last = reg.versions(1)[0]
        self.assertEqual((last['decision'], last['restoredVersion'], last['failedVersion']), ('rollback', 2, 4))
        self.assertTrue(last['reason'].startswith('proefperiode mislukt: '), last['reason'])
        note = s.read_json('agent.json', {})['notice']
        self.assertEqual((note['kind'], note['version'], note['restoredVersion']), ('probation-failed', 4, 2))
        self.assertTrue(note['reason'].startswith('proefperiode mislukt') and note['at'])
        self.assertNotIn('notice', reg.read_snapshot(2), 'de snapshot zelf blijft schoon')
        # Afkoelperiode: recept B wordt (ook als het beste) niet meteen weer gepromoot.
        self.assertIn(A_key(RB), s.active_cooldowns(reg))
        d, why = self.finish(RB, 'b3', RP(edge=0.4))
        self.assertEqual(d, 'kept', why)
        self.assertIn('afkoelperiode', why)
        self.assertEqual(self.published(), (A_key(RA), 'a2'))
        self.assertEqual(s.read_json('agent.json', {})['notice']['version'], 4, 'de melding blijft staan')
        # Na de afkoelperiode mag het weer.
        reg.set_meta('cooldowns', {A_key(RB): '2000-01-01T00:00:00'})
        self.assertEqual(s.active_cooldowns(reg), {})
        self.assertEqual(self.finish(RB, 'b4', RP(edge=0.4))[0], 'promoted')

    def test_bad_luck_is_not_failure(self):
        import probation
        # Gemiddeld iets verlies, maar zo'n grote spreiding dat het pech kan zijn.
        pcts = [-0.05 + (3 if i % 2 else -3) for i in range(30)]
        ev = probation.evaluate(pcts, 0.3, 30, 0.9, time.time(), time.time())
        self.assertEqual(ev['status'], 'geslaagd', ev)
        self.assertGreater(ev['upperPct'], 0.3)
        self.assertIn('pech', ev['reason'])
        bad = probation.evaluate([-0.3] * 15 + [-0.2] * 15, 0.3, 30, 0.9, time.time(), time.time())
        self.assertEqual(bad['status'], 'mislukt')
        self.assertIn('−0,25%', bad['reason'])

    def test_too_few_trades_does_nothing(self):
        s = self.s
        reg = self.promote_two()
        s.add_agent_trades(trades_around(RB, -1.0, n=10))
        p = reg.get(4)['probation']
        self.assertEqual((p['status'], p['trades']), ('proef', 10))
        self.assertIn('10 van 30', p['reason'])
        self.assertEqual(reg.active(), 4)
        # Na veertien dagen nog te weinig: de proef loopt door, met uitleg, zonder actie.
        with s.publish_lock:
            p = s._check_probation(now=time.time() + 15 * 86400)
        self.assertEqual(p['status'], 'proef')
        self.assertIn('na 15 dagen', p['reason'])
        self.assertEqual(reg.get(4)['probation']['reason'], p['reason'])
        self.assertEqual(reg.active(), 4)
        self.assertNotIn('notice', s.read_json('agent.json', {}))

    def test_pinned_is_not_rolled_back(self):
        s = self.s
        reg = self.promote_two()
        reg.set_pinned(4)
        s.add_agent_trades(trades_around(RB, -0.3))
        p = reg.get(4)['probation']
        self.assertEqual(p['status'], 'mislukt')
        self.assertIn('vastgezet', p['reason'])
        self.assertEqual((reg.active(), reg.pinned()), (4, 4))
        self.assertEqual(self.published()[0], A_key(RB))
        self.assertNotIn('notice', s.read_json('agent.json', {}))
        self.assertNotEqual(reg.versions(1)[0]['decision'], 'rollback')

    def test_no_previous_version_keeps_model(self):
        s = self.s
        self.finish(RA, 'a1', RP())
        reg = s.registry()
        s.add_agent_trades(trades_around(RA, -0.3))
        p = reg.get(1)['probation']
        self.assertEqual(p['status'], 'mislukt')
        self.assertIn('geen eerdere bruikbare versie', p['reason'])
        self.assertEqual(reg.active(), 1)
        self.assertEqual(self.published(), (A_key(RA), 'a1'))
        self.assertNotIn('notice', s.read_json('agent.json', {}))
        # Daarna niets meer: de proef is beslist.
        s.add_agent_trades(trades_around(RA, -0.3, n=5))
        self.assertEqual(reg.get(1)['probation']['trades'], 30)

    def test_errors_never_break_feedback_or_rounds(self):
        from unittest import mock
        s = self.s
        self.promote_two()
        with mock.patch.object(s.probation_mod, 'evaluate', side_effect=RuntimeError('kapot')):
            self.assertEqual(s.add_agent_trades(trades_around(RB, -0.3)), 30)
            self.assertEqual(self.finish(RB, 'b3', RP(edge=0.4))[0], 'promoted')
        self.assertTrue(any('proefperiode' in m and 'mislukt' in m for m in self.logs))

    def test_config_keys(self):
        s = self.s
        th = s.promote_thresholds()
        self.assertEqual((th['promoteConfidence'], th['probationTrades'], th['probationConfidence'], th['probationCooldownHours']),
                         (0.95, 30, 0.9, 72))
        cfg = s.validate_config({'agent': {'probationTrades': 12, 'promoteConfidence': 0.9, 'probationCooldownHours': 24}})
        self.assertEqual((cfg['agent']['probationTrades'], cfg['agent']['promoteConfidence'], cfg['agent']['probationCooldownHours']),
                         (12, 0.9, 24.0))
        for bad in ({'probationTrades': 1}, {'promoteConfidence': 1.5}, {'probationConfidence': 0.1}, {'probationCooldownHours': -1}):
            with self.assertRaises(ValueError):
                s.validate_config({'agent': bad})


class StatGate(GateBase):
    """De statistische promotietoets op de eindtests."""

    def M(self, mean, std=1.0, n=300, order=2, ratio=10.0):
        return {'status': 'veelbelovend', 'order': order, 'ratio': ratio, 'tested': 2, 'testAvg': mean, 'testDrawdown': 4.0,
                'testProfitFactor': 2.0, 'testMean': mean, 'testStd': std, 'testTrades': n}

    def test_clearly_better_noise_and_selection_correction(self):
        s = self.s
        th = s.promote_thresholds()
        ok, why = s.promotion_gate(self.M(0.5), self.M(0.1), th)
        self.assertTrue(ok, why)
        self.assertIn('met 95% zekerheid beter: +0,40% per trade (ondergrens +0,', why)
        # Ruis: een klein verschil bij deze spreiding is niet genoeg, ook al is de score veel hoger.
        ok, why = s.promotion_gate(self.M(0.15, ratio=50), self.M(0.1), th)
        self.assertFalse(ok)
        self.assertTrue(why.startswith('niet zeker genoeg beter: ondergrens −0,'), why)
        # Selectiecorrectie: met één recept net genoeg, met honderd geteste recepten niet meer.
        self.assertTrue(s.promotion_gate(self.M(0.3), self.M(0.1), th, candidates=1)[0])
        ok, why = s.promotion_gate(self.M(0.3), self.M(0.1), th, candidates=100)
        self.assertFalse(ok)
        self.assertIn('gecorrigeerd voor 100 geteste recepten', why)
        # De bestaande eisen blijven: terugval en winstfactor.
        ok, why = s.promotion_gate({**self.M(0.5), 'testDrawdown': 10.0}, self.M(0.1), th)
        self.assertFalse(ok)
        self.assertIn('terugval', why)
        ok, why = s.promotion_gate({**self.M(0.5), 'testProfitFactor': 1.0}, self.M(0.1), th)
        self.assertFalse(ok)
        self.assertIn('winstfactor', why)
        # Strenger instellen kan.
        self.assertFalse(s.promotion_gate(self.M(0.3), self.M(0.1), {**th, 'promoteConfidence': 0.999})[0])

    def test_old_rounds_without_spread_fall_back_to_score(self):
        s = self.s
        th = s.promote_thresholds()
        old = {**self.M(0.1), 'testStd': None, 'testTrades': None}
        ok, why = s.promotion_gate(self.M(0.15, ratio=10.2), old, th)
        self.assertFalse(ok)
        self.assertIn('niet duidelijk hoger', why, 'terugval op de score-eis')
        ok, why = s.promotion_gate(self.M(0.15, ratio=20), old, th)
        self.assertTrue(ok, why)
        self.assertNotIn('zekerheid', why)

    def test_spread_from_stored_std_or_sharpe(self):
        import agent_search as A
        e = {'rounds': [{'test': {'trades': 10, 'avgPct': 0.3, 'stdPct': 1.0}}, {'test': {'trades': 30, 'avgPct': 0.1, 'stdPct': 2.0}}]}
        mean, sd, n = A.test_stats(e)
        both = [0.3 + (1.0 if i % 2 else -1.0) * math.sqrt(9 / 10) for i in range(10)] + \
               [0.1 + (2.0 if i % 2 else -2.0) * math.sqrt(29 / 30) for i in range(30)]
        self.assertEqual(n, 40)
        self.assertAlmostEqual(mean, float(np.mean(both)))
        self.assertAlmostEqual(sd, float(np.std(both, ddof=1)))
        # Oude ronde zonder stdPct maar met sharpe: std = gemiddelde / sharpe.
        old = {'rounds': [{'test': {'trades': 20, 'avgPct': 0.3, 'sharpe': 0.5, 'stdPct': None}}]}
        self.assertAlmostEqual(A.test_stats(old)[1], 0.6)
        self.assertIsNone(A.test_stats({'rounds': [{'test': {'trades': 20, 'avgPct': 0.3, 'sharpe': None}}]}))
        import agent
        self.assertAlmostEqual(agent.trade_metrics([2.0, -1.0, 3.0, -1.0])['stdPct'], float(np.std([2.0, -1.0, 3.0, -1.0], ddof=1)))
        self.assertIn('stdPct', A.PART_FIELDS)

    def test_t_quantile(self):
        import stats
        for df, p, want in ((5, 0.95, 2.015), (29, 0.9, 1.3114), (100, 0.95, 1.6602), (2, 0.95, 2.92), (1e9, 0.95, 1.6449)):
            self.assertAlmostEqual(stats.t_quantile(p, df), want, places=3)

    def test_in_a_round(self):
        s = self.s
        self.finish(RA, 'a1', RPS(avg=0.3))
        # Veel hogere score (edge), maar per trade in de eindtest nauwelijks beter: niet promoveren.
        self.finish(RB, 'b1', RPS(avg=0.31, edge=0.4))
        d, why = self.finish(RB, 'b2', RPS(avg=0.31, edge=0.4))
        self.assertEqual(d, 'kept', why)
        self.assertIn('niet zeker genoeg beter', why)
        self.finish(RC, 'c1', RPS(avg=1.0, edge=0.5))
        d, why = self.finish(RC, 'c2', RPS(avg=1.0, edge=0.5))
        self.assertEqual(d, 'promoted', why)
        self.assertIn('aantoonbaar beter (met 95% zekerheid beter', why)
        self.assertIn('gecorrigeerd voor 3 geteste recepten', why)
        rec = s.registry().versions(1)[0]
        self.assertEqual(rec['reason'][:len(agent_text(RC))], agent_text(RC))
        self.assertAlmostEqual(rec['metrics']['test']['stdPct'], 1.0)


def agent_text(r):
    import agent
    return agent.recipe_text({**agent.RECIPE_DEFAULT, **r})


VOL = {'hoog': {'trades': 10, 'avgPct': -0.5, 'winRate': 30, 'profitFactor': 0.5, 'edgePct': -0.6},
       'normaal': {'trades': 40, 'avgPct': 0.4, 'winRate': 60, 'profitFactor': 2.0, 'edgePct': 0.3},
       'laag': {'trades': 10, 'avgPct': 0.2, 'winRate': 50, 'profitFactor': 1.5, 'edgePct': None}}
VOL2 = {'hoog': {'trades': 30, 'avgPct': 0.1, 'winRate': 50, 'profitFactor': 1.2, 'edgePct': 0.0},
        'normaal': {'trades': 30, 'avgPct': 0.2, 'winRate': 55, 'profitFactor': 1.5, 'edgePct': 0.1}}


class VolStatsAndPractice(HttpGate):
    def test_vol_stats_summed_over_test_rounds(self):
        import agent_search as A
        e = {'rounds': [{'test': {'byVolatility': VOL}}, {'test': {'byVolatility': VOL2}}, {'test': None}]}
        v = A.vol_stats(e)
        self.assertEqual(set(v), {'hoog', 'normaal', 'laag'})
        self.assertEqual(v['hoog']['trades'], 40)
        self.assertAlmostEqual(v['hoog']['avgPct'], (10 * -0.5 + 30 * 0.1) / 40)
        self.assertAlmostEqual(v['hoog']['edgePct'], (10 * -0.6 + 30 * 0.0) / 40)
        self.assertAlmostEqual(v['normaal']['avgPct'], (40 * 0.4 + 30 * 0.2) / 70)
        self.assertEqual(v['laag']['trades'], 10)
        self.assertNotIn('edgePct', v['laag'], 'geen marktbeweging bekend: geen voordeel')
        self.assertEqual(A.vol_stats({'rounds': []})['hoog'], {'trades': 0, 'avgPct': None})

    def test_vol_stats_in_every_part_of_agent_json(self):
        s = self.s
        self.finish(RA, 'a1', RPS(vol=VOL))
        self.finish(RA, 'a2', RPS(vol=VOL2))
        a = s.read_json('agent.json', None)
        self.assertEqual(a['volStats']['hoog']['trades'], 40)
        self.assertAlmostEqual(a['volStats']['normaal']['avgPct'], (40 * 0.4 + 30 * 0.2) / 70)
        # Extra recepten (recipe_part), het plan per marktfase en recepten die de eigenaar live hield.
        self.finish(RB, 'b1', RPS(vol=VOL))
        data = s.load_agents()
        part = s.recipe_part(A_key(RB), data['recipes'][A_key(RB)], fake_agent(RB, 'b1'), data)
        self.assertEqual(part['volStats']['hoog']['avgPct'], -0.5)
        kept = s.add_kept({'recipeKey': A_key(RA), 'regimes': {}, 'extras': []}, [A_key(RB)], data)
        self.assertEqual(kept['extras'][-1]['volStats']['normaal']['trades'], 40)
        board = [data['recipes'][A_key(RA)], data['recipes'][A_key(RB)]]
        from unittest import mock
        with mock.patch.object(s.agent_search, 'choose_per_regime',
                               return_value={'stijgend': {'key': A_key(RB), 'why': 'best', 'edge': 0.3, 'trades': 40}}):
            plan = s.regime_plan(board, data['recipes'][A_key(RA)], data)
        self.assertEqual(plan['stijgend']['agent']['volStats']['laag']['trades'], 10)
        # GET /agent.json werkt het bij, ook voor ?keep=.
        a = s.read_json('agent.json', None)
        a.pop('volStats')
        s.write_json('agent.json', a)
        code, got = self.req('GET', f'/agent.json?keep={A_key(RB)}')
        self.assertEqual(code, 200)
        self.assertEqual(got['volStats']['hoog']['trades'], 40)
        self.assertEqual(next(x for x in got['extras'] if x['recipeKey'] == A_key(RB))['volStats']['hoog']['trades'], 10)

    def test_practice_per_version(self):
        import probation
        s = self.s
        reg = s.registry()
        snap = lambda r, tag: {**fake_agent(r, tag), 'recipeKey': A_key(r)}
        base = {'by': 'VPS', 'recipeText': 't', 'metrics': {}, 'comparedTo': None}
        reg.record({**base, 'at': '2026-01-01T00:00:00', 'recipeKey': A_key(RA), 'publishedKey': A_key(RA), 'decision': 'promoted',
                    'reason': 'x', 'expectedPct': 0.3}, snapshot=snap(RA, 'a1'))
        reg.record({**base, 'at': '2026-01-05T00:00:00', 'recipeKey': A_key(RC), 'decision': 'rejected', 'reason': 'x'})
        reg.record({**base, 'at': '2026-01-10T00:00:00', 'recipeKey': A_key(RB), 'publishedKey': A_key(RB), 'decision': 'promoted',
                    'reason': 'x', 'expectedPct': 0.2}, snapshot=snap(RB, 'b1'))
        reg.record({**base, 'at': '2026-01-20T00:00:00', 'recipeKey': A_key(RA), 'publishedKey': A_key(RA), 'decision': 'rollback',
                    'reason': 'x', 'restoredVersion': 1})
        reg.set_active(1)

        def t(r, day, pct, mode='paper', **kw):
            return {'recipe': A_key(r), 'pct': pct, 'mode': mode, 'openedAt': f'2026-01-{day:02d}T12:00:00',
                    'closedAt': f'2026-01-{day:02d}T13:00:00', **kw}
        rows = [t(RA, 2, 1.0), t(RA, 3, -0.5, 'live'), t(RA, 4, 0.5, explore=True), t(RA, 4, 0.5, virtual=True),
                t(RA, 12, 9.0),                         # recept A terwijl v3 (B) actief was: hoort niet bij v1
                t(RB, 11, 0.4), t(RB, 12, -0.1, 'live'), t(RB, 21, 5.0),  # de laatste is na het terugzetten
                t(RA, 22, 2.0, 'live')]                # v1 weer actief na het terugzetten
        s.write_json('agent_trades.json', rows)
        code, out = self.req('GET', '/registry')
        self.assertEqual(code, 200)
        by = {v['version']: v for v in out['versions']}
        self.assertNotIn('practice', by[2], 'alleen gepromote en de actieve versie')
        self.assertNotIn('practice', by[4])
        p1, p3 = by[1]['practice'], by[3]['practice']
        self.assertEqual((p1['trades'], p1['sumPct'], p1['expectedPct']), (3, 2.5, 0.3))
        self.assertAlmostEqual(p1['avgPct'], 2.5 / 3)
        self.assertEqual(p1['byMode']['paper'], {'trades': 1, 'avgPct': 1.0})
        self.assertEqual(p1['byMode']['live']['trades'], 2)
        self.assertAlmostEqual(p1['byMode']['live']['avgPct'], 0.75)
        self.assertEqual([x['cumPct'] for x in p1['series']], [1.0, 0.5, 2.5])
        self.assertEqual([x['mode'] for x in p1['series']], ['paper', 'live', 'live'])
        self.assertEqual(p1['series'][0]['at'], '2026-01-02T13:00:00')
        self.assertEqual((p3['trades'], p3['expectedPct']), (2, 0.2))
        self.assertAlmostEqual(p3['sumPct'], 0.3)
        self.assertEqual(p3['byMode']['live'], {'trades': 1, 'avgPct': -0.1})
        json.dumps(out, allow_nan=False)
        # Duizenden trades: hooguit 300 punten, eerste en laatste blijven, het eindtotaal klopt.
        many = [t(RA, 2, 0.01 * (i % 7 - 3)) for i in range(5000)]
        pr = probation.practice(probation.real_trades(many), [(0, None, A_key(RA))])
        self.assertEqual(len(pr['series']), 300)
        self.assertEqual(pr['trades'], 5000)
        self.assertAlmostEqual(pr['series'][-1]['cumPct'], pr['sumPct'], places=3)
        self.assertAlmostEqual(pr['series'][0]['cumPct'], -0.03)


# ---------- Audit van de statistiek, de proefperiode en het terugzetten ----------

# Tabelwaarden van de t-verdeling (eenzijdig kwantiel p, df vrijheidsgraden), uit de gangbare
# statistiektabellen, afgerond op 3 decimalen.
T_TABLE = {
    1: (3.078, 6.314, 12.706, 31.821, 318.309), 2: (1.886, 2.920, 4.303, 6.965, 22.327),
    3: (1.638, 2.353, 3.182, 4.541, 10.215), 4: (1.533, 2.132, 2.776, 3.747, 7.173),
    5: (1.476, 2.015, 2.571, 3.365, 5.893), 6: (1.440, 1.943, 2.447, 3.143, 5.208),
    7: (1.415, 1.895, 2.365, 2.998, 4.785), 8: (1.397, 1.860, 2.306, 2.896, 4.501),
    9: (1.383, 1.833, 2.262, 2.821, 4.297), 10: (1.372, 1.812, 2.228, 2.764, 4.144),
    11: (1.363, 1.796, 2.201, 2.718, 4.025), 12: (1.356, 1.782, 2.179, 2.681, 3.930),
    13: (1.350, 1.771, 2.160, 2.650, 3.852), 14: (1.345, 1.761, 2.145, 2.624, 3.787),
    15: (1.341, 1.753, 2.131, 2.602, 3.733), 16: (1.337, 1.746, 2.120, 2.583, 3.686),
    17: (1.333, 1.740, 2.110, 2.567, 3.646), 18: (1.330, 1.734, 2.101, 2.552, 3.610),
    19: (1.328, 1.729, 2.093, 2.539, 3.579), 20: (1.325, 1.725, 2.086, 2.528, 3.552),
    21: (1.323, 1.721, 2.080, 2.518, 3.527), 22: (1.321, 1.717, 2.074, 2.508, 3.505),
    23: (1.319, 1.714, 2.069, 2.500, 3.485), 24: (1.318, 1.711, 2.064, 2.492, 3.467),
    25: (1.316, 1.708, 2.060, 2.485, 3.450), 26: (1.315, 1.706, 2.056, 2.479, 3.435),
    27: (1.314, 1.703, 2.052, 2.473, 3.421), 28: (1.313, 1.701, 2.048, 2.467, 3.408),
    29: (1.311, 1.699, 2.045, 2.462, 3.396), 30: (1.310, 1.697, 2.042, 2.457, 3.385),
    60: (1.296, 1.671, 2.000, 2.390, 3.232), 120: (1.289, 1.658, 1.980, 2.358, 3.160),
    float('inf'): (1.282, 1.645, 1.960, 2.326, 3.090)}
T_PS = (0.9, 0.95, 0.975, 0.99, 0.999)


def _t_tail(t, df, steps=40000):
    """P(T > t) door numeriek integreren van de dichtheid (Simpson, na x = t / u zodat de staart
    eindig wordt): een onafhankelijke controle, zonder de formules van stats.py."""
    c = math.exp(math.lgamma((df + 1) / 2) - math.lgamma(df / 2)) / math.sqrt(df * math.pi)
    u = np.linspace(1e-12, 1.0, steps + 1)
    x = t / u
    f = c * (1 + x * x / df) ** (-(df + 1) / 2) * t / (u * u)
    w = np.ones(steps + 1)
    w[1:-1:2], w[2:-1:2] = 4, 2
    return float((f * w).sum() * (1.0 / steps) / 3)


class AuditStats(unittest.TestCase):
    """Rekenwerk van stats.py tegen tabellen en een onafhankelijke berekening."""

    def test_t_quantile_against_tables(self):
        import stats
        for df, row in T_TABLE.items():
            for p, want in zip(T_PS, row):
                got = stats.t_quantile(p, df)
                self.assertLess(abs(got - want), 0.0006 + want * 1e-5, f'df={df} p={p}: {got} in plaats van {want}')
                self.assertAlmostEqual(stats.t_quantile(1 - p, df), -got, places=6, msg='symmetrisch')

    def test_t_quantile_at_bonferroni_levels(self):
        import stats
        # 1 - 0,05/k voor k = 50 en 200 geteste recepten, en een nog strengere: de staartkans van het
        # kwantiel moet kloppen (hooguit 1% ernaast), ook bij weinig vrijheidsgraden en niet-gehele df.
        for p in (1 - 0.05 / 50, 1 - 0.05 / 200, 0.9999):
            for df in list(range(3, 31)) + [2.5, 3.7, 7.3, 60, 120, 1000]:
                tail = _t_tail(stats.t_quantile(p, df), df)
                self.assertLess(abs(tail - (1 - p)) / (1 - p), 0.01, f'df={df} p={p}: staart {tail}')
        self.assertAlmostEqual(stats.t_quantile(0.999, None), 3.0902, places=4)
        self.assertAlmostEqual(stats.t_quantile(0.999, float('nan')), 3.0902, places=4)
        self.assertAlmostEqual(stats.t_quantile(0.5, 4), 0.0, places=9)

    def test_welch_and_pooled(self):
        import stats
        rnd = np.random.default_rng(1)
        a, b = rnd.normal(0.5, 1.0, 10), rnd.normal(0.1, 2.0, 30)
        diff, lower, df = stats.welch_lower((a.mean(), a.std(ddof=1), 10), (b.mean(), b.std(ddof=1), 30), 0.95)
        v1, v2 = a.var(ddof=1) / 10, b.var(ddof=1) / 30
        self.assertAlmostEqual(df, (v1 + v2) ** 2 / (v1 ** 2 / 9 + v2 ** 2 / 29))
        self.assertAlmostEqual(lower, diff - stats.t_quantile(0.95, df) * math.sqrt(v1 + v2))
        # Samenvoegen: gelijk aan alle trades achter elkaar, ook met verschil tussen de rondes.
        parts = [rnd.normal(m, s, n) for m, s, n in ((0.3, 1.0, 12), (-0.4, 0.5, 7), (1.0, 2.0, 1), (0.0, 1.5, 40))]
        rows = [(len(x), float(x.mean()), float(x.std(ddof=1)) if len(x) > 1 else 0.0) for x in parts]
        mean, sd, n = stats.pooled(rows)
        allx = np.concatenate(parts)
        self.assertEqual(n, 60)
        self.assertAlmostEqual(mean, float(allx.mean()))
        self.assertAlmostEqual(sd, float(allx.std(ddof=1)))
        # Randgevallen: niets, één trade, onbekende of kapotte spreiding.
        self.assertIsNone(stats.pooled([]))
        self.assertIsNone(stats.pooled([(1, 0.5, 0.0)]))
        self.assertIsNone(stats.pooled([(0, 0.5, 1.0)]))
        for bad in (None, float('nan'), float('inf')):
            self.assertIsNone(stats.pooled([(10, 0.5, 1.0), (10, 0.5, bad)]))
        self.assertEqual(stats.pooled([(0, 9.9, None), (5, 0.5, 1.0)])[2], 5, 'lege ronde telt niet mee')
        self.assertEqual(stats.mean_upper([], 0.9), (None, None, None))
        self.assertEqual(stats.mean_upper([0.4], 0.9), (0.4, None, None))

    def test_effective_trades_per_unique_period(self):
        import stats
        d = 86400.0
        same = [(60, 0, 9 * d)] * 6
        self.assertAlmostEqual(stats.effective_trades(same), 60, msg='zes keer dezelfde periode: 60 trades, niet 360')
        self.assertAlmostEqual(stats.effective_trades([(60, 0, 9 * d), (60, 9 * d, 18 * d)]), 120, msg='los van elkaar: optellen')
        self.assertAlmostEqual(stats.effective_trades([(60, 0, 10 * d), (60, 5 * d, 15 * d)]), 90, msg='half overlappend')
        self.assertAlmostEqual(stats.effective_trades([(60, 0, 9 * d), (30, None, None)]), 90, msg='onbekende periode: los geteld')
        self.assertEqual(stats.effective_trades([]), 0)
        self.assertLessEqual(stats.effective_trades([(10, 0, 9 * d), (100, 0, 1 * d)]), 110)


def _sim_round(trades, start_h, days=9.0):
    """Een eindtest-ronde zoals add_round hem bewaart, met een eindtest vanaf start_h uur."""
    from datetime import datetime, timedelta, timezone
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=start_h)
    fmt = lambda t: t.strftime('%Y-%m-%d %H:%M')
    x = np.asarray(trades, dtype=float)
    part = {'trades': len(x), 'avgPct': float(x.mean()), 'stdPct': float(x.std(ddof=1)), 'maxDrawdownPct': 4.0,
            'edgePct': float(x.mean()), 'grossWinPct': float(x[x > 0].sum()), 'grossLossPct': float(-x[x < 0].sum())}
    return {'ok': True, 'ts': t0.timestamp() + days * 86400, 'testDays': days, 'test': part, 'val': dict(part),
            'periods': {'eindtest': [fmt(t0), fmt(t0 + timedelta(days=days))]}}


def _sim_promotions(s, delta, n, rounds, trials, seed, same_period=True, k=1, jitter=0.2):
    """Hoe vaak haalt kandidaat B de statistische toets tegen A? Beide recepten hebben een echte
    verwachting van 0,2% (B: + delta) per trade, std 1%. Elke ronde test hetzelfde recept opnieuw
    op (bijna) dezelfde eindtest (6 uur later, zoals retestHours), met grotendeels dezelfde trades
    (ander zaadje: kleine afwijking `jitter`). same_period=False: elke ronde een nieuwe periode."""
    rnd = np.random.default_rng(seed)
    hits = 0
    for _ in range(trials):
        ents = []
        for mu in (0.2 + delta, 0.2):
            base = rnd.normal(mu, 1.0, n)
            rs = []
            for r in range(rounds):
                if same_period:
                    rs.append(_sim_round(base + rnd.normal(0, jitter, n), 6 * r))
                else:
                    rs.append(_sim_round(rnd.normal(mu, 1.0, n), 24 * 10 * r))
            ents.append({'key': 'x', 'recipe': {'timeframe': '15m'}, 'rounds': rs})
        out = s.stat_test(s.recipe_metrics(ents[0]), s.recipe_metrics(ents[1]), 0.95, k)
        hits += bool(out and out[0])
    return hits / trials


class AuditPseudoReplication(GateBase):
    """Rondes die dezelfde eindtestperiode opnieuw testen, zijn geen nieuwe, onafhankelijke trades."""

    def test_repeated_rounds_on_same_period_do_not_inflate_evidence(self):
        # Gelijke echte verwachting: de toets mag hooguit ~5% (eenzijdig, 95%) onterecht promoveren.
        # Telden de 6 herhaalde rondes als 360 losse trades, dan was dat ~25%.
        rate = _sim_promotions(self.s, 0.0, 60, 6, 300, seed=11)
        self.assertLess(rate, 0.10, f'onterecht gepromoot in {rate:.0%} van de gevallen')

    def test_real_new_periods_still_count_fully(self):
        # Echt nieuwe periodes (los van elkaar) tellen wel volledig: de toets wordt daar niet strenger.
        s = self.s
        rnd = np.random.default_rng(3)
        e = {'key': 'x', 'recipe': {'timeframe': '15m'}, 'rounds': [_sim_round(rnd.normal(0.2, 1, 60), 24 * 10 * r) for r in range(3)]}
        m = s.recipe_metrics(e)
        self.assertEqual(m['testTrades'], 180)
        self.assertAlmostEqual(m['testEffTrades'], 180)
        same = {**e, 'rounds': [_sim_round(rnd.normal(0.2, 1, 60), 0) for _ in range(3)]}
        self.assertAlmostEqual(s.recipe_metrics(same)['testEffTrades'], 60)
        # Gelijke verwachting op nieuwe periodes: ook ~5%.
        self.assertLess(_sim_promotions(s, 0.0, 60, 3, 300, seed=5, same_period=False), 0.10)
        # Een echt beter recept komt er met genoeg nieuwe periodes wel door.
        self.assertGreater(_sim_promotions(s, 0.4, 100, 3, 100, seed=6, same_period=False), 0.8)

    def test_rounds_without_period_use_time_and_test_days(self):
        s = self.s
        r1 = _sim_round([0.1, 0.3, -0.2, 0.5], 0)
        r2 = _sim_round([0.1, 0.3, -0.2, 0.5], 6)
        for r in (r1, r2):
            r['periods'] = None
        m = s.recipe_metrics({'key': 'x', 'recipe': {'timeframe': '15m'}, 'rounds': [r1, r2]})
        self.assertEqual(m['testTrades'], 8)
        self.assertLess(m['testEffTrades'], 5, 'zelfde eindtest (op 6 uur na): bijna dezelfde trades')


class AuditRollback(HttpGate):
    """Terugzetten: nooit naar een model dat (in een eerdere versie van dezelfde proef) zakte."""

    def fail_b_after_retrain(self):
        s = self.s
        self.finish(RA, 'a1', RP())
        self.finish(RA, 'a2', RP())
        self.finish(RB, 'b1', RP(edge=0.4))
        self.assertEqual(self.finish(RB, 'b2', RP(edge=0.4))[0], 'promoted')       # v4, op proef
        d, why = self.finish(RB, 'b3', RP(edge=0.4))                               # v5: zelfde recept, proef loopt door
        self.assertEqual(d, 'promoted', why)
        reg = s.registry()
        self.assertEqual(reg.get(5)['probation']['startVersion'], 4)
        s.add_agent_trades(trades_around(RB, -0.3))
        self.assertEqual(reg.get(5)['probation']['status'], 'mislukt')
        self.assertEqual((reg.active(), self.published()), (2, (A_key(RA), 'a2')))
        return reg

    def test_never_back_to_a_failed_model_from_an_inherited_probation(self):
        s = self.s
        reg = self.fail_b_after_retrain()
        # Daarna wordt C gepromoot en zakt ook: terug naar A (v2), niet naar v4 (B, dezelfde gezakte proef).
        self.finish(RC, 'c1', RP(edge=0.5))
        d, why = self.finish(RC, 'c2', RP(edge=0.5))
        self.assertEqual(d, 'promoted', why)
        c_ver = reg.active()
        s.add_agent_trades(trades_around(RC, -0.3, n=30))
        self.assertEqual(reg.get(c_ver)['probation']['status'], 'mislukt')
        self.assertEqual(reg.get(c_ver)['probation']['restoredVersion'], 2)
        self.assertEqual((reg.active(), self.published()), (2, (A_key(RA), 'a2')))
        self.assertEqual(s.load_agents()['published']['key'], A_key(RA))
        self.assertEqual(set(s.active_cooldowns(reg)), {A_key(RB), A_key(RC)})
        # Ook na de afkoelperiode niet automatisch terug naar het gezakte B-model.
        reg.set_meta('cooldowns', {})
        self.assertIsNone(s._rollback_target(reg, 99, A_key(RA), s.load_agents()))

    def test_rollback_is_atomic_against_feedback(self):
        # Feedback (add_agent_trades) leest en schrijft agents.json; een terugzetting tegelijk mag niet
        # verloren gaan (anders wijst agents.json 'published' naar een ander recept dan agent.json).
        from unittest import mock
        s = self.s
        self.finish(RA, 'a1', RP())
        self.finish(RB, 'b1', RP(edge=0.4))
        self.finish(RB, 'b2', RP(edge=0.4))
        self.assertEqual(self.published()[0], A_key(RB))
        inside, go = threading.Event(), threading.Event()
        real = s.load_agents

        def slow_load():
            d = real()
            if threading.current_thread().name == 'feedback':
                inside.set()
                go.wait(5)
            return d
        out = {}
        with mock.patch.object(s, 'load_agents', slow_load):
            t1 = threading.Thread(target=lambda: s.add_agent_trades([AT(RA, 0.1)]), name='feedback')
            t1.start()
            self.assertTrue(inside.wait(5))
            t2 = threading.Thread(target=lambda: out.setdefault('r', s.registry_rollback({'version': 1})), name='rollback')
            t2.start()
            t2.join(0.5)
            go.set()
            t1.join(10)
            t2.join(10)
        self.assertEqual(out['r'][0], 200, out)
        self.assertEqual(self.published()[0], A_key(RA))
        self.assertEqual(s.load_agents()['published']['key'], A_key(RA), 'agents.json past bij agent.json')
        self.assertEqual(s.load_agents()['live'][A_key(RA)]['n'], 1, 'en de feedback telt ook mee')


class AuditProbationTrades(unittest.TestCase):
    """Koppeling trade -> versie bij de proef: op het openingsmoment, met of zonder tijdzone."""

    def test_trades_belong_to_version_by_opening_time(self):
        import probation
        from datetime import datetime, timezone
        since = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc).timestamp()
        rows = [{'recipe': 'b', 'pct': 1.0, 'mode': 'paper', 'openedAt': '2026-03-01T11:59:00Z', 'closedAt': '2026-03-01T13:00:00Z'},
                {'recipe': 'b', 'pct': 2.0, 'mode': 'live', 'openedAt': '2026-03-01T12:00:00+00:00', 'closedAt': '2026-03-01T13:00:00Z'},
                {'recipe': 'b', 'pct': 3.0, 'mode': 'paper', 'openedAt': '2026-03-01T14:00:00+02:00', 'closedAt': '2026-03-01T15:00:00Z'},
                {'recipe': 'b', 'pct': 4.0, 'mode': 'paper', 'openedAt': '', 'at': '2026-03-01T13:00:00Z'},
                {'recipe': 'b', 'pct': 'x', 'mode': 'paper', 'openedAt': '2026-03-01T13:00:00Z'},
                {'recipe': 'b', 'pct': 5.0, 'mode': 'paper', 'openedAt': '2026-03-01T13:00:00Z', 'explore': True}]
        got = probation.trades_in(probation.real_trades(rows), 'b', since)
        # Voor het promotiemoment geopend (ook al na sluiten): niet; 14:00+02:00 = 12:00 UTC: wel.
        self.assertEqual(sorted(t['pct'] for t in got), [2.0, 3.0, 4.0])
        self.assertEqual({t['mode'] for t in got}, {'paper', 'live'})
        self.assertEqual(probation.trades_in(probation.real_trades(rows), 'b', since, since + 1), [t for t in got if t['open'] < since + 1])
