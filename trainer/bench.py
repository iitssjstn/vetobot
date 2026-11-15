"""Meetprogramma: hoe snel leert dit apparaat?

Draait een paar nep-leerrondes van de AI-trader (zelfde rekenwerk als een echte ronde, met
nepkoersen, zonder internet en zonder iets op te slaan) en meldt per ronde hoe lang het duurde.
Elke ronde is precies even zwaar, dus wordt een latere ronde trager, dan wordt het apparaat warm
en gaat het langzamer rekenen.

Gebruik:
    python bench.py                  # 3 rondes, standaard werklast
    python bench.py --rounds 5       # langer meten (beter om warmte te zien)
    TRAIN_JOBS=4 python bench.py     # met 4 kernen (standaard 2, zoals de leerserver)

Vergelijk de uitkomst op de VPS en op de telefoon: dezelfde werklast, dus de tijden zijn direct
te vergelijken.
"""
import resources  # als eerste: begrenst de threads (TRAIN_JOBS), net als de leerserver

import argparse
import os
import platform
import random
import resource
import sys
import time

COINS = 8          # zoveel nep-coins
CANDLES = 40_000   # zoveel 5m-candles per coin (± 139 dagen)
M5 = 300_000


def market(n, seed, momentum=0.6):
    """Nepkoersen. Met momentum zetten stijgingen vaker door (dan valt er iets te leren, en
    rekent de leerserver ook de extra testperiodes door, net als bij een goed recept)."""
    rnd = random.Random(seed)
    c, price, drift = [], 100.0, 0.0
    for i in range(n):
        drift = momentum * drift + rnd.gauss(0, 0.0025)
        o = price
        price = max(0.01, price * (1 + drift))
        hi = max(o, price) * (1 + abs(rnd.gauss(0, 0.001)))
        lo = min(o, price) * (1 - abs(rnd.gauss(0, 0.001)))
        c.append([i * M5, o, hi, lo, price, 1000 + rnd.random() * 500])
    return c


def cpu_info():
    model = platform.processor() or platform.machine()
    try:
        with open('/proc/cpuinfo') as f:
            for line in f:
                low = line.lower()
                if low.startswith(('model name', 'hardware', 'cpu model')):
                    model = line.split(':', 1)[1].strip()
                    break
    except OSError:
        pass
    return model


def main(argv=None):
    ap = argparse.ArgumentParser(description='Hoe snel leert dit apparaat?')
    ap.add_argument('--rounds', type=int, default=3)
    ap.add_argument('--coins', type=int, default=COINS)
    ap.add_argument('--candles', type=int, default=CANDLES)
    args = ap.parse_args(argv)

    import numpy
    import sklearn
    import agent

    print('=' * 64)
    print(' vetobot-trainer meetprogramma')
    print(f' Apparaat : {cpu_info()} · {os.cpu_count()} kernen · {platform.machine()}')
    print(f' Software : Python {platform.python_version()} · numpy {numpy.__version__} · scikit-learn {sklearn.__version__}')
    print(f' Instelling: TRAIN_JOBS={resources.TRAIN_JOBS} · voorrang nice {resources.lower_priority()}')
    print(f" Werklast : {args.coins} coins × {f'{args.candles:,}'.replace(',', '.')} candles (5m), {args.rounds} rondes")
    print('=' * 64, flush=True)

    t = time.time()
    pairs = [f'C{i}/EUR' for i in range(args.coins)]
    data = {p: market(args.candles, i) for i, p in enumerate(pairs)}
    data['BTC/EUR'] = market(args.candles, 99, momentum=0.3)
    h1 = {p: market(args.candles // 12, i + 50) for i, p in enumerate(pairs + ['BTC/EUR'])}
    fetch = lambda p, tf, d: h1[p] if tf == '1h' else data[p]
    print(f'Nepkoersen klaargezet in {time.time() - t:.0f} s', flush=True)

    times = []
    for r in range(args.rounds):
        t = time.time()
        _, rep = agent.train_agent({'costPct': 0.2, 'days': 365, 'agent': {}}, {'timeframe': '5m', 'holdDays': 1},
                                   fetch, pairs, log=lambda *_: None, seed=1)
        times.append(time.time() - t)
        print(f'Ronde {r + 1}: {times[-1]:.1f} s  (extra testperiodes: {"ja" if rep.get("folds") else "nee"})', flush=True)

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    avg = sum(times) / len(times)
    slower = (times[-1] / times[0] - 1) * 100 if len(times) > 1 else 0.0
    print('-' * 64)
    print(f'Gemiddeld per ronde : {avg:.1f} s  → ± {3600 / avg:.0f} rondes per uur bij deze werklast')
    print(f'Geheugen (piek)     : {peak:.0f} MB')
    if len(times) > 1:
        print(f'Laatste t.o.v. eerste ronde: {slower:+.0f}%'
              + ('  ← trager geworden: waarschijnlijk warm geworden' if slower > 15 else '  (stabiel)'))
    print('Stuur deze uitkomst door om de VPS en de telefoon te vergelijken.')
    return times


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
