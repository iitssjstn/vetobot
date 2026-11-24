"""Proefperiode van een nieuw gepromoot model, en de praktijkresultaten per modelversie.

Na elke promotie is de nieuwe actieve versie 'op proef'. We tellen de echte trades van de bot (paper
en live, niet de verkenner en niet de virtuele) met het gepubliceerde recept van die versie, vanaf het
promotiemoment. Na `need` trades vergelijken we met wat de eindtest beloofde (gemiddeld % per trade):
  mislukt   het gemiddelde in de praktijk is ≤ 0 én de bovengrens van een eenzijdig betrouwbaarheids-
            interval (t-verdeling, betrouwbaarheid `conf`) ligt onder de verwachting: duidelijk
            slechter dan beloofd, niet alleen pech;
  geslaagd  anders.
Wat er bij 'mislukt' gebeurt (terugzetten, afkoelperiode, melding aan de bot) staat in server.py.
Hier alleen het rekenwerk, zonder bestanden of het register: makkelijk te testen.
"""
from datetime import datetime

import stats

LONG_DAYS = 14          # na zoveel dagen zonder genoeg trades: de proef loopt door, met uitleg
SERIES_MAX = 300        # zoveel punten hooguit in de praktijkgrafiek per versie


def ts_of(v):
    """ISO-tijd (met of zonder tijdzone) als unix-tijd, of None."""
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def real_trades(rows):
    """Echte trades uit agent_trades.json (geen verkenner, niet virtueel), per recept, op volgorde van
    sluiten: {recept: [{'open', 'close', 'pct', 'mode', 'at'}]}. 'open' is wanneer de trade begon (daarop
    hoort hij bij een modelversie), 'close' wanneer hij sloot (daarop staat hij in de grafiek)."""
    out = {}
    for t in rows or []:
        if not isinstance(t, dict) or t.get('explore') or t.get('virtual') or not t.get('recipe'):
            continue
        try:
            pct = float(t['pct'])
        except (KeyError, TypeError, ValueError):
            continue
        close = ts_of(t.get('closedAt')) or ts_of(t.get('at'))
        start = ts_of(t.get('openedAt')) or close
        if start is None:
            continue
        out.setdefault(t['recipe'], []).append({'open': start, 'close': close if close is not None else start, 'pct': pct,
                                                'mode': 'live' if t.get('mode') == 'live' else 'paper',
                                                'at': t.get('closedAt') or t.get('at')})
    for xs in out.values():
        xs.sort(key=lambda x: x['close'])
    return out


def trades_in(by_recipe, key, start, end=None):
    """De trades van recept `key` die begonnen in [start, end)."""
    return [t for t in by_recipe.get(key, ()) if t['open'] >= start and (end is None or t['open'] < end)]


def _pct(v, d=2):
    return '–' if v is None else f'{v:+.{d}f}%'.replace('.', ',').replace('-', '−')


def evaluate(pcts, expected, need, conf, since_ts, now_ts):
    """Beoordeling van een lopende proef. pcts: rendementen (% na kosten) van de echte trades sinds de
    promotie. Geeft {'status', 'trades', 'avgPct', 'upperPct', 'reason', 'decided'}; decided is False
    zolang er te weinig trades zijn (dan blijft de status 'proef')."""
    n = len(pcts)
    mean, _, upper = stats.mean_upper(pcts, conf)
    out = {'trades': n, 'avgPct': mean, 'upperPct': upper}
    if n < need:
        days = (now_ts - since_ts) / 86400 if since_ts else 0
        why = f'{n} van {need} echte trades'
        if days >= LONG_DAYS:
            why = (f'na {days:.0f} dagen pas {n} van {need} echte trades; de proef loopt door tot er genoeg trades zijn '
                   '(geen actie, te weinig bewijs om iets te beslissen)')
        return {**out, 'status': 'proef', 'reason': why, 'decided': False}
    exp = expected if expected is not None else 0.0
    pc = f'{conf * 100:g}%'
    if mean <= 0 and upper is not None and upper < exp:
        return {**out, 'status': 'mislukt', 'decided': True,
                'reason': (f'gemiddeld {_pct(mean)} per trade over {n} echte trades, terwijl de eindtest {_pct(expected)} beloofde; '
                           f'met {pc} zekerheid hooguit {_pct(upper)}: duidelijk slechter dan beloofd')}
    if mean <= 0:
        why = (f'gemiddeld {_pct(mean)} per trade over {n} echte trades (verwacht {_pct(expected)}); de bovengrens '
               f'{_pct(upper)} ({pc}) laat nog toe dat het pech is, dus niet afgekeurd')
    else:
        why = f'gemiddeld {_pct(mean)} per trade over {n} echte trades (verwacht {_pct(expected)})'
    return {**out, 'status': 'geslaagd', 'reason': why, 'decided': True}


def downsample(points, limit=SERIES_MAX):
    """Hooguit `limit` punten, gelijk verdeeld, altijd met het eerste en het laatste punt."""
    n = len(points)
    if n <= limit:
        return list(points)
    idx = sorted({round(i * (n - 1) / (limit - 1)) for i in range(limit)})
    return [points[i] for i in idx]


def practice(by_recipe, windows, expected=None):
    """Praktijkresultaten van één modelversie. windows: [(start, eind of None, recept)] de periodes
    waarin deze versie de actieve was. Geeft {trades, avgPct, sumPct, expectedPct, byMode, series}."""
    rows = []
    for start, end, key in windows:
        if key and start is not None:
            rows += trades_in(by_recipe, key, start, end)
    rows.sort(key=lambda t: t['close'])
    n = len(rows)
    total = sum(t['pct'] for t in rows)
    by_mode = {}
    for m in ('paper', 'live'):
        xs = [t['pct'] for t in rows if t['mode'] == m]
        by_mode[m] = {'trades': len(xs), 'avgPct': sum(xs) / len(xs) if xs else None}
    cum, series = 0.0, []
    for t in rows:
        cum += t['pct']
        series.append({'at': t['at'], 'cumPct': round(cum, 4), 'mode': t['mode']})
    return {'trades': n, 'avgPct': total / n if n else None, 'sumPct': round(total, 4), 'expectedPct': expected,
            'byMode': by_mode, 'series': downsample(series)}
