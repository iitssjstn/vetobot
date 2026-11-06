"""Maakt test/fixtures/ml-parity.json: candles, kenmerken en modeluitkomsten berekend door Python.

De Node-test (test/mlmodel.test.js) rekent hetzelfde uit in JavaScript en controleert dat de
uitkomsten gelijk zijn. Draai dit opnieuw na een wijziging aan de kenmerken:

    cd trainer && python3 make_parity_fixture.py
"""
import json
import math
import os
import random

from features import FEATURES, context, features_at, series
from train import _impute, contributions_json, export_model, predict_json

N = 700
STEP = 300_000  # 5m-candles
T0 = 1_762_000_000_000 - (1_762_000_000_000 % STEP)


def walk(seed, start, vol):
    rnd = random.Random(seed)
    out, p = [], start
    for k in range(N):
        o = p
        p = max(1e-6, p * (1 + rnd.gauss(0.0002, vol)))
        hi = max(o, p) * (1 + abs(rnd.gauss(0, vol / 3)))
        lo = min(o, p) * (1 - abs(rnd.gauss(0, vol / 3)))
        out.append([T0 + k * STEP, round(o, 8), round(hi, 8), round(lo, 8), round(p, 8), round(rnd.random() * 1000 + 10, 4)])
    return out


def main():
    from sklearn.ensemble import GradientBoostingClassifier
    coin = walk(1, 0.35, 0.008)
    btc = walk(2, 60000, 0.004)
    btc = btc[30:]  # BTC begint later: de eerste coin-candles hebben geen BTC-kenmerken
    s, ctx = series(coin), context(btc)
    rows = [features_at(coin, s, i, ctx) for i in range(len(coin))]
    X = [[f[k] for k in FEATURES] for f in rows if f]
    rnd = random.Random(3)
    y = [1 if (r[FEATURES.index('rsi14')] < 45) ^ (rnd.random() < 0.2) else 0 for r in X]
    medians = []
    for j in range(len(FEATURES)):
        col = sorted(v for v in (r[j] for r in X) if v is not None)
        medians.append(col[len(col) // 2] if col else 0.0)
    Xi = _impute(X, medians)
    model = GradientBoostingClassifier(n_estimators=20, max_depth=3, learning_rate=0.1, random_state=1).fit(Xi, y)
    exported = export_model(model, medians, Xi)
    m = {'version': 1, 'kind': 'gbdt', 'features': FEATURES, **exported, 'meta': {}}
    points = []
    for end in (251, 270, 330, 450, 600, N):
        f = features_at(coin, s, end - 1, ctx)
        points.append({'end': end, 'features': f})
    probs = [float(model.predict_proba(_impute([[p['features'][k] for k in FEATURES]], medians))[0][1]) for p in points]
    missing = float(model.predict_proba([medians])[0][1])
    for p in points:
        base, c = contributions_json(m, _impute([[p['features'][k] for k in FEATURES]], medians)[0])
        p['base'], p['contrib'] = base, c
        raw = base + sum(c)
        assert abs(1 / (1 + math.exp(-raw)) - predict_json(m, _impute([[p['features'][k] for k in FEATURES]], medians)[0])) < 1e-9
    out = {'candles': coin, 'btc': btc, 'points': points, 'model': m, 'probs': probs, 'missing': missing}
    dest = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'ml-parity.json')
    with open(dest, 'w') as fh:
        json.dump(out, fh)
    print(f'Geschreven: {dest} ({len(points)} punten)')


def agent_fixture():
    """Kleine AI-trader en de uitkomsten volgens Python, voor test/agent.test.js."""
    import agent
    coin = walk(4, 0.35, 0.008)
    btc = walk(2, 60000, 0.004)
    ctx = context(btc)
    mk = agent.Market('X/EUR', coin, ctx)
    rows = mk.X[agent.WARMUP:]
    import numpy as np
    rnd = random.Random(1)
    y = np.array([rnd.gauss(0, 1) + (r[0] - 50) / 20 for r in rows])
    med = agent._medians(rows)
    m = agent._fit(agent._impute(rows, med), y)
    entry = agent.export_reg(m, FEATURES, med)
    pos_rows = np.array([list(r) + [rnd.gauss(0, 2), float(rnd.randint(0, 50)), abs(rnd.gauss(0, 3)), abs(rnd.gauss(0, 1))] for r in rows])
    pmed = agent._medians(pos_rows)
    m2 = agent._fit(agent._impute(pos_rows, pmed), y + pos_rows[:, len(FEATURES)] * 0.3)
    exit_ = agent.export_reg(m2, FEATURES + agent.POS_FEATURES, pmed)
    pts = []
    for k in (0, 50, 200, 400):
        f = {key: (None if math.isnan(v) else float(v)) for key, v in zip(FEATURES, rows[k])}
        pf = dict(zip(agent.POS_FEATURES, [float(v) for v in pos_rows[k][len(FEATURES):]]))
        er = agent._impute(rows[k:k + 1], med)[0]
        xr = agent._impute(pos_rows[k:k + 1], pmed)[0]
        pts.append({'features': f, 'pos': pf, 'entry': float(m.predict([er])[0]), 'exit': float(m2.predict([xr])[0]),
                    'entryJson': agent.predict_reg_json(entry, list(er)), 'exitJson': agent.predict_reg_json(exit_, list(xr))})
        assert abs(pts[-1]['entry'] - pts[-1]['entryJson']) < 1e-9 and abs(pts[-1]['exit'] - pts[-1]['exitJson']) < 1e-9
    out = {'agent': {'version': 2, 'kind': 'agent', 'timeframe': '15m', 'threshold': 0.2, 'maxHoldCandles': 96, 'safetyStopPct': 10,
                     'costPct': 0.4, 'entry': entry, 'exit': exit_, 'meta': {}}, 'points': pts}
    dest = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'agent-parity.json')
    with open(dest, 'w') as fh:
        json.dump(out, fh)
    print(f'Geschreven: {dest}')


if __name__ == '__main__':
    main()
    agent_fixture()
