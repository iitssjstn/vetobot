"""De AI-trader zoekt zelf de beste manier van traden.

Een "recept" is hoe hij leert en handelt: op welke candle-tijd, hoe lang hij een positie
hooguit vasthoudt, hoe groot zijn model is, en hoe ver hij vooruitkijkt bij het leren. De
koopdrempel en welke coins hij handelt kiest hij per training zelf (op de validatie).

Elke ronde probeert hij één recept: een variatie op zijn beste tot nu toe, zijn beste opnieuw
(werkt het nog steeds?), of iets nieuws. Hij bewaart per recept de laatste rondes en beoordeelt
een recept op het gemiddelde daarvan, niet op één toevallig goede ronde. Een recept is pas
"betrouwbaar" als het in meerdere rondes standhoudt.
"""
import random
import time

SPACE = {
    'timeframe': ['5m', '15m', '30m', '1h', '2h', '4h'],
    'holdDays': [0.5, 1, 2, 4],
    'depth': [3, 4, 6],
    'leaf': [100, 200, 400],
    'look': [3, 5, 8],
}
ORDER = ['timeframe', 'holdDays', 'depth', 'leaf', 'look']
KEEP_ROUNDS = 6
RELIABLE_ROUNDS = 2       # zoveel rondes met eindtest voordat een recept "betrouwbaar" kan zijn
RELIABLE_AVG = 0.1        # gewogen gemiddeld minstens zoveel % per trade in de eindtests
RELIABLE_TRADES = 60      # samen minstens zoveel eindtest-trades
MAX_DRAWDOWN = 15         # grootste terugval in een eindtest (opgeteld % per trade) mag niet groter zijn


def key_of(r):
    return '|'.join(f'{r[k]:g}' if isinstance(r[k], float) else str(r[k]) for k in ORDER)


def all_recipes(timeframes):
    out = [{}]
    for k in ORDER:
        vals = [v for v in SPACE[k] if k != 'timeframe' or v in timeframes]
        out = [{**o, k: v} for o in out for v in vals]
    return out


def neighbours(r, allowed):
    out = []
    for k in ORDER:
        vals = SPACE[k]
        if r.get(k) not in vals:
            continue
        i = vals.index(r[k])
        for j in (i - 1, i + 1):
            if 0 <= j < len(vals):
                n = {**r, k: vals[j]}
                if key_of(n) in allowed:
                    out.append(n)
    return out


def score(entry):
    """Beoordeling van een recept over al zijn rondes: gewogen gemiddeld resultaat per trade in
    de eindtests (gewogen naar aantal trades), plus hoeveel rondes en trades erachter zitten."""
    rounds = [x for x in entry.get('rounds', []) if (x.get('test') or {}).get('trades')]
    n = sum(x['test']['trades'] for x in rounds)
    if not n:
        return {'avg': None, 'trades': 0, 'rounds': len(entry.get('rounds', [])), 'tested': 0, 'positive': 0, 'drawdown': None, 'safe': None}
    avg = sum(x['test']['avgPct'] * x['test']['trades'] for x in rounds) / n
    dd = max((x['test'].get('maxDrawdownPct') or 0) for x in rounds)
    # Risico-gewogen: winst per trade, minus een straf voor grote terugvallen. Liever iets minder
    # winst met kleine verliezen dan veel winst met diepe dalen.
    safe = avg - dd / 100
    return {'avg': avg, 'trades': n, 'rounds': len(entry.get('rounds', [])), 'tested': len(rounds),
            'positive': sum(1 for x in rounds if x['test']['avgPct'] > 0), 'drawdown': dd, 'safe': safe}


def status(entry):
    """betrouwbaar: houdt stand over meerdere rondes · veelbelovend: één goede ronde, moet zich nog
    herhalen · oefenen: nog geen winst · afgevallen: meerdere rondes verlies."""
    sc = score(entry)
    if sc['avg'] is None:
        return 'oefenen'
    last_ok = bool(entry['rounds'] and entry['rounds'][-1].get('ok'))
    if (sc['tested'] >= RELIABLE_ROUNDS and sc['avg'] >= RELIABLE_AVG and sc['trades'] >= RELIABLE_TRADES
            and sc['positive'] >= sc['tested'] - 1 and last_ok and sc['drawdown'] <= MAX_DRAWDOWN):
        return 'betrouwbaar'
    if sc['tested'] >= 3 and sc['avg'] < 0:
        return 'afgevallen'
    if last_ok:
        return 'veelbelovend'
    return 'oefenen'


def rank_key(entry):
    st = status(entry)
    sc = score(entry)
    order = {'betrouwbaar': 3, 'veelbelovend': 2, 'oefenen': 1, 'afgevallen': 0}[st]
    return (order, sc['safe'] if sc['safe'] is not None else -99, sc['trades'])


def leaderboard(recipes, limit=12):
    rows = sorted(recipes.values(), key=rank_key, reverse=True)
    return rows[:limit]


def tf_weight(recipes, tf):
    """Leert van eerdere rondes: candle-tijden waar het steeds verlies gaf, krijgt minder kansen."""
    sc = [score(e) for e in recipes.values() if e['recipe']['timeframe'] == tf]
    sc = [x for x in sc if x['avg'] is not None]
    if len(sc) < 3:
        return 1.0
    avg = sum(x['avg'] for x in sc) / len(sc)
    if len(sc) >= 6 and all(x['avg'] < 0 for x in sc):
        return 0.1
    return max(0.2, min(3.0, 1.0 + avg * 5))


def pick(recipes, timeframes, rnd=None, now=None):
    """Welk recept deze ronde, en waarom. Geeft (recept, reden)."""
    rnd = rnd or random.Random()
    now = now or time.time()
    allowed = {key_of(r): r for r in all_recipes(timeframes)}
    board = [e for e in leaderboard(recipes, 5) if key_of(e['recipe']) in allowed and status(e) != 'afgevallen']
    # 1. De beste opnieuw als die nog geen bewijs over meerdere rondes heeft, of al even niet getest is.
    if board:
        best = board[0]
        last = best['rounds'][-1].get('ts', 0) if best.get('rounds') else 0
        if score(best)['tested'] < RELIABLE_ROUNDS + 1 and now - last > 1800:
            return best['recipe'], 'retest'
        if now - last > 6 * 3600:
            return best['recipe'], 'retest'
    # 2. Verder bouwen op wat werkt (ongeveer de helft van de rondes).
    if board and rnd.random() < 0.55:
        base = [e for e in board[:3] if (score(e)['avg'] or 0) > 0] or board[:1]
        near = [n for e in base for n in neighbours(e['recipe'], allowed) if key_of(n) not in recipes]
        if near:
            return rnd.choice(near), 'near'
    # 3. Iets nieuws, vaker op candle-tijden die tot nu toe goed werkten.
    fresh = [r for k, r in allowed.items() if k not in recipes]
    if fresh:
        w = [tf_weight(recipes, r['timeframe']) for r in fresh]
        return rnd.choices(fresh, weights=w, k=1)[0], 'fresh'
    # Alles al eens geprobeerd: het langst niet geteste goede recept opnieuw.
    old = sorted((e for e in recipes.values() if key_of(e['recipe']) in allowed and status(e) != 'afgevallen'),
                 key=lambda e: e['rounds'][-1].get('ts', 0) if e.get('rounds') else 0)
    return (old[0]['recipe'], 'old') if old else (rnd.choice(list(allowed.values())), 'fresh')


def add_round(recipes, recipe, report):
    k = key_of(recipe)
    e = recipes.setdefault(k, {'key': k, 'recipe': recipe, 'rounds': []})
    slim = {'ts': time.time(), 'at': report.get('at'), 'ok': report.get('ok'), 'reason': report.get('reason'),
            'test': {x: (report.get('test') or {}).get(x) for x in ('trades', 'avgPct', 'totalPct', 'winRate', 'avgHeld', 'buyHoldPct', 'maxDrawdownPct', 'worstPct')} if report.get('test') else None,
            'val': {x: (report.get('validation') or {}).get(x) for x in ('trades', 'avgPct', 'totalPct')} if report.get('validation') else None,
            'coins': report.get('coins'), 'threshold': report.get('threshold'), 'testDays': report.get('testDays')}
    e['rounds'] = (e['rounds'] + [slim])[-KEEP_ROUNDS:]
    e['status'] = status(e)
    e['score'] = score(e)
    return e
