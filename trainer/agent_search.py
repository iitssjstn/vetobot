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
    # Geduld bij verkopen: minstens zoveel candles vasthouden, en pas verkopen als de verwachting van
    # langer vasthouden onder -marge % zakt. 1 / 0 is het oude gedrag (zo snel mogelijk verkopen).
    'minHold': [1, 3, 6],
    'margin': [0.0, 0.05, 0.15],
}
ORDER = ['timeframe', 'holdDays', 'depth', 'leaf', 'look', 'minHold', 'margin']
DEFAULTS = {'minHold': 1, 'margin': 0.0}
KEEP_ROUNDS = 6
RELIABLE_ROUNDS = 2       # zoveel rondes met eindtest voordat een recept "betrouwbaar" kan zijn
RELIABLE_AVG = 0.1        # gewogen gemiddeld minstens zoveel % per trade in de eindtests
RELIABLE_TRADES = 60      # samen minstens zoveel eindtest-trades
MAX_DRAWDOWN = 15         # grootste terugval in een eindtest (opgeteld % per trade) mag niet groter zijn
DANGER_DRAWDOWN = 25      # boven deze terugval nooit gebruiken, ook niet om in paper te oefenen
MIN_DD = 1.0              # ondergrens voor de terugval bij winst/terugval (anders deelt hij door bijna 0)


def key_of(r):
    """Sleutel van een recept. Geduld-instellingen alleen als ze afwijken van het oude gedrag, zodat
    recepten van vóór het geduld dezelfde sleutel (en resultaten) houden."""
    fmt = lambda v: f'{v:g}' if isinstance(v, float) else str(v)
    base = '|'.join(fmt(r[k]) for k in ORDER if k not in DEFAULTS)
    extra = ''.join(f"|{'h' if k == 'minHold' else 'm'}{fmt(r.get(k, d))}" for k, d in DEFAULTS.items() if r.get(k, d) != d)
    return base + extra


def all_recipes(timeframes):
    out = [{}]
    for k in ORDER:
        vals = [v for v in SPACE[k] if k != 'timeframe' or v in timeframes]
        out = [{**o, k: v} for o in out for v in vals]
    return out


def neighbours(r, allowed):
    out = []
    r = {**DEFAULTS, **r}
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


PART_FIELDS = ('trades', 'avgPct', 'totalPct', 'winRate', 'avgHeld', 'buyHoldPct', 'maxDrawdownPct', 'worstPct', 'marketPct',
               'edgePct', 'beatMarketRate', 'byRegime', 'portfolio',
               'netReturnPct', 'profitFactor', 'sharpe', 'avgWinPct', 'avgLossPct', 'grossWinPct', 'grossLossPct', 'byVolatility')


def _agg(rounds, part):
    """Samenvatting van één deel (val of test) over alle rondes."""
    rs = [x[part] for x in rounds if (x.get(part) or {}).get('trades')]
    n = sum(r['trades'] for r in rs)
    if not n:
        return {'avg': None, 'edge': None, 'ratio': None, 'trades': 0, 'rounds': 0, 'positive': 0, 'drawdown': None}
    avg = sum(r['avgPct'] * r['trades'] for r in rs) / n
    dd = max((r.get('maxDrawdownPct') or 0) for r in rs)
    er = [r for r in rs if r.get('edgePct') is not None]
    en = sum(r['trades'] for r in er)
    edge = sum(r['edgePct'] * r['trades'] for r in er) / en if en else None
    # Winst/terugval: het resultaat van de portefeuille boven de markt, gedeeld door de grootste
    # terugval van die portefeuille. Rondes zonder portefeuille: winst per trade × trades.
    def gain(r):
        pf = r.get('portfolio') or {}
        if pf.get('excessPct') is not None:
            return pf['excessPct']
        return (r['edgePct'] if r.get('edgePct') is not None else r['avgPct']) * r['trades']
    ratio = sum(gain(r) for r in rs) / len(rs) / max(dd, MIN_DD)
    return {'avg': avg, 'edge': edge, 'ratio': ratio, 'trades': n, 'rounds': len(rs),
            'positive': sum(1 for r in rs if r['avgPct'] > 0), 'drawdown': dd}


def score(entry):
    """Beoordeling van een recept over al zijn rondes.
    Kiezen en rangschikken gebeurt op de VALIDATIE (alle coins, de periode waarop ook de koopdrempel
    gekozen is). De EINDTEST is alleen de controle: houdt het stand op een periode die bij het kiezen
    niet meetelde? Zo is het beste recept niet het recept dat toevallig het best op de eindtest scoorde.
    - avg / edge: gemiddeld resultaat per trade en het voordeel boven de markt (validatie);
    - ratio: winst boven de markt ten opzichte van de grootste terugval (validatie);
    - drawdown: de grootste terugval, validatie of eindtest;
    - test: dezelfde cijfers voor de eindtest (alleen voor de controle)."""
    rounds = entry.get('rounds', [])
    v, t = _agg(rounds, 'val'), _agg(rounds, 'test')
    # Werkte het in meerdere periodes (walk-forward)? Aandeel periodes met winst, over alle rondes
    # die periodes hebben. Een recept dat maar in een deel van de periodes werkt, zakt in de rangorde.
    fr = [x for x in rounds if x.get('folds')]
    fn = sum(len(x['folds']) for x in fr)
    fp = sum(x.get('foldsPositive') or 0 for x in fr)
    cons = fp / fn if fn else None
    if cons is not None and v['ratio'] is not None and v['ratio'] > 0:
        v = {**v, 'ratio': v['ratio'] * cons}
    dds = [x for x in (v['drawdown'], t['drawdown']) if x is not None]
    return {'avg': v['avg'], 'edge': v['edge'], 'ratio': v['ratio'], 'trades': v['trades'], 'rounds': len(rounds),
            'tested': t['rounds'], 'positive': t['positive'], 'drawdown': max(dds) if dds else None, 'safe': v['ratio'],
            'test': {'avg': t['avg'], 'edge': t['edge'], 'trades': t['trades'], 'drawdown': t['drawdown']},
            'periods': {'n': fn, 'positive': fp, 'share': cons}}


def test_profit_factor(entry):
    """Winstfactor in de eindtests over alle rondes samen: som winst / |som verlies|.
    Geeft (waarde, bekend): bekend is False als geen enkele ronde die cijfers heeft (oudere rondes);
    zonder verlies maar met winst is de waarde oneindig (float('inf'), niet in JSON zetten)."""
    rows = [x['test'] for x in entry.get('rounds', []) if (x.get('test') or {}).get('trades')
            and x['test'].get('grossWinPct') is not None and x['test'].get('grossLossPct') is not None]
    if not rows:
        return None, False
    win = sum(r['grossWinPct'] for r in rows)
    loss = sum(r['grossLossPct'] for r in rows)
    if loss > 0:
        return win / loss, True
    return (float('inf') if win > 0 else None), True


def status(entry):
    """betrouwbaar: goed op de validatie én de eindtest houdt stand over meerdere rondes, beter dan
    de markt · veelbelovend: de laatste ronde haalde de eindtest, moet zich nog herhalen · oefenen:
    nog niet goed genoeg · afgevallen: meerdere eindtests verlies · te riskant: een terugval van meer
    dan DANGER_DRAWDOWN%, nooit gebruiken (ook niet in paper)."""
    sc = score(entry)
    if sc['avg'] is None and sc['test']['avg'] is None:
        return 'oefenen'
    if entry.get('risky') or (sc['drawdown'] or 0) > DANGER_DRAWDOWN:
        return 'te riskant'
    t = sc['test']
    last_ok = bool(entry['rounds'] and entry['rounds'][-1].get('ok'))
    if (sc['tested'] >= RELIABLE_ROUNDS and t['avg'] is not None and t['avg'] >= RELIABLE_AVG and t['trades'] >= RELIABLE_TRADES
            and sc['positive'] >= sc['tested'] - 1 and last_ok and sc['drawdown'] <= MAX_DRAWDOWN
            and t['edge'] is not None and t['edge'] > 0 and sc['edge'] is not None and sc['edge'] > 0):
        return 'betrouwbaar'
    if sc['tested'] >= 3 and t['avg'] is not None and t['avg'] < 0:
        return 'afgevallen'
    if last_ok:
        return 'veelbelovend'
    return 'oefenen'


REGIMES = ['stijgend', 'zijwaarts', 'dalend']
REGIME_MIN_TRADES = 20    # zoveel validatie-trades in een marktfase voordat de Strategy Agent erop afgaat


def regime_score(entry, part='val'):
    """Per marktfase: aantal trades, gemiddeld resultaat en voordeel boven de markt, over alle
    rondes van dit recept. Standaard op de validatie: daarop wordt gekozen, niet op de eindtest."""
    out = {}
    for reg in REGIMES:
        rows = [((x.get(part) or {}).get('byRegime') or {}).get(reg) for x in entry.get('rounds', [])]
        rows = [r for r in rows if r and r.get('trades')]
        n = sum(r['trades'] for r in rows)
        er = [r for r in rows if r.get('edgePct') is not None]
        en = sum(r['trades'] for r in er)
        out[reg] = {'trades': n, 'avg': sum(r['avgPct'] * r['trades'] for r in rows) / n if n else None,
                    'edge': sum(r['edgePct'] * r['trades'] for r in er) / en if en else None}
    return out


def choose_per_regime(entries, main):
    """Strategy Agent: kies per marktfase welk recept de bot gebruikt.
    entries: bruikbare recepten (met model), main: het beste recept overall.
    Per fase: het recept dat in die fase het meest beter deed dan de markt (met genoeg trades en
    status betrouwbaar of veelbelovend). Is er geen, en heeft het hoofdrecept in die fase bewezen
    verlies tegenover de markt, dan niet handelen in die fase. Anders het hoofdrecept.
    Geeft {fase: {'key': recept-sleutel of None, 'why': korte reden}}."""
    order = {'betrouwbaar': 2, 'veelbelovend': 1}
    plan = {}
    main_rs = regime_score(main) if main else {}
    for reg in REGIMES:
        cands = []
        for e in entries:
            st = status(e)
            rs = regime_score(e)[reg]
            if st in order and rs['trades'] >= REGIME_MIN_TRADES and rs['edge'] is not None and rs['edge'] > 0:
                cands.append(((order[st], rs['edge']), e, rs))
        if cands:
            _, e, rs = max(cands, key=lambda c: c[0])
            plan[reg] = {'key': e['key'], 'why': 'best', 'edge': rs['edge'], 'trades': rs['trades']}
            continue
        mr = main_rs.get(reg) or {}
        if main and mr.get('trades', 0) >= REGIME_MIN_TRADES and mr.get('edge') is not None and mr['edge'] <= 0:
            plan[reg] = {'key': None, 'why': 'pauze', 'edge': mr['edge'], 'trades': mr['trades']}
        else:
            plan[reg] = {'key': main['key'] if main else None, 'why': 'weinig bewijs', 'edge': mr.get('edge'), 'trades': mr.get('trades', 0)}
    return plan


def rank_key(entry):
    st = status(entry)
    sc = score(entry)
    order = {'betrouwbaar': 3, 'veelbelovend': 2, 'oefenen': 1, 'afgevallen': 0, 'te riskant': -1}[st]
    return (order, sc['ratio'] if sc['ratio'] is not None else -99, sc['trades'])


def usable(entry):
    """Mag dit recept gebruikt worden (ook om te oefenen)? Nooit als het te riskant is."""
    return status(entry) != 'te riskant'


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


def last_test_ts(entry):
    """Wanneer dit recept voor het laatst getest is (unix-tijd), 0 als nooit."""
    return (entry.get('rounds') or [{}])[-1].get('ts') or 0 if entry else 0


def pick(recipes, timeframes, rnd=None, now=None, exclude=frozenset(), may_retest=None):
    """Welk recept deze ronde, en waarom. Geeft (recept, reden).
    exclude: sleutels van recepten die nu al door de VPS of een helper getraind worden.
    may_retest(entry, now): mag een al getest recept nu opnieuw (genoeg nieuwe data)? Nieuwe recepten
    mogen altijd. Is er niets dat mag, dan (None, 'te vers'): even wachten op nieuwe data."""
    rnd = rnd or random.Random()
    now = now or time.time()
    allowed = {key_of(r): r for r in all_recipes(timeframes) if key_of(r) not in exclude}
    # Verder bouwen mag ook op een beste recept dat zelf nog te vers is om opnieuw te trainen.
    base_board = [e for e in leaderboard(recipes, 5) if key_of(e['recipe']) in allowed and status(e) not in ('afgevallen', 'te riskant')]
    if may_retest is not None:
        # Al geteste recepten zonder genoeg nieuwe data vallen af; ongeteste blijven gewoon mogelijk.
        stale = {k for k in allowed if k in recipes and not may_retest(recipes[k], now)}
        allowed = {k: r for k, r in allowed.items() if k not in stale}
        if not allowed:
            return None, ('te vers' if stale else None)
    board = [e for e in leaderboard(recipes, 5) if key_of(e['recipe']) in allowed and status(e) not in ('afgevallen', 'te riskant')]
    # 1. De beste opnieuw als die nog geen bewijs over meerdere rondes heeft, of al even niet getest is.
    if board:
        best = board[0]
        last = best['rounds'][-1].get('ts', 0) if best.get('rounds') else 0
        if score(best)['tested'] < RELIABLE_ROUNDS + 1 and now - last > 1800:
            return best['recipe'], 'retest'
        if now - last > 6 * 3600:
            return best['recipe'], 'retest'
    # 2. Verder bouwen op wat werkt (ongeveer de helft van de rondes).
    if base_board and rnd.random() < 0.55:
        base = [e for e in base_board[:3] if (score(e)['avg'] or 0) > 0] or base_board[:1]
        near = [n for e in base for n in neighbours(e['recipe'], allowed) if key_of(n) not in recipes]
        if near:
            return rnd.choice(near), 'near'
    # 3. Iets nieuws, vaker op candle-tijden die tot nu toe goed werkten.
    fresh = [r for k, r in allowed.items() if k not in recipes]
    if fresh:
        w = [tf_weight(recipes, r['timeframe']) for r in fresh]
        return rnd.choices(fresh, weights=w, k=1)[0], 'fresh'
    # Alles al eens geprobeerd: het langst niet geteste goede recept opnieuw.
    old = sorted((e for e in recipes.values() if key_of(e['recipe']) in allowed and status(e) not in ('afgevallen', 'te riskant')),
                 key=lambda e: e['rounds'][-1].get('ts', 0) if e.get('rounds') else 0)
    if old:
        return old[0]['recipe'], 'old'
    if allowed:
        return rnd.choice(list(allowed.values())), 'fresh'
    return None, None


def add_round(recipes, recipe, report):
    k = key_of(recipe)
    e = recipes.setdefault(k, {'key': k, 'recipe': recipe, 'rounds': []})
    slim = {'ts': time.time(), 'at': report.get('at'), 'ok': report.get('ok'), 'reason': report.get('reason'),
            'test': {x: report['test'].get(x) for x in PART_FIELDS} if report.get('test') else None,
            'val': {x: report['validation'].get(x) for x in PART_FIELDS} if report.get('validation') else None,
            'coins': report.get('coins'), 'threshold': report.get('threshold'), 'testDays': report.get('testDays'),
            'periods': report.get('periods'), 'folds': report.get('folds'), 'foldsPositive': report.get('foldsPositive')}
    e['rounds'] = (e['rounds'] + [slim])[-KEEP_ROUNDS:]
    # Eén keer te diep gezakt is genoeg: dat blijft onthouden, ook als die ronde uit de lijst valt.
    if any((slim[p] or {}).get('maxDrawdownPct') is not None and slim[p]['maxDrawdownPct'] > DANGER_DRAWDOWN for p in ('val', 'test')):
        e['risky'] = True
    e['status'] = status(e)
    e['score'] = score(e)
    return e
