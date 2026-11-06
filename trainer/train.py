"""Traint het voorspelmodel voor vetobot.

1. Haalt de candle-geschiedenis op bij Bitvavo (publieke API, geen keys nodig).
2. Bepaalt voor elk moment in die geschiedenis de uitkomst als je daar had gekocht:
   eerst de winstdoelstelling geraakt (1) of eerst de stop / tijd om (0), na kosten.
3. Traint een gradient-boosting-model op de kenmerken uit features.py.
4. Test op de laatste periode die het model niet gezien heeft, en vergelijkt met
   "zomaar kopen". Alleen als het model echt beter is, wordt het gepubliceerd.
5. Exporteert het model als JSON dat de bot in JavaScript kan uitrekenen.
"""
import json
import math
import time
import urllib.request

from features import FEATURES, WARMUP, features_at, label_at, series

BITVAVO = 'https://api.bitvavo.com/v2'
TF_MS = {'1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
         '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000}


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'vetobot-trainer'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def top_markets(n):
    """De n EUR-markten met het meeste handelsvolume (in euro) van de afgelopen 24 uur."""
    rows = _get(f'{BITVAVO}/ticker/24h')
    eur = [r for r in rows if str(r.get('market', '')).endswith('-EUR') and r.get('volumeQuote')]
    eur.sort(key=lambda r: float(r['volumeQuote']), reverse=True)
    return [r['market'].replace('-', '/') for r in eur[:n]]


def fetch_candles(pair, timeframe, days, log=print):
    """Candles van de afgelopen `days` dagen, oud -> nieuw, alleen gesloten candles."""
    market = pair.replace('/', '-')
    step = TF_MS[timeframe]
    now = int(time.time() * 1000)
    start = now - days * 86_400_000
    end = now
    out = {}
    while end > start:
        rows = _get(f'{BITVAVO}/{market}/candles?interval={timeframe}&limit=1440&start={start}&end={end}')
        if not rows:
            break
        for r in rows:
            ts = int(r[0])
            out[ts] = [ts, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
        oldest = min(int(r[0]) for r in rows)
        if oldest >= end:
            break
        end = oldest - 1
        time.sleep(0.15)  # netjes binnen de rate limit van Bitvavo blijven
    candles = [out[k] for k in sorted(out)]
    return [c for c in candles if c[0] + step <= now]


def build_dataset(candles, cfg, step=2):
    """Kenmerken, labels en rendementen per moment. step=2: elke tweede candle (minder overlap)."""
    s = series(candles)
    X, y, ret, ts = [], [], [], []
    horizon = int(cfg['horizon'])
    for i in range(WARMUP, len(candles) - horizon - 1, step):
        f = features_at(candles, s, i)
        if f is None:
            continue
        lab, r = label_at(candles, i, cfg['targetPct'], cfg['stopPct'], horizon, cfg['costPct'])
        X.append([f[k] for k in FEATURES])
        y.append(lab)
        ret.append(r)
        ts.append(candles[i][0])
    return X, y, ret, ts


def _impute(X, medians):
    return [[medians[j] if (v is None or (isinstance(v, float) and math.isnan(v))) else v for j, v in enumerate(row)] for row in X]


def export_model(model, medians, X_sample):
    """sklearn GradientBoostingClassifier -> JSON dat src/mlmodel.js kan uitrekenen."""
    lr = float(model.learning_rate)
    trees = []
    for est in model.estimators_[:, 0]:
        t = est.tree_
        trees.append({
            'f': [int(v) for v in t.feature],
            't': [float(v) for v in t.threshold],
            'l': [int(v) for v in t.children_left],
            'r': [int(v) for v in t.children_right],
            'v': [float(v[0][0]) for v in t.value],
        })
    # Startwaarde (log-odds van het gemiddelde): afleiden uit één voorspelling.
    row = X_sample[0]

    def tree_sum(row):
        total = 0.0
        for tr in trees:
            n = 0
            while tr['l'][n] != -1:
                n = tr['l'][n] if row[tr['f'][n]] <= tr['t'][n] else tr['r'][n]
            total += tr['v'][n]
        return total

    init = float(model.decision_function([row])[0]) - lr * tree_sum(row)
    return {'init': init, 'learningRate': lr, 'trees': trees, 'medians': medians}


def predict_json(m, row):
    """Zelfde berekening als de bot doet (voor controle)."""
    total = 0.0
    for tr in m['trees']:
        n = 0
        while tr['l'][n] != -1:
            n = tr['l'][n] if row[tr['f'][n]] <= tr['t'][n] else tr['r'][n]
        total += tr['v'][n]
    raw = m['init'] + m['learningRate'] * total
    return 1 / (1 + math.exp(-raw))


def evaluate(probs, y, ret, cfg):
    """Hoe had het model het gedaan op de testperiode, vergeleken met zomaar kopen."""
    from sklearn.metrics import roc_auc_score
    n = len(y)
    base = {'n': n, 'winRate': sum(y) / n * 100, 'avgReturnPct': sum(ret) / n}
    buckets = []
    for thr in (0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7):
        idx = [i for i, p in enumerate(probs) if p >= thr]
        if len(idx) < 20:
            continue
        buckets.append({'minProb': thr, 'n': len(idx), 'winRate': sum(y[i] for i in idx) / len(idx) * 100,
                        'avgReturnPct': sum(ret[i] for i in idx) / len(idx)})
    try:
        auc = float(roc_auc_score(y, probs))
    except ValueError:
        auc = 0.5
    # Alleen drempels met genoeg trades tellen mee; anders is "de beste" vaak toeval.
    min_n = max(50, int(n * 0.03))
    eligible = [b for b in buckets if b['n'] >= min_n]
    best = max(eligible, key=lambda b: b['avgReturnPct'], default=None)
    return {'auc': auc, 'base': base, 'buckets': buckets, 'best': best, 'minTrades': min_n}


def train(cfg, log=print, fetch=fetch_candles, markets=top_markets):
    """Volledige training. Geeft (model_json_of_None, rapport)."""
    from sklearn.ensemble import GradientBoostingClassifier

    started = time.time()
    pairs = cfg.get('pairs') or markets(int(cfg.get('topN', 15)))
    tr_X, tr_y, te_X, te_y, te_ret = [], [], [], [], []
    used = []
    for pair in pairs:
        try:
            candles = fetch(pair, cfg['timeframe'], int(cfg['days']))
        except Exception as e:  # één coin die faalt mag de training niet stoppen
            log(f'{pair}: ophalen mislukt: {e}')
            continue
        if len(candles) < WARMUP + int(cfg['horizon']) + 200:
            log(f'{pair}: te weinig candles ({len(candles)}), overgeslagen')
            continue
        X, y, ret, _ = build_dataset(candles, cfg)
        # Tijdsplitsing per coin: oudste 80% trainen, nieuwste 20% testen (nooit door elkaar).
        cut = int(len(X) * 0.8)
        gap = int(cfg['horizon'])  # geen overlap tussen de laatste trainings- en eerste testuitkomst
        tr_X += X[:max(0, cut - gap)]
        tr_y += y[:max(0, cut - gap)]
        te_X += X[cut:]
        te_y += y[cut:]
        te_ret += ret[cut:]
        used.append(pair)
        log(f'{pair}: {len(candles)} candles, {len(X)} voorbeelden')

    report = {'pairs': used, 'trainSamples': len(tr_X), 'testSamples': len(te_X), 'config': cfg}
    if not used:
        report['published'] = False
        report['reason'] = 'Kon bij geen enkele coin koersen ophalen bij Bitvavo; heeft de VPS internet en klopt de coinlijst?'
        return None, report
    if len(tr_X) < 2000 or len(te_X) < 300 or len(set(tr_y)) < 2:
        report['published'] = False
        report['reason'] = 'Te weinig data om betrouwbaar te trainen'
        return None, report

    # Ontbrekende waarden vullen met de mediaan uit de trainingsdata (de bot doet hetzelfde).
    medians = []
    for j in range(len(FEATURES)):
        col = sorted(v for v in (row[j] for row in tr_X) if v is not None and not (isinstance(v, float) and math.isnan(v)))
        medians.append(col[len(col) // 2] if col else 0.0)
    tr_X = _impute(tr_X, medians)
    te_X = _impute(te_X, medians)

    model = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.05,
                                       subsample=0.8, min_samples_leaf=100, random_state=7)
    model.fit(tr_X, tr_y)
    probs = list(model.predict_proba(te_X)[:, 1])
    metrics = evaluate(probs, te_y, te_ret, cfg)
    exported = export_model(model, medians, te_X)
    # Controle: de JSON-berekening moet gelijk zijn aan sklearn.
    for k in range(min(50, len(te_X))):
        assert abs(predict_json(exported, te_X[k]) - probs[k]) < 1e-6, 'export klopt niet'

    best = metrics['best']
    base = metrics['base']
    # Streng: het model moet op de testperiode echt winst na kosten maken, duidelijk beter zijn
    # dan zomaar kopen, en meer kunnen dan gokken (AUC). Een model dat dat niet haalt, kan
    # je beter niet gebruiken: dan blijft het vorige (of geen) model in gebruik.
    good = (metrics['auc'] >= 0.53 and best is not None and best['avgReturnPct'] > 0
            and best['avgReturnPct'] >= base['avgReturnPct'] + 0.1)
    report.update({
        'metrics': metrics, 'seconds': round(time.time() - started, 1), 'published': good,
        'reason': None if good else 'Het model maakte op de testperiode geen duidelijke winst na kosten; het vorige model blijft in gebruik',
    })
    if not good:
        return None, report
    model_json = {
        'version': 1, 'kind': 'gbdt', 'features': FEATURES, **exported,
        'meta': {
            'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'timeframe': cfg['timeframe'], 'days': cfg['days'], 'targetPct': cfg['targetPct'], 'stopPct': cfg['stopPct'],
            'horizon': cfg['horizon'], 'costPct': cfg['costPct'], 'pairs': used,
            'trainSamples': len(tr_X), 'testSamples': len(te_X), 'metrics': metrics,
            'suggestedMinProb': best['minProb'],
        },
    }
    return model_json, report
