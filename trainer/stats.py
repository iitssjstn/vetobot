"""Kleine statistiek voor de poortwachter en de proefperiode (zonder scipy).

- t_quantile: kwantiel van de t-verdeling (Cornish-Fisher-reeks rond de normale verdeling; vanaf
  10 vrijheidsgraden op 0,001 nauwkeurig, voor 1 en 2 exact; voor 3 t/m 9 bij extreme kansen iets
  te klein, maar zo weinig trades halen de andere eisen toch niet).
- pooled: gemiddelde, standaardafwijking en aantal trades over meerdere rondes samen, uit de
  samenvatting per ronde (gemiddelde, std en aantal), zonder de losse trades.
- welch_lower: eenzijdige ondergrens van het verschil in gemiddelde (Welch, ongelijke spreiding).
- mean_upper: eenzijdige bovengrens van een gemiddelde (t-verdeling).
"""
import math
from statistics import NormalDist


def t_quantile(p, df):
    """Kwantiel p (0..1) van de t-verdeling met df vrijheidsgraden."""
    z = NormalDist().inv_cdf(min(max(p, 1e-12), 1 - 1e-12))
    if df is None or not math.isfinite(df) or df > 1e6:
        return z
    v = max(float(df), 1.0)
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
