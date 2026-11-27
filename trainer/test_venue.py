"""Fase 3: Bybit in de leerserver. Geen netwerk: nep-koersen en een nep-API van Bybit.

Bewijst dat oude data zonder 'venue' (= Bitvavo) precies dezelfde livecheck en kosten geeft als
vroeger, dat Bybit-trades en Bybit-koersen apart blijven, en dat venueStats gepubliceerd wordt."""
import importlib
import json
import math
import os
import random
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import numpy as np

import agent as agent_mod
import livecheck
import train
import venue_eval
import venues

H1 = 3_600_000


def candles(n, seed, start=0, step=H1, base=100.0):
    rnd = random.Random(seed)
    out, price = [], base
    for i in range(n):
        o = price
        price = max(0.01, price * (1 + rnd.gauss(0, 0.004)))
        out.append([start + i * step, o, max(o, price) * 1.001, min(o, price) * 0.999, price, 1000.0])
    return out


def old_rows():
    """Oude agent_trades.json-rijen (zonder 'venue'), zoals een bestaande leerserver ze heeft."""
    rnd = random.Random(5)
    rows = []
    for i in range(70):
        day = 1 + i // 3
        rows.append({'timeframe': '15m', 'recipe': 'r1', 'pct': round(rnd.gauss(0.3, 1.0), 4), 'version': 'v', 'features': {},
                     'mode': 'paper', 'pair': ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'][i % 3], 'at': f'2026-10-{day:02d}T10:00:00',
                     'entryTs': None, 'openedAt': f'2026-10-{day:02d}T08:00:00Z', 'closedAt': f'2026-10-{day:02d}T10:00:00Z',
                     'marketRegime': ['stijgend', 'zijwaarts'][i % 2], 'costPct': round(0.5 + rnd.random() * 0.3, 4),
                     'explore': False, 'virtual': False, 'expectedPct': 0.2, 'mkt': 0.0})
    return rows


def old_cost_table(rows, cfg):
    """De kostentabel zoals hij vóór fase 3 was (letterlijk overgenomen), als referentie."""
    rows = [t for t in rows if not t.get('virtual') and isinstance(t.get('costPct'), (int, float))]
    base = float(cfg['costPct'])
    p75 = lambda xs: sorted(xs)[min(len(xs) - 1, int(round(0.75 * (len(xs) - 1))))]
    default = p75([t['costPct'] for t in rows[-200:]]) if len(rows) >= 10 else base
    per, info = {}, {}
    for pair in sorted({t['pair'] for t in rows if t.get('pair')}):
        xs = [t['costPct'] for t in rows if t.get('pair') == pair][-30:]
        if len(xs) >= 5:
            per[pair] = p75(xs)
        info[pair] = {'measured': round(p75(xs), 4), 'median': round(sorted(xs)[len(xs) // 2], 4), 'n': len(xs),
                      'used': round(per.get(pair, default), 4)}
    return per, info, default


def const_tree(value):
    return {'f': [-2], 't': [-2.0], 'l': [-1], 'r': [-1], 'v': [value], 'n': [1.0]}


def toy_part(key='15m|a', coins=('BTC/EUR', 'ETH/EUR'), entry=1.0, exit_=-1.0, trained='2026-11-01T00:00:00Z', test_start='2026-11-20 00:00'):
    """Een klein recept: koopt altijd (verwachting +1%), verkoopt na 1 candle."""
    nf = len(agent_mod.FEATURES)
    return {'version': 2, 'kind': 'agent', 'timeframe': '1h', 'threshold': 0.2, 'maxHoldCandles': 12, 'safetyStopPct': 10,
            'minHoldCandles': 1, 'exitMarginPct': 0.0, 'costPct': 0.5, 'coins': list(coins), 'recipeKey': key, 'stage': 'getest',
            'entry': {'version': 1, 'kind': 'gbdt-reg', 'features': agent_mod.FEATURES, 'init': entry, 'learningRate': 1.0,
                      'medians': [0.0] * nf, 'trees': [const_tree(0.0)]},
            'exit': {'version': 1, 'kind': 'gbdt-reg', 'features': agent_mod.FEATURES + agent_mod.POS_FEATURES, 'init': exit_, 'learningRate': 1.0,
                     'medians': [0.0] * (nf + 4), 'trees': [const_tree(0.0)]},
            'meta': {'trainedAt': trained, 'report': {'periods': {'eindtest': [test_start, '2026-11-25 00:00']}}}}


class Venues(unittest.TestCase):
    def test_pairs_and_files(self):
        self.assertEqual(venues.to_venue_pair('SOL/EUR', 'bybit'), 'SOL/USDT')
        self.assertEqual(venues.to_base_pair('SOL/USDT'), 'SOL/EUR')
        self.assertEqual(venues.to_venue_pair('SOL/USDC', 'bybit'), 'SOL/USDC')
        self.assertEqual(venues.venue_of(None), 'bitvavo')
        self.assertEqual(venues.venue_of('kraken'), 'bitvavo')
        self.assertEqual(venues.trades_file('bitvavo'), 'agent_trades.json')
        self.assertEqual(venues.trades_file(None), 'agent_trades.json')
        self.assertEqual(venues.trades_file('bybit'), 'agent_trades-bybit.json')
        self.assertEqual(venues.data_dir('/d', 'candles', 'bitvavo'), os.path.join('/d', 'candles'))
        self.assertEqual(venues.data_dir('/d', 'candles', 'bybit'), os.path.join('/d', 'candles-bybit'))

    def test_usdc_back_to_eur(self):
        # Bybit EU/NL (MiCA): de bot handelt in X/USDC; de leerserver kent alles als X/EUR.
        self.assertEqual(venues.to_base_pair('SOL/USDC'), 'SOL/EUR')
        self.assertEqual(venues.to_base_pair('SOL/USDT'), 'SOL/EUR')
        self.assertEqual(venues.to_base_pair('SOL/EUR'), 'SOL/EUR')
        self.assertEqual(venues.to_base_pair('SOL/PLN'), 'SOL/PLN')
        self.assertEqual(venues.to_base_pair('SOL'), 'SOL')
        # Koersen van de leerserver blijven van bybit.com in USDT.
        self.assertEqual(venues.to_venue_pair(venues.to_base_pair('SOL/USDC'), 'bybit'), 'SOL/USDT')

    def test_rows_without_venue_are_bitvavo(self):
        rows = [{'a': 1}, {'a': 2, 'venue': 'bitvavo'}, {'a': 3, 'venue': 'bybit'}, 'kapot']
        self.assertEqual([r['a'] for r in venues.rows_of(rows, 'bitvavo')], [1, 2])
        self.assertEqual([r['a'] for r in venues.rows_of(rows, 'bybit')], [3])

    def test_base_cost(self):
        cfg = {'costPct': 0.6, 'venues': {'bybit': {'feePct': 0.1}}}
        self.assertEqual(venues.base_cost(cfg, 'bitvavo'), 0.6)
        self.assertAlmostEqual(venues.base_cost(cfg, 'bybit'), 0.2 + 0.1)  # 2 × 0,1% fee + slippage 0,1%
        self.assertAlmostEqual(venues.base_cost({'costPct': 0.3}, 'bybit'), 0.2)  # slippage nooit onder 0

    def test_validate(self):
        out = venues.validate({'bybit': {'enabled': False, 'pairs': ['sol/usdt', 'BTC/EUR']}}, {'bybit': dict(venues.DEFAULT_CFG)})
        self.assertEqual(out['bybit']['pairs'], ['SOL/EUR', 'BTC/EUR'])
        self.assertFalse(out['bybit']['enabled'])
        for bad in ({'kraken': {}}, {'bybit': {'feePct': 5}}, {'bybit': {'pairs': ['X/USDC']}}, {'bybit': {'everyHours': 0}}):
            with self.assertRaises(ValueError):
                venues.validate(bad, {})


class BybitCandles(unittest.TestCase):
    def test_fetch_range_pages_back_newest_first(self):
        data = candles(2500, 1, start=1_000 * H1)
        calls = []

        def get(url):
            q = dict(x.split('=') for x in url.split('?')[1].split('&'))
            calls.append(q)
            self.assertEqual((q['category'], q['symbol'], q['interval']), ('spot', 'SOLUSDT', '60'))
            rows = [c for c in data if int(q['start']) <= c[0] <= int(q['end'])][-1000:]
            return [[str(c[0])] + [str(x) for x in c[1:]] + ['0'] for c in reversed(rows)]  # nieuwste eerst, als strings
        orig, venues.time.sleep = venues.time.sleep, lambda s: None
        try:
            out = venues.bybit_fetch_range('SOL/EUR', '1h', data[0][0], data[-1][0], get=get)
        finally:
            venues.time.sleep = orig
        self.assertEqual([c[0] for c in out], [c[0] for c in data])
        self.assertAlmostEqual(out[100][4], data[100][4])
        self.assertEqual(len(calls), 3)

    def test_cache_separate_from_bitvavo(self):
        d = tempfile.mkdtemp()
        now = 500 * H1
        bv = lambda p, tf, a, b: [c for c in candles(500, 2) if a <= c[0] <= b]
        by = lambda p, tf, a, b: [c for c in candles(500, 3, base=110.0) if a <= c[0] <= b]
        a = train.fetch_candles('BTC/EUR', '1h', 10, cache_dir=venues.data_dir(d, 'candles', 'bitvavo'), now_ms=now, fetch=bv)
        b = train.fetch_candles('BTC/USDT', '1h', 10, cache_dir=venues.data_dir(d, 'candles', 'bybit'), now_ms=now, fetch=by, venue='bybit')
        self.assertTrue(os.path.exists(os.path.join(d, 'candles', 'BTC-EUR_1h.json')))
        self.assertTrue(os.path.exists(os.path.join(d, 'candles-bybit', 'BTC-USDT_1h.json')))
        self.assertEqual(sorted(os.listdir(os.path.join(d, 'candles-bybit'))), ['BTC-USDT_1h.json', 'BTC-USDT_1h.meta.json'])
        self.assertNotIn('BTC-USDT_1h.json', os.listdir(os.path.join(d, 'candles')))
        self.assertNotEqual(a[-1][4], b[-1][4])
        # Tweede keer uit de opslag, de Bitvavo-opslag blijft van Bitvavo.
        again = train.fetch_candles('BTC/EUR', '1h', 10, cache_dir=venues.data_dir(d, 'candles', 'bitvavo'), now_ms=now, fetch=bv)
        self.assertEqual(again, a)

    def test_default_fetch_for_bybit(self):
        seen = []
        orig = venues.bybit_fetch_range
        venues.bybit_fetch_range = lambda p, tf, a, b: seen.append(p) or []
        try:
            train.fetch_candles('ETH/USDT', '1h', 2, venue='bybit', now_ms=100 * H1)
        finally:
            venues.bybit_fetch_range = orig
        self.assertEqual(seen, ['ETH/USDT'])


class JsonModel(unittest.TestCase):
    def test_same_as_predict_reg_json(self):
        from sklearn.ensemble import HistGradientBoostingRegressor
        rnd = np.random.default_rng(1)
        X = rnd.normal(size=(800, 5))
        y = X[:, 0] * 2 - X[:, 3] + rnd.normal(scale=0.1, size=800)
        m = HistGradientBoostingRegressor(max_iter=20, max_depth=3).fit(X, y)
        js = agent_mod.export_reg(m, [f'f{i}' for i in range(5)], [0.0] * 5)
        jr = venue_eval.JsonReg(js)
        got = jr.predict(X[:50])
        want = [agent_mod.predict_reg_json(js, row) for row in X[:50]]
        np.testing.assert_allclose(got, want, rtol=1e-9, atol=1e-9)


class ServerVenue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        os.environ['DATA_DIR'] = cls.dir
        import server
        importlib.reload(server)
        cls.s = server
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        for f in os.listdir(self.dir):
            p = os.path.join(self.dir, f)
            if os.path.isfile(p) and f not in ('token', 'helper-token') and not f.startswith('registry'):
                os.remove(p)
        self.s.state['thoughts'] = []

    def get(self, p):
        r = urllib.request.Request(self.base + p, headers={'Authorization': f'Bearer {self.s.token()}'})
        with urllib.request.urlopen(r) as res:
            return json.loads(res.read())

    def bybit_trade(self, pct=0.5, **kw):
        return {'kind': 'agentTrade', 'venue': 'bybit', 'pair': 'SOL/USDT', 'timeframe': '15m', 'recipe': 'r1', 'pct': pct, 'mode': 'paper',
                'openedAt': '2026-11-02T08:00:00Z', 'closedAt': '2026-11-02T10:00:00Z', 'marketRegime': 'stijgend', 'costPct': 0.25,
                'expectedPct': 0.3, 'features': {'rsi': 50}, **kw}

    def test_feedback_with_venue_goes_to_own_file(self):
        self.s.write_json('agent_trades.json', old_rows())
        before = self.s.read_json('agent_trades.json', None)
        agents_before = self.s.read_json('agents.json', None)
        added = self.s.add_feedback([self.bybit_trade(), self.bybit_trade(pct=-0.2, explore=True),
                                     {'kind': 'arm', 'venue': 'bybit', 'key': 'x', 'pct': 1.0, 'shadow': False},
                                     {'venue': 'bybit', 'pair': 'SOL/USDT', 'timeframe': '15m', 'ts': 1, 'returnPct': 1.0, 'features': {'rsi': 1.0}},
                                     {'kind': 'agentTrade', 'pair': 'BTC/EUR', 'timeframe': '15m', 'recipe': 'r1', 'pct': 0.1, 'mode': 'paper'}])
        self.assertEqual(added, 0, 'geen model-feedback van Bybit in feedback.json')
        self.assertEqual(self.s.read_json('feedback.json', []), [])
        self.assertIsNone(self.s.read_json('arms.json', None))
        by = self.s.read_json('agent_trades-bybit.json', [])
        self.assertEqual(len(by), 2)
        self.assertEqual({r['venue'] for r in by}, {'bybit'})
        self.assertEqual(by[0]['pair'], 'SOL/EUR')
        self.assertEqual(by[0]['venuePair'], 'SOL/USDT')
        self.assertNotIn('features', by[0], 'geen leervoorbeelden van Bybit')
        bv = self.s.read_json('agent_trades.json', [])
        self.assertEqual(bv[:-1], before, 'Bitvavo-trades onveranderd')
        self.assertEqual(len(bv), len(before) + 1)
        self.assertNotIn('venue', bv[-1])
        live = self.s.load_agents()['live']
        self.assertEqual(live['r1']['n'], 1, 'alleen de Bitvavo-trade telt in agents.json')
        self.assertIsNone(agents_before)
        self.assertEqual(self.s.venue_live('bybit')['r1']['n'], 1, 'verkenner telt niet')

    def test_feedback_from_bybit_eu_usdc(self):
        # Feedback van een bot op Bybit EU: pair X/USDC wordt X/EUR, de naam op de beurs blijft in venuePair.
        before = self.s.read_json('agent_trades.json', None)
        self.s.add_feedback([self.bybit_trade(pair='SOL/USDC'), self.bybit_trade(pair='ETH/USDC', pct=-0.1)])
        by = self.s.read_json('agent_trades-bybit.json', [])
        self.assertEqual([r['pair'] for r in by], ['SOL/EUR', 'ETH/EUR'])
        self.assertEqual([r['venuePair'] for r in by], ['SOL/USDC', 'ETH/USDC'])
        self.assertEqual(self.s.read_json('agent_trades.json', None), before, 'Bitvavo onaangeroerd')
        self.assertEqual(self.s.venue_live('bybit')['r1']['n'], 2)
        # Coins voor de Bybit-koersen van de leerserver: X/EUR (opgehaald als X/USDT van bybit.com).
        self.assertEqual(self.s.venue_pairs({}, 'bybit', [r['venuePair'] for r in by]), ['SOL/EUR', 'ETH/EUR'])

    def test_old_data_same_livecheck_and_costs(self):
        rows = old_rows()
        self.s.write_json('agent_trades.json', rows)
        entry = None
        cfg = self.s.config()
        want_lc = livecheck.check([t for t in rows if t['mode'] == 'paper' and not t['explore'] and t['recipe'] == 'r1'], 'onbekend',
                                  slots=int(cfg['agent']['maxOpen']), assumed_cost=0.5)
        want_cost = old_cost_table(rows, cfg)
        want_weeks = livecheck.weeks([t for t in rows if t['mode'] == 'paper' and not t['explore']], None)
        want_cal = livecheck.calibration(rows)
        got = lambda: (self.s.live_check('r1', entry, 0.5), self.s.cost_table(cfg), livecheck.weeks(self.s.paper_rows(), None),
                       livecheck.calibration(self.s.load_agent_trades()), self.s.round_config(cfg)['costs'])
        first = got()
        self.assertEqual(first[0], want_lc)
        self.assertEqual(first[1], want_cost)
        self.assertEqual(first[2], want_weeks)
        self.assertEqual(first[3], want_cal)
        self.assertEqual(first[4], want_cost[0])
        # Bybit-trades erbij (veel, met hoge kosten): de Bitvavo-uitkomst blijft exact gelijk.
        self.s.add_feedback([self.bybit_trade(pct=-3.0, costPct=2.5, closedAt=f'2026-11-{d:02d}T10:00:00Z') for d in range(1, 28)])
        self.assertEqual(got(), first)
        # Ook met 'venue': 'bitvavo' expliciet in de rijen.
        self.s.write_json('agent_trades.json', [{**r, 'venue': 'bitvavo'} for r in rows])
        self.assertEqual(got()[:2], first[:2])

    def test_costs_and_livecheck_per_venue(self):
        self.s.write_json('agent_trades.json', old_rows())
        cfg = self.s.config()
        per, info, default = self.s.cost_table(cfg, 'bybit')
        self.assertEqual(per, {})
        self.assertAlmostEqual(default, venues.base_cost(cfg, 'bybit'))
        self.assertAlmostEqual(default, 0.2)  # standaard: costPct 0,5 = 2 × 0,25 fee, dus geen slippage; Bybit 2 × 0,1
        self.s.add_feedback([self.bybit_trade(costPct=0.3 + i / 100, pair='ETH/USDT') for i in range(12)])
        per, info, default = self.s.cost_table(cfg, 'bybit')
        self.assertIn('ETH/EUR', per)
        self.assertAlmostEqual(per['ETH/EUR'], 0.38)
        self.assertEqual(self.s.cost_table(cfg), old_cost_table(old_rows(), cfg), 'Bitvavo-kosten zonder Bybit-trades')
        lc_by = self.s.live_check('r1', None, 0.4, venue='bybit')
        self.assertEqual(lc_by['trades'], 12)
        self.assertEqual(self.s.live_check('r1', None, 0.4)['trades'], 70)

    def write_agent(self, parts):
        main = parts[0]
        a = {**main, 'regimes': {}, 'extras': parts[1:]}
        self.s.write_json('agent.json', a)
        self.s.write_json('agents.json', {'version': self.s.AGENTS_VERSION, 'recipes': {}, 'published': {'key': main['recipeKey']}})
        return a

    def fake_fetch(self, now_ms):
        n = 900
        start = now_ms - n * H1
        series = {p: candles(n, i + 10, start=start) for i, p in enumerate(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'])}
        calls = []

        def fetch(pair, tf, days):
            calls.append(pair)
            return series[pair]
        return fetch, calls

    def test_venue_round_publishes_venue_stats(self):
        import calendar
        import time as _t
        now = calendar.timegm(_t.strptime('2026-11-27 00:00', '%Y-%m-%d %H:%M'))
        self.write_agent([toy_part('15m|a'), toy_part('15m|b', coins=('SOL/EUR',))])
        fetch, calls = self.fake_fetch(now * 1000)
        cfg = self.s.config()
        self.assertTrue(cfg['venues']['bybit']['enabled'], 'Bybit-leren staat standaard aan')
        n = self.s.venue_round(cfg, fetch=fetch, now=now)
        self.assertEqual(n, 2)
        self.assertTrue(all(p.endswith('/USDT') for p in calls), calls)
        st = self.s.read_json('venue_stats.json', {})['bybit']
        a = st['15m|a']
        self.assertGreater(a['trades'], 10)
        self.assertAlmostEqual(a['costPct'], 0.2)  # Bybit-kosten, niet de 0,5 van Bitvavo
        self.assertEqual(a['since'], '2026-11-20T00:00:00Z')
        self.assertEqual(sorted(a['coins']), ['BTC/EUR', 'ETH/EUR'])
        # Elke trade: 1 candle vasthouden min de kosten.
        self.assertTrue(math.isfinite(a['avgPct']))
        # Nog eens: niets opnieuw (zelfde model, binnen everyHours).
        self.assertEqual(self.s.venue_round(cfg, fetch=fetch, now=now + 60), 0)
        self.assertEqual(self.s.venue_round(cfg, fetch=fetch, now=now + 7 * 3600), 2)
        # Gepubliceerd in /agent.json en /registry.
        self.s.add_feedback([self.bybit_trade(recipe='15m|a', pct=0.4), self.bybit_trade(recipe='15m|a', pct=0.2)])
        got = self.get('/agent.json')
        vs = got['venueStats']['bybit']
        self.assertEqual(vs['trades'], a['trades'])
        self.assertEqual(vs['practice'], {'trades': 2, 'avgPct': 0.3, 'winRate': 100.0})
        self.assertAlmostEqual(got['venueCosts']['bybit']['costPct'], 0.2)
        self.assertNotIn('venueLiveCheck', got, 'zonder recept in agents.json geen livecheck per beurs')
        self.assertEqual(got['extras'][0]['venueStats']['bybit']['trades'], st['15m|b']['trades'])
        reg = self.get('/registry')
        self.assertEqual(reg['venueStats']['bybit']['15m|a']['trades'], a['trades'])
        status = self.get('/status')
        self.assertEqual(status['agent']['venues']['bybit']['recipes']['15m|a']['practice']['trades'], 2)
        # Bitvavo-velden blijven zoals ze waren.
        self.assertEqual(got['costPct'], 0.5)
        self.assertEqual(got['threshold'], 0.2)

    def test_disabled_means_unchanged_output(self):
        self.write_agent([toy_part('15m|a')])
        empty = self.get('/agent.json')
        self.assertNotIn('venueStats', empty, 'zonder Bybit-data precies als vroeger')
        self.assertNotIn('venueCosts', empty)
        self.assertNotIn('venueStats', self.get('/registry'))
        self.s.add_feedback([self.bybit_trade(recipe='15m|a')])
        on = self.get('/agent.json')
        self.assertIn('venueStats', on)
        self.assertEqual({k: v for k, v in on.items() if not k.startswith('venue')}, empty)
        self.s.write_json('config.json', {**self.s.read_json('config.json', {}), 'venues': {'bybit': {'enabled': False}}})
        off = self.get('/agent.json')
        self.assertNotIn('venueStats', off)
        self.assertNotIn('venueCosts', off)
        self.assertEqual({k: v for k, v in on.items() if not k.startswith('venue')}, off)
        self.assertEqual(self.s.venue_round(self.s.config(), fetch=lambda *a: self.fail('geen koersen ophalen')), 0)
        self.assertNotIn('venues', self.get('/status')['agent'])

    def test_learnstats_per_venue(self):
        self.s.write_json('agent_trades.json', old_rows())
        self.s.add_feedback([self.bybit_trade()])
        bv = self.get('/learnstats')
        by = self.get('/learnstats?venue=bybit')
        self.assertNotIn('venue', bv)
        self.assertEqual(bv['agentTrades']['total'], 70)
        self.assertEqual(by['venue'], 'bybit')
        self.assertEqual(by['agentTrades']['total'], 1)

    def test_config_venues(self):
        cfg = self.s.validate_config({'venues': {'bybit': {'enabled': False, 'pairs': ['SOL/USDT'], 'feePct': 0.08}}})
        self.assertEqual(cfg['venues']['bybit'], {'enabled': False, 'pairs': ['SOL/EUR'], 'feePct': 0.08, 'everyHours': 6})
        with self.assertRaises(ValueError):
            self.s.validate_config({'venues': {'bybit': {'feePct': 9}}})


if __name__ == '__main__':
    unittest.main()
