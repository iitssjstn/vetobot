"""Orderboek en losse transacties verzamelen ("microstructuur").

Bitvavo bewaart geen geschiedenis van het orderboek, dus de trainer neemt het vanaf nu zelf op:
elke minuut per coin een samenvatting van het orderboek en van de transacties in die minuut.
Na genoeg dagen test de trainer of deze gegevens het model beter maken (zie experiment in
server.py) en gebruikt ze alleen als dat zo is.

Opslag: /data/micro/<PAIR>/<YYYY-MM-DD>.jsonl, één regel per minuut:
  {t, spread, bid1, ask1, buy, sell, n, big}
  t      = begin van de minuut (ms)
  spread = verschil bied/laat in % van de middenprijs
  bid1   = euro aan biedingen binnen 1% van de middenprijs (kopers die klaar staan)
  ask1   = euro aan laten binnen 1% (verkopers die klaar staan)
  buy    = euro aan transacties waarbij de koper het initiatief nam (koopt "tegen de laat")
  sell   = euro aan transacties waarbij de verkoper het initiatief nam
  n      = aantal transacties
  big    = grootste losse transactie in euro
"""
import json
import os
import time
from datetime import datetime, timezone

from train import BITVAVO, _get

MICRO_FEATURES = ['microBookImb', 'microSpread', 'microBuyRatio60', 'microFlow60', 'microIntensity']
MINUTE = 60_000
KEEP_DAYS = 120


def _day(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def summarize_book(book):
    bids = [(float(p), float(q)) for p, q in book.get('bids', [])]
    asks = [(float(p), float(q)) for p, q in book.get('asks', [])]
    if not bids or not asks:
        return None
    bid, ask = bids[0][0], asks[0][0]
    mid = (bid + ask) / 2
    within = lambda side: sum(p * q for p, q in side if abs(p - mid) / mid <= 0.01)
    return {'spread': (ask - bid) / mid * 100, 'bid1': within(bids), 'ask1': within(asks)}


def summarize_trades(trades, t0, t1):
    """Transacties met t0 <= timestamp < t1 samenvatten."""
    buy = sell = big = 0.0
    n = 0
    for tr in trades:
        ts = int(tr['timestamp'])
        if not t0 <= ts < t1:
            continue
        eur = float(tr['amount']) * float(tr['price'])
        n += 1
        big = max(big, eur)
        if tr.get('side') == 'buy':
            buy += eur
        else:
            sell += eur
    return {'buy': buy, 'sell': sell, 'n': n, 'big': big}


class Collector:
    """Neemt elke minuut het orderboek en de transacties van de gekozen coins op."""

    def __init__(self, root, get=_get, log=print):
        self.root = root
        self.get = get
        self.log = log
        self.last_trade_ts = {}

    def path(self, pair, day):
        d = os.path.join(self.root, pair.replace('/', '-'))
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, f'{day}.jsonl')

    def collect(self, pairs, now_ms=None):
        """Eén ronde: per coin het boek en de transacties van de afgelopen minuut."""
        now = now_ms or int(time.time() * 1000)
        t1 = now - now % MINUTE  # begin van de huidige minuut: de vorige minuut is compleet
        t0 = t1 - MINUTE
        done = 0
        for pair in pairs:
            market = pair.replace('/', '-')
            try:
                book = summarize_book(self.get(f'{BITVAVO}/{market}/book?depth=200'))
                since = self.last_trade_ts.get(pair, t0)
                trades = []
                end = t1 - 1
                for _ in range(5):  # hooguit 5000 transacties per minuut ophalen (nieuwste eerst)
                    rows = self.get(f'{BITVAVO}/{market}/trades?limit=1000&start={since}&end={end}')
                    trades += rows
                    if len(rows) < 1000:
                        break
                    end = min(int(r['timestamp']) for r in rows) - 1
                tr = summarize_trades(trades, t0, t1)
                self.last_trade_ts[pair] = t1
            except Exception as e:  # één coin mislukt: de rest gaat door
                self.log(f'Orderboek {pair}: ophalen mislukt: {e}')
                continue
            if not book:
                continue
            row = {'t': t0, **{k: round(v, 6) for k, v in book.items()}, **{k: round(v, 4) if isinstance(v, float) else v for k, v in tr.items()}}
            with open(self.path(pair, _day(t0)), 'a') as f:
                f.write(json.dumps(row) + '\n')
            done += 1
            time.sleep(0.05)
        return done

    def cleanup(self, now_ms=None):
        now = now_ms or int(time.time() * 1000)
        oldest = _day(now - KEEP_DAYS * 86_400_000)
        for pair in os.listdir(self.root) if os.path.isdir(self.root) else []:
            d = os.path.join(self.root, pair)
            for name in os.listdir(d):
                if name[:10] < oldest:
                    try:
                        os.remove(os.path.join(d, name))
                    except OSError:
                        pass


def load(root, pair, start_ms=None, end_ms=None):
    """Alle minuten van een coin (oud -> nieuw) als dict t -> rij."""
    d = os.path.join(root, pair.replace('/', '-'))
    out = {}
    if not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        day = name[:10]
        if start_ms and day < _day(start_ms):
            continue
        if end_ms and day > _day(end_ms):
            continue
        with open(os.path.join(d, name)) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                out[int(r['t'])] = r
    return out


def coverage(root):
    """Per coin: aantal minuten, eerste en laatste minuut, dagen."""
    info = []
    if not os.path.isdir(root):
        return info
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        files = sorted(os.listdir(d)) if os.path.isdir(d) else []
        if not files:
            continue
        n = 0
        first = last = None
        for fn in (files[0], files[-1]):
            with open(os.path.join(d, fn)) as f:
                rows = [json.loads(x) for x in f if x.strip()]
            if rows:
                first = rows[0]['t'] if first is None else first
                last = rows[-1]['t']
        for fn in files:
            with open(os.path.join(d, fn)) as f:
                n += sum(1 for _ in f)
        info.append({'pair': name.replace('-', '/'), 'minutes': n, 'from': first, 'to': last,
                     'days': round((last - first) / 86_400_000, 1) if first is not None and last is not None else 0})
    return info


class Series:
    """Minuten van één coin als reeks met lopende sommen, zodat de kenmerken op elk moment
    in een paar stappen uit te rekenen zijn (ook over 24 uur), in plaats van 1440 minuten optellen."""

    def __init__(self, rows):
        self.rows = rows
        if not rows:
            self.t0 = 0
            self.size = 0
            return
        self.t0 = min(rows)
        self.size = (max(rows) - self.t0) // MINUTE + 1
        cnt = [0] * (self.size + 1)
        buy = [0.0] * (self.size + 1)
        sell = [0.0] * (self.size + 1)
        n = [0.0] * (self.size + 1)
        for k in range(self.size):
            r = rows.get(self.t0 + k * MINUTE)
            cnt[k + 1] = cnt[k] + (1 if r else 0)
            buy[k + 1] = buy[k] + (r['buy'] if r else 0.0)
            sell[k + 1] = sell[k] + (r['sell'] if r else 0.0)
            n[k + 1] = n[k] + (r['n'] if r else 0)
        self.cnt, self.buy, self.sell, self.n = cnt, buy, sell, n

    def _sum(self, arr, last_idx, length):
        hi = min(last_idx + 1, self.size)
        lo = max(0, last_idx + 1 - length)
        return (arr[hi] - arr[lo]) if hi > lo else 0

    def at(self, close_ms):
        """Microstructuur-kenmerken op het moment dat een candle sluit (close_ms), uit de minuten
        ervoor. Ontbreekt er te veel, dan None per kenmerk."""
        out = {k: None for k in MICRO_FEATURES}
        if not self.size:
            return out
        last = close_ms - close_ms % MINUTE - MINUTE  # laatste complete minuut vóór het sluiten
        snap = None
        for k in range(5):  # boek: de meest recente minuut binnen 5 minuten
            snap = self.rows.get(last - k * MINUTE)
            if snap:
                break
        if snap:
            tot = snap['bid1'] + snap['ask1']
            out['microBookImb'] = snap['bid1'] / tot if tot > 0 else None
            out['microSpread'] = snap['spread']
        idx = (last - self.t0) // MINUTE
        if idx < 0:
            return out
        have_h = self._sum(self.cnt, idx, 60)
        if have_h >= 40:  # minstens 40 van de 60 minuten aanwezig
            buy = self._sum(self.buy, idx, 60)
            sell = self._sum(self.sell, idx, 60)
            out['microBuyRatio60'] = buy / (buy + sell) if buy + sell > 0 else 0.5
            have_d = self._sum(self.cnt, idx, 1440)
            if have_d >= 960:
                vol_day = (self._sum(self.buy, idx, 1440) + self._sum(self.sell, idx, 1440)) / have_d * 60
                n_day = self._sum(self.n, idx, 1440) / have_d * 60
                out['microFlow60'] = (buy - sell) / vol_day if vol_day > 0 else 0.0
                out['microIntensity'] = self._sum(self.n, idx, 60) / have_h * 60 / n_day if n_day > 0 else 1.0
        return out


def features_at(rows, close_ms):
    return Series(rows).at(close_ms)

MIN_DAYS = 14  # zoveel dagen orderboek-data nodig voordat het experiment zinvol is


def rows_fn(root):
    """Voor de training: pair -> functie(sluittijd_ms) -> kenmerken. Laadt per coin één keer."""
    cache = {}

    def for_pair(pair):
        if pair not in cache:
            cache[pair] = Series(load(root, pair))
        return cache[pair].at
    return for_pair


def experiment(cfg, root, fetch, log=print, think=None):
    """Maakt het model betere keuzes met orderboek-data? Eerlijke vergelijking op dezelfde
    periode (alleen waar er orderboek-data is): een model zonder en een model mét, zelfde
    tijdsplitsing, zelfde test. Geeft een rapport; 'better' = mét is duidelijk beter."""
    from sklearn.ensemble import GradientBoostingClassifier
    from train import FEATURES, TF_MS, _impute, build_dataset, evaluate
    from features import context

    say = think or (lambda *a, **k: None)
    cov = {c['pair']: c for c in coverage(root)}
    pairs = [p for p in (cfg.get('pairs') or list(cov)) if cov.get(p, {}).get('days', 0) >= MIN_DAYS]
    if len(pairs) < 2:
        return {'ran': False, 'reason': f'Nog niet genoeg orderboek-data (minstens {MIN_DAYS} dagen bij 2 coins nodig)'}
    tf_ms = TF_MS.get(cfg['timeframe'], 60_000)
    fn = rows_fn(root)
    try:
        ctx = context(fetch('BTC/EUR', cfg['timeframe'], int(cfg['days'])))
    except Exception:
        ctx = None
    tr_a, tr_b, tr_y, te_a, te_b, te_y, te_r = [], [], [], [], [], [], []
    for pair in pairs:
        try:
            candles = fetch(pair, cfg['timeframe'], int(cfg['days']))
        except Exception as e:
            log(f'Experiment {pair}: {e}')
            continue
        start = cov[pair]['from'] + 1440 * MINUTE  # eerste dag niet: de 24-uurs kenmerken moeten vol zijn
        X, y, ret, ts = build_dataset(candles, cfg, step=1, ctx=ctx, micro_fn=fn(pair), micro_keys=MICRO_FEATURES)
        keep = [k for k in range(len(X)) if ts[k] + tf_ms >= start and X[k][len(FEATURES)] is not None]
        if len(keep) < 300:
            continue
        cut = int(len(keep) * 0.7)
        gap = int(cfg['horizon'])
        for j, k in enumerate(keep):
            if j < cut - gap:
                tr_a.append(X[k][:len(FEATURES)]); tr_b.append(X[k]); tr_y.append(y[k])
            elif j >= cut:
                te_a.append(X[k][:len(FEATURES)]); te_b.append(X[k]); te_y.append(y[k]); te_r.append(ret[k])
    if len(tr_y) < 1500 or len(te_y) < 300 or len(set(tr_y)) < 2:
        return {'ran': False, 'reason': 'Te weinig voorbeelden in de periode met orderboek-data'}

    def fit_eval(trX, teX):
        med = []
        for j in range(len(trX[0])):
            col = sorted(v for v in (r[j] for r in trX) if v is not None)
            med.append(col[len(col) // 2] if col else 0.0)
        m = GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.05, subsample=0.8,
                                       min_samples_leaf=100, random_state=7)
        m.fit(_impute(trX, med), tr_y)
        return evaluate(list(m.predict_proba(_impute(teX, med))[:, 1]), te_y, te_r, cfg), m

    without, _ = fit_eval(tr_a, te_a)
    with_m, m = fit_eval(tr_b, te_b)
    ba = (without.get('best') or {}).get('avgReturnPct')
    bb = (with_m.get('best') or {}).get('avgReturnPct')
    better = bool(bb is not None and bb > 0 and (ba is None or bb >= ba + 0.05) and with_m['auc'] >= without['auc'])
    imp = sorted(zip(MICRO_FEATURES, m.feature_importances_[len(FEATURES):]), key=lambda x: -x[1])
    report = {'ran': True, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'pairs': pairs,
              'train': len(tr_y), 'test': len(te_y), 'without': {'auc': without['auc'], 'best': without.get('best')},
              'with': {'auc': with_m['auc'], 'best': with_m.get('best')}, 'better': better,
              'importance': {k: float(v) for k, v in imp}}
    f = lambda v: '–' if v is None else f'{v:+.2f}%'.replace('.', ',')
    say(f"Experiment orderboek-data ({len(pairs)} coins, {len(te_y)} testmomenten): zonder {f(ba)} per trade (AUC {without['auc']:.3f}), "
        f"mét {f(bb)} per trade (AUC {with_m['auc']:.3f}). ".replace('.', ',', 0) +
        ('Met orderboek-data voorspel ik duidelijk beter, dus ik neem het voortaan mee.' if better else
         'Het orderboek maakt mij (nog) niet beter; ik laat het weg en probeer het later opnieuw met meer data.'),
        kind='result' if better else 'insight')
    return report


def latest(root, pairs=None, now_ms=None):
    """Orderboek-kenmerken van nu, per coin (voor de bot)."""
    now = now_ms or int(time.time() * 1000)
    out = {}
    names = pairs or [c['pair'] for c in coverage(root)]
    for pair in names:
        rows = load(root, pair, start_ms=now - 26 * 3600_000)
        if rows:
            out[pair] = features_at(rows, now)
    return out
