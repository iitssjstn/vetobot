import json
import os
import math
import random
import re
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
        self.assertTrue(any(t.startswith('Strategy Agent:') for t in said), said)
        info = s.agent_info()
        self.assertEqual(info['published']['timeframe'], '15m')
        self.assertEqual(len(info['recipes']), 1)
        self.assertEqual(info['recipes'][0]['score']['tested'], 1)
        # Echte trades: tellen per recept
        s.add_agent_trades([{'timeframe': '15m', 'recipe': pub['recipeKey'], 'pct': 0.5, 'features': {'rsi14': 40}} for _ in range(20)])
        self.assertEqual(s.load_agents()['live'][pub['recipeKey']]['n'], 20)
        self.assertEqual(len(s.agent_extra('15m')), 20)


class RecipeSearch(unittest.TestCase):
    def test_status_needs_repeated_success(self):
        import agent_search as A
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        recipes = {}
        good = {'ok': True, 'test': {'trades': 50, 'avgPct': 0.3, 'totalPct': 15, 'winRate': 55, 'edgePct': 0.2, 'maxDrawdownPct': 4}}
        e = A.add_round(recipes, r, good)
        self.assertEqual(e['status'], 'veelbelovend', 'één goede ronde is nog geen bewijs')
        e = A.add_round(recipes, r, good)
        self.assertEqual(e['status'], 'betrouwbaar')
        bad = {'ok': False, 'test': {'trades': 50, 'avgPct': -0.6, 'totalPct': -30, 'winRate': 30}}
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
        rising = {'ok': True, 'test': {'trades': 50, 'avgPct': 0.4, 'totalPct': 20, 'winRate': 60, 'marketPct': 0.6, 'edgePct': -0.2, 'maxDrawdownPct': 3}}
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
            A.add_round(recipes, calm, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.2, 'totalPct': 12, 'edgePct': 0.15, 'maxDrawdownPct': 2}})
            A.add_round(recipes, wild, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.5, 'totalPct': 30, 'edgePct': 0.4, 'maxDrawdownPct': 14}})
        board = A.leaderboard(recipes)
        self.assertEqual(board[0]['recipe'], calm, 'meer winst per risico wint van meer winst met diepe dalen')
        self.assertAlmostEqual(A.score(recipes[A.key_of(calm)])['ratio'], 0.15 * 60 / 2)

    def test_too_deep_drawdown_never_used(self):
        import agent_search as A
        recipes = {}
        r = {'timeframe': '15m', 'holdDays': 1, 'depth': 4, 'leaf': 200, 'look': 5}
        deep = {'ok': True, 'test': {'trades': 60, 'avgPct': 0.8, 'totalPct': 48, 'edgePct': 0.6, 'maxDrawdownPct': 30}}
        e = A.add_round(recipes, r, deep)
        self.assertEqual(e['status'], 'te riskant')
        self.assertFalse(A.usable(e))
        # Ook na genoeg nette rondes (de diepe valt uit de lijst) blijft hij te riskant.
        for _ in range(A.KEEP_ROUNDS + 1):
            e = A.add_round(recipes, r, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.3, 'totalPct': 18, 'edgePct': 0.2, 'maxDrawdownPct': 3}})
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
            return {'ok': True, 'test': {'trades': 60, 'avgPct': avg, 'totalPct': avg * 60, 'edgePct': edge, 'maxDrawdownPct': 3, 'byRegime': by}}
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
        A.add_round(recipes, good_r, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}})
        rec, why = A.pick(recipes, ['5m', '15m', '30m', '1h', '2h'], rnd=random.Random(1), now=time.time() + 3600)
        self.assertEqual((A.key_of(rec), why), (A.key_of(good_r), 'retest'), 'beste eerst nog eens bewijzen')
        A.add_round(recipes, good_r, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}})
        A.add_round(recipes, good_r, {'ok': True, 'test': {'trades': 60, 'avgPct': 0.4, 'totalPct': 24, 'winRate': 55}})
        # 5m: alles verlies
        for i, r in enumerate(A.all_recipes(['5m'])[:6]):
            A.add_round(recipes, r, {'ok': False, 'test': {'trades': 40, 'avgPct': -0.5, 'totalPct': -20, 'winRate': 30}})
        self.assertEqual(A.tf_weight(recipes, '5m'), 0.1)
        whys, tfs = [], []
        for seed in range(40):
            rec, why = A.pick(recipes, ['5m', '15m', '30m', '1h', '2h'], rnd=random.Random(seed), now=time.time() + 60)
            whys.append(why)
            tfs.append(rec['timeframe'])
        self.assertGreater(whys.count('near'), 10, 'bouwt verder op het beste recept')
        self.assertLess(tfs.count('5m'), 4, '5m (alles verlies) bijna niet meer')


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
