"""Kenmerken per coin en candle-tijd bewaren, zodat een leerronde alleen de nieuwe candles hoeft
uit te rekenen in plaats van steeds de hele geschiedenis.

Per (coin, candle-tijd, soort) een bestand met de tijdstippen en de kenmerken. Bij een volgende
ronde worden de rijen op tijdstip teruggevonden; alleen het nieuwe stuk aan het eind wordt
uitgerekend, met een aanloop van TAIL candles zodat voortschrijdende gemiddelden kloppen.
Sluit het niet aan (gat, andere kenmerken, oudere geschiedenis erbij), dan rekent hij alles opnieuw.
"""
import hashlib
import os
import time

import numpy as np

from features import FEATURES, WARMUP, features_at, series

VERSION = 1
TAIL = 2000  # aanloop voor het nieuwe stuk (ruim meer dan de langste indicator)
SAVE_ROWS = 2000        # zoveel nieuwe rijen: meteen opslaan
SAVE_EVERY_S = 6 * 3600  # anders hooguit eens per 6 uur
_SIG = hashlib.sha1(('|'.join(FEATURES) + f'|{WARMUP}|{VERSION}').encode()).hexdigest()[:12]


def _compute(candles, ctx, lo):
    """Kenmerken voor candles[lo:], als matrix (NaN als onbekend)."""
    s = series(candles)
    X = np.full((len(candles) - lo, len(FEATURES)), np.nan)
    for i in range(max(lo, WARMUP), len(candles)):
        f = features_at(candles, s, i, ctx)
        if f is not None:
            X[i - lo] = [np.nan if f[k] is None else f[k] for k in FEATURES]
    return X


def matrix(pair, tf, candles, ctx, cache_dir=None, tag='btc'):
    """Kenmerken per candle (rij per candle, de eerste WARMUP rijen NaN). Met cache_dir bewaard."""
    n = len(candles)
    if not cache_dir or n <= WARMUP:
        return _compute(candles, ctx, 0)
    os.makedirs(cache_dir, exist_ok=True)
    file = os.path.join(cache_dir, f"{pair.replace('/', '-')}_{tf}_{tag}.npz")
    ts = np.fromiter((c[0] for c in candles), dtype=np.int64, count=n)
    X = None
    try:
        with np.load(file) as z:
            if str(z['sig']) == _SIG:
                old_ts, old_X = z['ts'], z['X']
                pos = np.searchsorted(old_ts, ts)
                pos_c = np.minimum(pos, len(old_ts) - 1)
                hit = old_ts[pos_c] == ts
                # Bruikbaar als alles tot een bepaald punt bekend is en alleen het eind ontbreekt.
                k = n if hit.all() else int(np.argmin(hit))
                if k > WARMUP and hit[:k].all() and not hit[k:].any():
                    X = np.full((n, len(FEATURES)), np.nan)
                    X[:k] = old_X[pos_c[:k]].astype(np.float64)
                    if k < n:
                        start = max(0, k - TAIL)
                        X[k:] = _compute(candles[start:], ctx, k - start).astype(np.float32).astype(np.float64)
                    new_rows = n - k
    except (OSError, ValueError, KeyError):
        X = None
    if X is None:
        # Zelfde afronding als wat uit de opslag komt, zodat een rij nooit van waarde verandert.
        X = _compute(candles, ctx, 0).astype(np.float32).astype(np.float64)
        new_rows = n
    # De eerste WARMUP candles van dit venster tellen nooit mee (net als zonder opslag).
    X[:WARMUP] = np.nan
    # Wegschrijven alleen als het de moeite is: het bestand is groot (alle candles). Een paar nieuwe
    # candles rekent hij de volgende ronde gewoon opnieuw uit (kost weinig), en eens per SAVE_EVERY_S
    # of bij veel nieuwe rijen wordt het bijgewerkt.
    try:
        age = time.time() - os.path.getmtime(file)
    except OSError:
        age = None
    if new_rows and (age is None or new_rows >= SAVE_ROWS or age >= SAVE_EVERY_S):
        tmp = file + '.tmp.npz'
        np.savez(tmp, sig=_SIG, ts=ts, X=X.astype(np.float32))
        os.replace(tmp, file)
    return X
