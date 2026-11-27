"""GET /learnstats: leerrondes van de laatste 24 uur en ontvangen trades van de AI-trader.

Draaien: cd trainer && python -m unittest test_learnstats
"""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime

import learnstats

NOW = time.mktime((2026, 11, 27, 12, 0, 0, 0, 0, -1))


def iso(hours_ago):
    return datetime.fromtimestamp(NOW - hours_ago * 3600).isoformat(timespec='seconds')


class Compute(unittest.TestCase):
    def test_rounds_last_day_without_rollbacks(self):
        versions = [{'at': iso(2), 'decision': 'kept'}, {'at': iso(10), 'decision': 'promoted'},
                    {'at': iso(1), 'decision': 'rollback'}, {'at': iso(30), 'decision': 'rejected'}, {'at': None, 'decision': 'kept'}]
        r = learnstats.compute(versions, [], True, True, NOW)
        self.assertEqual(r['rounds']['lastDay'], 2, 'terugzetten is geen leerronde; ouder dan 24 uur telt niet')
        self.assertEqual(r['rounds']['ageHours'], 2.0)
        self.assertEqual(r['rounds']['lastAt'], iso(2))
        self.assertTrue(r['enabled'])

    def test_no_rounds(self):
        r = learnstats.compute([], [], False, False, NOW)
        self.assertEqual(r['rounds']['lastDay'], 0)
        self.assertIsNone(r['rounds']['lastAt'])
        self.assertIsNone(r['rounds']['ageHours'])
        self.assertFalse(r['enabled'])

    def test_agent_trades_received(self):
        trades = [{'at': iso(1), 'explore': False}, {'at': iso(5), 'explore': True}, {'at': iso(80)},
                  {'at': 'kapot'}, 'geen dict', {'at': iso(70), 'virtual': True}]
        r = learnstats.compute([], trades, True, True, NOW)['agentTrades']
        self.assertEqual(r['total'], 4)
        self.assertEqual(r['recent'], 3, 'laatste 3 dagen (72 uur)')
        self.assertEqual(r['recentReal'], 1, 'zonder verkenner en virtuele trades')
        self.assertEqual(r['ageHours'], 1.0)


class Endpoint(unittest.TestCase):
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

    def get(self, tok):
        r = urllib.request.Request(self.base + '/learnstats', headers={'Authorization': f'Bearer {tok}'})
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, {}

    def test_needs_token(self):
        self.assertEqual(self.get('fout')[0], 401)

    def test_counts_received_agent_trades(self):
        before = self.get(self.s.token())[1]['agentTrades']['recent']
        self.s.add_agent_trades([{'timeframe': '15m', 'recipe': 'r1', 'pct': 0.4, 'mode': 'paper', 'pair': 'BTC/EUR'}])
        code, body = self.get(self.s.token())
        self.assertEqual(code, 200)
        self.assertEqual(body['agentTrades']['recent'], before + 1)
        self.assertLess(body['agentTrades']['ageHours'], 0.1)
        self.assertIn('lastDay', body['rounds'])
        self.assertIn('enabled', body)


if __name__ == '__main__':
    unittest.main()
