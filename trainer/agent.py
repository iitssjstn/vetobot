"""De AI-trader: een lerende agent die zelf uitzoekt wanneer hij koopt en wanneer hij verkoopt.

Geen vaste winstdoelen, stops of looptijden. De agent kijkt naar de markt en naar zijn eigen
positie, kiest een actie, en krijgt als enige beloning de winst of het verlies in % na kosten.

Hoe hij leert (reinforcement learning, "fitted Q-iteration"):
  1. Verkopen leren. Voor posities op allerlei momenten in het verleden leert hij de waarde van
     "nog een candle vasthouden": de koersverandering van die candle plus de waarde van de beste
     keuze daarna (vasthouden of verkopen). Dat herhaalt hij een aantal keer, zodat hij steeds
     verder vooruit leert kijken. Verkopen heeft waarde 0 (je hebt wat je hebt).
     -> Hij verkoopt zodra de verwachte waarde van vasthouden onder 0 komt.
  2. Kopen leren. Voor elk moment in het verleden speelt hij een aankoop na met zijn eigen
     verkoopgedrag uit stap 1, inclusief kosten. Daarop leert hij de waarde van "nu kopen".
     -> Hij koopt als die verwachte waarde boven een drempel ligt.
  3. Eerlijk testen. De koersgeschiedenis wordt in de tijd gesplitst: 70% leren, 15% om de
     koopdrempel te kiezen, 15% als eindtest die hij nooit eerder zag. Daar handelt hij als
     in het echt (één positie per coin, kosten, veiligheidsstop) en wordt vergeleken met
     "niets doen" en "kopen en vasthouden".

Modellen: HistGradientBoostingRegressor (snel, werkt zonder GPU), geëxporteerd als dezelfde
JSON-bomen die de bot in JavaScript uitrekent.
"""
import math
import random
import time

import numpy as np

import featcache
import resources
import market as market_agent
from features import FEATURES, WARMUP, context

POS_FEATURES = ['posPnlPct', 'posCandles', 'posMaxPct', 'posDrawPct']
TF_MIN = {'1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240}
DEFAULT_TIMEFRAMES = ['15m', '30m', '1h', '5m']


def _fit(X, y, w=None, seed=7, depth=4, leaf=200, iters=120):
    from sklearn.ensemble import HistGradientBoostingRegressor
    m = HistGradientBoostingRegressor(max_iter=iters, max_depth=depth, learning_rate=0.08, min_samples_leaf=leaf,
                                      l2_regularization=1.0, random_state=seed)
    with resources.fit_guard():  # nooit twee trainingen tegelijk; warning-instellingen heel houden
        m.fit(X, y, sample_weight=w)
    return m


def export_reg(model, features, medians):
    """HistGradientBoostingRegressor -> JSON-bomen voor src/mlmodel.js (kind gbdt-reg).
    Uitkomst = init + som van de bladwaarden (de leersnelheid zit al in de bladen)."""
    trees = []
    for pred in model._predictors:
        nodes = pred[0].nodes
        trees.append({
            'f': [int(n['feature_idx']) if not n['is_leaf'] else -2 for n in nodes],
            't': [float(n['num_threshold']) if not n['is_leaf'] else -2.0 for n in nodes],
            'l': [int(n['left']) if not n['is_leaf'] else -1 for n in nodes],
            'r': [int(n['right']) if not n['is_leaf'] else -1 for n in nodes],
            'v': [float(n['value']) for n in nodes],
            'n': [float(n['count']) for n in nodes],
        })
    return {'version': 1, 'kind': 'gbdt-reg', 'features': features, 'init': float(np.ravel(model._baseline_prediction)[0]),
            'learningRate': 1.0, 'medians': medians, 'trees': trees}


def predict_reg_json(m, row):
    total = 0.0
    for t in m['trees']:
        n = 0
        while t['l'][n] != -1:
            n = t['l'][n] if row[t['f'][n]] <= t['t'][n] else t['r'][n]
        total += t['v'][n]
    return m['init'] + m['learningRate'] * total


def _medians(X):
    med = []
    for j in range(X.shape[1]):
        col = X[:, j]
        col = col[~np.isnan(col)]
        med.append(float(np.median(col)) if len(col) else 0.0)
    return med


def _impute(X, med):
    X = X.copy()
    for j, m in enumerate(med):
        bad = np.isnan(X[:, j])
        if bad.any():
            X[bad, j] = m
    return X


def pos_state(entry, price, hmax, h):
    """Kenmerken van de eigen positie: winst nu, hoe lang al, beste stand, terugval vanaf de top."""
    pnl = (price / entry - 1) * 100
    mx = (hmax / entry - 1) * 100
    return [pnl, float(h), mx, mx - pnl]


class Market:
    """Kenmerken van één coin, vooraf uitgerekend (rij per candle; NaN als onbekend)."""

    def __init__(self, pair, candles, ctx, tf=None, cache_dir=None):
        self.pair = pair
        self.c = candles
        # Met opslag (alleen als de BTC-kenmerken er zijn) hoeft alleen het nieuwe stuk uitgerekend.
        self.X = featcache.matrix(pair, tf, candles, ctx, cache_dir if ctx is not None and tf else None)
        self.close = np.array([x[4] for x in candles], dtype=float)
        self.high = np.array([x[2] for x in candles], dtype=float)
        self.low = np.array([x[3] for x in candles], dtype=float)
        self.valid = ~np.isnan(self.X[:, 0])
        self.tf_ms = int(candles[1][0] - candles[0][0]) if len(candles) > 1 else 0


def _split(n, gap=0):
    """Leren, validatie en eindtest in de tijd na elkaar, met een buffer van gap candles (de
    maximale duur van een trade) tussen de delen: een trade aan het eind van het ene deel loopt
    dan nooit door in het volgende."""
    a, b = int(n * 0.70), int(n * 0.85)
    return (WARMUP, a), (a + gap, b), (b + gap, n)


MAX_EXIT_ROWS = 250_000   # plafond voor het aantal leervoorbeelden bij verkopen (geheugen)
MAX_ENTRY_ROWS = 300_000  # en bij kopen


def _pos_block(entry, price, hmax, h):
    """pos_state voor veel rijen tegelijk (numpy)."""
    pnl = (price / entry - 1) * 100
    mx = (hmax / entry - 1) * 100
    return np.column_stack([pnl, h.astype(float), mx, mx - pnl])


def _step_for(markets, part_len, step, per_row, cap):
    """Grotere stap als er anders meer dan cap voorbeelden zouden komen."""
    est = sum(max(0, part_len(mk)) for mk in markets) / step * per_row
    return step if est <= cap else int(math.ceil(step * est / cap))


def learn_exit(markets, H, rnd, say, iters=5, per_entry=6, step=3, fit_kw=None, pol=(1, 0.0)):
    """Stap 1: de waarde van vasthouden leren (fitted Q-iteration).
    Elk voorbeeld: positie geopend op candle i, nu h candles later.
    Per coin als numpy-blok opgebouwd en met een plafond, zodat het geheugen niet meegroeit met
    het aantal dagen en coins."""
    step = _step_for(markets, lambda mk: mk.split[0][1] - H - 2 - mk.split[0][0], step, min(per_entry, H - 1), MAX_EXIT_ROWS)
    S, S2, R, last, held = [], [], [], [], []
    for mk in markets:
        lo, hi = mk.split[0]
        ts, es, hs_, rm, rm2 = [], [], [], [], []
        for i in range(lo, hi - H - 2, step):
            if not mk.valid[i]:
                continue
            entry = mk.close[i]
            hs = sorted(rnd.sample(range(H - 1), min(per_entry, H - 1)))
            run_max = entry
            j_prev = i
            for h in hs:
                t = i + h
                run_max = max(run_max, mk.high[j_prev:t + 1].max())
                j_prev = t + 1
                if not (mk.valid[t] and mk.valid[t + 1]):
                    continue
                ts.append(t)
                es.append(entry)
                hs_.append(h)
                rm.append(run_max)
                rm2.append(max(run_max, mk.high[t + 1]))
        if not ts:
            continue
        t, e, h, r1, r2 = np.array(ts), np.array(es), np.array(hs_), np.array(rm), np.array(rm2)
        p, p2 = mk.close[t], mk.close[t + 1]
        S.append(np.hstack([mk.X[t], _pos_block(e, p, r1, h)]))
        S2.append(np.hstack([mk.X[t + 1], _pos_block(e, p2, r2, h + 1)]))
        R.append((p2 / p - 1) * 100 * (p / e))  # verandering als % van de inleg
        last.append(h + 1 >= H - 1)
        held.append(h + 1)
    if not S:
        return None, None
    S, S2, R, last, held = np.vstack(S), np.vstack(S2), np.concatenate(R), np.concatenate(last), np.concatenate(held)
    if len(S) < 2000:
        return None, None
    med = _medians(S)
    S, S2 = _impute(S, med), _impute(S2, med)
    q2 = np.zeros(len(S))
    model = None
    for k in range(iters):
        # Waarde van de volgende stap volgens het geduld uit het recept: binnen de minimale duur moet
        # hij vasthouden (q2); daarna houdt hij vast zolang q2 >= -marge, anders verkoopt hij (0).
        nxt = np.where(held < pol[0], q2, np.where(q2 >= -pol[1], q2, 0.0))
        y = R + np.where(last, 0.0, nxt)
        model = _fit(S, y, seed=7 + k, **(fit_kw or {}))
        q2 = model.predict(S2)
        say(k)
    return model, med


_WHY = ('einde data', 'veiligheidsstop', 'zelf verkocht', 'maximale duur')


def simulate_exits(mk, idx, exit_model, exit_med, H, safety_stop, pol=(1, 0.0)):
    """Speel aankopen op candles idx na met het geleerde verkoopgedrag. Geeft per aankoop
    (rendement % zonder kosten, aantal candles, reden). Alle aankopen tegelijk per stap (numpy)."""
    m = len(idx)
    if not m:
        return []
    idx = np.asarray(idx, dtype=np.int64)
    n = len(mk.c)
    entry = mk.close[idx]
    runmax = entry.copy()
    ret = np.zeros(m)
    held = np.zeros(m, dtype=np.int64)
    why = np.full(m, -1, dtype=np.int64)
    active = np.arange(m)
    min_hold = max(1, pol[0])
    h = 0
    while len(active) and h < H:
        t = idx[active] + h
        end = t >= n - 1
        if end.any():
            a = active[end]
            ret[a] = (mk.close[np.minimum(t[end], n - 1)] / entry[a] - 1) * 100
            held[a], why[a] = h, 0
            active, t = active[~end], t[~end]
        if h > 0 and len(active):
            runmax[active] = np.maximum(runmax[active], mk.high[t])
            # Veiligheidsstop binnen de candle
            stop = (mk.low[t] / entry[active] - 1) * 100 <= -safety_stop
            if stop.any():
                a = active[stop]
                ret[a], held[a], why[a] = -safety_stop, h, 1
                active, t = active[~stop], t[~stop]
        if not len(active):
            break
        rows = np.hstack([mk.X[t], _pos_block(entry[active], mk.close[t], runmax[active], np.full(len(active), h))])
        q = exit_model.predict(_impute(rows, exit_med))
        # Geduld (uit het recept): minstens pol[0] candles vasthouden, en pas verkopen als de
        # verwachting van langer vasthouden onder -pol[1] % zakt. De noodstop werkt altijd.
        if h >= min_hold:
            sell = q < -pol[1]
            if sell.any():
                a = active[sell]
                ret[a] = (mk.close[t[sell]] / entry[a] - 1) * 100
                held[a], why[a] = h, 2
                active = active[~sell]
        h += 1
    if len(active):
        t = np.minimum(idx[active] + H, n - 1)
        ret[active] = (mk.close[t] / entry[active] - 1) * 100
        held[active], why[active] = H, 3
    return [(float(r), int(d), _WHY[w]) for r, d, w in zip(ret, held, why)]


def learn_entry(markets, exit_model, exit_med, H, cost, safety_stop, step=2, extra=None, fit_kw=None, pol=(1, 0.0)):
    """Stap 2: de waarde van "nu kopen" leren: nagespeeld met het eigen verkoopgedrag, na kosten."""
    X, y, w = [], [], []
    step = _step_for(markets, lambda mk: mk.split[0][1] - H - 2 - mk.split[0][0], step, 1, MAX_ENTRY_ROWS)
    for mk in markets:
        lo, hi = mk.split[0]
        idx = [i for i in range(lo, hi - H - 2, step) if mk.valid[i]]
        if not idx:
            continue
        res = simulate_exits(mk, idx, exit_model, exit_med, H, safety_stop, pol)
        for i, r in zip(idx, res):
            X.append(mk.X[i])
            y.append(r[0] - getattr(mk, 'cost', cost))
            w.append(1.0)
    for row, ret, *weights in extra or []:
        X.append(row)
        y.append(ret)
        w.append(float(weights[0]) if weights else 3.0)
    if len(X) < 1500:
        return None, None
    X = np.array(X, dtype=float)
    med = _medians(X)
    return _fit(_impute(X, med), np.array(y), np.array(w), **(fit_kw or {})), med


def _part_outcomes(mk, part, entry_model, entry_med, exit_model, exit_med, H, safety_stop, pol=(1, 0.0)):
    """Voor één coin en één periode: verwachte waarde per candle en de uitkomst als hij daar
    zou kopen (in één keer uitgerekend, zodat drempels snel te vergelijken zijn)."""
    lo, hi = mk.split[part]
    cand = [i for i in range(lo, hi - 1) if mk.valid[i]]
    if not cand:
        return {}, lo, hi
    q = entry_model.predict(_impute(mk.X[cand], entry_med))
    idx = [i for i, v in zip(cand, q) if v > 0]
    res = simulate_exits(mk, idx, exit_model, exit_med, H, safety_stop, pol) if idx else []
    qmap = dict(zip(cand, q))
    return {i: (qmap[i], r) for i, r in zip(idx, res)}, lo, hi


def _times(mk):
    """Tijdstippen van de candles als numpy-array (zuinig: 8 bytes per candle)."""
    if getattr(mk, 'ts', None) is None:
        mk.ts = np.fromiter((x[0] for x in mk.c), dtype=np.int64, count=len(mk.c))
    return mk.ts


def _find(ts, t):
    j = int(np.searchsorted(ts, t))
    return j if j < len(ts) and ts[j] == t else None


def market_move(bench, t0, t1):
    """Wat de markt deed tussen twee tijdstippen: gemiddelde koersverandering (%) van alle coins
    die op beide momenten een candle hebben. None als geen enkele coin dat heeft."""
    moves = []
    for m in bench:
        ts = _times(m)
        a, b = _find(ts, t0), _find(ts, t1)
        if a is not None and b is not None and m.close[a] > 0:
            moves.append((m.close[b] / m.close[a] - 1) * 100)
    return sum(moves) / len(moves) if moves else None


def portfolio(trades, markets, slots=2, start=100.0):
    """Een echte portefeuille door de tijd: startvermogen, hooguit `slots` trades tegelijk, elke
    nieuwe trade krijgt een gelijk deel van het vermogen (vermogen / slots, nooit meer dan het vrije
    geld). Trades van alle coins op echte tijd door elkaar; is alles bezet, dan wordt een trade
    overgeslagen. Het vermogen wordt elke candle gewaardeerd tegen de koers van dat moment, dus ook
    verlies tijdens een trade telt mee in de terugval.
    trades: [{'pair', 'i' (candle van kopen), 'held' (candles), 'ret' (% na kosten), 'mkt' (% markt)}].
    Geeft returnPct, excessPct (resultaat boven de markt tijdens de trades), maxDrawdownPct (% van
    het vermogen), underwaterDays (langste periode onder de top), taken en skipped."""
    if not trades:
        return {'returnPct': 0.0, 'excessPct': 0.0, 'maxDrawdownPct': 0.0, 'underwaterDays': 0.0, 'taken': 0, 'skipped': 0}
    mks = {m.pair: m for m in markets}
    for m in mks.values():
        _times(m)
    entries = sorted(trades, key=lambda t: (int(mks[t['pair']].ts[t['i']]), t['pair']))
    grid = sorted({int(mks[t['pair']].ts[j]) for t in trades
                   for j in range(t['i'], min(t['i'] + max(1, t['held']), len(mks[t['pair']].ts) - 1) + 1)})
    cash, excess, open_, k = start, 0.0, [], 0
    peak, dd, taken, skipped = start, 0.0, 0, 0
    under_since, under_max = None, 0
    for now in grid:
        # Eerst verkopen wat nu afloopt, dan kopen.
        keep = []
        for p in open_:
            if p['exit_ts'] <= now:
                cash += p['alloc'] * (1 + p['ret'] / 100)
                if p['mkt'] is not None:
                    excess += p['alloc'] * (p['ret'] - p['mkt']) / 100
            else:
                keep.append(p)
        open_ = keep
        while k < len(entries) and int(mks[entries[k]['pair']].ts[entries[k]['i']]) <= now:
            t = entries[k]
            k += 1
            if len(open_) >= slots or any(p['pair'] == t['pair'] for p in open_):
                skipped += 1
                continue
            m = mks[t['pair']]
            equity = cash + sum(_value(p, now) for p in open_)
            alloc = min(cash, equity / slots)
            if alloc <= 0:
                skipped += 1
                continue
            end = min(t['i'] + max(1, t['held']), len(m.ts) - 1)
            cash -= alloc
            open_.append({'pair': t['pair'], 'm': m, 'i': t['i'], 'alloc': alloc, 'ret': t['ret'], 'mkt': t.get('mkt'),
                          'exit_ts': int(m.ts[end])})
            taken += 1
        equity = cash + sum(_value(p, now) for p in open_)
        if equity >= peak:
            peak = equity
            if under_since is not None:
                under_max = max(under_max, now - under_since)
            under_since = None
        else:
            dd = max(dd, (peak - equity) / peak * 100)
            under_since = now if under_since is None else under_since
    for p in open_:
        cash += p['alloc'] * (1 + p['ret'] / 100)
        if p['mkt'] is not None:
            excess += p['alloc'] * (p['ret'] - p['mkt']) / 100
    if under_since is not None:
        under_max = max(under_max, grid[-1] - under_since)
    return {'returnPct': (cash / start - 1) * 100, 'excessPct': excess / start * 100, 'maxDrawdownPct': dd,
            'underwaterDays': round(under_max / 86_400_000, 1), 'taken': taken, 'skipped': skipped}


def _value(p, now):
    """Waarde van een open positie op tijdstip now (slotkoers van die candle)."""
    m = p['m']
    j = int(np.searchsorted(m.ts, now, side='right')) - 1
    j = max(p['i'], min(j, len(m.close) - 1))
    return p['alloc'] * m.close[j] / m.close[p['i']]


def _by_regime(trades):
    """Resultaat per marktfase bij het kopen (voor de Strategy Agent)."""
    out = {}
    for reg in {t['reg'] for t in trades if t.get('reg')}:
        ts = [t for t in trades if t.get('reg') == reg]
        cmp = [t for t in ts if t['mkt'] is not None]
        out[reg] = {'trades': len(ts), 'avgPct': sum(t['ret'] for t in ts) / len(ts),
                    'edgePct': sum(t['ret'] - t['mkt'] for t in cmp) / len(cmp) if cmp else None}
    return out


def backtest(markets, part, entry_model, entry_med, exit_model, exit_med, H, cost, safety_stop, thresholds, cache=None, bench=None, regimes=None, slots=2, pol=(1, 0.0)):
    """Handelen zoals in het echt op een deel van de tijd (1 = validatie, 2 = eindtest):
    één positie per coin, kopen als de verwachte waarde > drempel, verkopen met het geleerde
    gedrag. Geeft per drempel het resultaat, ook vergeleken met de markt (bench: de coins waarmee
    vergeleken wordt, standaard dezelfde) tijdens precies dezelfde trades. Met regimes (Market
    Agent) ook per marktfase bij het kopen."""
    if cache is None:
        cache = {}
    bench = bench or markets
    out = {}
    for thr in thresholds:
        trades, bh = [], []
        for mk in markets:
            key = (mk.pair, part)
            if key not in cache:
                cache[key] = _part_outcomes(mk, part, entry_model, entry_med, exit_model, exit_med, H, safety_stop, pol)
            oc, lo, hi = cache[key]
            if hi - lo < 10:
                continue
            c_mk = getattr(mk, 'cost', cost)
            bh.append((mk.close[hi - 1] / mk.close[lo] - 1) * 100 - c_mk)
            i = lo
            while i < hi - 1:
                o = oc.get(i)
                if o and o[0] > thr:
                    ret, held, why = o[1]
                    end = min(i + held, len(mk.c) - 1)
                    mkt = market_move(bench, int(mk.c[i][0]), int(mk.c[end][0]))
                    reg = regimes.at(mk.pair, int(mk.c[i][0]) + mk.tf_ms) if regimes else None
                    trades.append({'pair': mk.pair, 'i': i, 'ret': ret - c_mk, 'held': held, 'why': why, 'mkt': mkt, 'reg': reg})
                    i += max(1, held)
                else:
                    i += 1
        n = len(trades)
        total = sum(t['ret'] for t in trades)
        # Risico: de terugval van een echte portefeuille (zoveel trades tegelijk als de bot, op echte
        # tijd, ook verlies tijdens een trade), in % van het vermogen.
        pf = portfolio(trades, markets, slots)
        dd = pf['maxDrawdownPct']
        # Vergelijken met meedobberen: wat de markt tijdens elke trade deed, en het voordeel daarboven.
        cmp = [t for t in trades if t['mkt'] is not None]
        out[thr] = {
            'marketPct': sum(t['mkt'] for t in cmp) / len(cmp) if cmp else None,
            'edgePct': sum(t['ret'] - t['mkt'] for t in cmp) / len(cmp) if cmp else None,
            'beatMarketRate': sum(1 for t in cmp if t['ret'] > t['mkt']) / len(cmp) * 100 if cmp else None,
            'maxDrawdownPct': dd, 'portfolio': pf, 'worstPct': min((t['ret'] for t in trades), default=None),
            'trades': n, 'avgPct': total / n if n else None, 'totalPct': total,
            'winRate': sum(1 for t in trades if t['ret'] > 0) / n * 100 if n else None,
            'avgHeld': sum(t['held'] for t in trades) / n if n else None,
            'buyHoldPct': sum(bh) / len(bh) if bh else None,
            'exits': {k: sum(1 for t in trades if t['why'] == k) for k in ('zelf verkocht', 'veiligheidsstop', 'maximale duur', 'einde data')},
            'byRegime': _by_regime(trades),
            'byPair': {p: {'trades': sum(1 for t in trades if t['pair'] == p), 'totalPct': sum(t['ret'] for t in trades if t['pair'] == p)}
                       for p in {t['pair'] for t in trades}},
        }
    return out


RECIPE_DEFAULT = {'timeframe': '15m', 'holdDays': 2, 'depth': 4, 'leaf': 200, 'look': 5, 'minHold': 1, 'margin': 0.0}
MIN_TEST_AVG = 0.1     # gemiddeld minstens zoveel % per trade in de eindtest
MIN_TEST_TRADES = 30   # en minstens zoveel trades, anders kan het toeval zijn


def recipe_text(r):
    """Een recept in gewone taal."""
    import thoughts as T
    depth = {3: 'eenvoudig', 4: 'gemiddeld', 6: 'uitgebreid'}.get(r['depth'], str(r['depth']))
    txt = (f"{r['timeframe']}-candles, hooguit {T.hold(int(r['holdDays'] * 1440))} vasthouden, {depth} model, "
           f"{r['look']} stappen vooruitkijken")
    if r.get('minHold', 1) != 1:
        txt += f", minstens {r['minHold']} candles vasthouden"
    if r.get('margin', 0) != 0:
        txt += f", verkopen pas onder -{r['margin']:g}%".replace('.', ',')
    return txt


THRESHOLDS = (0.0, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2)
# Eerdere periodes: leren tot fractie a van de geschiedenis, testen op a..b (met buffer). De gewone
# validatie (0,70..0,85) is de laatste periode; de eindtest (0,85..1) blijft de controle.
FOLDS = ((0.40, 0.55), (0.55, 0.70))


def _before(extra, ts):
    """Echte trades die helemaal vóór tijdstip ts liggen (anders lekt de testperiode in het leren)."""
    return [(row, ret, t[2]) if len(t) > 2 else (row, ret) for row, ret, *t in extra
            if t and t[0] and t[0] < ts and (len(t) < 2 or (t[1] and t[0] <= t[1] < ts))]


def _fold(markets, a, b, H, rnd, recipe, fit_kw, pol, cost, safety, extra, regimes, slots):
    """Eén eerdere periode: leer op [begin, a], test op [a + buffer, b]. Geeft het resultaat per
    koopdrempel, of None als er te weinig data is."""
    saved = [mk.split for mk in markets]
    try:
        for mk in markets:
            n = len(mk.c)
            mk.split = ((WARMUP, int(n * a)), (int(n * a) + H, int(n * b)), (int(n * b), int(n * b)))
        exit_model, exit_med = learn_exit(markets, H, rnd, lambda k: None, iters=recipe['look'], fit_kw=fit_kw, pol=pol)
        if exit_model is None:
            return None
        start = min(int(mk.c[mk.split[1][0]][0]) for mk in markets)
        entry_model, entry_med = learn_entry(markets, exit_model, exit_med, H, cost, safety, extra=_before(extra, start), fit_kw=fit_kw, pol=pol)
        if entry_model is None:
            return None
        return backtest(markets, 1, entry_model, entry_med, exit_model, exit_med, H, cost, safety, THRESHOLDS,
                        bench=markets, regimes=regimes, slots=slots, pol=pol)
    finally:
        for mk, sp in zip(markets, saved):
            mk.split = sp


def train_agent(cfg, recipe, fetch, pairs, log=print, progress=None, extra=None, seed=1):
    """Train een AI-trader volgens een recept (candle-tijd, maximale duur, modelgrootte, hoe ver
    vooruitkijken). Kiest zelf de koopdrempel én de coins (op de validatie), en test daarna eerlijk.
    Geeft (agent_json_of_None, rapport)."""
    if isinstance(recipe, str):
        recipe = {**RECIPE_DEFAULT, 'timeframe': recipe}
    recipe = {**RECIPE_DEFAULT, **recipe}
    tf = recipe['timeframe']
    step = progress or (lambda *a: None)
    started = time.time()
    rnd = random.Random(seed)
    cost = float(cfg['costPct'])
    safety = float((cfg.get('agent') or {}).get('safetyStopPct') or 10)
    slots = int((cfg.get('agent') or {}).get('maxOpen') or 2)
    # Geduld bij verkopen: minimaal vasthouden (candles) en verkoopmarge (%), zoekt hij zelf uit.
    pol = (int(recipe.get('minHold', 1)), float(recipe.get('margin', 0.0)))
    H = int(min(400, max(12, recipe['holdDays'] * 1440 // TF_MIN.get(tf, 15))))
    fit_kw = {'depth': recipe['depth'], 'leaf': recipe['leaf']}
    step('agent', 0, 5, f'AI-trader {tf}: koersen klaarzetten')
    try:
        ctx = context(fetch('BTC/EUR', tf, int(cfg['days'])))
    except Exception:
        ctx = None
    markets = []
    for pair in pairs:
        try:
            c = fetch(pair, tf, int(cfg['days']))
        except Exception as e:
            log(f'AI-trader: {pair} {tf} ophalen mislukt: {e}')
            continue
        if len(c) < WARMUP + 6 * H:
            continue
        mk = Market(pair, c, ctx, tf, cfg.get('featureCache'))
        mk.split = _split(len(c), H)
        # Werkelijke kosten van deze coin (gemeten door de bot), anders de ingestelde kosten.
        mk.cost = float((cfg.get('costs') or {}).get(pair, cost))
        markets.append(mk)
    base = {'timeframe': tf, 'recipe': recipe, 'ok': False}
    if len(markets) < 1:
        return None, {**base, 'reason': 'Te weinig koersen voor dit recept'}
    step('agent', 1, 5, f'AI-trader {tf}: leren wanneer verkopen')
    exit_model, exit_med = learn_exit(markets, H, rnd, lambda k: step('agent', 1, 5, f"AI-trader {tf}: verkopen leren, stap {k + 1}/{recipe['look']}"),
                                      iters=recipe['look'], fit_kw=fit_kw, pol=pol)
    if exit_model is None:
        return None, {**base, 'reason': 'Te weinig voorbeelden om verkopen te leren'}
    step('agent', 2, 5, f'AI-trader {tf}: leren wanneer kopen')
    # Echte trades van de bot alleen als ze vóór de validatie liggen: anders lekt de eindtest
    # (die altijd de nieuwste periode is) in het leren.
    val_start = min(int(mk.c[mk.split[1][0]][0]) for mk in markets)
    extra_all = extra or []
    extra = _before(extra_all, val_start)
    entry_model, entry_med = learn_entry(markets, exit_model, exit_med, H, cost, safety, extra=extra, fit_kw=fit_kw, pol=pol)
    if entry_model is None:
        return None, {**base, 'reason': 'Te weinig voorbeelden om kopen te leren'}
    step('agent', 3, 5, f'AI-trader {tf}: koopdrempel en coins kiezen')
    # Koopdrempel kiezen op de validatieperiode (niet op de eindtest). Het resultaat op de validatie
    # (alle coins) is ook waarop recepten gekozen en gerangschikt worden; de eindtest is alleen de
    # controle (goed genoeg: ja of nee).
    regimes = market_agent.build(fetch, [m.pair for m in markets], int(cfg['days']), log=log, cache_dir=cfg.get('featureCache'))
    vals = backtest(markets, 1, entry_model, entry_med, exit_model, exit_med, H, cost, safety, THRESHOLDS,
                    bench=markets, regimes=regimes, slots=slots, pol=pol)
    # Eerdere periodes (walk-forward): hetzelfde recept opnieuw geleerd op een korter stuk verleden en
    # getest op de periode erna. Werkt een recept in meerdere periodes, dan is het minder vaak toeval.
    ref = max(markets, key=lambda m: len(m.c))
    when = lambda i: time.strftime('%Y-%m-%d %H:%M', time.gmtime(ref.c[min(i, len(ref.c) - 1)][0] / 1000))
    folds = []
    # Alleen de moeite waard als het recept op de gewone validatie al winst maakt; anders valt het
    # toch af en sparen we de rekentijd voor het volgende recept.
    promising = any(v['trades'] >= max(10, len(markets) * 2) and v['totalPct'] > 0 for v in vals.values())
    for k, (fa, fb) in enumerate(FOLDS if promising and cfg.get('folds', True) else ()):
        step('agent', 3, 5, f'AI-trader {tf}: eerdere periode {k + 1}/{len(FOLDS)} leren en testen')
        fv = _fold(markets, fa, fb, H, random.Random(seed * 1000 + k), recipe, fit_kw, pol, cost, safety, extra_all, regimes, slots)
        if fv:
            lo, hi = int(len(ref.c) * fa) + H, int(len(ref.c) * fb)
            folds.append({'period': [when(lo), when(hi - 1)], 'vals': fv})
    folds.append({'period': [when(ref.split[1][0]), when(ref.split[1][1] - 1)], 'vals': vals})
    # Koopdrempel: het meeste resultaat over alle periodes samen (genoeg trades in de laatste).
    best = None
    for thr, v in vals.items():
        total = sum(f['vals'][thr]['totalPct'] for f in folds)
        if v['trades'] >= max(10, len(markets) * 2) and (best is None or total > best[2]):
            best = (thr, v, total)
    if best is None:
        return None, {**base, 'reason': 'Op de validatie vond hij geen drempel met genoeg trades'}
    thr, val = best[0], best[1]
    fold_rows = [{'period': f['period'], **{x: f['vals'][thr].get(x) for x in ('trades', 'avgPct', 'totalPct', 'edgePct', 'maxDrawdownPct')}} for f in folds]
    fold_pos = sum(1 for f in fold_rows if f['trades'] and f['totalPct'] > 0)
    # Coins kiezen, ook op de validatie (alle periodes samen): alleen coins waar hij daar winst maakte.
    bp = {}
    for f in folds:
        for p, x in (f['vals'][thr].get('byPair') or {}).items():
            b = bp.setdefault(p, {'trades': 0, 'totalPct': 0.0})
            b['trades'] += x['trades']
            b['totalPct'] += x['totalPct']
    coins = [m.pair for m in markets if bp.get(m.pair, {}).get('trades', 0) >= 2 and bp[m.pair]['totalPct'] > 0]
    if not coins:
        coins = [m.pair for m in markets]
    chosen = [m for m in markets if m.pair in coins]
    step('agent', 4, 5, f'AI-trader {tf}: eindtest')
    test = backtest(chosen, 2, entry_model, entry_med, exit_model, exit_med, H, cost, safety, (thr,), bench=markets, regimes=regimes, slots=slots, pol=pol)[thr]
    days_test = sum((mk.split[2][1] - mk.split[2][0]) for mk in chosen) / len(chosen) * TF_MIN.get(tf, 15) / 1440
    # Alleen goed als hij ook beter deed dan meedobberen met de markt tijdens zijn trades.
    # En alleen als het in de meeste periodes werkte (alle op één na), niet in één toevallig goede.
    ok = bool(val['totalPct'] > 0 and test['trades'] >= MIN_TEST_TRADES and (test['avgPct'] or 0) >= MIN_TEST_AVG
              and (test.get('edgePct') is None or test['edgePct'] > 0) and fold_pos >= max(1, len(fold_rows) - 1))
    periods = {name: [when(lo), when(hi - 1)] for name, (lo, hi) in zip(('leren', 'validatie', 'eindtest'), ref.split)}
    report = {**base, 'ok': ok, 'threshold': thr, 'validation': val, 'test': test, 'testDays': round(days_test, 1), 'periods': periods,
              'folds': fold_rows if len(fold_rows) > 1 else None, 'foldsPositive': fold_pos if len(fold_rows) > 1 else None,
              'pairs': [m.pair for m in markets], 'coins': coins, 'maxHold': H, 'seconds': round(time.time() - started)}
    try:
        report['exitFocus'] = _importance(exit_model, FEATURES + POS_FEATURES, markets, exit_med, H)
    except Exception:
        pass
    agent = {
        'version': 2, 'kind': 'agent', 'timeframe': tf, 'threshold': thr, 'maxHoldCandles': H, 'safetyStopPct': safety,
        'minHoldCandles': pol[0], 'exitMarginPct': pol[1],
        'costPct': round(sum(m.cost for m in chosen) / len(chosen), 4), 'costs': {m.pair: round(m.cost, 4) for m in chosen}, 'coins': coins, 'recipe': recipe, 'entry': export_reg(entry_model, FEATURES, entry_med),
        'exit': export_reg(exit_model, FEATURES + POS_FEATURES, exit_med),
        'meta': {'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'report': report},
    }
    return agent, report


def _importance(model, names, markets, med, H, n=3000):
    """Grove "waar let hij op": hoeveel de verkoopwaarde verandert als je één kenmerk door elkaar husselt."""
    rng = np.random.default_rng(3)
    rows = []
    for mk in markets:
        lo, hi = mk.split[0]
        for i in rng.integers(lo, max(lo + 1, hi - H - 2), size=max(1, n // len(markets))):
            h = int(rng.integers(1, H - 1))
            t = i + h
            if t < len(mk.c) and mk.valid[t]:
                rows.append(list(mk.X[t]) + pos_state(mk.close[i], mk.close[t], mk.high[i:t + 1].max(), h))
    X = _impute(np.array(rows, dtype=float), med)
    base = model.predict(X)
    out = []
    for j, k in enumerate(names):
        Xs = X.copy()
        rng.shuffle(Xs[:, j])
        out.append((k, float(np.mean(np.abs(model.predict(Xs) - base)))))
    out.sort(key=lambda x: -x[1])
    return out[:6]
