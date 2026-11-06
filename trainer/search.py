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
from train import TF_MS, _impute, evaluate, export_model, regime_of, REGIMES

TARGETS = [0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]
STOPS = [0.8, 1.2, 1.6, 2.0, 2.5, 3.5, 5.0]
HOLD_MINUTES = [30, 60, 120, 240, 480, 720, 1440]
TF_ORDER = ['1m', '5m', '15m', '30m', '1h', '2h', '4h']
# Niets gekozen: deze candle-tijden (1m verliest bijna altijd door de kosten).
DEFAULT_TIMEFRAMES = ['5m', '15m', '30m', '1h']
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


def neighbours(c, cands_by_key):
    """Strategieën die één stapje verschillen (doel, stop, duur of candle-tijd)."""
    out = []
    for field, grid in (('targetPct', TARGETS), ('stopPct', STOPS), ('holdMinutes', HOLD_MINUTES), ('timeframe', TF_ORDER)):
        if c[field] not in grid:
            continue
        i = grid.index(c[field])
        for j in (i - 1, i + 1):
            if 0 <= j < len(grid):
                k = key_of({**c, field: grid[j]})
                if k in cands_by_key:
                    out.append(cands_by_key[k])
    return out


def promising(results, n=3):
    """De beste strategieën tot nu toe (bevestigd eerst, dan op score), om verder op te bouwen."""
    rows = [r for r in results.values() if r.get('score') is not None and r['score'] > 0]
    rows.sort(key=lambda r: (r.get('status') == 'bevestigd', r['score']), reverse=True)
    return rows[:n]


def pick(cands, results, n, rnd):
    """Welke strategieën deze ronde?

    - Ongeveer de helft: "verder bouwen" op wat goed werkt, door strategieën te proberen die
      één stapje verschillen van de beste tot nu toe (iets hoger doel, iets ruimere stop, ...).
    - De beste wordt af en toe opnieuw getest op de nieuwste koersen (werkt hij nog steeds?).
    - De rest: nog nooit geteste strategieën (ontdekken), daarna de langst geleden geteste.
    """
    by_key = {key_of(c): c for c in cands}
    chosen, seen = [], set()

    def add(c):
        k = key_of(c)
        if k not in seen and len(chosen) < n:
            seen.add(k)
            chosen.append(c)

    top = promising(results)
    if top:
        # De nummer 1 opnieuw testen als dat al even geleden is (de markt verandert).
        best = top[0]
        if best['key'] in by_key and best.get('testedAt', '') < time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 6 * 3600)):
            add(by_key[best['key']])
        near = [c for t in top if t['key'] in by_key for c in neighbours(by_key[t['key']], by_key)]
        fresh_near = [c for c in near if key_of(c) not in results]
        rnd.shuffle(fresh_near)
        for c in fresh_near[:max(1, n // 2)]:
            add(c)
    fresh = [c for c in cands if key_of(c) not in results]
    rnd.shuffle(fresh)
    old = sorted((c for c in cands if key_of(c) in results), key=lambda c: results[key_of(c)].get('testedAt', ''))
    for c in fresh + old:
        add(c)
    return chosen


def choose_champion(results, current):
    """Nieuwe beste strategie? Alleen bevestigde tellen. Overstappen als er nog geen is, als de
    huidige niet meer bevestigd is (bij opnieuw testen), of als een andere duidelijk beter is."""
    ok = [r for r in results.values() if r.get('status') == 'bevestigd']
    if not ok:
        return None
    best = max(ok, key=lambda r: r['score'])
    cur = results.get(current) if current else None
    if not cur or cur.get('status') != 'bevestigd':
        return best['key']
    if best['key'] != current and best['score'] >= cur['score'] + 0.05:
        return best['key']
    return None


def required_edge(n_tested):
    """Hoe meer strategieën getest, hoe overtuigender de winnaar moet zijn (in % per trade boven zomaar kopen)."""
    return round(0.1 + 0.05 * math.log2(1 + max(0, n_tested)), 3)


def _split3(n, gap):
    a, b = int(n * 0.6), int(n * 0.8)
    return (0, max(0, a - gap)), (a, max(a, b - gap)), (b, n)


def run_round(cfg, results, log=print, fetch=None, markets=None, progress=None, rnd=None, should_stop=None, models_out=None):
    """Eén zoekronde. Werkt `results` (dict key -> uitslag) bij en geeft de geteste keys terug."""
    from sklearn.ensemble import GradientBoostingClassifier

    rnd = rnd or random.Random()
    step = progress or (lambda *a: None)
    scfg = cfg.get('search') or {}
    timeframes = scfg.get('timeframes') or DEFAULT_TIMEFRAMES
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
            if should_stop and should_stop():
                log('Zoeker: gepauzeerd voor een training')
                judge(results)
                return tested
            hold = f"{c['holdMinutes'] / 60:g} uur" if c['holdMinutes'] >= 60 else f"{c['holdMinutes']} min"
            step('search', n, len(group), f"Strategie {n + 1}/{len(group)}: {tf}, +{c['targetPct']:g}% / −{c['stopPct']:g}%, max {hold}".replace('.', ','))
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
            # Model bewaren (wordt een "arm" voor het zelflerend kiezen als de strategie bevestigd wordt).
            if best and models_out is not None:
                Xi = _impute(trX[:1], medians)
                models_out[entry['key']] = {
                    'version': 1, 'kind': 'gbdt', 'features': FEATURES, **export_model(model, medians, Xi),
                    'meta': {'trainedAt': entry['testedAt'], 'timeframe': tf, 'targetPct': c['targetPct'], 'stopPct': c['stopPct'],
                             'horizon': c['horizon'], 'costPct': cfg['costPct'], 'days': cfg['days'],
                             'metrics': {'auc': va['auc'], 'best': best, 'base': va['base']}, 'suggestedMinProb': best['minProb']},
                }
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
