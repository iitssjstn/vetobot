"""Live-toelating en de lange paper-test van de AI-trader.

Een recept mag pas live als ALLE eisen gehaald zijn (en de eigenaar het daarna zelf aanzet in het
dashboard). De eisen gaan over de echte trades in paper, niet over backtests:
  1. het recept is betrouwbaar (validatie + eindtests, zie agent_search.status);
  2. minstens MIN_TRADES paper-trades over minstens MIN_DAYS dagen;
  3. gemiddeld na echte kosten minstens MIN_AVG % per trade, en de voorzichtige ondergrens
     (gemiddelde min één standaardfout) boven 0;
  4. beter dan de markt tijdens dezelfde trades;
  5. terugval van de paper-portefeuille hooguit MAX_DD %;
  6. trades in minstens MIN_REGIMES verschillende marktfases;
  7. gemeten kosten niet meer dan COST_FACTOR keer de kosten waarmee hij geleerd heeft.
"""
import bisect
import math
from datetime import datetime, timezone

MIN_TRADES = 50
MIN_DAYS = 21
MIN_AVG = 0.1
MAX_DD = 10.0
MIN_REGIMES = 2
COST_FACTOR = 1.5
MKT_SHARE = 0.8      # bij zoveel van de trades moet de marktbeweging bekend zijn


def _ms(iso):
    try:
        d = datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _close_at(ts, closes, t):
    """Slotkoers van het laatste candle dat op tijdstip t begonnen was."""
    j = bisect.bisect_right(ts, t) - 1
    return closes[j] if j >= 0 else None


def fill_market(rows, candles):
    """Vult per trade 'mkt' in: wat de markt (alle coins samen, 1h-candles) deed tussen kopen en
    verkopen, in %. candles: {pair: [[ts, o, h, l, c, v], ...]}. Geeft het aantal ingevulde trades."""
    series = {p: ([int(x[0]) for x in c], [float(x[4]) for x in c]) for p, c in candles.items() if c}
    n = 0
    for r in rows:
        if r.get('mkt') is not None:
            continue
        t0, t1 = _ms(r.get('openedAt')), _ms(r.get('closedAt'))
        if not t0 or not t1 or t1 < t0:
            continue
        moves = []
        for ts, closes in series.values():
            if not ts or ts[-1] < t1 - 2 * 3600_000:
                continue  # nog geen candle tot aan het verkopen
            a, b = _close_at(ts, closes, t0), _close_at(ts, closes, t1)
            if a and b:
                moves.append((b / a - 1) * 100)
        if moves:
            r['mkt'] = sum(moves) / len(moves)
            n += 1
    return n


def _drawdown(pcts, slots):
    """Terugval van een portefeuille die elke trade met 1/slots van het vermogen doet."""
    eq = peak = 1.0
    dd = 0.0
    for p in pcts:
        eq *= 1 + p / 100 / max(1, slots)
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak * 100)
    return dd


def check(rows, status, slots=2, assumed_cost=None):
    """Eisen voor live voor één recept. rows: zijn paper-trades (oud -> nieuw).
    Geeft {'allMet', 'checks': [{'key', 'label', 'ok', 'now'}], 'trades'}."""
    pct = [float(r['pct']) for r in rows]
    n = len(pct)
    avg = sum(pct) / n if n else None
    se = (math.sqrt(sum((x - avg) ** 2 for x in pct) / (n - 1)) / math.sqrt(n)) if n > 1 else None
    times = [t for t in (_ms(r.get('closedAt') or r.get('at')) for r in rows) if t]
    days = (max(times) - min(times)) / 86_400_000 if len(times) > 1 else 0.0
    with_mkt = [r for r in rows if r.get('mkt') is not None]
    edge = sum(float(r['pct']) - r['mkt'] for r in with_mkt) / len(with_mkt) if with_mkt else None
    dd = _drawdown(pct, slots) if n else None
    regimes = sorted({r['marketRegime'] for r in rows if r.get('marketRegime')})
    costs = [r['costPct'] for r in rows if isinstance(r.get('costPct'), (int, float))]
    cost = sum(costs) / len(costs) if costs else None
    f = lambda v, d=2: '–' if v is None else f"{v:+.{d}f}".replace('.', ',')
    checks = [
        {'key': 'status', 'label': 'Recept is betrouwbaar (validatie en eindtests)', 'ok': status == 'betrouwbaar', 'now': status},
        {'key': 'trades', 'label': f'Minstens {MIN_TRADES} paper-trades over minstens {MIN_DAYS} dagen',
         'ok': n >= MIN_TRADES and days >= MIN_DAYS, 'now': f'{n} trades over {days:.0f} dagen'},
        {'key': 'avg', 'label': f'Gemiddeld ≥ +{MIN_AVG:g}% per trade na kosten, en de voorzichtige ondergrens boven 0',
         'ok': avg is not None and se is not None and avg >= MIN_AVG and avg - se > 0,
         'now': f'{f(avg)}% (ondergrens {f(None if avg is None or se is None else avg - se)}%)'},
        {'key': 'market', 'label': 'Beter dan de markt tijdens dezelfde trades',
         'ok': edge is not None and edge > 0 and len(with_mkt) >= MKT_SHARE * n,
         'now': f'{f(edge)}% per trade ({len(with_mkt)} van {n} gemeten)'},
        {'key': 'drawdown', 'label': f'Terugval van de paper-portefeuille hooguit {MAX_DD:g}%',
         'ok': dd is not None and dd <= MAX_DD, 'now': '–' if dd is None else f'{dd:.1f}%'.replace('.', ',')},
        {'key': 'regimes', 'label': f'Trades in minstens {MIN_REGIMES} marktfases', 'ok': len(regimes) >= MIN_REGIMES,
         'now': ', '.join(regimes) or 'nog geen'},
        {'key': 'cost', 'label': f'Gemeten kosten hooguit {COST_FACTOR:g}× de kosten waarmee hij leerde',
         'ok': cost is not None and assumed_cost is not None and cost <= COST_FACTOR * assumed_cost,
         'now': f"{'–' if cost is None else f'{cost:.2f}%'.replace('.', ',')} tegenover {'–' if assumed_cost is None else f'{assumed_cost:.2f}%'.replace('.', ',')}"},
    ]
    return {'allMet': all(c['ok'] for c in checks), 'checks': checks, 'trades': n}


def weeks(rows, start_iso=None, limit=12):
    """De lange paper-test: per week (maandag t/m zondag) de trades, het gemiddelde na kosten en
    of hij beter deed dan de markt. Nieuwste week eerst."""
    start = _ms(start_iso) if start_iso else None
    by = {}
    for r in rows:
        t = _ms(r.get('closedAt') or r.get('at'))
        if not t or (start and t < start):
            continue
        y, w, _ = datetime.fromtimestamp(t / 1000, tz=timezone.utc).isocalendar()
        by.setdefault((y, w), []).append(r)
    out = []
    for (y, w), rs in sorted(by.items(), reverse=True)[:limit]:
        pct = [float(r['pct']) for r in rs]
        mk = [float(r['pct']) - r['mkt'] for r in rs if r.get('mkt') is not None]
        edge = sum(mk) / len(mk) if mk else None
        out.append({'week': f'{y}-W{w:02d}', 'trades': len(rs), 'avg': sum(pct) / len(pct), 'edge': edge,
                    'beatMarket': edge is not None and edge > 0, 'regimes': sorted({r['marketRegime'] for r in rs if r.get('marketRegime')})})
    return out


CAL_BINS = [(-99.0, -0.5), (-0.5, 0.0), (0.0, 0.2), (0.2, 0.5), (0.5, 99.0)]


def calibration(rows, last=1000):
    """Klopt de verwachting van de AI-trader? Per groep verwachte uitkomst (bij het kopen): hoeveel
    trades, gemiddeld verwacht, gemiddeld echt (na kosten), en hoe vaak winst. Apart voor de gewone
    trades en de verkenner (die koopt juist ook bij lage verwachtingen)."""
    rows = [r for r in rows[-last:] if isinstance(r.get('expectedPct'), (int, float))]
    out = []
    for lo, hi in CAL_BINS:
        for who, sel in (('gewoon', lambda r: not r.get('explore')), ('verkenner', lambda r: bool(r.get('explore')))):
            rs = [r for r in rows if sel(r) and lo <= r['expectedPct'] < hi]
            if not rs:
                continue
            out.append({'from': lo, 'to': hi, 'who': who, 'trades': len(rs),
                        'expected': sum(r['expectedPct'] for r in rs) / len(rs),
                        'actual': sum(float(r['pct']) for r in rs) / len(rs),
                        'winRate': sum(1 for r in rs if float(r['pct']) > 0) / len(rs) * 100})
    return out
