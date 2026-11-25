"""Kleine statistiek voor de poortwachter en de proefperiode (zonder scipy).

- t_quantile: kwantiel van de t-verdeling. Startwaarde uit de Cornish-Fisher-reeks rond de normale
  verdeling (voor 1 en 2 vrijheidsgraden exact), daarna bijgesteld met Newton op de exacte
  verdelingsfunctie (onvolledige bètafunctie). De reeks alleen was bij weinig vrijheidsgraden en
  strenge niveaus (Bonferroni, bv. 0,999) te klein, tot 9% bij 3 vrijheidsgraden: te soepel.
- pooled: gemiddelde, standaardafwijking en aantal trades over meerdere rondes samen, uit de
  samenvatting per ronde (gemiddelde, std en aantal), zonder de losse trades.
- welch_lower: eenzijdige ondergrens van het verschil in gemiddelde (Welch, ongelijke spreiding).
- mean_upper: eenzijdige bovengrens van een gemiddelde (t-verdeling).
- effective_trades: hoeveel trades er echt los van elkaar zijn als rondes (deels) dezelfde
  eindtestperiode opnieuw testen (zie daar).
"""
import math
from statistics import NormalDist


def _betacf(a, b, x):
    """Kettingbreuk van de onvolledige bètafunctie (Lentz)."""
    tiny = 1e-300
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1)
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        for aa in (m * (b - m) * x / ((a + m2 - 1) * (a + m2)), -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))):
            d = 1.0 + aa * d
            d = 1.0 / (d if abs(d) > tiny else tiny)
            c = 1.0 + aa / c
            c = c if abs(c) > tiny else tiny
            h *= d * c
        if abs(d * c - 1.0) < 1e-15:
            break
    return h


def _ibeta(a, b, x):
    """Geregulariseerde onvolledige bètafunctie I_x(a, b)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lb = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    if x < (a + 1) / (a + b + 2):
        return math.exp(lb) * _betacf(a, b, x) / a
    return 1.0 - math.exp(lb) * _betacf(b, a, 1 - x) / b


def t_tail(t, df):
    """P(T > t) voor t >= 0 (exact, via de onvolledige bètafunctie)."""
    return 0.5 * _ibeta(df / 2, 0.5, df / (df + t * t))


def _t_series(p, v):
    z = NormalDist().inv_cdf(p)
    if v < 1.5:
        return math.tan(math.pi * (p - 0.5))
    if v < 2.5:
        return (2 * p - 1) / math.sqrt(2 * p * (1 - p))
    z2 = z * z
    g1 = (z2 + 1) * z / 4
    g2 = ((5 * z2 + 16) * z2 + 3) * z / 96
    g3 = (((3 * z2 + 19) * z2 + 17) * z2 - 15) * z / 384
    g4 = ((((79 * z2 + 776) * z2 + 1482) * z2 - 1920) * z2 - 945) * z / 92160
    return z + g1 / v + g2 / v ** 2 + g3 / v ** 3 + g4 / v ** 4


def t_quantile(p, df):
    """Kwantiel p (0..1) van de t-verdeling met df vrijheidsgraden."""
    p = min(max(p, 1e-12), 1 - 1e-12)
    if df is None or not math.isfinite(df) or df > 1e6:
        return NormalDist().inv_cdf(p)
    if p < 0.5:
        return -t_quantile(1 - p, df)
    v = max(float(df), 1.0)
    if v == 1.0 or v == 2.0:
        return _t_series(p, v)  # exact
    # Newton op de staartkans, vanaf de reeks (die ligt al dichtbij, dus een paar stappen).
    q, t = 1 - p, max(_t_series(p, v), 0.0)
    c = math.exp(math.lgamma((v + 1) / 2) - math.lgamma(v / 2)) / math.sqrt(v * math.pi)
    for _ in range(50):
        pdf = c * (1 + t * t / v) ** (-(v + 1) / 2)
        if pdf <= 0:
            break
        step = (t_tail(t, v) - q) / pdf
        t = max(t + step, t / 2)
        if abs(step) < 1e-12 * max(1.0, t):
            break
    return t


def pooled(parts):
    """parts: [(n, gemiddelde, std)] per ronde. Geeft (gemiddelde, std, n) over alles samen, of None
    als dat niet kan (geen trades, of een ronde zonder bekende std)."""
    rows = [(int(n), float(m), s) for n, m, s in parts if n]
    big_n = sum(n for n, _, _ in rows)
    if big_n < 2 or any(s is None or not math.isfinite(s) for _, _, s in rows):
        return None
    mean = sum(n * m for n, m, _ in rows) / big_n
    ss = sum((n - 1) * s * s + n * (m - mean) ** 2 for n, m, s in rows)
    return mean, math.sqrt(max(ss, 0.0) / (big_n - 1)), big_n


def welch_lower(a, b, conf):
    """Eenzijdige ondergrens (betrouwbaarheid conf) van gemiddelde(a) - gemiddelde(b).
    a, b: (gemiddelde, std, n). Geeft (verschil, ondergrens, vrijheidsgraden)."""
    (m1, s1, n1), (m2, s2, n2) = a, b
    v1, v2 = s1 * s1 / n1, s2 * s2 / n2
    diff = m1 - m2
    se = math.sqrt(v1 + v2)
    if se <= 1e-12:
        return diff, diff, None
    den = (v1 * v1 / (n1 - 1) if n1 > 1 else 0) + (v2 * v2 / (n2 - 1) if n2 > 1 else 0)
    df = (v1 + v2) ** 2 / den if den > 0 else max(n1 + n2 - 2, 1)
    return diff, diff - t_quantile(conf, df) * se, df


def mean_upper(xs, conf):
    """Eenzijdige bovengrens (betrouwbaarheid conf) van het gemiddelde van xs. Geeft (gemiddelde,
    std, bovengrens); bij minder dan 2 waarden is de bovengrens None."""
    n = len(xs)
    if not n:
        return None, None, None
    mean = sum(xs) / n
    if n < 2:
        return mean, None, None
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1))
    return mean, sd, mean + t_quantile(conf, n - 1) * sd / math.sqrt(n)


def effective_trades(parts):
    """Hoeveel trades er echt los van elkaar zijn. parts: [(n, begin, eind)] per ronde, met de
    eindtestperiode als unix-tijden (of None als die niet bekend is).

    Waarom: hetzelfde recept wordt na een paar uur opnieuw getest (retestHours), en de eindtest is
    steeds de nieuwste 15% van de data (bij 60 dagen zo'n 9 dagen). Zes rondes testen dan bijna
    dezelfde 9 dagen markt: grotendeels dezelfde trades, alleen met een iets ander model. Die als
    6 x n losse trades tellen maakt de standaardfout tot sqrt(6) keer te klein (pseudo-replicatie):
    in een simulatie met twee even goede recepten werd dan in ~23% van de gevallen gepromoot in
    plaats van 5% (zie AuditPseudoReplication in test_trainer.py).

    Methode: rondes met overlappende periodes vormen samen één stuk markt. Per stuk tellen we de
    trades die in die tijd passen: gemiddelde trades per dag (over die rondes) x de lengte van het
    stuk (de vereniging van de periodes). Zes keer dezelfde periode telt dus als één ronde; twee
    periodes die half overlappen als anderhalf; periodes los van elkaar tellen gewoon op. Nooit
    meer dan de trades zelf. Rondes zonder bekende periode tellen los (zoals vroeger).
    Het gemiddelde en de spreiding blijven die van alle rondes samen (pooled): herhaald meten op
    dezelfde periode maakt het gemiddelde niet scheef, alleen de zekerheid was te groot."""
    known, total = [], 0.0
    for n, a, b in parts:
        if not n:
            continue
        if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)) or b <= a:
            total += n
        else:
            known.append((float(a), float(b), float(n)))
    known.sort()
    i = 0
    while i < len(known):
        lo, hi = known[i][0], known[i][1]
        group = [known[i]]
        i += 1
        while i < len(known) and known[i][0] < hi:
            hi = max(hi, known[i][1])
            group.append(known[i])
            i += 1
        density = sum(n / (b - a) for a, b, n in group) / len(group)
        total += min(sum(n for _, _, n in group), density * (hi - lo))
    return total
