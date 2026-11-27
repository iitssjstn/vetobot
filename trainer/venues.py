"""Beurzen (venues) in de leerserver: Bitvavo (standaard, X/EUR) en Bybit (X/USDT).

Bybit EU en Bybit NL hebben (MiCA) geen USDT-paren; de bot handelt daar in X/USDC. Feedback van die bots
heeft dus een venuePair X/USDC; to_base_pair maakt daar net als van X/USDT weer X/EUR van. De leerserver
zelf haalt zijn Bybit-koersen altijd van bybit.com (X/USDT, publieke API): bewust zo gelaten, de koersen
van USDT- en USDC-paren liggen vrijwel gelijk en de kenmerken zijn relatief.

Bitvavo blijft precies zoals het was: dezelfde bestanden (agent_trades.json, candles/, features/),
dezelfde kosten, dezelfde livecheck en dezelfde training/promotie. Bybit krijgt eigen bestanden
(agent_trades-bybit.json, candles-bybit/, features-bybit/), zodat de Bitvavo-kant nooit vervuild raakt:
  - trades die de bot op Bybit deed (feedback met venue 'bybit');
  - koersen van Bybit (publieke API, geen keys), voor de eindtest van de actieve recepten op Bybit
    (zie venue_eval.py) en de marktbeweging tijdens Bybit-trades.
Oude data zonder 'venue' is Bitvavo.
"""
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT = 'bitvavo'
VENUES = {
    'bitvavo': {'label': 'Bitvavo', 'quote': 'EUR', 'feePct': 0.25},
    # Bybit spot: 0,1% taker en maker (standaardtarief, zonder VIP-korting), zoals src/venue.js.
    'bybit': {'label': 'Bybit', 'quote': 'USDT', 'feePct': 0.1},
}
OTHER = tuple(v for v in VENUES if v != DEFAULT)
_QUOTES = {v['quote'] for v in VENUES.values()}
# Quotes die terug naar X/EUR gaan (naam van de leerserver): ook USDC (Bybit EU/NL, zie boven).
BASE_QUOTES = _QUOTES | {'USDC'}


def venue_of(v):
    """Onbekend, leeg of ontbrekend (oude data): Bitvavo."""
    return v if isinstance(v, str) and v in VENUES else DEFAULT


def label(v):
    return VENUES[venue_of(v)]['label']


def to_venue_pair(pair, venue):
    """'SOL/EUR' -> 'SOL/USDT' op Bybit (en terug op Bitvavo). Andere quotes blijven zoals ze zijn."""
    s = str(pair or '')
    if '/' not in s:
        return s
    base, quote = s.split('/', 1)
    if quote not in _QUOTES:
        return s
    return f"{base}/{VENUES[venue_of(venue)]['quote']}"


def to_base_pair(pair):
    """Naam zoals de leerserver en de recepten hem kennen (X/EUR): X/USDT en X/USDC worden X/EUR."""
    s = str(pair or '')
    if '/' not in s:
        return s
    base, quote = s.split('/', 1)
    if quote not in BASE_QUOTES:
        return s
    return f"{base}/{VENUES[DEFAULT]['quote']}"


def trades_file(venue):
    """Bestand met de trades van de AI-trader op deze beurs."""
    v = venue_of(venue)
    return 'agent_trades.json' if v == DEFAULT else f'agent_trades-{v}.json'


def data_dir(data, sub, venue):
    """Map voor koersen ('candles') of kenmerken ('features') van deze beurs. Bitvavo: de bestaande map."""
    v = venue_of(venue)
    return os.path.join(data, sub if v == DEFAULT else f'{sub}-{v}')


def rows_of(rows, venue):
    """Alleen de rijen van deze beurs (rijen zonder 'venue' zijn Bitvavo)."""
    v = venue_of(venue)
    return [r for r in rows or [] if isinstance(r, dict) and venue_of(r.get('venue')) == v]


DEFAULT_CFG = {'enabled': True, 'pairs': [], 'feePct': VENUES['bybit']['feePct'], 'everyHours': 6}


def validate(body, current):
    """Instellingen per beurs (alleen Bybit): {'bybit': {'enabled', 'pairs', 'feePct', 'everyHours'}}.
    pairs: coins op Bybit (X/USDT of X/EUR, worden X/EUR opgeslagen); leeg = de coins van de recepten."""
    out = {k: dict(v) for k, v in (current or {}).items()}
    for v, b in (body or {}).items():
        if v not in OTHER:
            raise ValueError(f'Onbekende beurs: {v}')
        if not isinstance(b, dict):
            raise ValueError(f'Instellingen voor {label(v)} moeten een object zijn')
        c = {**DEFAULT_CFG, **out.get(v, {}), **b}
        raw = [str(p).upper() for p in c.get('pairs') or []]
        # Coins voor de Bybit-koersen van de leerserver (bybit.com): tegen USDT of EUR, zoals altijd.
        pairs = [to_base_pair(p) if p.split('/', 1)[-1] in _QUOTES else p for p in raw]
        if len(pairs) > 50 or any(not p.endswith('/EUR') for p in pairs):
            raise ValueError(f'Coins op {label(v)}: maximaal 50, tegen USDT (of EUR)')
        fee = float(c.get('feePct'))
        if not 0 <= fee <= 2:
            raise ValueError(f'Fee op {label(v)} moet tussen 0% en 2% liggen')
        every = float(c.get('everyHours'))
        if not 1 <= every <= 168:
            raise ValueError(f'Testen op {label(v)}: elke 1 tot 168 uur')
        out[v] = {'enabled': bool(c.get('enabled')), 'pairs': list(dict.fromkeys(pairs)), 'feePct': fee, 'everyHours': every}
    return out


def settings(cfg, venue):
    """Instellingen van een andere beurs uit de config (met standaardwaarden)."""
    return {**DEFAULT_CFG, **(((cfg or {}).get('venues') or {}).get(venue) or {})}


def base_cost(cfg, venue):
    """Kosten per ronde (kopen + verkopen, %) waarmee gerekend wordt zolang er op deze beurs nog niet
    genoeg gemeten is. Bitvavo: de ingestelde kosten (zoals altijd). Bybit: 2 × de fee van Bybit plus de
    slippage die in de Bitvavo-kosten zit (ingestelde kosten min 2 × 0,25%, nooit onder 0)."""
    v = venue_of(venue)
    cost = float(cfg['costPct'])
    if v == DEFAULT:
        return cost
    slip = max(0.0, cost - 2 * VENUES[DEFAULT]['feePct'])
    return 2 * float(settings(cfg, v)['feePct']) + slip


# ---------- Koersen van Bybit (publieke API, geen keys) ----------
BYBIT = 'https://api.bybit.com/v5/market/kline'
BYBIT_INTERVAL = {'1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D'}
BYBIT_LIMIT = 1000


class BybitError(Exception):
    pass


def _get(url, tries=3):
    req = urllib.request.Request(url, headers={'User-Agent': 'vetobot-trainer'})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if (e.code == 429 or e.code >= 500) and attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise BybitError(f'HTTP {e.code} van Bybit: {e.reason}') from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise BybitError(f'Bybit niet bereikbaar: {getattr(e, "reason", e)}') from None
        if not isinstance(body, dict) or body.get('retCode') not in (0, '0'):
            raise BybitError(f"Bybit: {(body or {}).get('retMsg') if isinstance(body, dict) else 'onbekend antwoord'}")
        return ((body.get('result') or {}).get('list')) or []
    return []


def bybit_fetch_range(pair, timeframe, start, end, get=None):
    """Candles van Bybit spot tussen start en end (ms), oud -> nieuw, zelfde vorm als train.fetch_range:
    [ts, open, high, low, close, volume]. pair als 'SOL/USDT' (of 'SOL/EUR': wordt SOL/USDT)."""
    get = get or _get
    sym = to_venue_pair(pair, 'bybit').replace('/', '')
    iv = BYBIT_INTERVAL[timeframe]
    out = {}
    while end > start:
        try:
            rows = get(f'{BYBIT}?category=spot&symbol={sym}&interval={iv}&start={int(start)}&end={int(end)}&limit={BYBIT_LIMIT}')
        except BybitError:
            if out:
                break
            raise
        if not rows:
            break
        for r in rows:
            ts = int(r[0])
            if start <= ts <= end:
                out[ts] = [ts, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
        oldest = min(int(r[0]) for r in rows)
        if oldest >= end or len(rows) < 2:
            break
        end = oldest - 1
        time.sleep(0.1)
    return [out[k] for k in sorted(out)]
