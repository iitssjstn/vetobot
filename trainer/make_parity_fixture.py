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


if __name__ == '__main__':
    main()
