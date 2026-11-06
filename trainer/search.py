"""Strategie-zoeker: probeert doorlopend andere combinaties van winstdoel, stop, maximale duur en
candle-tijd, en houdt een ranglijst bij.

Waarom drie stukken data? Als je veel strategieën test, ziet er altijd wel één goed uit door
puur toeval. Daarom:
  - stuk 1 (oudste 60%): het model leert
  - stuk 2 (volgende 20%): hiermee wordt de strategie beoordeeld en de ranglijst gemaakt
  - stuk 3 (nieuwste 20%): de winnaar moet zich hier nog bewijzen, met de drempel die op stuk 2
    gekozen is. Alleen dan heet hij "bevestigd".
Daarnaast wordt de lat op stuk 2 hoger naarmate er meer strategieën getest zijn.
"""
import math
import random
import time

from features import FEATURES, WARMUP, context, features_at, label_at, series
from train import TF_MS, _impute, evaluate, regime_of, REGIMES

TARGETS = [0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0]
STOPS = [0.8, 1.2, 1.6, 2.0, 2.5, 3.5]
HOLD_MINUTES = [30, 60, 120, 240, 480]
TF_MIN = {'1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240}


def key_of(c):
    return f"{c['timeframe']}|{c['targetPct']:g}|{c['stopPct']:g}|{c['holdMinutes']}"


def all_candidates(timeframes, cost_pct):
    out = []
    for tf in timeframes:
        for t in TARGETS:
            if t < cost_pct * 2:  # winstdoel moet ruim boven de kosten liggen
                continue
            for s in STOPS:
                if s > t * 2.5 or t > s * 4:  # extreme verhoudingen overslaan
                    continue
                for h in HOLD_MINUTES:
                    candles = h // TF_MIN.get(tf, 5)
                    if candles < 4 or candles > 500:
                        continue
                    out.append({'timeframe': tf, 'targetPct': t, 'stopPct': s, 'holdMinutes': h, 'horizon': candles})
    return out


def pick(cands, results, n, rnd):
    """Eerst nog nooit geteste strategieën (willekeurig), daarna de langst geleden geteste."""
    fresh = [c for c in cands if key_of(c) not in results]
    rnd.shuffle(fresh)
    old = sorted((c for c in cands if key_of(c) in results), key=lambda c: results[key_of(c)].get('testedAt', ''))
    return (fresh + old)[:n]


def required_edge(n_tested):
    """Hoe meer strategieën getest, hoe overtuigender de winnaar moet zijn (in % per trade boven zomaar kopen)."""
    return round(0.1 + 0.05 * math.log2(1 + max(0, n_tested)), 3)


def _split3(n, gap):
    a, b = int(n * 0.6), int(n * 0.8)
    return (0, max(0, a - gap)), (a, max(a, b - gap)), (b, n)


def run_round(cfg, results, log=print, fetch=None, markets=None, progress=None, rnd=None):
    """Eén zoekronde. Werkt `results` (dict key -> uitslag) bij en geeft de geteste keys terug."""
    from sklearn.ensemble import GradientBoostingClassifier

    rnd = rnd or random.Random()
    step = progress or (lambda *a: None)
    scfg = cfg.get('search') or {}
    timeframes = scfg.get('timeframes') or [cfg['timeframe']]
    per_round = int(scfg.get('perRound') or 6)
    cands = all_candidates(timeframes, float(cfg['costPct']))
    chosen = pick(cands, results, per_round, rnd)
    if not chosen:
        return []
    pairs = cfg.get('pairs') or markets(int(cfg.get('topN', 15)))
    # Minder voorbeelden dan de hoofdtraining: de zoeker moet veel strategieën kunnen proberen.
    max_samples = max(20_000, int(cfg.get('maxSamples') or 300_000) // 3)
    tested = []
    for tf in sorted({c['timeframe'] for c in chosen}):
        group = [c for c in chosen if c['timeframe'] == tf]
        step('search', 0, len(group), f'Strategie-zoeker: koersen {tf} klaarzetten')
        ctx = None
        try:
            ctx = context(fetch('BTC/EUR', tf, int(cfg['days'])))
        except Exception as e:
            log(f'Zoeker: BTC/EUR {tf} ophalen mislukt: {e}')
        data = []  # per coin: candles, indexen, kenmerken
        per_pair = max(3_000, max_samples // max(1, len(pairs)))
        max_h = max(c['horizon'] for c in group)
        for pair in pairs:
            try:
                candles = fetch(pair, tf, int(cfg['days']))
            except Exception as e:
                log(f'Zoeker: {pair} {tf} ophalen mislukt: {e}')
                continue
            if len(candles) < WARMUP + max_h + 300:
                continue
            s = series(candles)
            stride = max(2, math.ceil(len(candles) / per_pair))
            idx, X = [], []
            for i in range(WARMUP, len(candles) - max_h - 1, stride):
                f = features_at(candles, s, i, ctx)
                if f is None:
                    continue
                idx.append(i)
                X.append([f[k] for k in FEATURES])
            data.append((pair, candles, idx, X))
        if not data:
            log(f'Zoeker: geen bruikbare koersen voor {tf}')
            continue
        for n, c in enumerate(group):
            step('search', n, len(group), f"Strategie {n + 1}/{len(group)}: {tf}, +{c['targetPct']:g}% / -{c['stopPct']:g}%, max {c['holdMinutes']} min")
            started = time.time()
            parts = {'tr': ([], []), 'va': ([], [], []), 'ho': ([], [], [])}
            for pair, candles, idx, X in data:
                labs = [label_at(candles, i, c['targetPct'], c['stopPct'], c['horizon'], cfg['costPct']) for i in idx]
                gap = max(1, c['horizon'] // max(1, (idx[1] - idx[0]) if len(idx) > 1 else 1))
                (a0, a1), (b0, b1), (h0, h1) = _split3(len(idx), gap)
                parts['tr'][0].extend(X[a0:a1])
                parts['tr'][1].extend(l for l, _ in labs[a0:a1])
                for name, (u, v) in (('va', (b0, b1)), ('ho', (h0, h1))):
                    parts[name][0].extend(X[u:v])
                    parts[name][1].extend(l for l, _ in labs[u:v])
                    parts[name][2].extend(r for _, r in labs[u:v])
            trX, trY = parts['tr']
            vaX, vaY, vaR = parts['va']
            hoX, hoY, hoR = parts['ho']
            entry = {**c, 'key': key_of(c), 'testedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                     'days': cfg['days'], 'pairs': len(data)}
            if len(trX) < 1500 or len(vaX) < 200 or len(hoX) < 200 or len(set(trY)) < 2:
                entry.update({'status': 'te weinig data', 'score': None})
                results[entry['key']] = entry
                tested.append(entry['key'])
                continue
            medians = []
            for j in range(len(FEATURES)):
                col = sorted(v for v in (r[j] for r in trX) if v is not None)
                medians.append(col[len(col) // 2] if col else 0.0)
            model = GradientBoostingClassifier(n_estimators=60, max_depth=3, learning_rate=0.1, subsample=0.8,
                                               min_samples_leaf=100, random_state=7)
            model.fit(_impute(trX, medians), trY)
            va = evaluate(list(model.predict_proba(_impute(vaX, medians))[:, 1]), vaY, vaR, cfg)
            best = va['best']
            score = (best['avgReturnPct'] - max(0.0, va['base']['avgReturnPct'])) if best else None
            entry.update({'val': {'auc': va['auc'], 'best': best, 'base': va['base']}, 'score': score,
                          'seconds': round(time.time() - started, 1)})
            # Controle op stuk 3, met de drempel van stuk 2 (niet opnieuw kiezen: dat zou valsspelen zijn).
            if best:
                hp = list(model.predict_proba(_impute(hoX, medians))[:, 1])
                sel = [k for k, p in enumerate(hp) if p >= best['minProb']]
                ho_base = sum(hoR) / len(hoR)
                ho = {'n': len(sel), 'base': ho_base,
                      'avgReturnPct': sum(hoR[k] for k in sel) / len(sel) if sel else None,
                      'winRate': sum(hoY[k] for k in sel) / len(sel) * 100 if sel else None}
                # Per soort markt: waar werkt deze strategie wel en niet?
                regimes = {}
                ti, ai = FEATURES.index('htfTrendPct'), FEATURES.index('atrPct')
                reg = {k: regime_of({'htfTrendPct': hoX[k][ti], 'atrPct': hoX[k][ai]}) for k in sel}
                for name in REGIMES:
                    ks = [k for k in sel if reg[k] == name]
                    if ks:
                        regimes[name] = {'n': len(ks), 'avgReturnPct': sum(hoR[k] for k in ks) / len(ks)}
                ho['regimes'] = regimes
                entry['holdout'] = ho
            results[entry['key']] = entry
            tested.append(entry['key'])
            log(f"Zoeker: {tf} +{c['targetPct']:g}%/-{c['stopPct']:g}% max {c['holdMinutes']} min -> "
                + (f"{best['avgReturnPct']:+.2f}% per trade bij >= {best['minProb']:.0%} (zomaar kopen {va['base']['avgReturnPct']:+.2f}%)" if best else 'geen bruikbare drempel'))
    judge(results)
    return tested


def judge(results):
    """Status van elke strategie, met een lat die meestijgt met het aantal geteste strategieën."""
    n = sum(1 for r in results.values() if r.get('score') is not None)
    need = required_edge(n)
    for r in results.values():
        if r.get('score') is None:
            r.setdefault('status', 'geen bruikbare drempel')
            continue
        best = r['val']['best']
        ho = r.get('holdout') or {}
        if best['avgReturnPct'] <= 0 or r['score'] < need or r['val']['auc'] < 0.52:
            r['status'] = 'niet goed genoeg'
        elif ho.get('avgReturnPct') is not None and ho['n'] >= 30 and ho['avgReturnPct'] > 0 and ho['avgReturnPct'] >= ho['base'] + 0.05:
            r['status'] = 'bevestigd'
        else:
            r['status'] = 'niet bevestigd'
    return need


def leaderboard(results, limit=20):
    rows = sorted(results.values(), key=lambda r: (r.get('status') == 'bevestigd', r.get('score') if r.get('score') is not None else -99), reverse=True)
    return rows[:limit]
