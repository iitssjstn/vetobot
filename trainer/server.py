"""vetobot-trainer: traint 's nachts het voorspelmodel en deelt het met de bot.

- De geheime code (token) wordt bij de eerste start gemaakt, staat in /data/token en wordt in de
  logs getoond. Die vul je in het vetobot-dashboard in. Geen keys in env-variabelen of .env.
- De bot stuurt zijn instellingen (candle-tijd, stop-loss, winstdoel, coins) via POST /config.
- Endpoints (allemaal met 'Authorization: Bearer <token>', behalve /health):
    GET  /health      leeft de trainer?
    GET  /model.json  het laatste goedgekeurde model
    GET  /status      instellingen, laatste trainingen en resultaten
    POST /config      nieuwe instellingen
    POST /train       nu trainen
"""
import hashlib
import hmac
import json
import random
import math
import os
import secrets
import threading
import time
import traceback
import warnings

# scikit-learn waarschuwt (onschuldig) bij elk model dat in een eigen thread traint; dat vult de
# log zonder dat er iets mis is. Alleen déze melding uitzetten, andere waarschuwingen blijven.
warnings.filterwarnings('ignore', message=r'.*sklearn\.utils\.parallel\.delayed.*')
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import agent as agent_mod
import agent_search
import livecheck
import micro as micro_mod
import search as searcher
import thoughts
import train as trainer

DATA = os.environ.get('DATA_DIR', '/data')
PORT = int(os.environ.get('PORT', '8787'))
TRAIN_HOUR = int(os.environ.get('TRAIN_HOUR', '3'))  # elke nacht om dit uur (tijdzone via TZ)

DEFAULTS = {'timeframe': '5m', 'days': 60, 'targetPct': 3.0, 'stopPct': 2.0, 'horizon': 36,
            'costPct': 0.5, 'pairs': [], 'topN': 15, 'maxSamples': 300_000, 'halfLifeDays': 45,
            # Wanneer trainen: 'times' = vaste uren, 'interval' = elke X uur, 'continuous' = na elke
            # training opnieuw (met een pauze van pauseMinutes).
            'schedule': {'mode': 'times', 'hours': [TRAIN_HOUR], 'everyHours': 6, 'pauseMinutes': 30},
            # Strategie-zoeker: na elke training nog een ronde andere strategieën proberen.
            # Doorlopend zoeken (met pauzeMinuten tussen rondes) en optioneel automatisch overstappen
            # op de beste bevestigde strategie.
            'search': {'enabled': False, 'timeframes': [], 'perRound': 6, 'pauseMinutes': 1, 'autoApply': False},
            'strategy': None,
            # Orderboek en transacties opnemen (elke minuut); useMicro wordt door het experiment gezet.
            'micro': {'enabled': True}, 'useMicro': False,
            # De AI-trader: leert zelf wanneer kopen en verkopen (zie agent.py). Draait doorlopend.
            'agent': {'enabled': True, 'timeframes': [], 'safetyStopPct': 10, 'pauseMinutes': 1, 'coinPool': 'top', 'maxOpen': 2}}
LIMITS = {'days': (7, 365), 'targetPct': (0.2, 50), 'stopPct': (0.2, 50), 'horizon': (3, 2000),
          'costPct': (0, 5), 'topN': (1, 50), 'maxSamples': (20_000, 2_000_000), 'halfLifeDays': (0, 365)}

os.makedirs(DATA, exist_ok=True)
state = {'running': False, 'history': [], 'log': [], 'progress': None, 'lastFinished': None}
wake = threading.Event()  # maakt de planner wakker als het schema verandert
lock = threading.Lock()


def path(name):
    return os.path.join(DATA, name)


def read_json(name, default):
    try:
        with open(path(name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(name, data):
    tmp = path(name + '.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path(name))


def token():
    p = path('token')
    if not os.path.exists(p):
        with open(p, 'w') as f:
            f.write(secrets.token_urlsafe(32))
        os.chmod(p, 0o600)
    with open(p) as f:
        return f.read().strip()


def log(msg):
    line = f'{datetime.now().strftime("%Y-%m-%d %H:%M:%S")} {msg}'
    print(line, flush=True)
    state['log'] = (state['log'] + [line])[-300:]


def think(text, kind='info'):
    """Het model "praat": een gedachte in gewoon Nederlands (zie thoughts.py)."""
    if not text:
        return
    item = {'at': datetime.now().isoformat(timespec='seconds'), 'text': text, 'kind': kind}
    state['thoughts'] = (state.get('thoughts', []) + [item])[-200:]
    try:
        write_json('thoughts.json', state['thoughts'])
    except Exception:
        pass


def set_progress(phase, done, total, text):
    p = state.get('progress') or {}
    state['progress'] = {**p, 'phase': phase, 'done': done, 'total': total, 'text': text, 'at': datetime.now().isoformat(timespec='seconds')}


def config():
    saved = read_json('config.json', {})
    cfg = {**DEFAULTS, **saved}
    cfg['schedule'] = {**DEFAULTS['schedule'], **(saved.get('schedule') or {})}
    cfg['search'] = {**DEFAULTS['search'], **(saved.get('search') or {})}
    cfg['micro'] = {**DEFAULTS['micro'], **(saved.get('micro') or {})}
    cfg['agent'] = {**DEFAULTS['agent'], **(saved.get('agent') or {})}
    return cfg


def validate_search(s, current):
    s = {**current, **(s or {})}
    tfs = [str(t) for t in s.get('timeframes') or []]
    if any(t not in searcher.TF_MIN for t in tfs) or len(tfs) > 5:
        raise ValueError('Onbekende candle-tijd voor de strategie-zoeker')
    per = int(s.get('perRound') or 6)
    if not 1 <= per <= 30:
        raise ValueError('Strategieën per ronde moet tussen 1 en 30 liggen')
    pause = int(s.get('pauseMinutes') if s.get('pauseMinutes') is not None else 1)
    if not 0 <= pause <= 720:
        raise ValueError('Pauze tussen zoekrondes moet tussen 0 en 720 minuten liggen')
    return {'enabled': bool(s.get('enabled')), 'timeframes': tfs, 'perRound': per, 'pauseMinutes': pause, 'autoApply': bool(s.get('autoApply'))}


search_lock = threading.Lock()


def load_search():
    return read_json('search.json', {'results': {}})


def search_info():
    data = load_search()
    results = data.get('results', {})
    n = sum(1 for r in results.values() if r.get('score') is not None)
    return {'tested': len(results), 'scored': n, 'requiredEdge': searcher.required_edge(n),
            'possible': len(searcher.all_candidates(config()['search']['timeframes'] or searcher.DEFAULT_TIMEFRAMES, config()['costPct'])),
            'leaderboard': searcher.leaderboard(results), 'lastRoundAt': data.get('lastRoundAt'),
            'rounds': data.get('rounds', 0), 'champion': data.get('champion'),
            'searching': state.get('searching', False), 'progress': state.get('searchProgress') if state.get('searching') else None,
            'nextRoundAt': state.get('nextSearchAt'),
            'arms': [{'key': r['key'], 'stage': st, 'hasModel': os.path.exists(path(arm_file(r['key'])))} for r, st in select_arms(results)]}


def validate_schedule(s, current):
    s = {**current, **(s or {})}
    if s['mode'] not in ('times', 'interval', 'continuous'):
        raise ValueError('Onbekend schema')
    hours = sorted({int(h) for h in s.get('hours') or []})
    if s['mode'] == 'times' and (not hours or any(h < 0 or h > 23 for h in hours) or len(hours) > 24):
        raise ValueError('Kies minstens één uur tussen 0 en 23')
    every = float(s.get('everyHours') or 6)
    if not 1 <= every <= 168:
        raise ValueError('Elke 1 tot 168 uur')
    pause = int(s.get('pauseMinutes') or 30)
    if not 15 <= pause <= 1440:
        raise ValueError('Pauze tussen trainingen: 15 tot 1440 minuten')
    return {'mode': s['mode'], 'hours': hours or [TRAIN_HOUR], 'everyHours': every, 'pauseMinutes': pause}


def validate_config(body):
    cfg = config()
    if 'timeframe' in body:
        if body['timeframe'] not in trainer.TF_MS:
            raise ValueError('Onbekende candle-tijd')
        cfg['timeframe'] = body['timeframe']
    for k, (lo, hi) in LIMITS.items():
        if k in body:
            v = float(body[k])
            if not lo <= v <= hi:
                raise ValueError(f'{k} moet tussen {lo} en {hi} liggen')
            cfg[k] = int(v) if k in ('days', 'horizon', 'topN') else v
    if 'pairs' in body:
        pairs = [str(p).upper() for p in body['pairs'] or []]
        if len(pairs) > 50 or any(not p.endswith('/EUR') for p in pairs):
            raise ValueError('Maximaal 50 coins, allemaal tegen EUR')
        cfg['pairs'] = pairs
    if 'schedule' in body:
        cfg['schedule'] = validate_schedule(body['schedule'], cfg['schedule'])
    if 'search' in body:
        cfg['search'] = validate_search(body['search'], cfg['search'])
    if isinstance(body.get('agent'), dict):
        a = {**cfg['agent'], **body['agent']}
        tfs = [str(t) for t in a.get('timeframes') or []]
        if any(t not in agent_mod.TF_MIN for t in tfs):
            raise ValueError('Onbekende candle-tijd voor de AI-trader')
        stop = float(a.get('safetyStopPct') or 10)
        if not 2 <= stop <= 30:
            raise ValueError('Noodstop moet tussen 2% en 30% liggen')
        cfg['agent'] = {'enabled': bool(a.get('enabled')), 'timeframes': tfs, 'safetyStopPct': stop,
                        'pauseMinutes': max(0, min(720, int(a.get('pauseMinutes') or 0))),
                        'coinPool': 'eigen' if a.get('coinPool') == 'eigen' else 'top',
                        # Zoveel trades tegelijk als de bot: daarmee rekent de portefeuille in de backtest.
                        'maxOpen': max(1, min(20, int(a.get('maxOpen') or 2)))}
    if isinstance(body.get('micro'), dict):
        cfg['micro'] = {'enabled': bool(body['micro'].get('enabled', cfg['micro']['enabled']))}
    # Zelf andere strategie-instellingen gekozen: dan is het niet meer de strategie van de zoeker.
    if any(k in body for k in ('timeframe', 'targetPct', 'stopPct', 'horizon')) and 'strategy' not in body:
        cfg['strategy'] = None
    if 'strategy' in body:
        cfg['strategy'] = body['strategy'] if isinstance(body['strategy'], dict) else None
    if cfg['targetPct'] <= cfg['costPct']:
        raise ValueError('Het winstdoel moet groter zijn dan de kosten per ronde')
    return cfg


FEEDBACK_MAX = 20000  # zoveel echte trades bewaren we maximaal (de nieuwste)
feedback_lock = threading.Lock()


def load_feedback():
    return read_json('feedback.json', [])


SIGNALS_MAX = 5000


def add_signals(items):
    """Oordelen van de AI over signalen (goedgekeurd/afgewezen), met de kans van het model.
    De uitkomst rekenen we later uit met de koersen (zie compute_teamwork)."""
    clean = []
    for t in items:
        try:
            clean.append({'pair': str(t['pair'])[:20], 'timeframe': str(t['timeframe'])[:5], 'ts': int(t['ts']),
                          'prob': float(t['prob']) if isinstance(t.get('prob'), (int, float)) else None,
                          'ai': 'approve' if t.get('aiDecision') == 'approve' else 'reject'})
        except (KeyError, TypeError, ValueError):
            continue
    if not clean:
        return 0
    with feedback_lock:
        rows = read_json('signals.json', [])
        seen = {(r['pair'], r['timeframe'], r['ts']) for r in rows}
        added = []
        for r in clean:
            k = (r['pair'], r['timeframe'], r['ts'])
            if k not in seen:
                seen.add(k)
                added.append(r)
        write_json('signals.json', (rows + added)[-SIGNALS_MAX:])
    return len(added)


def compute_teamwork():
    """Wie had gelijk: het model of de AI? Voor elk signaal rekenen we met de bewaarde koersen uit
    hoe het was afgelopen (zelfde doel/stop/duur/kosten als de training), en vergelijken
    goedgekeurd met afgewezen, en de gevallen waarin model en AI het oneens waren."""
    cfg = config()
    signals = read_json('signals.json', [])
    model = read_json('model.json', None)
    thr = ((model or {}).get('meta', {}).get('metrics', {}).get('best') or {}).get('minProb') or 0.5
    loaded = {}
    done = []
    pending = 0
    for sg in signals:
        if sg['timeframe'] != cfg['timeframe']:
            continue
        key = (sg['pair'], sg['timeframe'])
        if key not in loaded:
            try:
                c = read_json(os.path.join('candles', f"{sg['pair'].replace('/', '-')}_{sg['timeframe']}.json"), [])
            except Exception:
                c = []
            loaded[key] = (c, {x[0]: i for i, x in enumerate(c)})
        c, idx = loaded[key]
        i = idx.get(sg['ts'])
        if i is None or i + int(cfg['horizon']) >= len(c):
            pending += 1
            continue
        lab, ret = trainer.label_at(c, i, cfg['targetPct'], cfg['stopPct'], int(cfg['horizon']), cfg['costPct'])
        done.append({**sg, 'win': lab, 'returnPct': ret})

    def summary(rows):
        if not rows:
            return {'n': 0, 'winRate': None, 'avgReturnPct': None}
        return {'n': len(rows), 'winRate': sum(r['win'] for r in rows) / len(rows) * 100,
                'avgReturnPct': sum(r['returnPct'] for r in rows) / len(rows)}
    model_yes = lambda r: r['prob'] is not None and r['prob'] >= thr * 100
    out = {
        'updatedAt': datetime.now().isoformat(timespec='seconds'), 'timeframe': cfg['timeframe'],
        'total': len(done), 'pending': pending, 'modelThreshold': thr * 100,
        'target': cfg['targetPct'], 'stop': cfg['stopPct'], 'horizon': cfg['horizon'],
        'approved': summary([r for r in done if r['ai'] == 'approve']),
        'rejected': summary([r for r in done if r['ai'] == 'reject']),
        # De interessante gevallen: model en AI oneens.
        'modelYesAiNo': summary([r for r in done if model_yes(r) and r['ai'] == 'reject']),
        'modelNoAiYes': summary([r for r in done if not model_yes(r) and r['ai'] == 'approve']),
        'bothYes': summary([r for r in done if model_yes(r) and r['ai'] == 'approve']),
        'recent': [{k: r[k] for k in ('pair', 'ts', 'prob', 'ai', 'win', 'returnPct')} for r in done[-12:]][::-1],
    }
    write_json('teamwork.json', out)
    return out


def add_feedback(trades):
    """Echte trades van de bot opslaan. Dubbele (zelfde coin, timeframe en tijdstip) tellen één keer.
    Items met kind 'signal' zijn oordelen van de AI over een signaal (geen trade)."""
    items = trades if isinstance(trades, list) else []
    ag = [t for t in items if isinstance(t, dict) and t.get('kind') == 'agentTrade']
    if ag:
        add_agent_trades(ag)
    items = [t for t in items if not (isinstance(t, dict) and t.get('kind') == 'agentTrade')]
    arms = [t for t in items if isinstance(t, dict) and t.get('kind') == 'arm']
    if arms:
        add_arm_results(arms)
    items = [t for t in items if not (isinstance(t, dict) and t.get('kind') == 'arm')]
    signals = [t for t in items if isinstance(t, dict) and t.get('kind') == 'signal']
    if signals:
        n = add_signals(signals)
        if n:
            log(f'{n} AI-oordeel/oordelen over signalen ontvangen')
    clean = []
    for t in items:
        if isinstance(t, dict) and t.get('kind') == 'signal':
            continue
        if not isinstance(t, dict) or not isinstance(t.get('features'), dict):
            continue
        try:
            row = {
                'pair': str(t['pair'])[:20], 'timeframe': str(t['timeframe'])[:5], 'ts': int(t['ts']),
                'returnPct': float(t['returnPct']),
                'features': {k: float(v) for k, v in t['features'].items() if isinstance(v, (int, float)) and k in trainer.FEATURES},
                'prob': float(t['prob']) if isinstance(t.get('prob'), (int, float)) else None,
                'exitReason': str(t.get('exitReason') or '')[:80], 'mode': str(t.get('mode') or '')[:6],
            }
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(row['returnPct']) or abs(row['returnPct']) > 100:
            continue
        clean.append(row)
    if not clean:
        return 0
    with feedback_lock:
        rows = load_feedback()
        seen = {(r['pair'], r['timeframe'], r['ts']) for r in rows}
        added = []
        for r in clean:
            key = (r['pair'], r['timeframe'], r['ts'])
            if key not in seen:
                seen.add(key)
                added.append(r)
        rows = (rows + added)[-FEEDBACK_MAX:]
        write_json('feedback.json', rows)
    if added:
        wins = sum(1 for r in added if r['returnPct'] > 0)
        log(f'{len(added)} echte trade(s) van de bot ontvangen ({wins} met winst)')
    return len(added)


def feedback_info():
    rows = load_feedback()
    by_tf = {}
    for r in rows:
        b = by_tf.setdefault(r['timeframe'], {'n': 0, 'wins': 0, 'sum': 0.0})
        b['n'] += 1
        b['wins'] += r['returnPct'] > 0
        b['sum'] += r['returnPct']
    return {'total': len(rows), 'byTimeframe': {k: {'n': v['n'], 'winRate': v['wins'] / v['n'] * 100, 'avgReturnPct': v['sum'] / v['n']}
                                                for k, v in by_tf.items()}}


def run_training(reason):
    with lock:
        if state['running']:
            return False
        state['running'] = True
    def job():
        started = datetime.now().isoformat(timespec='seconds')
        state['progress'] = {'startedAt': started, 'reason': reason, 'phase': 'start', 'done': 0, 'total': 1,
                             'text': 'Wachten tot de strategie-zoeker klaar is met de huidige strategie' if state.get('searching') else 'Starten'}
        state['wantMain'] = True
        work_lock.acquire()  # niet tegelijk met de zoeker: allebei zwaar voor de processor
        state['wantMain'] = False
        try:
            cfg = config()
            log(f'Training gestart ({reason}): {cfg["timeframe"]}, {cfg["days"]} dagen, doel +{cfg["targetPct"]}% / stop -{cfg["stopPct"]}%')
            cache = os.path.join(DATA, 'candles')
            fetch = lambda pair, tf, days: trainer.fetch_candles(pair, tf, days, cache_dir=cache, log=log)
            model, report = trainer.train(cfg, log=log, progress=set_progress, fetch=fetch, feedback=load_feedback(), think=think,
                                          micro=micro_mod.rows_fn(MICRO_DIR))
            report['startedAt'] = started
            report['finishedAt'] = datetime.now().isoformat(timespec='seconds')
            if model:
                if cfg.get('strategy'):
                    model['meta']['strategy'] = cfg['strategy']
                write_json('model.json', model)
                log(f'Nieuw model gepubliceerd (AUC {report["metrics"]["auc"]:.3f})')
            else:
                log(f'Geen nieuw model: {report.get("reason")}')
            state['history'] = ([report] + state['history'])[:10]
            write_json('history.json', state['history'])
            run_micro_experiment(cfg, fetch)
        except Exception as e:
            log(f'Training mislukt: {e}')
            traceback.print_exc()
            state['history'] = ([{'startedAt': started, 'published': False, 'reason': f'Fout: {e}'}] + state['history'])[:10]
        finally:
            try:
                compute_teamwork()
            except Exception as e:
                log(f'Scorebord AI + model bijwerken mislukt: {e}')
            work_lock.release()
            state['running'] = False
            state['lastFinished'] = datetime.now()
            state['cache'] = cache_info()
            wake.set()
    threading.Thread(target=job, daemon=True).start()
    return True


def next_run(now=None, schedule=None, last_finished=None):
    """Wanneer de volgende geplande training is, volgens het schema."""
    now = now or datetime.now()
    s = schedule or config()['schedule']
    last = last_finished if last_finished is not None else state.get('lastFinished')
    if s['mode'] == 'interval':
        if not last:
            return now + timedelta(minutes=1)
        return max(now, last + timedelta(hours=float(s['everyHours'])))
    if s['mode'] == 'continuous':
        if not last:
            return now + timedelta(minutes=1)
        return max(now, last + timedelta(minutes=int(s['pauseMinutes'])))
    for add in range(0, 2):
        day = (now + timedelta(days=add)).date()
        for h in sorted(s['hours']):
            t = datetime.combine(day, datetime.min.time()).replace(hour=int(h))
            if t > now:
                return t
    return now + timedelta(days=1)


SCHEDULE_REASON = {'times': 'geplande training', 'interval': 'training volgens interval', 'continuous': 'doorlopende training'}


def scheduler():
    if not os.path.exists(path('model.json')):
        run_training('eerste start')
    while True:
        due = next_run()
        wake.clear()
        # Slapen tot het tijd is, maar wakker worden als het schema verandert of een training klaar is.
        wake.wait(timeout=max(5, (due - datetime.now()).total_seconds()))
        if state['running'] or datetime.now() < next_run():
            continue
        run_training(SCHEDULE_REASON.get(config()['schedule']['mode'], 'geplande training'))


work_lock = threading.Lock()
search_wake = threading.Event()
MICRO_DIR = os.path.join(DATA, 'micro')


def run_micro_experiment(cfg, fetch):
    """Hooguit één keer per dag: maakt orderboek-data het model beter? Zo ja: voortaan meenemen."""
    last = read_json('micro_experiment.json', {})
    if last.get('at') and (time.time() - datetime.fromisoformat(last['at'].replace('Z', '+00:00')).timestamp()) < 20 * 3600:
        return
    try:
        set_progress('test', 0, 1, 'Experiment: maakt orderboek-data het model beter?')
        r = micro_mod.experiment(cfg, MICRO_DIR, fetch, log=log, think=think)
    except Exception as e:
        log(f'Experiment orderboek-data mislukt: {e}')
        return
    if not r.get('ran'):
        r['at'] = last.get('at')  # niet gedraaid: niet als "vandaag gedaan" tellen
        write_json('micro_experiment.json', {**last, 'lastReason': r['reason']})
        return
    write_json('micro_experiment.json', r)
    saved = read_json('config.json', {})
    if bool(saved.get('useMicro')) != r['better']:
        saved['useMicro'] = r['better']
        write_json('config.json', saved)
        log('Orderboek-data wordt voortaan meegenomen in het model' if r['better'] else 'Orderboek-data wordt niet (meer) meegenomen')


micro_state = {'lastDayNote': None, 'errors': 0}


def micro_worker():
    """Neemt elke minuut het orderboek en de transacties op van de coins."""
    col = micro_mod.Collector(MICRO_DIR, log=lambda m: None)
    started_note = False
    while True:
        cfg = config()
        if not cfg['micro']['enabled']:
            time.sleep(30)
            continue
        try:
            pairs = list(dict.fromkeys((cfg.get('pairs') or trainer.top_markets(int(cfg.get('topN', 15)))) + ['BTC/EUR']))
        except Exception:
            time.sleep(60)
            continue
        if not started_note:
            think(f"Ik ben begonnen met het opnemen van het orderboek en alle transacties van {len(pairs)} coins, elke minuut. "
                  f"Bitvavo bewaart dat zelf niet, dus ik bouw mijn eigen geschiedenis op. Na {micro_mod.MIN_DAYS} dagen test ik of "
                  "ik daar betere voorspellingen door doe.", kind='doing')
            started_note = True
        try:
            done = col.collect(pairs)
            micro_state['errors'] = 0 if done else micro_state['errors'] + 1
        except Exception as e:
            micro_state['errors'] += 1
            if micro_state['errors'] in (3, 60):
                log(f'Orderboek opnemen mislukt: {e}')
        today = datetime.now().strftime('%Y-%m-%d')
        if micro_state['lastDayNote'] != today and datetime.now().hour == 12:
            micro_state['lastDayNote'] = today
            col.cleanup()
            cov = micro_mod.coverage(MICRO_DIR)
            days = max((c['days'] for c in cov), default=0)
            exp = read_json('micro_experiment.json', {})
            think(f"Orderboek-data: ik heb nu {days:g} dagen van {len(cov)} coins. ".replace('.', ',', 1) +
                  (f"Nog {max(0, micro_mod.MIN_DAYS - days):.0f} dagen tot het eerste experiment." if days < micro_mod.MIN_DAYS else
                   ('Ik gebruik het in mijn voorspellingen.' if config().get('useMicro') else
                    'Het experiment liet nog geen verbetering zien; ik blijf verzamelen en test opnieuw.' if exp.get('ran') else 'Het experiment draait na de volgende training.')),
                  kind='insight')
        time.sleep(max(5, 60 - datetime.now().second))


def micro_info():
    cfg = config()
    # Dekking hooguit elke 5 minuten opnieuw tellen (bestanden lezen kost tijd).
    if not micro_state.get('cov') or time.time() - micro_state.get('covAt', 0) > 300:
        micro_state['cov'] = micro_mod.coverage(MICRO_DIR)
        micro_state['covAt'] = time.time()
    return {'enabled': cfg['micro']['enabled'], 'useMicro': bool(cfg.get('useMicro')), 'minDays': micro_mod.MIN_DAYS,
            'coverage': micro_state['cov'], 'experiment': read_json('micro_experiment.json', {})}


def set_search_progress(phase, done, total, text):
    p = state.get('searchProgress') or {}
    state['searchProgress'] = {**p, 'phase': phase, 'done': done, 'total': total, 'text': text}


ARMS_MAX = 5      # bevestigde strategieën
TRIAL_MAX = 4     # proefstrategieën (veelbelovend, nog niet bevestigd)
MIN_ARMS = 3      # altijd minstens zoveel strategieën om mee te leren (desnoods verkenning)


def arm_file(key):
    return os.path.join('arms', key.replace('|', '_').replace('.', ',') + '.json')


def select_arms(results):
    """Welke strategieën gaan naar de bot, en in welke rol:
    - bevestigd: mag echt traden
    - proef: veelbelovend maar nog niet bevestigd; leert met schaduwtrades (en in paper echt)
    - verkenning: als er nog te weinig zijn, de beste van de rest; alleen schaduwtrades
    Zo is er altijd iets om van te leren, ook voordat er een bevestigde strategie is."""
    scored = [r for r in results.values() if (r.get('val') or {}).get('best') and r.get('score') is not None]
    scored.sort(key=lambda r: r['score'], reverse=True)
    out = [(r, 'bevestigd') for r in scored if r.get('status') == 'bevestigd'][:ARMS_MAX]
    out += [(r, 'proef') for r in scored if r.get('status') != 'bevestigd' and r['score'] > 0
            and r.get('status') != 'afgevallen'][:TRIAL_MAX]
    if len(out) < MIN_ARMS:
        have = {r['key'] for r, _ in out}
        out += [(r, 'verkenning') for r in scored if r['key'] not in have and r.get('status') != 'afgevallen'][:MIN_ARMS - len(out)]
    return out


def save_arms(results, models):
    """Modellen van de gekozen strategieën bewaren (de "armen" voor het zelflerend kiezen in de
    bot); de rest gaat eruit."""
    os.makedirs(path('arms'), exist_ok=True)
    chosen = select_arms(results)
    for key, m in models.items():
        if any(r['key'] == key for r, _ in chosen):
            write_json(arm_file(key), m)
    keep = {os.path.basename(arm_file(r['key'])) for r, _ in chosen}
    for name in os.listdir(path('arms')):
        if name not in keep:
            try:
                os.remove(os.path.join(path('arms'), name))
            except OSError:
                pass


def load_arms():
    """Strategieën met hun model en rol, voor de bot."""
    data = load_search()
    out = []
    for r, stage in select_arms(data.get('results', {})):
        m = read_json(arm_file(r['key']), None)
        if not m:
            continue
        out.append({'key': r['key'], 'stage': stage, 'timeframe': r['timeframe'], 'targetPct': r['targetPct'], 'stopPct': r['stopPct'],
                    'holdMinutes': r['holdMinutes'], 'minProb': r['val']['best']['minProb'], 'score': r['score'],
                    'holdout': {k: r.get('holdout', {}).get(k) for k in ('n', 'avgReturnPct')}, 'live': r.get('live'), 'model': m})
    return out


def add_arm_results(items):
    """Resultaten van de bot per strategie (echte trades en schaduwtrades): de "live-test".
    Een strategie die het live goed doet kan zo bevestigd worden; een die live verliest valt af."""
    clean = [t for t in items if isinstance(t.get('key'), str) and isinstance(t.get('pct'), (int, float)) and math.isfinite(t['pct'])]
    if not clean:
        return 0
    with search_lock:
        data = load_search()
        res = data.get('results', {})
        changed = []
        for t in clean:
            r = res.get(t['key'])
            if not r:
                continue
            lv = r.setdefault('live', {'n': 0, 'sum': 0.0, 'wins': 0, 'real': 0, 'shadow': 0})
            w = 0.5 if t.get('shadow') else 1.0
            lv['n'] += w
            lv['sum'] += t['pct'] * w
            lv['wins'] += w if t['pct'] > 0 else 0
            lv['shadow' if t.get('shadow') else 'real'] += 1
            before = r.get('status')
            searcher.judge(res)
            if r.get('status') != before:
                changed.append((r, before))
        write_json('search.json', data)
    for r, before in changed:
        lv = r['live']
        if r['status'] == 'bevestigd':
            think(f"{thoughts.name(r)} heeft zich live bewezen: {lv['real']} echte en {lv['shadow']} schaduwtrades, gemiddeld "
                  f"{thoughts.pct(lv['sum'] / lv['n'])} per trade. Ik promoveer hem tot bevestigde strategie.", kind='result')
        elif r['status'] == 'afgevallen':
            think(f"{thoughts.name(r)} doet het live slecht: gemiddeld {thoughts.pct(lv['sum'] / lv['n'])} per trade over "
                  f"{lv['real']} echte en {lv['shadow']} schaduwtrades. Ik laat hem vallen en zoek verder.", kind='warn')
    return len(clean)


def search_round():
    """Eén ronde van de zoeker; stapt daarna eventueel over op een nieuwe beste strategie."""
    cfg = config()
    cache = os.path.join(DATA, 'candles')
    fetch = lambda pair, tf, days: trainer.fetch_candles(pair, tf, days, cache_dir=cache)
    switch = None
    with work_lock:
        state['searching'] = True
        state['searchProgress'] = {'startedAt': datetime.now().isoformat(timespec='seconds'), 'phase': 'search', 'done': 0, 'total': 1, 'text': 'Starten'}
        try:
            with search_lock:
                data = load_search()
                models = {}
                missing = [r['key'] for r, _ in select_arms(data['results']) if not os.path.exists(path(arm_file(r['key'])))]
                searcher.run_round(cfg, data['results'], log=log, fetch=fetch, markets=trainer.top_markets,
                                   progress=set_search_progress, should_stop=lambda: state.get('wantMain'), models_out=models, think=think,
                                   prefer=missing[:4])
                save_arms(data['results'], models)
                data['lastRoundAt'] = datetime.now().isoformat(timespec='seconds')
                data['rounds'] = data.get('rounds', 0) + 1
                current = (data.get('champion') or {}).get('key')
                new = searcher.choose_champion(data['results'], current)
                if new:
                    r = data['results'][new]
                    data['champion'] = {'key': new, 'since': data['lastRoundAt'], 'score': r['score']}
                    switch = r
                elif current and current in data['results']:
                    data['champion']['score'] = data['results'][current].get('score')
                write_json('search.json', data)
        finally:
            state['searching'] = False
            state['cache'] = cache_info()
            try:
                compute_teamwork()
            except Exception as e:
                log(f'Scorebord AI + model bijwerken mislukt: {e}')
    if switch:
        think(thoughts.champion(switch, cfg['search']['autoApply']), kind='result')
        log(f"Nieuwe beste strategie gevonden: {switch['timeframe']} +{switch['targetPct']:g}% / -{switch['stopPct']:g}%, "
            f"max {switch['holdMinutes']} min ({switch['val']['best']['avgReturnPct']:+.2f}% per trade, controle {switch['holdout']['avgReturnPct']:+.2f}%)")
        if cfg['search']['autoApply']:
            saved = read_json('config.json', {})
            saved.update({'timeframe': switch['timeframe'], 'targetPct': switch['targetPct'], 'stopPct': switch['stopPct'],
                          'horizon': switch['horizon'],
                          'strategy': {'key': switch['key'], 'timeframe': switch['timeframe'], 'targetPct': switch['targetPct'],
                                       'stopPct': switch['stopPct'], 'holdMinutes': switch['holdMinutes'],
                                       'minProb': switch['val']['best']['minProb'], 'autoApply': True}})
            write_json('config.json', saved)
            log('Automatisch overstappen staat aan: model wordt nu getraind op deze strategie; de bot neemt hem over zodra het model klaar is')
            run_training('nieuwe beste strategie')


def search_worker():
    """Zoekt doorlopend zolang de zoeker aan staat, met een korte pauze tussen rondes."""
    while True:
        cfg = config()
        if not cfg['search']['enabled'] or cfg['agent']['enabled']:  # de AI-trader vervangt de zoeker
            state['nextSearchAt'] = None
            search_wake.clear()
            search_wake.wait(timeout=60)
            continue
        if state['running'] or state.get('wantMain'):
            time.sleep(5)
            continue
        try:
            search_round()
        except Exception as e:
            log(f'Zoeker: ronde mislukt: {e}')
            traceback.print_exc()
        pause = int(config()['search'].get('pauseMinutes') or 0)
        state['nextSearchAt'] = (datetime.now() + timedelta(minutes=pause)).isoformat(timespec='minutes')
        search_wake.clear()
        search_wake.wait(timeout=max(5, pause * 60))


# ---------- De AI-trader ----------
agent_wake = threading.Event()


AGENTS_VERSION = 3   # 3: kiezen op validatie, portefeuille-terugval, werkelijke kosten


def load_agents():
    d = read_json('agents.json', {})
    if d.get('recipes') and d.get('version', 1) < AGENTS_VERSION:
        # Oudere metingen (eindtest om te kiezen, opgetelde terugval, vaste kosten) zijn niet te
        # vergelijken met de nieuwe: bewaren als archief, recepten beginnen opnieuw.
        arch = read_json('agents-archief.json', [])
        arch.append({'archivedAt': datetime.now().isoformat(timespec='seconds'), 'version': d.get('version', 1), 'recipes': d['recipes']})
        write_json('agents-archief.json', arch[-5:])
        d = {**d, 'version': AGENTS_VERSION, 'recipes': {}, 'published': None, 'since': datetime.now().isoformat(timespec='seconds')}
        write_json('agents.json', d)
        log('AI-trader: nieuwe manier van meten; oude receptresultaten staan in agents-archief.json, de recepten beginnen opnieuw.')
    return {'version': AGENTS_VERSION, 'recipes': d.get('recipes') or {}, 'published': d.get('published') if d.get('recipes') else None,
            'live': d.get('live') or {}, 'round': d.get('round', 0), 'since': d.get('since') or datetime.now().isoformat(timespec='seconds')}


COST_MIN_PAIR = 5     # zoveel gemeten trades per coin voordat die coin eigen kosten krijgt
COST_MIN_ALL = 10     # zoveel in totaal voordat het gemiddelde van alle coins de ingestelde kosten vervangt


def _p75(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.75 * (len(xs) - 1))))]


def cost_table(cfg):
    """Werkelijke kosten per ronde (kopen + verkopen, %) per coin, gemeten door de bot: fees plus
    de afwijking van de koers. Voorzichtig: het 75e percentiel van de laatste 30 trades.
    Geeft (kosten per coin, uitleg per coin, kosten voor coins zonder eigen metingen)."""
    rows = [t for t in read_json('agent_trades.json', []) if isinstance(t.get('costPct'), (int, float))]
    base = float(cfg['costPct'])
    default = _p75([t['costPct'] for t in rows[-200:]]) if len(rows) >= COST_MIN_ALL else base
    per, info = {}, {}
    for pair in sorted({t['pair'] for t in rows if t.get('pair')}):
        xs = [t['costPct'] for t in rows if t.get('pair') == pair][-30:]
        if len(xs) >= COST_MIN_PAIR:
            per[pair] = _p75(xs)
        info[pair] = {'measured': round(_p75(xs), 4), 'median': round(sorted(xs)[len(xs) // 2], 4), 'n': len(xs),
                      'used': round(per.get(pair, default), 4)}
    return per, info, default


def agent_extra(tf):
    """Echte trades van de AI-trader (paper/live) als extra leervoorbeelden voor "kopen":
    (kenmerken, resultaat %, tijdstip van kopen in ms of None). train_agent gebruikt alleen trades
    van vóór de validatie."""
    out = []
    for t in read_json('agent_trades.json', []):
        if t.get('timeframe') != tf or not isinstance(t.get('features'), dict):
            continue
        f = t['features']
        out.append(([float(f[k]) if isinstance(f.get(k), (int, float)) else float('nan') for k in agent_mod.FEATURES], float(t['pct']),
                    t.get('entryTs')))
    return out


def _int_or_none(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float_or_none(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def add_agent_trades(items):
    """Uitkomsten van echte trades van de AI-trader: telt mee voor 'bewezen' en om van te leren."""
    clean = []
    for t in items:
        try:
            clean.append({'timeframe': str(t['timeframe']), 'recipe': str(t.get('recipe') or ''), 'pct': float(t['pct']), 'version': str(t.get('version') or ''),
                          'features': {k: float(v) for k, v in (t.get('features') or {}).items() if isinstance(v, (int, float))},
                          'mode': str(t.get('mode') or ''), 'pair': str(t.get('pair') or ''), 'at': datetime.now().isoformat(timespec='seconds'),
                          'entryTs': _int_or_none(t.get('entryTs')), 'openedAt': str(t.get('openedAt') or ''), 'closedAt': str(t.get('closedAt') or ''),
                          'marketRegime': t.get('marketRegime') if t.get('marketRegime') in agent_search.REGIMES else None,
                          'costPct': _float_or_none(t.get('costPct'))})
        except (KeyError, TypeError, ValueError):
            continue
    if not clean:
        return 0
    with feedback_lock:
        rows = (read_json('agent_trades.json', []) + clean)[-5000:]
        write_json('agent_trades.json', rows)
    data = load_agents()
    for t in clean:
        lv = data['live'].setdefault(t.get('recipe') or t['timeframe'], {'n': 0, 'sum': 0.0, 'wins': 0})
        lv['n'] += 1
        lv['sum'] += t['pct']
        lv['wins'] += t['pct'] > 0
        if lv['n'] == livecheck.MIN_TRADES:
            avg = lv['sum'] / lv['n']
            think(f"Na {lv['n']} echte trades met dit recept doe ik gemiddeld {thoughts.pct(avg)} per trade. "
                  'Of ik live mag, hangt af van alle eisen op de pagina Trainer (en daarna van jouw akkoord).',
                  kind='result' if avg >= livecheck.MIN_AVG else 'warn')
    write_json('agents.json', data)
    return len(clean)


def agent_pairs(cfg):
    """Op welke coins hij leert: je eigen coins, of (standaard) ook de grootste coins van Bitvavo,
    zodat hij zelf kan uitzoeken waar hij het best handelt."""
    own = list(cfg.get('pairs') or [])
    if cfg['agent'].get('coinPool') == 'eigen' and own:
        return own
    try:
        top = trainer.top_markets(20)
    except Exception:
        top = []
    return list(dict.fromkeys(own + top))[:24] or own


WHY_RECIPE = {
    'retest': 'mijn beste recept tot nu toe opnieuw, op de nieuwste koersen: houdt het stand?',
    'near': 'een variatie op mijn beste recept, misschien werkt dit nog beter',
    'fresh': 'iets nieuws dat ik nog niet geprobeerd heb',
    'old': 'een recept van een tijd geleden opnieuw, de markt kan veranderd zijn',
}


def agent_round():
    """Eén leerronde: zelf een recept kiezen, trainen, testen, en de beste manier van traden kiezen."""
    cfg = config()
    tfs = cfg['agent']['timeframes'] or agent_mod.DEFAULT_TIMEFRAMES
    try:
        fill_trade_market(cfg)
    except Exception as e:
        log(f'Marktbeweging bij trades invullen mislukt: {e}')
    data = load_agents()
    recipe, why = agent_search.pick(data['recipes'], tfs, rnd=random.Random(data.get('round', 0) + int(time.time())))
    key = agent_search.key_of(recipe)
    cache = os.path.join(DATA, 'candles')
    fetch = lambda pair, t, days: trainer.fetch_candles(pair, t, days, cache_dir=cache)
    pairs = agent_pairs(cfg)
    think(f"Ik probeer nu: {agent_mod.recipe_text(recipe)}, op {len(pairs)} coins. Waarom: {WHY_RECIPE.get(why, why)}", kind='doing')
    with work_lock:
        state['agentBusy'] = True
        state['agentProgress'] = {'startedAt': datetime.now().isoformat(timespec='seconds'), 'phase': 'agent', 'done': 0, 'total': 5,
                                  'text': f'Recept {agent_mod.recipe_text(recipe)}: starten'}
        try:
            def prog(phase, done, total, text):
                state['agentProgress'] = {**state['agentProgress'], 'done': done, 'total': total, 'text': text}
            costs, _, cost_default = cost_table(cfg)
            agent, report = agent_mod.train_agent({**cfg, 'agent': cfg['agent'], 'costPct': cost_default, 'costs': costs}, recipe, fetch, pairs, log=log,
                                                  progress=prog, extra=agent_extra(recipe['timeframe']), seed=data.get('round', 0) + 1)
        finally:
            state['agentBusy'] = False
    data = load_agents()
    data['round'] = data.get('round', 0) + 1
    report['at'] = datetime.now().isoformat(timespec='seconds')
    entry = agent_search.add_round(data['recipes'], recipe, report)
    os.makedirs(path('agents'), exist_ok=True)
    if agent:
        write_json(os.path.join('agents', key.replace('|', '_') + '.json'), agent)
    try:
        think(agent_mod_say(report, entry), kind='result' if report.get('ok') else 'warn')
    except Exception as e:  # een bericht mag een leerronde nooit laten mislukken
        log(f'AI-trader: bericht over de ronde mislukt: {e}')
    # De beste manier van traden kiezen: hoogste status, dan gemiddelde over de rondes.
    # Te riskante recepten (terugval > 25%) nooit gebruiken, ook niet om in paper te oefenen.
    board = [e for e in agent_search.leaderboard(data['recipes'], 50) if agent_search.usable(e)
             and os.path.exists(path(os.path.join('agents', e['key'].replace('|', '_') + '.json')))]
    prev = data.get('published')
    if board:
        best = board[0]
        st = agent_search.status(best)
        a = read_json(os.path.join('agents', best['key'].replace('|', '_') + '.json'), None)
        lv = data['live'].get(best['key']) or {}
        a['liveCheck'] = live_check(best['key'], best, a.get('costPct'))
        a['stage'] = agent_stage(best, a['liveCheck'])
        a['recipeKey'] = best['key']
        a['recipeStatus'] = st
        a['live'] = lv
        a['regimes'] = regime_plan(board, best, data)
        write_json('agent.json', a)
        plan_now = {reg: p['key'] for reg, p in a['regimes'].items()}
        plan_before = (prev or {}).get('regimes')
        data['published'] = {'key': best['key'], 'timeframe': a['timeframe'], 'stage': a['stage'], 'status': st, 'at': report['at'],
                             'regimes': plan_now}
        if plan_now != plan_before:
            think(regime_plan_text(a['regimes'], data['recipes']), kind='insight')
        if not prev or prev.get('key') != best['key'] or prev.get('stage') != a['stage']:
            sc = agent_search.score(best)
            coins = a.get('coins') or []
            think(f"Mijn beste manier van traden is nu: {agent_mod.recipe_text(best['recipe'])} ({st}; gemiddeld "
                  f"{thoughts.pct(sc['avg'])} per trade op de validatie, eindtest {thoughts.pct(sc['test']['avg'])} over {sc['test']['trades']} trades in {sc['tested']} ronde{'' if sc['tested'] == 1 else 's'}). "
                  f"Ik handel {len(coins)} coin{'' if len(coins) == 1 else 's'}: {', '.join(coins[:8])}{' …' if len(coins) > 8 else ''}. " +
                  {'getest': 'De bot gebruikt hem in paper; live pas als ik alle eisen voor live haal en jij het daarna aanzet.',
                   'bewezen': 'Ik haal alle eisen voor live. Live handel ik pas als jij dat op de pagina Trainer aanzet.',
                   'oefenen': 'Hij maakt in de test nog niet genoeg winst, dus de bot oefent er alleen mee in paper (als je dat toestaat).'}[a['stage']],
                  kind='result' if a['stage'] != 'oefenen' else 'insight')
    elif prev and prev.get('stage') != 'geblokkeerd':
        # Geen bruikbaar recept meer, en het recept waar de bot mee handelde is te riskant geworden:
        # de bot mag er niet meer mee handelen.
        old = data['recipes'].get(prev.get('key'))
        a = read_json('agent.json', None)
        if a and old and not agent_search.usable(old):
            a['stage'] = 'geblokkeerd'
            a['recipeStatus'] = 'te riskant'
            write_json('agent.json', a)
            data['published'] = {**prev, 'stage': 'geblokkeerd', 'status': 'te riskant', 'at': report['at']}
            think(f"Mijn recept {agent_mod.recipe_text(old['recipe'])} zakte in een test meer dan {agent_search.DANGER_DRAWDOWN}% terug. "
                  'Dat is te riskant: de bot handelt er niet meer mee, ook niet in paper, tot ik een veiliger recept vind.', kind='warn')
    write_json('agents.json', data)


def paper_rows(key=None):
    """Paper-trades van de AI-trader (oud -> nieuw), eventueel alleen van één recept."""
    return [t for t in read_json('agent_trades.json', []) if t.get('mode') == 'paper' and (key is None or t.get('recipe') == key)]


def live_check(key, entry, assumed_cost=None):
    """De eisen voor live voor één recept (zie livecheck.py)."""
    return livecheck.check(paper_rows(key), agent_search.status(entry) if entry else 'onbekend',
                           slots=int(config()['agent'].get('maxOpen') or 2), assumed_cost=assumed_cost)


def agent_stage(entry, lc):
    """Hoe ver een recept is: oefenen (paper, als dat mag), getest (paper), of bewezen: alle eisen
    voor live gehaald (live handelt hij pas als de eigenaar dat daarna zelf aanzet)."""
    st = agent_search.status(entry)
    if lc and lc.get('allMet'):
        return 'bewezen'
    return 'getest' if st in ('betrouwbaar', 'veelbelovend') else 'oefenen'


def fill_trade_market(cfg):
    """Vult bij de echte trades in wat de markt deed tijdens de trade (voor 'beter dan de markt')."""
    rows = read_json('agent_trades.json', [])
    todo = [r for r in rows if r.get('mkt') is None and r.get('closedAt')]
    if not todo:
        return 0
    cache = os.path.join(DATA, 'candles')
    candles = {}
    for pair in agent_pairs(cfg):
        try:
            candles[pair] = trainer.fetch_candles(pair, '1h', 30, cache_dir=cache)
        except Exception as e:
            log(f'Marktbeweging bij trades: {pair} ophalen mislukt: {e}')
    with feedback_lock:
        rows = read_json('agent_trades.json', [])
        n = livecheck.fill_market(rows, candles)
        if n:
            write_json('agent_trades.json', rows)
    return n


AGENT_PART_KEYS = ('version', 'kind', 'timeframe', 'threshold', 'maxHoldCandles', 'safetyStopPct', 'costPct', 'coins', 'recipe', 'entry', 'exit', 'meta')


def regime_plan(board, best, data):
    """Strategy Agent: per marktfase welk recept de bot gebruikt. Een ander recept dan het
    hoofdrecept gaat in zijn geheel mee in agent.json, zodat de bot het zelf kan uitrekenen."""
    out = {}
    for reg, p in agent_search.choose_per_regime(board, best).items():
        item = dict(p)
        if p['key'] and p['key'] != best['key']:
            sub = read_json(os.path.join('agents', p['key'].replace('|', '_') + '.json'), None)
            entry = data['recipes'].get(p['key'])
            if not sub or not entry:
                item = {'key': best['key'], 'why': 'weinig bewijs', 'edge': None, 'trades': 0}
            else:
                lv = data['live'].get(p['key']) or {}
                lc = live_check(p['key'], entry, sub.get('costPct'))
                item['agent'] = {**{k: sub[k] for k in AGENT_PART_KEYS if k in sub}, 'recipeKey': p['key'],
                                 'recipeStatus': agent_search.status(entry), 'stage': agent_stage(entry, lc), 'live': lv, 'liveCheck': lc}
        out[reg] = item
    return out


REGIME_NAME = {'stijgend': 'een stijgende markt', 'zijwaarts': 'een zijwaartse markt', 'dalend': 'een dalende markt'}


def regime_plan_text(plan, recipes):
    parts = []
    for reg in agent_search.REGIMES:
        p = plan.get(reg) or {}
        if not p.get('key'):
            parts.append(f"in {REGIME_NAME[reg]} handel ik niet (daar deed ik het slechter dan de markt)")
            continue
        rec = agent_mod.recipe_text((recipes.get(p['key']) or {}).get('recipe') or {})
        why = {'best': f"daar het best, {thoughts.pct(p.get('edge'))} per trade beter dan de markt",
               'weinig bewijs': 'mijn hoofdrecept, nog te weinig bewijs per marktfase'}.get(p['why'], p['why'])
        parts.append(f"in {REGIME_NAME[reg]} gebruik ik {rec} ({why})")
    return 'Strategy Agent: ' + '; '.join(parts) + '.'


def agent_mod_say(r, entry=None):
    tf = r.get('timeframe')
    rec = agent_mod.recipe_text(r.get('recipe') or {'timeframe': tf, **agent_mod.RECIPE_DEFAULT})
    if not r.get('test'):
        return f"Recept {rec}: {r.get('reason') or 'geen resultaat'}."
    t = r['test']
    if not t.get('trades'):
        return (f"Resultaat {rec}: in de eindtest deed ik geen enkele trade (mijn koopdrempel werd daar nooit gehaald). "
                'Zonder trades kan ik niet laten zien dat dit werkt, dus dit recept is niet goed genoeg.')
    f = thoughts.pct
    held = (t.get('avgHeld') or 0) * agent_mod.TF_MIN.get(tf, 15)
    per = r.get('periods') or {}
    s = (f"Resultaat {rec}: in de eindtest ({' tot '.join(per['eindtest']) if per.get('eindtest') else 'de laatste ' + str(r.get('testDays')).replace('.', ',') + ' dagen'}, "
         f"niet gebruikt bij het leren of kiezen) "
         f"deed ik {t['trades']} trades, gemiddeld {f(t['avgPct'])} per trade, {'?' if t.get('winRate') is None else format(t['winRate'], '.0f')}% met winst, "
         f"gemiddeld {thoughts.hold(int(held))} vastgehouden. Kopen en vasthouden had {f(t.get('buyHoldPct'))} opgeleverd. "
         f"Mijn grootste terugval was {f(-(t.get('maxDrawdownPct') or 0))}, mijn slechtste trade {f(t.get('worstPct'))}. ")
    if t.get('edgePct') is not None:
        beat = '' if t.get('beatMarketRate') is None else f" ({t['beatMarketRate']:.0f}% van de trades beter)"
        s += (f"De markt deed tijdens mijn trades gemiddeld {f(t.get('marketPct'))}; ik deed het per trade {f(t['edgePct'])} "
              f"{'beter' if t['edgePct'] > 0 else 'slechter'} dan meedobberen{beat}. ")
        if t['edgePct'] <= 0:
            s += 'Winst die ik ook met meedobberen had gehad, telt niet. '
    if (t.get('maxDrawdownPct') or 0) > agent_search.DANGER_DRAWDOWN:
        s += f"Die terugval is meer dan {agent_search.DANGER_DRAWDOWN}%: te riskant, dit recept gebruik ik nooit meer. "
    coins, pairs = r.get('coins') or [], r.get('pairs') or []
    if len(coins) < len(pairs):
        s += f"Ik koos {len(coins)} van de {len(pairs)} coins om te handelen (op de andere verloor ik in de validatie). "
    focus = r.get('exitFocus') or []
    if focus:
        names = [thoughts.LABELS.get(k, {'posPnlPct': 'mijn winst of verlies', 'posCandles': 'hoe lang ik al in de trade zit',
                                         'posMaxPct': 'de hoogste winst tot nu toe', 'posDrawPct': 'hoeveel ik terugzakte vanaf de top'}.get(k, k)) for k, _ in focus[:3]]
        s += f"Bij verkopen let ik vooral op: {', '.join(names)}. "
    if entry:
        sc = agent_search.score(entry)
        st = agent_search.status(entry)
        if sc['tested'] > 1:
            s += (f"Over {sc['tested']} rondes met dit recept: op de validatie gemiddeld {f(sc['avg'])} per trade ({sc['trades']} trades), "
                  f"in de eindtests {f(sc['test']['avg'])} ({sc['test']['trades']} trades). ")
        s += {'betrouwbaar': 'Dit recept houdt stand: betrouwbaar.',
              'veelbelovend': 'Veelbelovend, maar het moet zich nog herhalen voordat ik het vertrouw.',
              'oefenen': 'Nog niet goed genoeg.',
              'afgevallen': 'Dit recept verliest steeds; ik laat het vallen.',
              'te riskant': 'Te riskant (te diepe terugval); dit recept gebruik ik nooit, ook niet om te oefenen.'}[st]
    return s


def agent_worker():
    """Leert doorlopend: candle-tijd na candle-tijd, steeds met de nieuwste koersen."""
    while True:
        cfg = config()
        if not cfg['agent']['enabled']:
            agent_wake.clear()
            agent_wake.wait(timeout=60)
            continue
        if state['running'] or state.get('wantMain'):
            time.sleep(5)
            continue
        try:
            agent_round()
        except Exception as e:
            log(f'AI-trader: leerronde mislukt: {e}')
            traceback.print_exc()
        pause = int(config()['agent'].get('pauseMinutes') or 0)
        state['nextAgentAt'] = (datetime.now() + timedelta(minutes=pause)).isoformat(timespec='minutes')
        agent_wake.clear()
        agent_wake.wait(timeout=max(5, pause * 60))


def agent_info():
    cfg = config()
    data = load_agents()
    pub = read_json('agent.json', None)
    board = []
    rows = agent_search.leaderboard(data.get('recipes', {}), 12)
    pk = (data.get('published') or {}).get('key')
    if pk and pk in data.get('recipes', {}) and all(e['key'] != pk for e in rows):
        rows.append(data['recipes'][pk])  # het recept van de bot altijd tonen, ook als het onderaan staat
    for e in rows:
        last = e['rounds'][-1] if e.get('rounds') else {}
        board.append({'key': e['key'], 'recipe': e['recipe'], 'text': agent_mod.recipe_text(e['recipe']), 'status': agent_search.status(e),
                      'score': agent_search.score(e), 'byRegime': agent_search.regime_score(e), 'last': last, 'live': data.get('live', {}).get(e['key'])})
    return {'enabled': cfg['agent']['enabled'], 'config': cfg['agent'], 'busy': state.get('agentBusy', False),
            'progress': state.get('agentProgress') if state.get('agentBusy') else None, 'nextAt': state.get('nextAgentAt'),
            'recipes': board, 'tried': len(data.get('recipes', {})),
            'possible': len(agent_search.all_recipes(cfg['agent']['timeframes'] or agent_mod.DEFAULT_TIMEFRAMES)),
            'published': data.get('published'), 'coins': (pub or {}).get('coins'),
            'stage': (pub or {}).get('stage'), 'rounds': data.get('round', 0),
            'regimes': {reg: {k: v for k, v in p.items() if k != 'agent'} | {'text': agent_mod.recipe_text(data['recipes'][p['key']]['recipe']) if p.get('key') in data.get('recipes', {}) else None}
                        for reg, p in ((pub or {}).get('regimes') or {}).items()},
            'liveCheck': (pub or {}).get('liveCheck'),
            'liveRules': {'minTrades': livecheck.MIN_TRADES, 'minDays': livecheck.MIN_DAYS, 'minAvg': livecheck.MIN_AVG, 'maxDd': livecheck.MAX_DD},
            # De lange paper-test: per week, sinds de nieuwe manier van meten.
            'paperTest': {'since': data.get('since'), 'weeks': livecheck.weeks(paper_rows(), data.get('since'))},
            'costs': (lambda c: {'perCoin': c[1], 'default': round(c[2], 4), 'configured': cfg['costPct']})(cost_table(cfg))}


def cache_info():
    """Hoeveel koersgeschiedenis er bewaard is, per coin."""
    d = os.path.join(DATA, 'candles')
    out = []
    try:
        for name in sorted(os.listdir(d)):
            if not name.endswith('.json') or name.endswith('.meta.json'):
                continue
            try:
                with open(os.path.join(d, name)) as f:
                    rows = json.load(f)
            except (OSError, ValueError):
                continue
            if rows:
                pair, tf = name[:-5].rsplit('_', 1)
                out.append({'pair': pair.replace('-', '/'), 'timeframe': tf, 'candles': len(rows),
                            'days': round((rows[-1][0] - rows[0][0]) / 86_400_000, 1)})
    except OSError:
        pass
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = 'vetobot-trainer'

    def log_message(self, *a):  # geen request-logs met mogelijk de token erin
        pass

    def send(self, code, body, ctype='application/json', extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        got = self.headers.get('Authorization', '')
        ok = hmac.compare_digest(got.encode(), f'Bearer {token()}'.encode())
        if not ok:
            time.sleep(0.5)  # raden vertragen
            self.send(401, {'error': 'Onjuiste of ontbrekende code'})
        return ok

    def do_GET(self):
        if self.path == '/health':
            return self.send(200, {'ok': True})
        if not self.authed():
            return
        if self.path == '/arms.json':
            data = json.dumps({'arms': load_arms()}).encode()
            etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.end_headers()
                return
            return self.send(200, data, extra={'ETag': etag})
        if self.path == '/agent.json':
            a = read_json('agent.json', None)
            if not a:
                return self.send(404, {'error': 'Nog geen AI-trader'})
            data = load_agents()
            live = data.get('live', {})
            a['live'] = live.get(a.get('recipeKey') or a['timeframe'], {})
            # Eisen voor live steeds actueel (nieuwe paper-trades komen tussen de leerrondes binnen).
            for part in [a] + [p['agent'] for p in (a.get('regimes') or {}).values() if p.get('agent')]:
                part['live'] = live.get(part.get('recipeKey'), {})
                entry = data['recipes'].get(part.get('recipeKey'))
                if entry and part.get('stage') != 'geblokkeerd':
                    part['liveCheck'] = live_check(part['recipeKey'], entry, part.get('costPct'))
                    part['stage'] = agent_stage(entry, part['liveCheck'])
            data = json.dumps(a).encode()
            etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.end_headers()
                return
            return self.send(200, data, extra={'ETag': etag})
        if self.path == '/micro/latest':
            cfg = config()
            return self.send(200, {'useMicro': bool(cfg.get('useMicro')), 'features': micro_mod.latest(MICRO_DIR, cfg.get('pairs') or None)})
        if self.path == '/teamwork':
            return self.send(200, read_json('teamwork.json', {'total': 0}))
        if self.path == '/model.json':
            try:
                with open(path('model.json'), 'rb') as f:
                    data = f.read()
            except OSError:
                return self.send(404, {'error': 'Nog geen model getraind'})
            etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.end_headers()
                return
            return self.send(200, data, extra={'ETag': etag})
        if self.path == '/status':
            model = read_json('model.json', None)
            return self.send(200, {
                'running': state['running'], 'progress': state['progress'] if state['running'] else None,
                'config': config(), 'nextRunAt': None if state['running'] else next_run().isoformat(timespec='minutes'), 'trainHour': TRAIN_HOUR,
                'cache': state.get('cache', []), 'feedback': feedback_info(), 'search': search_info(),
                'teamwork': read_json('teamwork.json', {'total': 0}), 'thoughts': state.get('thoughts', [])[-120:],
                'micro': micro_info(), 'agent': agent_info(),
                'model': model and model.get('meta'), 'history': state['history'], 'log': state['log'][-150:],
            })
        self.send(404, {'error': 'Niet gevonden'})

    def do_POST(self):
        if not self.authed():
            return
        length = min(int(self.headers.get('Content-Length') or 0), 500000 if self.path == '/feedback' else 20000)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.send(400, {'error': 'Ongeldige JSON'})
        if self.path == '/config':
            try:
                cfg = validate_config(body)
            except (ValueError, TypeError) as e:
                return self.send(400, {'error': str(e)})
            write_json('config.json', cfg)
            log('Instellingen bijgewerkt door vetobot')
            wake.set()
            search_wake.set()
            agent_wake.set()
            return self.send(200, {'ok': True, 'config': cfg})
        if self.path == '/feedback':
            added = add_feedback(body.get('trades'))
            return self.send(200, {'ok': True, 'added': added})
        if self.path == '/train':
            started = run_training('handmatig vanuit vetobot')
            return self.send(200 if started else 409, {'ok': started, 'error': None if started else 'Er loopt al een training'})
        self.send(404, {'error': 'Niet gevonden'})


def main():
    state['history'] = read_json('history.json', [])
    state['thoughts'] = read_json('thoughts.json', [])
    state['cache'] = cache_info()
    t = token()
    print('=' * 70, flush=True)
    print(' vetobot-trainer', flush=True)
    print(f' Code voor het dashboard (Instellingen -> Eigen model): {t}', flush=True)
    print(f' Volgende training: {next_run():%Y-%m-%d %H:%M}', flush=True)
    print('=' * 70, flush=True)
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=search_worker, daemon=True).start()
    threading.Thread(target=micro_worker, daemon=True).start()
    threading.Thread(target=agent_worker, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
