"""vetobot-trainer: traint 's nachts het voorspelmodel en deelt het met de bot.

- De geheime code (token) wordt bij de eerste start gemaakt, staat in /data/token en wordt in de
  logs getoond. Die vul je in het vetobot-dashboard in. Geen keys in env-variabelen of .env.
- De bot stuurt zijn instellingen (candle-tijd, stop-loss, winstdoel, coins) via POST /config.
- Endpoints (allemaal met 'Authorization: Bearer <token>', behalve /health):
    GET  /health      leeft de trainer?
    GET  /model.json  het laatste goedgekeurde model
    GET  /status      instellingen, laatste trainingen en resultaten
    GET  /registry    modelregister: alle sessies/versies, actieve en vastgezette versie, per versie de
                      proefperiode (probation) en de praktijkresultaten (practice), en de afkoelperiodes
    POST /registry/rollback {version}  een eerdere versie terugzetten (en vastzetten)
    POST /registry/unpin              weer zelf laten kiezen
    POST /config      nieuwe instellingen
    POST /train       nu trainen
"""
import resources  # als eerste: begrenst de threads van numpy/scikit-learn (TRAIN_JOBS)
import copy
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
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import agent as agent_mod
import agent_search
import learnstats
import livecheck
import micro as micro_mod
import probation as probation_mod
import registry as registry_mod
import stats
import search as searcher
import thoughts
import train as trainer

DATA = os.environ.get('DATA_DIR', '/data')
PORT = int(os.environ.get('PORT', '8787'))
TRAIN_HOUR = int(os.environ.get('TRAIN_HOUR', '3'))  # elke nacht om dit uur (tijdzone via TZ)


def _env_num(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


# Poortwachter bij publiceren en de regel voor opnieuw trainen (instelbaar via /config -> agent,
# standaardwaarden ook via de omgeving).
PROMOTE_DEFAULTS = {
    'promoteMinGainPct': _env_num('PROMOTE_MIN_GAIN_PCT', 5),      # een ander recept: score minstens zoveel % beter
    'promoteMinRounds': int(_env_num('PROMOTE_MIN_ROUNDS', 2)),     # en minstens zoveel rondes met eindtest
    'promoteMaxDdFactor': _env_num('PROMOTE_MAX_DD_FACTOR', 1.25),  # eindtest-terugval hooguit zoveel keer die van het actieve
    'retrainTolerancePct': _env_num('RETRAIN_TOLERANCE_PCT', 5),    # hetzelfde recept opnieuw: zoveel % slechter mag (ruis)
    'retestHours': _env_num('RETEST_HOURS', 6),                     # hetzelfde recept pas na zoveel uur opnieuw trainen
    'retestTrades': int(_env_num('RETEST_TRADES', 20)),             # of na zoveel nieuwe trades van de bot met dat recept
    # Statistische toets bij een ander recept: met zoveel zekerheid beter per trade in de eindtests
    # (na correctie voor het aantal geteste recepten, zie promotion_gate).
    'promoteConfidence': _env_num('PROMOTE_CONFIDENCE', 0.95),
    # Proefperiode na een promotie (zie probation.py): na zoveel echte trades beoordelen, met deze
    # zekerheid, en een mislukt recept zoveel uur niet opnieuw promoveren.
    'probationTrades': int(_env_num('PROBATION_TRADES', 30)),
    'probationConfidence': _env_num('PROBATION_CONFIDENCE', 0.9),
    'probationCooldownHours': _env_num('PROBATION_COOLDOWN_HOURS', 72),
}

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
            'agent': {'enabled': True, 'timeframes': [], 'safetyStopPct': 10, 'pauseMinutes': 1, 'coinPool': 'top', 'maxOpen': 2,
                      'hours': None, **PROMOTE_DEFAULTS}}
# Grenzen voor de poortwachter en de regel voor opnieuw trainen.
PROMOTE_LIMITS = {'promoteMinGainPct': (0, 100), 'promoteMinRounds': (1, 6), 'promoteMaxDdFactor': (1, 5),
                  'retrainTolerancePct': (0, 50), 'retestHours': (0, 168), 'retestTrades': (1, 1000),
                  'promoteConfidence': (0.5, 0.999), 'probationTrades': (5, 1000), 'probationConfidence': (0.5, 0.999),
                  'probationCooldownHours': (0, 720)}
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
    """Atomair opslaan: eerst naar een eigen tijdelijk bestand (per proces en thread, zodat twee
    schrijvers elkaar niet in de weg zitten), naar schijf, dan in één keer vervangen. Gaat er iets mis,
    dan blijft het oude bestand heel."""
    tmp = path(f'{name}.tmp.{os.getpid()}.{threading.get_ident()}')
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path(name))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def token():
    p = path('token')
    if not os.path.exists(p):
        with open(p, 'w') as f:
            f.write(secrets.token_urlsafe(32))
        os.chmod(p, 0o600)
    with open(p) as f:
        return f.read().strip()


def helper_token():
    """Aparte code voor helpers: geeft alleen toegang tot recepten ophalen en uitkomsten terugsturen,
    niet tot de instellingen, de modellen of de status."""
    p = path('helper-token')
    if not os.path.exists(p):
        with open(p, 'w') as f:
            f.write('h-' + secrets.token_urlsafe(24))
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
    if s['mode'] not in ('times', 'interval', 'continuous', 'off'):
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
                        'maxOpen': max(1, min(20, int(a.get('maxOpen') or 2))),
                        # Leeruren: alleen op deze uren leren (leeg = doorlopend). None = AGENT_HOURS uit de omgeving.
                        'hours': parse_hours(a['hours']) if a.get('hours') not in (None, '') else (None if a.get('hours') is None else [])}
        for k, (lo, hi) in PROMOTE_LIMITS.items():
            v = float(a.get(k) if a.get(k) is not None else PROMOTE_DEFAULTS[k])
            if not lo <= v <= hi:
                raise ValueError(f'{k} moet tussen {lo} en {hi} liggen')
            cfg['agent'][k] = int(v) if isinstance(PROMOTE_DEFAULTS[k], int) else v
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
    if s['mode'] == 'off':
        return None  # uit: alleen nog als je zelf op 'Nu trainen' drukt
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


SCHEDULE_REASON = {'off': 'handmatige training', 'times': 'geplande training', 'interval': 'training volgens interval', 'continuous': 'doorlopende training'}


def scheduler():
    if not os.path.exists(path('model.json')) and next_run():
        run_training('eerste start')
    while True:
        due = next_run()
        wake.clear()
        if due is None:
            # Het oude voorspelmodel staat uit (de AI-trader leert zelf): wachten tot het schema verandert.
            wake.wait(timeout=600)
            continue
        # Slapen tot het tijd is, maar wakker worden als het schema verandert of een training klaar is.
        wake.wait(timeout=max(5, (due - datetime.now()).total_seconds()))
        nxt = next_run()
        if state['running'] or nxt is None or datetime.now() < nxt:
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
    rows = [t for t in read_json('agent_trades.json', []) if not t.get('virtual') and isinstance(t.get('costPct'), (int, float))]
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
    (kenmerken, resultaat %, instaptijd, sluitingstijd, gewicht). train_agent gebruikt alleen trades
    die volledig vóór de validatie zijn afgesloten; virtuele voorbeelden tellen minder zwaar."""
    out = []
    for t in read_json('agent_trades.json', []):
        if t.get('timeframe') != tf or not isinstance(t.get('features'), dict):
            continue
        try:
            closed_ts = int(datetime.fromisoformat(str(t.get('closedAt')).replace('Z', '+00:00')).timestamp() * 1000)
        except (ValueError, TypeError, OverflowError, OSError):
            closed_ts = None
        f = t['features']
        out.append(([float(f[k]) if isinstance(f.get(k), (int, float)) else float('nan') for k in agent_mod.FEATURES], float(t['pct']),
                    t.get('entryTs'), closed_ts, 0.75 if t.get('virtual') else 3.0))
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
                          'costPct': _float_or_none(t.get('costPct')), 'explore': bool(t.get('explore') or t.get('virtual')),
                          'virtual': bool(t.get('virtual')),
                          'expectedPct': _float_or_none(t.get('expectedPct'))})
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(clean[-1]['pct']):  # NaN/Infinity: zou de live-tellingen en de JSON voor de bot bederven
            clean.pop()
    if not clean:
        return 0
    with feedback_lock:
        rows = (read_json('agent_trades.json', []) + clean)[-5000:]
        write_json('agent_trades.json', rows)
    # agents.json lezen-aanpassen-schrijven onder publish_lock: anders kan een leerronde of een
    # terugzetting die tegelijk agents.json schrijft verloren gaan ('published' wijst dan naar een
    # ander recept dan agent.json), of gaan deze tellingen verloren. Zie AuditRollback.
    with publish_lock:
        data = load_agents()
        # Trades van de verkenner leren mee, maar tellen niet als resultaat in de praktijk.
        for t in (t for t in clean if not t['explore']):
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
    # Licht: alleen als de actieve versie op proef is, worden de trades geteld (zie _check_probation).
    try:
        check_probation()
    except Exception as e:  # de feedback mag nooit mislukken door de proef
        log(f'Modelregister: proefperiode controleren mislukt: {e}')
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


# ---------- Leerrondes: de VPS zelf en helpers ----------
# Een recept dat al getraind wordt (door de VPS of een helper) wordt niet nog eens uitgedeeld. Komt een
# helper niet terug binnen LEASE_S, dan vervalt zijn opdracht en kan het recept opnieuw gekozen worden.
LEASE_S = int(os.environ.get('HELPER_LEASE_MINUTES') or 90) * 60
inflight = {}           # recept-sleutel -> {'id', 'by', 'at'}
inflight_lock = threading.Lock()
publish_lock = threading.Lock()


def _iso_ts(v):
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def retest_rule(cfg, trades=None):
    """Mag een al getest recept opnieuw getraind worden? Alleen als er genoeg nieuwe data is:
    minstens retestHours uur (of één candle van het recept, als die langer duurt) sinds de vorige
    test, of minstens retestTrades nieuwe trades van de bot met dat recept sinds de vorige test.
    Geeft een functie (entry, now) -> bool voor agent_search.pick."""
    a = cfg.get('agent') or {}
    hours = float(a.get('retestHours') if a.get('retestHours') is not None else PROMOTE_DEFAULTS['retestHours'])
    need = int(a.get('retestTrades') if a.get('retestTrades') is not None else PROMOTE_DEFAULTS['retestTrades'])
    rows = read_json('agent_trades.json', []) if trades is None else trades
    times = {}
    for t in rows:
        ts = _iso_ts(t.get('at'))
        if ts is not None and t.get('recipe'):
            times.setdefault(t['recipe'], []).append(ts)

    def ok(entry, now):
        last = agent_search.last_test_ts(entry)
        if not last:
            return True
        wait = max(hours * 3600, agent_mod.TF_MIN.get(entry['recipe'].get('timeframe'), 15) * 60)
        if now - last >= wait:
            return True
        return sum(1 for ts in times.get(entry['key'], ()) if ts > last) >= need
    return ok


def choose_recipe(cfg, data, by):
    """Kies een recept dat nog niemand traint en zet het op naam van `by`. Geeft (recept, reden, id).
    Een al getest recept alleen als er genoeg nieuwe data is (retest_rule); is alles te vers, dan
    (None, 'te vers', None): even wachten."""
    tfs = cfg['agent']['timeframes'] or agent_mod.DEFAULT_TIMEFRAMES
    try:
        rule = retest_rule(cfg)
    except Exception as e:  # de regel mag het leren nooit stilleggen
        log(f'AI-trader: regel voor opnieuw trainen mislukt: {e}')
        rule = None
    with inflight_lock:
        now = time.time()
        for k in [k for k, v in inflight.items() if now - v['at'] > LEASE_S]:
            log(f"AI-trader: {inflight[k]['by']} kwam niet terug met {k}; het recept is weer vrij")
            del inflight[k]
        recipe, why = agent_search.pick(data['recipes'], tfs, rnd=random.Random(data.get('round', 0) + int(now * 1000) % 100000),
                                        exclude=frozenset(inflight), may_retest=rule)
        if recipe is None:
            if why == 'te vers':
                if not state.get('agentWaiting'):
                    state['agentWaiting'] = datetime.now().isoformat(timespec='seconds')
                    log('AI-trader: alle recepten zijn kort geleden getest en er is nog te weinig nieuwe data; ik wacht.')
            return None, why, None
        state['agentWaiting'] = None
        job_id = secrets.token_hex(8)
        inflight[agent_search.key_of(recipe)] = {'id': job_id, 'by': by, 'at': now}
    return recipe, why, job_id


def release(recipe):
    with inflight_lock:
        inflight.pop(agent_search.key_of(recipe), None)


def round_config(cfg):
    """Instellingen voor train_agent (ook wat een helper meekrijgt)."""
    costs, _, cost_default = cost_table(cfg)
    return {'costPct': cost_default, 'costs': costs, 'days': int(cfg['days']),
            'agent': {k: cfg['agent'].get(k) for k in ('safetyStopPct', 'maxOpen')}}


HELPER_PROTOCOL = 1
helpers = {}            # naam -> wat de helper doet en deed (alleen in het geheugen)


def _helper_seen(name, body):
    h = helpers.setdefault(name, {'name': name, 'rounds': 0, 'failed': 0, 'seconds': [], 'firstSeen': datetime.now().isoformat(timespec='seconds')})
    h.update({'lastSeen': datetime.now().isoformat(timespec='seconds'), 'platform': str(body.get('platform') or '')[:80],
              'jobs': body.get('jobs'), 'version': body.get('version')})
    return h


def helper_claim(body):
    """Een helper vraagt om werk. Geeft een recept met alles wat nodig is om het te trainen, of
    {'job': None, 'waitSeconds': ...} als er nu niets te doen is."""
    name = str(body.get('name') or 'helper')[:40]
    h = _helper_seen(name, body)
    if body.get('protocol') != HELPER_PROTOCOL:
        return {'job': None, 'waitSeconds': 600, 'error': 'Deze helper is te oud of te nieuw voor de leerserver; werk hem bij.'}
    cfg = config()
    if not cfg['agent']['enabled']:
        h['busy'] = None
        return {'job': None, 'waitSeconds': 120, 'reason': 'De AI-trader leert nu niet.'}
    data = load_agents()
    recipe, why, job_id = choose_recipe(cfg, data, name)
    if recipe is None:
        return {'job': None, 'waitSeconds': 60 if why != 'te vers' else 300,
                'reason': 'Er is nog te weinig nieuwe data om recepten opnieuw te trainen.' if why == 'te vers' else 'Alle recepten worden al getraind.'}
    h['busy'] = {'id': job_id, 'recipe': agent_search.key_of(recipe), 'since': datetime.now().isoformat(timespec='seconds')}
    think(f"Helper {name} traint nu: {agent_mod.recipe_text(recipe)}. Waarom: {WHY_RECIPE.get(why, why)}", kind='doing')
    return {'job': {'id': job_id, 'recipe': recipe, 'why': why, 'protocol': HELPER_PROTOCOL, 'agentsVersion': AGENTS_VERSION,
                    'cfg': round_config(cfg), 'pairs': agent_pairs(cfg),
                    'extra': [list(x) for x in agent_extra(recipe['timeframe'])], 'seed': data.get('round', 0) + 1}}


def helper_result(body):
    """Een helper stuurt de uitkomst terug. Wordt verwerkt alsof de VPS het recept zelf trainde."""
    name = str(body.get('name') or 'helper')[:40]
    h = _helper_seen(name, body)
    job_id = str(body.get('id') or '')
    with inflight_lock:
        key = next((k for k, v in inflight.items() if v['id'] == job_id), None)
    if key is None:
        return 409, {'ok': False, 'error': 'Onbekende of verlopen opdracht'}
    recipe = body.get('recipe') or {}
    try:
        if agent_search.key_of(recipe) != key:
            raise ValueError('ander recept dan de opdracht')
        if body.get('agentsVersion') != AGENTS_VERSION:
            raise ValueError('andere manier van meten (werk de helper bij)')
        report, agent = body.get('report'), body.get('agent')
        if not isinstance(report, dict):
            raise ValueError('geen rapport')
        if agent is not None and (agent.get('kind') != 'agent' or agent.get('version') != 2 or not agent.get('entry') or not agent.get('exit')):
            raise ValueError('onbekend formaat voor de AI-trader')
    except (ValueError, TypeError, AttributeError) as e:
        with inflight_lock:
            inflight.pop(key, None)
        h['failed'] += 1
        h['busy'] = None
        log(f'Helper {name}: uitkomst niet gebruikt: {e}')
        return 400, {'ok': False, 'error': str(e)}
    if body.get('error'):
        with inflight_lock:
            inflight.pop(key, None)
        h['failed'] += 1
        h['busy'] = None
        log(f"Helper {name}: ronde mislukt: {str(body['error'])[:300]}")
        return 200, {'ok': True}
    try:
        finish_round(recipe, agent, report, by=name)
    finally:
        release(recipe)
    h['rounds'] += 1
    h['busy'] = None
    if isinstance(body.get('seconds'), (int, float)):
        h['seconds'] = (h['seconds'] + [round(float(body['seconds']), 1)])[-20:]
    return 200, {'ok': True}


# ---------- Koppelen met een korte code ----------
# De helper-code is lang. In het dashboard maak je een koppelcode van 6 cijfers (15 minuten geldig,
# één keer te gebruiken); de helper ruilt die bij /helper/pair in voor de helper-code. Tegen raden:
# een koppelcode is na 5 foute pogingen ongeldig, en na 20 foute pogingen in 15 minuten wordt
# koppelen 15 minuten geweigerd.
PAIR_TTL_S = 15 * 60
pairing = {'code': None, 'until': 0.0, 'wrong': 0, 'fails': [], 'blockedUntil': 0.0}
pairing_lock = threading.Lock()


def new_pair_code():
    with pairing_lock:
        pairing.update({'code': f'{secrets.randbelow(1_000_000):06d}', 'until': time.time() + PAIR_TTL_S, 'wrong': 0})
        return {'code': pairing['code'], 'expiresAt': datetime.fromtimestamp(pairing['until']).isoformat(timespec='seconds'),
                'minutes': PAIR_TTL_S // 60}


def helper_pair(body):
    """Koppelcode inwisselen voor de helper-code. Geeft (status, antwoord)."""
    code = ''.join(ch for ch in str(body.get('code') or '') if ch.isdigit())
    now = time.time()
    with pairing_lock:
        pairing['fails'] = [t for t in pairing['fails'] if now - t < PAIR_TTL_S]
        if now < pairing['blockedUntil']:
            return 429, {'error': 'Te veel foute koppelcodes; probeer het over een kwartier opnieuw.'}
        ok = bool(pairing['code']) and now < pairing['until'] and hmac.compare_digest(code, pairing['code'])
        if ok:
            pairing.update({'code': None, 'until': 0.0, 'wrong': 0})
        else:
            pairing['fails'].append(now)
            pairing['wrong'] += 1
            if pairing['wrong'] >= 5:
                pairing.update({'code': None, 'until': 0.0})
            if len(pairing['fails']) >= 20:
                pairing['blockedUntil'] = now + PAIR_TTL_S
    if not ok:
        time.sleep(float(os.environ.get('PAIR_FAIL_DELAY', '1')))  # raden vertragen
        return 403, {'error': 'Onjuiste of verlopen koppelcode. Maak een nieuwe in het dashboard (Trainer → Helpers).'}
    name = str(body.get('name') or 'helper')[:40]
    log(f'Helper {name} gekoppeld met een koppelcode')
    think(f'Er is een nieuwe helper gekoppeld: {name}. Hij gaat recepten voor me trainen.', kind='info')
    return 200, {'token': helper_token()}


def helpers_info():
    now = datetime.now()
    out = []
    for h in helpers.values():
        seen = datetime.fromisoformat(h['lastSeen'])
        out.append({**{k: h.get(k) for k in ('name', 'platform', 'jobs', 'rounds', 'failed', 'busy', 'lastSeen', 'firstSeen', 'version')},
                    'online': (now - seen).total_seconds() < LEASE_S,
                    'avgSeconds': round(sum(h['seconds']) / len(h['seconds']), 1) if h['seconds'] else None})
    return sorted(out, key=lambda x: x['lastSeen'], reverse=True)


def agent_round():
    """Eén leerronde: zelf een recept kiezen, trainen, testen, en de beste manier van traden kiezen."""
    cfg = config()
    try:
        fill_trade_market(cfg)
    except Exception as e:
        log(f'Marktbeweging bij trades invullen mislukt: {e}')
    data = load_agents()
    recipe, why, _ = choose_recipe(cfg, data, 'VPS')
    if recipe is None:
        return  # alles wordt al getraind (door helpers)
    try:
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
                agent, report = agent_mod.train_agent({**cfg, **round_config(cfg), 'featureCache': os.path.join(DATA, 'features')},
                                                      recipe, fetch, pairs, log=log, progress=prog,
                                                      extra=agent_extra(recipe['timeframe']), seed=data.get('round', 0) + 1)
            finally:
                state['agentBusy'] = False
        finish_round(recipe, agent, report, 'VPS')
    finally:
        release(recipe)


def finish_round(recipe, agent, report, by='VPS'):
    """Uitkomst van een ronde verwerken (van de VPS zelf of van een helper): bewaren, beoordelen en
    de beste manier van traden kiezen voor de bot."""
    with publish_lock:
        return _finish_round(recipe, agent, report, by)


def agent_file(key):
    return os.path.join('agents', key.replace('|', '_') + '.json')


# ---------- Modelversiebeheer (zie registry.py) ----------
_registries = {}


def registry():
    """Het modelregister in DATA_DIR (één per map, ook als DATA_DIR in tests wisselt)."""
    r = _registries.get(DATA)
    if r is None:
        r = _registries[DATA] = registry_mod.Registry(DATA, log=log)
    return r


def promote_thresholds(cfg=None):
    a = (cfg or config()).get('agent') or {}
    out = {k: a.get(k) if a.get(k) is not None else d for k, d in PROMOTE_DEFAULTS.items()}
    out['dangerDrawdownPct'] = agent_search.DANGER_DRAWDOWN
    return out


STATUS_ORDER = {'betrouwbaar': 3, 'veelbelovend': 2, 'oefenen': 1, 'afgevallen': 0, 'te riskant': -1}
METRIC_FIELDS = ('trades', 'avgPct', 'totalPct', 'winRate', 'maxDrawdownPct', 'worstPct', 'marketPct', 'edgePct', 'beatMarketRate',
                 'netReturnPct', 'profitFactor', 'sharpe', 'stdPct', 'avgWinPct', 'avgLossPct', 'byRegime', 'byVolatility', 'portfolio')
COMPARE_FIELDS = ('ratio', 'avg', 'edge', 'testAvg', 'testDrawdown', 'testProfitFactor', 'tested')


def recipe_metrics(entry):
    """De cijfers van een recept over al zijn rondes, waarop de poortwachter vergelijkt: de bestaande
    score (ratio winst/terugval op de validatie), de eindtest-terugval en de winstfactor in de eindtests."""
    if not entry:
        return None
    sc = agent_search.score(entry)
    st = agent_search.status(entry)
    pf, known = agent_search.test_profit_factor(entry)
    ts = agent_search.test_stats(entry)
    eff = _safe(lambda: stats.effective_trades(_test_spans(entry)), 'unieke eindtest-trades tellen') if ts else None
    return {'status': st, 'order': STATUS_ORDER.get(st, 0), 'ratio': sc['ratio'], 'avg': sc['avg'], 'edge': sc['edge'],
            'tested': sc['tested'], 'testAvg': sc['test']['avg'], 'testDrawdown': sc['test']['drawdown'],
            'testProfitFactor': pf, 'pfKnown': known,
            # Voor de statistische toets: gemiddelde, spreiding en aantal trades over alle eindtests samen.
            'testMean': ts[0] if ts else None, 'testStd': ts[1] if ts else None, 'testTrades': ts[2] if ts else None,
            # Zoveel van die trades zijn echt los van elkaar (rondes op dezelfde eindtest tellen één keer).
            'testEffTrades': eff}


def _test_spans(entry):
    """Per eindtest-ronde (dezelfde rondes als agent_search.test_stats): (trades, begin, eind) van de
    eindtestperiode als unix-tijd. Uit periods['eindtest'] (UTC, 'JJJJ-MM-DD UU:MM'); oudere rondes
    zonder periodes: de testDays dagen tot het moment van de ronde (de eindtest is altijd de nieuwste
    data). Onbekend: (trades, None, None)."""
    out = []
    for x in (entry or {}).get('rounds', []):
        t = x.get('test') or {}
        if not t.get('trades') or t.get('avgPct') is None:
            continue
        a = b = None
        span = ((x.get('periods') or {}).get('eindtest')) or None
        try:
            a, b = (datetime.strptime(str(s), '%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc).timestamp() for s in span)
        except (TypeError, ValueError):
            a = b = None
        if (a is None or b is None or b <= a) and _num(x.get('ts')) and _num(x.get('testDays')) and x['testDays'] > 0:
            a, b = x['ts'] - x['testDays'] * 86400, x['ts']
        out.append((t['trades'], a, b))
    return out


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def metric_deltas(new, old):
    """Verschil (nieuw - actief) per cijfer, alleen waar beide bekend zijn."""
    if not new or not old:
        return {}
    return {k: new[k] - old[k] for k in COMPARE_FIELDS if _num(new.get(k)) and _num(old.get(k))}


def _f(v, d=2):
    if v is None:
        return '–'
    if isinstance(v, float) and math.isinf(v):
        return '∞'
    return f'{v:.{d}f}'.replace('.', ',')


def _sp(v, d=2):
    """Een percentage met teken, Nederlands: +0,08% of −0,03%."""
    return '–' if v is None else f'{v:+.{d}f}%'.replace('.', ',').replace('-', '−')


def stat_test(new, old, conf, candidates=1):
    """Statistische toets op de eindtests: is het gemiddelde rendement per trade van `new` met
    betrouwbaarheid `conf` hoger dan dat van `old`? Eenzijdige Welch t-toets op (gemiddelde, std,
    aantal trades) van alle eindtest-rondes samen, waarbij rondes op dezelfde eindtestperiode niet als
    extra trades tellen (testEffTrades, zie stats.effective_trades). Correctie voor selectie (Bonferroni): de beste van
    `candidates` geteste recepten is vaak toevallig de beste, dus de toets gebruikt 1 - (1 - conf) /
    candidates als betrouwbaarheid; hoe meer recepten geprobeerd, hoe strenger.
    Geeft (ok, reden, cijfers) of None als de toets niet kan (oudere rondes zonder spreiding)."""
    keys = ('testMean', 'testStd', 'testTrades')
    if not all(_num((new or {}).get(k)) and _num((old or {}).get(k)) for k in keys) or new['testTrades'] < 2 or old['testTrades'] < 2:
        return None
    # Het aantal trades voor de standaardfout: alleen de trades die echt los van elkaar zijn. Rondes
    # die dezelfde eindtestperiode opnieuw testen, tellen niet als nieuwe trades (stats.effective_trades).
    eff = lambda m: min(m['testTrades'], max(m['testEffTrades'], 2.0)) if _num(m.get('testEffTrades')) else m['testTrades']
    n_new, n_old = eff(new), eff(old)
    k = max(1, int(candidates or 1))
    level = 1 - (1 - float(conf)) / k
    diff, lower, _ = stats.welch_lower((new['testMean'], new['testStd'], n_new), (old['testMean'], old['testStd'], n_old), level)
    pc = f'{float(conf) * 100:g}%'
    corr = f', gecorrigeerd voor {k} geteste recepten' if k > 1 else ''
    info = {'diffPct': diff, 'lowerPct': lower, 'confidence': float(conf), 'level': level, 'candidates': k,
            'trades': [n_new, n_old]}
    if lower > 0:
        return True, f'met {pc} zekerheid beter: {_sp(diff)} per trade (ondergrens {_sp(lower)}{corr})', info
    return False, f'niet zeker genoeg beter: ondergrens {_sp(lower)} per trade ({_sp(diff)} gemiddeld, {pc} zekerheid{corr})', info


def promotion_gate(new, old, th, same=False, candidates=1):
    """Is `new` aantoonbaar beter dan het actieve model `old` (beide recipe_metrics)? Geeft (ok, reden).
    Ander recept: minstens promoteMinRounds geteste rondes, een status die niet lager is, en met
    promoteConfidence zekerheid een hoger gemiddeld rendement per trade in de eindtests (stat_test, met
    correctie voor het aantal geteste recepten `candidates`). Kan die toets niet (oudere rondes zonder
    spreiding), dan de oude eis: hogere status, of bij gelijke status een score (ratio) minstens
    promoteMinGainPct % hoger. Verder: eindtest-terugval hooguit promoteMaxDdFactor x die van het
    actieve model, en een winstfactor die niet lager is.
    Hetzelfde recept opnieuw getraind (same): niet slechter dan ervoor, met retrainTolerancePct % speling."""
    if old is None:
        return True, 'er was nog geen actief model om mee te vergelijken'
    if new is None:
        return False, 'geen cijfers voor het nieuwe model'
    factor = float(th['promoteMaxDdFactor'])
    stat = None
    if same:
        tol = float(th['retrainTolerancePct']) / 100
        if new['order'] < old['order']:
            return False, f"de status zakte van {old['status']} naar {new['status']}"
        a, b = new['ratio'], old['ratio']
        if b is not None and (a is None or a < b - abs(b) * tol):
            return False, f'de score zakte van {_f(b)} naar {_f(a)}'
    else:
        need = int(th['promoteMinRounds'])
        if (new['tested'] or 0) < need:
            return False, f"nog maar {new['tested'] or 0} geteste ronde{'' if new['tested'] == 1 else 's'}, minstens {need} nodig"
        gain = float(th['promoteMinGainPct']) / 100
        if new['order'] < old['order']:
            return False, f"status {new['status']} is lager dan {old['status']} van het actieve model"
        stat = stat_test(new, old, th.get('promoteConfidence', PROMOTE_DEFAULTS['promoteConfidence']), candidates)
        if stat is not None:
            if not stat[0]:
                return False, stat[1]
        elif new['order'] == old['order']:
            a, b = new['ratio'], old['ratio']
            if a is None or (b is not None and (a <= b or a < b + abs(b) * gain)):
                return False, f"score {_f(a)} is niet duidelijk hoger dan {_f(b)} (minstens {float(th['promoteMinGainPct']):g}% beter nodig)"
    a, b = new['testDrawdown'], old['testDrawdown']
    if b is not None and (a is None or a > factor * max(b, agent_search.MIN_DD)):
        return False, f'eindtest-terugval {_f(a, 1)}% is meer dan {factor:g}× die van het actieve model ({_f(b, 1)}%)'
    a, b = new['testProfitFactor'], old['testProfitFactor']
    if b is not None:
        lim = b * (1 - float(th['retrainTolerancePct']) / 100) if same else b
        if a is None or a < lim:
            return False, f'winstfactor {_f(a)} is lager dan {_f(b)} van het actieve model'
    return True, ('niet slechter dan de vorige training van dit recept' if same else
                  f"aantoonbaar beter{f' ({stat[1]})' if stat else ''}: score {_f(new['ratio'])} tegen {_f(old['ratio'])}, terugval {_f(new['testDrawdown'], 1)}% "
                  f"tegen {_f(old['testDrawdown'], 1)}%, winstfactor {_f(new['testProfitFactor'])} tegen {_f(old['testProfitFactor'])}")


def publish_agent(main, board, data, prev, report):
    """Het model van recept `main` publiceren als agent.json (voor paper; live zet alleen de eigenaar
    aan). Met het plan per marktfase en de extra recepten. Geeft de gepubliceerde agent, of None."""
    st = agent_search.status(main)
    a = read_json(agent_file(main['key']), None)
    if not isinstance(a, dict) or not a.get('entry') or not a.get('exit'):
        log(f"AI-trader: model van {main['key']} niet leesbaar; agent.json blijft zoals hij was")
        return None
    lv = data['live'].get(main['key']) or {}
    a['liveCheck'] = live_check(main['key'], main, a.get('costPct'))
    a['stage'] = agent_stage(main, a['liveCheck'])
    a['recipeKey'] = main['key']
    a['recipeStatus'] = st
    a['live'] = lv
    a['volStats'] = agent_search.vol_stats(main)
    a['regimes'] = regime_plan(board, main, data)
    a['extras'] = extra_recipes(board, main, a['regimes'], data)
    # Een melding voor de bot (mislukte proef) blijft een week staan; de bot meldt hem één keer per 'at'.
    old = read_json('agent.json', None)
    note = old.get('notice') if isinstance(old, dict) else None
    if isinstance(note, dict) and (probation_mod.ts_of(note.get('at')) or 0) > time.time() - 7 * 86400:
        a['notice'] = note
    write_json('agent.json', a)
    plan_now = {reg: p['key'] for reg, p in a['regimes'].items()}
    plan_before = (prev or {}).get('regimes')
    data['published'] = {'key': main['key'], 'timeframe': a['timeframe'], 'stage': a['stage'], 'status': st, 'at': report['at'],
                         'regimes': plan_now}
    if plan_now != plan_before:
        think(regime_plan_text(a['regimes'], data['recipes']), kind='insight')
    if not prev or prev.get('key') != main['key'] or prev.get('stage') != a['stage']:
        sc = agent_search.score(main)
        coins = a.get('coins') or []
        think(f"Mijn beste manier van traden is nu: {agent_mod.recipe_text(main['recipe'])} ({st}; gemiddeld "
              f"{thoughts.pct(sc['avg'])} per trade op de validatie, eindtest {thoughts.pct(sc['test']['avg'])} over {sc['test']['trades']} trades in {sc['tested']} ronde{'' if sc['tested'] == 1 else 's'}). "
              f"Ik handel {len(coins)} coin{'' if len(coins) == 1 else 's'}: {', '.join(coins[:8])}{' …' if len(coins) > 8 else ''}. " +
              {'getest': 'De bot gebruikt hem in paper; live pas als ik alle eisen voor live haal en jij het daarna aanzet.',
               'bewezen': 'Ik haal alle eisen voor live. Live handel ik pas als jij dat op de pagina Trainer aanzet.',
               'oefenen': 'Hij maakt in de test nog niet genoeg winst, dus de bot oefent er alleen mee in paper (als je dat toestaat).'}[a['stage']],
              kind='result' if a['stage'] != 'oefenen' else 'insight')
    return a


def _safe(fn, what, default=None):
    """Registerwerk mag een leerronde of het publiceren nooit laten mislukken."""
    try:
        return fn()
    except Exception as e:
        log(f'Modelregister: {what} mislukt: {e}')
        return default


def _finish_round(recipe, agent, report, by):
    """Uitkomst verwerken en beslissen wat de bot krijgt. Publiceren gebeurt alleen bij een aantoonbare
    verbetering (promotion_gate), of uit veiligheid als het actieve recept te riskant werd of verdween.
    Anders blijft agent.json precies zoals hij was. Elke sessie komt in het modelregister.
    Geeft (beslissing, reden)."""
    # Eerst de proef van het actieve model (kan terugzetten, dus vóór het lezen van agents.json).
    _safe(_check_probation, 'proefperiode controleren')
    data = load_agents()
    data['round'] = data.get('round', 0) + 1
    key = agent_search.key_of(recipe)
    report['at'] = datetime.now().isoformat(timespec='seconds')
    before = copy.deepcopy(data['recipes'].get(key))
    entry = agent_search.add_round(data['recipes'], recipe, report)
    os.makedirs(path('agents'), exist_ok=True)
    old_file = read_json(agent_file(key), None) if agent else None
    if agent:
        write_json(agent_file(key), agent)
    try:
        think((f'Helper {by}: ' if by != 'VPS' else '') + agent_mod_say(report, entry), kind='result' if report.get('ok') else 'warn')
    except Exception as e:  # een bericht mag een leerronde nooit laten mislukken
        log(f'AI-trader: bericht over de ronde mislukt: {e}')
    cfg = config()
    th = promote_thresholds(cfg)
    reg = registry()
    _safe(ensure_baseline, 'bestaand model vastleggen')
    # Te riskante recepten (terugval > 25%) nooit gebruiken, ook niet om in paper te oefenen.
    board = [e for e in agent_search.leaderboard(data['recipes'], 50) if agent_search.usable(e)
             and os.path.exists(path(agent_file(e['key'])))]
    prev = data.get('published')
    active_key = (prev or {}).get('key') if prev and prev.get('stage') != 'geblokkeerd' else None
    active_entry = data['recipes'].get(active_key) if active_key else None
    active_ok = bool(active_entry and agent_search.usable(active_entry) and os.path.exists(path(agent_file(active_key))))
    active_version = _safe(reg.active, 'actieve versie lezen')
    pinned = _safe(reg.pinned, 'vastgezette versie lezen')
    if pinned is not None:
        snap = _safe(lambda: reg.read_snapshot(pinned), 'snapshot lezen') or {}
        pin_key = snap.get('recipeKey') or (_safe(lambda: reg.get(pinned), 'vastgezette versie lezen') or {}).get('recipeKey')
        pin_entry = data['recipes'].get(pin_key) if pin_key else None
        if pin_entry and not agent_search.usable(pin_entry):
            # Veiligheid gaat voor: een vastgezet recept dat te riskant werd, wordt losgelaten.
            _safe(lambda: reg.set_pinned(None), 'losmaken')
            log(f'Modelregister: v{pinned} losgemaakt, het recept is te riskant geworden')
            think(f'Je had versie v{pinned} vastgezet, maar dat recept zakte meer dan {agent_search.DANGER_DRAWDOWN}% terug. '
                  'Dat is te riskant: ik maak hem los en kies weer zelf het beste veilige model.', kind='warn')
            pinned = None
    mine = _safe(lambda: recipe_metrics(entry), 'cijfers berekenen')
    act_m = _safe(lambda: recipe_metrics(before if key == active_key else active_entry), 'cijfers berekenen')
    # Recepten waarvan de proef net mislukte, worden een tijd niet opnieuw gepromoot.
    cooling = _safe(lambda: active_cooldowns(reg), 'afkoelperiodes lezen', {}) or {}
    decision, reason, main, published_key = 'rejected', '', None, None
    try:
        if pinned is not None:
            decision, reason = 'kept', f'vastgezet op v{pinned}'
        elif not board:
            decision, reason = 'rejected', 'geen bruikbaar recept (alles te riskant of zonder model)'
        else:
            best = board[0]
            same_retrained = bool(active_ok and key == active_key and agent is not None)
            same_ok, same_why = True, ''
            if same_retrained:
                if key in cooling:
                    same_ok, same_why = False, _cooldown_text(cooling[key])
                else:
                    same_ok, same_why = promotion_gate(recipe_metrics(entry), recipe_metrics(before), th, same=True)
                if not same_ok and old_file:
                    # Het vorige model van dit recept blijft (ook in agents/, zodat alles bij elkaar past).
                    write_json(agent_file(key), old_file)
            if not active_ok:
                # Veiligheid: het beste bruikbare recept, maar liefst niet een dat net door de proef zakte.
                best = next((e for e in board if e['key'] not in cooling), best)
                main, decision = best, 'promoted'
                reason = ('eerste model van de AI-trader' if not prev else
                          'het actieve recept is te riskant geworden of verdwenen; veiligheid: het beste bruikbare recept')
            elif best['key'] == active_key:
                if same_retrained and same_ok:
                    main, decision, reason = best, 'promoted', f'hetzelfde recept opnieuw getraind en {same_why}'
                elif same_retrained:
                    decision, reason = 'kept', f'hetzelfde recept opnieuw getraind, maar {same_why}; de vorige versie blijft'
                elif key == active_key:
                    decision, reason = 'kept', 'deze ronde leverde geen nieuw model; het actieve model blijft'
                else:
                    decision, reason = 'rejected', 'niet beter dan het actieve recept; het actieve model blijft'
            else:
                if best['key'] in cooling:
                    ok, why = False, _cooldown_text(cooling[best['key']])
                else:
                    # Selectiecorrectie: zoveel recepten met een eindtest dingen mee om de eerste plaats.
                    tested = sum(1 for e in board if agent_search.score(e)['tested'] >= 1)
                    ok, why = promotion_gate(recipe_metrics(best), recipe_metrics(active_entry), th, candidates=tested)
                if ok:
                    main, decision, reason = best, 'promoted', f'{agent_mod.recipe_text(best["recipe"])}: {why}'
                elif same_retrained and same_ok:
                    main, decision = active_entry, 'promoted'
                    reason = (f'hetzelfde recept opnieuw getraind en {same_why}; '
                              f'{agent_mod.recipe_text(best["recipe"])} is nog niet aantoonbaar beter ({why})')
                else:
                    decision = 'kept'
                    reason = f'kandidaat {agent_mod.recipe_text(best["recipe"])} is niet aantoonbaar beter: {why}; het actieve model blijft'
                    if same_retrained:
                        reason += f' (nieuwe training van het actieve recept: {same_why})'
    except Exception as e:
        # Beoordelen mislukt: veilig blijven. Is er een actief model, dan blijft dat; anders het beste.
        log(f'AI-trader: beoordelen voor publiceren mislukt: {e}')
        traceback.print_exc()
        main = None
        if board and not active_ok and pinned is None:
            main, decision, reason = board[0], 'promoted', f'beoordelen mislukt ({e}); geen actief model, dus het beste bruikbare recept'
        else:
            decision, reason = 'kept', f'beoordelen mislukt ({e}); het actieve model blijft'
    snapshot = None
    if main is not None:
        snapshot = publish_agent(main, board, data, prev, report)
        if snapshot is None:
            decision, reason = 'kept', 'het model kon niet gelezen worden; het actieve model blijft'
        else:
            published_key = main['key']
    elif not board and prev and prev.get('stage') != 'geblokkeerd':
        # Geen bruikbaar recept meer, en het recept waar de bot mee handelde is te riskant geworden:
        # de bot mag er niet meer mee handelen.
        old = data['recipes'].get(prev.get('key'))
        a = read_json('agent.json', None)
        if a and old and not agent_search.usable(old):
            a['stage'] = 'geblokkeerd'
            a['recipeStatus'] = 'te riskant'
            write_json('agent.json', a)
            data['published'] = {**prev, 'stage': 'geblokkeerd', 'status': 'te riskant', 'at': report['at']}
            reason += '; het actieve recept is te riskant: de bot handelt er niet meer mee'
            _safe(lambda: reg.set_pinned(None), 'losmaken')
            think(f"Mijn recept {agent_mod.recipe_text(old['recipe'])} zakte in een test meer dan {agent_search.DANGER_DRAWDOWN}% terug. "
                  'Dat is te riskant: de bot handelt er niet meer mee, ook niet in paper, tot ik een veiliger recept vind.', kind='warn')
    if main is None and board:
        # Geen nieuw model: het actieve model blijft byte-gelijk, maar de lijst extra recepten (om live
        # te zetten) wel bijwerken, anders zie je nieuwe goede recepten pas na een promotie.
        def refresh_extras():
            a = read_json('agent.json', None)
            if not isinstance(a, dict) or a.get('stage') == 'geblokkeerd':
                return
            ext = extra_recipes(board, {'key': a.get('recipeKey')}, a.get('regimes'), data)
            if [x.get('recipeKey') for x in ext] != [x.get('recipeKey') for x in a.get('extras') or []]:
                a['extras'] = ext
                write_json('agent.json', a)
        _safe(refresh_extras, 'extra recepten bijwerken')
    write_json('agents.json', data)
    if decision == 'kept' and pinned is None and main is None and key != active_key and reason.startswith('kandidaat'):
        think(f'Ik houd mijn huidige model: {reason}.', kind='insight')
    rec = _safe(lambda: session_record(recipe, agent, report, by, cfg, entry, mine, act_m, active_version, active_key,
                                       decision, reason, published_key), 'sessie samenstellen')
    expected = None
    if rec is not None and snapshot is not None:
        # Wat de eindtest belooft voor het gepubliceerde recept: daarmee vergelijkt de proefperiode.
        expected = (_safe(lambda: recipe_metrics(main), 'cijfers berekenen') or {}).get('testAvg')
        rec['expectedPct'] = expected
    if rec is not None:
        snap_clean = {k: x for k, x in snapshot.items() if k != 'notice'} if snapshot is not None else None
        saved = _safe(lambda: reg.record(rec, snapshot=snap_clean), 'sessie opslaan')
        if saved:
            log(f"Modelregister: v{saved['version']} {decision} ({reason})")
            if snapshot is not None:
                _safe(lambda: start_probation(reg, saved['version'], published_key, expected, report['at'],
                                              active_version, active_key, th), 'proefperiode starten')
    state['lastDecision'] = {'decision': decision, 'reason': reason, 'at': report['at']}
    return decision, reason


def _part_metrics(part):
    return {k: part.get(k) for k in METRIC_FIELDS} if isinstance(part, dict) else None


def session_record(recipe, agent, report, by, cfg, entry, mine, act_m, active_version, active_key, decision, reason, published_key):
    """Een leerronde als record voor het modelregister."""
    rec = {**agent_mod.RECIPE_DEFAULT, **recipe}
    per = report.get('periods') or {}
    feats = list(((agent or {}).get('entry') or {}).get('features') or agent_mod.FEATURES)
    exit_feats = ((agent or {}).get('exit') or {}).get('features') or agent_mod.FEATURES + agent_mod.POS_FEATURES
    return {
        'at': report.get('at'), 'by': by, 'recipeKey': agent_search.key_of(recipe), 'recipeText': agent_mod.recipe_text(rec),
        'dataset': {'pairs': report.get('pairs'), 'coins': report.get('coins'), 'days': int(cfg.get('days') or 0),
                    'periods': per or None, 'testPeriod': per.get('eindtest'), 'testDays': report.get('testDays')},
        'features': feats + [f for f in exit_feats if f not in feats],
        'settings': {**rec, 'threshold': report.get('threshold'), 'maxHoldCandles': report.get('maxHold')},
        'metrics': {'ok': bool(report.get('ok')), 'reason': report.get('reason'), 'status': agent_search.status(entry) if entry else None,
                    'test': _part_metrics(report.get('test')), 'validation': _part_metrics(report.get('validation')),
                    'score': {k: v for k, v in (mine or {}).items() if k != 'order'}},
        'decision': decision, 'reason': reason, 'publishedKey': published_key,
        'comparedTo': ({'version': active_version, 'recipeKey': active_key,
                        'metrics': {k: v for k, v in act_m.items() if k != 'order'},
                        'deltas': metric_deltas(mine, act_m)} if active_key and act_m else None),
    }


def ensure_baseline(by='VPS'):
    """Het model dat al in gebruik was voordat het modelregister bestond, vastleggen als eerste gepromote
    versie (met een kopie als terugvaloptie). Zonder dit staat er 'nog geen gepromoot model' terwijl de
    bot er wel mee handelt, en kun je er niet naar terug. Doet niets als er al een actieve versie is."""
    reg = registry()
    if reg.active() is not None:
        return None
    a = read_json('agent.json', None)
    if not isinstance(a, dict) or not a.get('entry') or not a.get('exit') or a.get('stage') == 'geblokkeerd':
        return None
    data = load_agents()
    key = a.get('recipeKey')
    entry = (data.get('recipes') or {}).get(key) if key else None
    recipe = (entry or {}).get('recipe') or a.get('recipe') or {}
    last = ((entry or {}).get('rounds') or [{}])[-1] or {}
    per = last.get('periods') or {}
    rec = {**agent_mod.RECIPE_DEFAULT, **recipe}
    m = recipe_metrics(entry)
    record = {
        'at': (data.get('published') or {}).get('at') or datetime.now().isoformat(timespec='seconds'), 'by': by,
        'recipeKey': key, 'recipeText': agent_mod.recipe_text(rec),
        'dataset': {'coins': a.get('coins'), 'days': int(config().get('days') or 0), 'periods': per or None,
                    'testPeriod': per.get('eindtest'), 'testDays': last.get('testDays')},
        'features': list((a.get('entry') or {}).get('features') or []),
        'settings': {**rec, 'threshold': a.get('threshold'), 'maxHoldCandles': a.get('maxHoldCandles')},
        'metrics': {'ok': bool(last.get('ok')), 'reason': last.get('reason'), 'status': agent_search.status(entry) if entry else None,
                    'test': _part_metrics(last.get('test')), 'validation': _part_metrics(last.get('val')),
                    'score': {k: v for k, v in (m or {}).items() if k != 'order'}},
        'decision': 'promoted', 'reason': 'het model dat al in gebruik was toen het modelregister begon (startpunt en terugvaloptie)',
        'publishedKey': key, 'comparedTo': None,
    }
    record['expectedPct'] = (m or {}).get('testAvg')
    rec_saved = reg.record(record, snapshot={k: x for k, x in a.items() if k != 'notice'})
    log(f"Modelregister: bestaand model vastgelegd als v{rec_saved['version']} ({key})")
    _safe(lambda: start_probation(reg, rec_saved['version'], key, record['expectedPct'], rec_saved['at']), 'proefperiode starten')
    return rec_saved


def _expected_of(v):
    """Wat de eindtest beloofde voor de versie (gemiddeld % per trade), zo goed als bekend."""
    for x in ((v.get('probation') or {}).get('expectedPct'), v.get('expectedPct')):
        if _num(x):
            return x
    if v.get('publishedKey') and v.get('publishedKey') == v.get('recipeKey'):
        x = (((v.get('metrics') or {}).get('score')) or {}).get('testAvg')
        return x if _num(x) else None
    return None


def registry_practice(reg, versions, trades=None):
    """Praktijkresultaten per gepromote (en de actieve) versie: de echte trades met het recept van die
    versie, zolang die versie de actieve was (van promotie of terugzetten tot de volgende). Voegt
    'practice' toe aan die versies (zie probation.practice)."""
    by_recipe = probation_mod.real_trades(read_json('agent_trades.json', []) if trades is None else trades)
    acts = reg.activations()
    windows = {}
    for i, (at, v, key, _) in enumerate(acts):
        end = probation_mod.ts_of(acts[i + 1][0]) if i + 1 < len(acts) else None
        windows.setdefault(v, []).append((probation_mod.ts_of(at), end, key))
    for v in versions:
        if (v['decision'] == 'promoted' and v.get('hasSnapshot')) or v.get('active'):
            v['practice'] = probation_mod.practice(by_recipe, windows.get(v['version'], []), _expected_of(v))
    return versions


def registry_info():
    reg = registry()
    out = reg.summary(200, thresholds=promote_thresholds())
    _safe(lambda: registry_practice(reg, out['versions']), 'praktijkresultaten berekenen')
    out['cooldowns'] = _safe(lambda: active_cooldowns(reg), 'afkoelperiodes lezen', {}) or {}
    # Versies vastgelegd vóór het portefeuille-rendement bewaard werd: aanvullen uit de laatste ronde van
    # dat recept, alleen voor het startpunt (dat is precies die ronde).
    try:
        recipes = load_agents().get('recipes') or {}
        for v in out.get('versions') or []:
            if not str(v.get('reason') or '').startswith('het model dat al in gebruik was'):
                continue
            if v.get('metrics') is None:
                v['metrics'] = {}
            m = v['metrics'] if isinstance(v['metrics'], dict) else None
            if m is None or (isinstance(m.get('test'), dict) and m['test'].get('portfolio') is not None):
                continue
            last = ((recipes.get(v.get('recipeKey')) or {}).get('rounds') or [{}])[-1] or {}
            if not last.get('test'):
                continue
            if isinstance(m.get('test'), dict):
                m['test']['portfolio'] = last['test'].get('portfolio')
            else:
                m['test'] = _part_metrics(last['test'])
    except Exception as e:
        log(f'Modelregister: aanvullen mislukt: {e}')
    return out


def _risky_snapshot(snap, entry):
    """Is een bewaarde versie te riskant om terug te zetten (recept te riskant, geblokkeerd, of een
    terugval van meer dan DANGER_DRAWDOWN% in de test van die versie)?"""
    rep = (snap.get('meta') or {}).get('report') or {}
    dds = [x for x in ((rep.get('test') or {}).get('maxDrawdownPct'), (rep.get('validation') or {}).get('maxDrawdownPct')) if _num(x)]
    return bool((entry and not agent_search.usable(entry)) or snap.get('stage') == 'geblokkeerd' or snap.get('recipeStatus') == 'te riskant'
                or any(x > agent_search.DANGER_DRAWDOWN for x in dds))


def _valid_snapshot(snap):
    return isinstance(snap, dict) and bool(snap.get('entry')) and bool(snap.get('exit'))


def _restore_version(reg, v, rec, snap, data, pin, by, reason, extra=None, notice=None):
    """Versie v (met snapshot) weer actief maken: agent.json, het model van het recept en
    agents.json gelijk aan die versie, en een record 'rollback'. Met pin ook vastzetten (alleen als de
    eigenaar het vraagt). Met notice een melding voor de bot in agent.json. Geeft de recept-sleutel."""
    key = snap.get('recipeKey') or rec.get('recipeKey')
    entry = data['recipes'].get(key)
    snap = {k: x for k, x in snap.items() if k != 'notice'}
    write_json('agent.json', {**snap, 'notice': notice} if notice else snap)
    if entry:
        write_json(agent_file(key), snap)  # het model van dit recept weer gelijk aan wat de bot heeft
    now = datetime.now().isoformat(timespec='seconds')
    data['published'] = {'key': key, 'timeframe': snap.get('timeframe'), 'stage': snap.get('stage'),
                         'status': agent_search.status(entry) if entry else snap.get('recipeStatus'), 'at': now,
                         'regimes': {r: p.get('key') for r, p in (snap.get('regimes') or {}).items()}}
    write_json('agents.json', data)
    reg.set_active(v)
    if pin:
        reg.set_pinned(v)
    _safe(lambda: reg.record({'at': now, 'by': by, 'recipeKey': key, 'recipeText': rec.get('recipeText'),
                              'dataset': rec.get('dataset'), 'features': rec.get('features'), 'settings': rec.get('settings'),
                              'metrics': rec.get('metrics'), 'decision': 'rollback', 'reason': reason, 'restoredVersion': v,
                              'publishedKey': key, 'comparedTo': None, **(extra or {})}), 'terugzetten vastleggen')
    return key


def registry_rollback(body):
    """Een eerdere gepubliceerde versie terugzetten en vastzetten. Geeft (status, antwoord)."""
    try:
        v = int(body.get('version'))
    except (TypeError, ValueError, AttributeError):
        return 400, {'error': 'Geef een versienummer'}
    reg = registry()
    with publish_lock:
        rec = reg.get(v)
        if not rec:
            return 404, {'error': f'Versie v{v} bestaat niet'}
        snap = reg.read_snapshot(v)
        if not _valid_snapshot(snap):
            return 400, {'error': f'Van v{v} is geen snapshot bewaard (alleen gepubliceerde versies kun je terugzetten)'}
        key = snap.get('recipeKey') or rec.get('recipeKey')
        data = load_agents()
        if _risky_snapshot(snap, data['recipes'].get(key)):
            return 400, {'error': f'v{v} is te riskant (terugval van meer dan {agent_search.DANGER_DRAWDOWN}%); die zet ik niet terug'}
        reason = f'teruggezet naar v{v} door de eigenaar; vastgezet tot je hem losmaakt'
        _restore_version(reg, v, rec, snap, data, True, 'eigenaar', reason)
    log(f'Modelregister: {reason}')
    think(f'Op jouw verzoek gebruik ik weer versie v{v} ({rec.get("recipeText") or key}). Zolang die vastgezet is, '
          'publiceer ik zelf geen ander model (ik blijf wel leren en alles vastleggen).', kind='info')
    return 200, {'ok': True, 'active': v, 'pinned': v}


# ---------- Proefperiode na een promotie (zie probation.py) ----------

def active_cooldowns(reg=None, now=None):
    """Recepten in de afkoelperiode na een mislukte proef: {recept: tot wanneer (ISO)}."""
    cd = (reg or registry()).meta('cooldowns', {}) or {}
    now = now or time.time()
    return {k: u for k, u in cd.items() if (probation_mod.ts_of(u) or 0) > now}


def _cooldown_text(until):
    try:
        when = datetime.fromisoformat(until).strftime('%d-%m %H:%M')
    except (TypeError, ValueError):
        when = str(until)
    return f'dit recept is in de afkoelperiode na een mislukte proefperiode (tot {when}); niet opnieuw gepromoot'


def start_probation(reg, version, key, expected, since, prev_version=None, prev_key=None, th=None):
    """Een net gepromote versie op proef zetten. Hetzelfde recept opnieuw getraind: de lopende (of
    geslaagde) proef van de vorige versie loopt door, anders zou een recept dat vaak opnieuw getraind
    wordt nooit genoeg trades halen. Een vorige versie die nog op proef was, is vervangen."""
    th = th or promote_thresholds()
    need = int(th['probationTrades'])
    prev = reg.get(prev_version) if prev_version is not None and prev_version != version else None
    pp = (prev or {}).get('probation') or {}
    if prev and prev_key == key and pp.get('status') in ('proef', 'geslaagd'):
        p = {**pp, 'inheritedFrom': prev_version}
        reg.set_probation(version, p)
        if pp.get('status') == 'proef':
            reg.set_probation(prev_version, {**pp, 'status': None, 'reason': f'de proef loopt door in v{version} (hetzelfde recept opnieuw getraind)'})
        return p
    p = {'status': 'proef', 'trades': 0, 'avgPct': None, 'expectedPct': expected, 'upperPct': None, 'since': since, 'decidedAt': None,
         'reason': f'op proef: na {need} echte trades vergelijk ik de praktijk met de eindtest', 'recipeKey': key,
         'startVersion': version, 'need': need}
    reg.set_probation(version, p)
    if prev and pp.get('status') == 'proef':
        reg.set_probation(prev_version, {**pp, 'status': None, 'decidedAt': since,
                                         'reason': f'vervangen door v{version} voordat de proef klaar was'})
    return p


def _rollback_target(reg, before, failed_key, data):
    """De nieuwste eerdere gepromote versie (van vóór de proef) die nog bruikbaar is: met snapshot,
    niet te riskant, niet zelf door een proef gezakt en niet van het mislukte recept.
    Geeft (versie, record, snapshot) of None.
    Gezakt telt ook voor een versie waarvan de proef doorliep in een latere versie van hetzelfde
    recept (opnieuw getraind) en daar mislukte: die versie zelf staat dan op status None, maar hoort
    bij dezelfde gezakte proef (van startVersion tot de versie waar hij mislukte). Recepten in de
    afkoelperiode ook niet."""
    rows = reg.versions(2000)
    failed = []   # (recept, van versie, tot en met versie) van mislukte proeven
    for r in rows:
        p = r.get('probation') or {}
        if p.get('status') == 'mislukt':
            failed.append((p.get('recipeKey') or r.get('publishedKey') or r.get('recipeKey'),
                           p.get('startVersion') or r['version'], r['version']))
    cooling = _safe(lambda: active_cooldowns(reg), 'afkoelperiodes lezen', {}) or {}
    for r in rows:
        if r['version'] >= before or r['decision'] != 'promoted' or not r['hasSnapshot']:
            continue
        if (r.get('probation') or {}).get('status') == 'mislukt':
            continue
        snap = reg.read_snapshot(r['version'])
        if not _valid_snapshot(snap):
            continue
        key = snap.get('recipeKey') or r.get('publishedKey') or r.get('recipeKey')
        if key == failed_key or key in cooling or _risky_snapshot(snap, data['recipes'].get(key)):
            continue
        if any(k == key and lo <= r['version'] <= hi for k, lo, hi in failed):
            continue
        return r['version'], r, snap
    return None


def _check_probation(now=None):
    """Loopt de proef van de actieve versie, en zijn er genoeg echte trades? Dan beslissen: geslaagd,
    of mislukt (automatisch terug naar de vorige bruikbare versie, niet vastgezet, met een melding
    voor de bot en een afkoelperiode voor het recept). Licht: zonder lopende proef alleen twee
    registerlezingen. Aanroepen met publish_lock (zie check_probation)."""
    reg = registry()
    act = reg.active()
    if act is None:
        return None
    rec = reg.get(act)
    p = (rec or {}).get('probation')
    if not p or p.get('status') != 'proef':
        return None
    th = promote_thresholds()
    need, conf = int(th['probationTrades']), float(th['probationConfidence'])
    now = now or time.time()
    since = probation_mod.ts_of(p.get('since'))
    key = p.get('recipeKey')
    rows = probation_mod.trades_in(probation_mod.real_trades(read_json('agent_trades.json', [])), key, since or 0)
    ev = probation_mod.evaluate([t['pct'] for t in rows], p.get('expectedPct'), need, conf, since, now)
    upd = {**p, 'trades': ev['trades'], 'avgPct': ev['avgPct'], 'upperPct': ev['upperPct'], 'need': need}
    if not ev['decided']:
        upd['reason'] = ev['reason']
        if upd != p:
            reg.set_probation(act, upd)
        return upd
    stamp = datetime.now().isoformat(timespec='seconds')
    upd.update(status=ev['status'], decidedAt=stamp, reason=ev['reason'])
    text = rec.get('recipeText') or key
    if ev['status'] == 'geslaagd':
        reg.set_probation(act, upd)
        log(f'Modelregister: proef van v{act} geslaagd ({ev["reason"]})')
        think(f'De proef van versie v{act} ({text}) is geslaagd: {ev["reason"]}.', kind='result')
        return upd
    pinned = reg.pinned()
    if pinned is not None:
        upd['reason'] += f'; v{pinned} is vastgezet door de eigenaar, dus ik zet niets terug'
        reg.set_probation(act, upd)
        log(f'Modelregister: proef van v{act} mislukt, maar vastgezet ({ev["reason"]})')
        think(f'De proef van versie v{act} ({text}) is mislukt: {ev["reason"]}. Je hebt v{pinned} vastgezet, dus ik verander niets.', kind='warn')
        return upd
    data = load_agents()
    target = _rollback_target(reg, p.get('startVersion') or act, key, data)
    if target is None:
        upd['reason'] += '; er is geen eerdere bruikbare versie om naar terug te gaan, dit model blijft'
        reg.set_probation(act, upd)
        log(f'Modelregister: proef van v{act} mislukt, geen eerdere versie ({ev["reason"]})')
        think(f'De proef van versie v{act} ({text}) is mislukt: {ev["reason"]}. Er is geen eerdere bruikbare versie, dus dit model blijft.',
              kind='warn')
        return upd
    v, trec, snap = target
    upd['reason'] += f'; teruggezet naar v{v}'
    upd['restoredVersion'] = v
    reg.set_probation(act, upd)
    reason = f'proefperiode mislukt: {ev["reason"]}'
    notice = {'kind': 'probation-failed', 'version': act, 'restoredVersion': v, 'reason': reason, 'at': stamp}
    _restore_version(reg, v, trec, snap, data, False, 'trainer', f'{reason}; automatisch teruggezet naar v{v} (niet vastgezet)',
                     extra={'failedVersion': act}, notice=notice)
    hours = float(th['probationCooldownHours'])
    cd = active_cooldowns(reg)
    cd[key] = (datetime.now() + timedelta(hours=hours)).isoformat(timespec='seconds')
    reg.set_meta('cooldowns', cd)
    log(f'Modelregister: proef van v{act} mislukt; automatisch teruggezet naar v{v}')
    think(f'De proef van versie v{act} ({text}) is mislukt: {ev["reason"]}. Ik ga terug naar v{v} '
          f'({trec.get("recipeText") or snap.get("recipeKey")}) en promoveer dit recept de komende {hours:g} uur niet opnieuw.', kind='warn')
    return upd


def check_probation(timeout=5):
    """De proef controleren vanuit de feedback (HTTP): nooit laten crashen, en niet blijven wachten als
    er net een leerronde publiceert (dan doet die het)."""
    if not publish_lock.acquire(timeout=timeout):
        return None
    try:
        return _safe(_check_probation, 'proefperiode controleren')
    finally:
        publish_lock.release()


def registry_unpin():
    reg = registry()
    with publish_lock:
        was = reg.pinned()
        reg.set_pinned(None)
    if was is not None:
        log(f'Modelregister: v{was} losgemaakt')
        think(f'Versie v{was} is losgemaakt: ik kies weer zelf, maar alleen een model dat aantoonbaar beter is.', kind='info')
    return 200, {'ok': True, 'pinned': None, 'was': was}


def paper_rows(key=None):
    """Paper-trades van de AI-trader (oud -> nieuw), eventueel alleen van één recept."""
    return [t for t in read_json('agent_trades.json', []) if t.get('mode') == 'paper' and not t.get('explore')
            and (key is None or t.get('recipe') == key)]


def live_check(key, entry, assumed_cost=None):
    """De eisen voor live voor één recept (zie livecheck.py)."""
    return livecheck.check(paper_rows(key), agent_search.status(entry) if entry else 'onbekend',
                           slots=int(config()['agent'].get('maxOpen') or 2), assumed_cost=assumed_cost)


def round_trend(recipes, days=21):
    """Per dag (nieuwste eerst): aantal leerrondes, de beste gemiddelde winst per trade op de
    validatie, en het beste voordeel boven de markt."""
    by = {}
    for e in recipes.values():
        for r in e.get('rounds', []):
            v = r.get('val') or {}
            if not v.get('trades') or not r.get('ts'):
                continue
            d = datetime.fromtimestamp(r['ts']).strftime('%Y-%m-%d')
            x = by.setdefault(d, {'day': d, 'rounds': 0, 'bestAvg': None, 'bestEdge': None})
            x['rounds'] += 1
            if v.get('avgPct') is not None and (x['bestAvg'] is None or v['avgPct'] > x['bestAvg']):
                x['bestAvg'] = v['avgPct']
            if v.get('edgePct') is not None and (x['bestEdge'] is None or v['edgePct'] > x['bestEdge']):
                x['bestEdge'] = v['edgePct']
    return sorted(by.values(), key=lambda x: x['day'], reverse=True)[:days]


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
                                 'recipeStatus': agent_search.status(entry), 'stage': agent_stage(entry, lc), 'live': lv, 'liveCheck': lc,
                                 'volStats': agent_search.vol_stats(entry)}
        out[reg] = item
    return out


EXTRA_RECIPES = 6


def extra_recipes(board, best, regimes, data, limit=EXTRA_RECIPES):
    """De beste andere recepten (getest of betrouwbaar) gaan ook mee naar de bot, zodat de eigenaar
    ze live kan toestaan of op eigen risico live kan zetten. De bot gebruikt ze alleen als dat zo is."""
    used = {best['key']} | {p.get('key') for p in (regimes or {}).values() if p.get('key')}
    out = []
    for e in board:
        if len(out) >= limit:
            break
        if e['key'] in used:
            continue
        sub = read_json(os.path.join('agents', e['key'].replace('|', '_') + '.json'), None)
        if not sub:
            continue
        part = recipe_part(e['key'], e, sub, data)
        if part['stage'] not in ('getest', 'bewezen'):
            continue
        out.append(part)
    return out


def recipe_part(key, entry, sub, data):
    """Een recept zoals de bot het als (extra) onderdeel van de AI-trader krijgt."""
    lc = live_check(key, entry, sub.get('costPct'))
    return {**{k: sub[k] for k in AGENT_PART_KEYS if k in sub}, 'recipeKey': key, 'recipeStatus': agent_search.status(entry),
            'stage': agent_stage(entry, lc), 'live': (data.get('live') or {}).get(key) or {}, 'liveCheck': lc, 'extra': True,
            'volStats': agent_search.vol_stats(entry)}


def add_kept(a, keys, data):
    """Recepten die de eigenaar live heeft gezet (de bot vraagt ze met ?keep=) altijd meesturen, ook als
    ze niet meer in het plan per marktfase of de top staan. Te riskante recepten nooit."""
    have = {p.get('recipeKey') for p in [a] + [p['agent'] for p in (a.get('regimes') or {}).values() if p.get('agent')] + list(a.get('extras') or [])}
    have |= {p.get('key') for p in (a.get('regimes') or {}).values()}
    for key in keys[:20]:
        if not key or key in have:
            continue
        entry = (data.get('recipes') or {}).get(key)
        sub = read_json(os.path.join('agents', key.replace('|', '_') + '.json'), None) if entry else None
        if not entry or not sub or not agent_search.usable(entry):
            continue
        a.setdefault('extras', []).append({**recipe_part(key, entry, sub, data), 'kept': True})
        have.add(key)
    return a


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
    if r.get('folds'):
        n, pos = len(r['folds']), r.get('foldsPositive') or 0
        s += (f"Ik heb dit recept in {n} periodes na elkaar getest (steeds geleerd op het verleden ervoor): in {pos} daarvan maakte het winst. "
              + ('' if pos >= max(1, n - 1) else 'Dat is te wisselend; ik reken dit recept niet goed. '))
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


def parse_hours(v):
    """'0-6,22,23' of [0, 1, 22] -> gesorteerde lijst uren (0..23). Leeg = doorlopend."""
    if isinstance(v, (list, tuple)):
        parts = [str(x) for x in v]
    else:
        parts = [p for p in str(v or '').replace(' ', '').split(',') if p]
    out = set()
    for p in parts:
        a, _, b = p.partition('-')
        lo, hi = int(a), int(b) if b else int(a)
        if not (0 <= lo <= 23 and 0 <= hi <= 23):
            raise ValueError('Leeruren moeten tussen 0 en 23 liggen')
        out.update(range(lo, hi + 1) if lo <= hi else list(range(lo, 24)) + list(range(0, hi + 1)))
    return sorted(out)


AGENT_HOURS_ENV = os.environ.get('AGENT_HOURS', '')


def agent_hours(cfg):
    """Op welke uren de AI-trader leert. Leeg = doorlopend."""
    h = cfg['agent'].get('hours')
    if h is None:
        try:
            return parse_hours(AGENT_HOURS_ENV)
        except ValueError:
            return []
    return h


def agent_may_learn(cfg, now=None):
    hours = agent_hours(cfg)
    return not hours or (now or datetime.now()).hour in hours


def cleanup_files(now=None):
    """Oude bestanden opruimen (elk uur):
    - opgeslagen kenmerken van coins/candle-tijden die 14 dagen niet gebruikt zijn;
    - koersopslag die 30 dagen niet gebruikt is;
    - modellen van recepten die niet meer bestaan;
    - achtergebleven .tmp-bestanden van een onderbroken opslag;
    - en in agents.json van recepten die allang niet meer meedoen alleen de laatste ronde.
    Geeft het aantal verwijderde bestanden."""
    now = now or time.time()
    removed = 0
    for sub, days in (('features', 14), ('candles', 30)):
        d = os.path.join(DATA, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            p = os.path.join(d, name)
            try:
                old = now - os.path.getmtime(p) > days * 86400
                if old or (name.endswith('.tmp') or '.tmp.' in name) and now - os.path.getmtime(p) > 3600:
                    os.remove(p)
                    removed += 1
            except OSError:
                pass
    data = load_agents()
    keep = {k.replace('|', '_') + '.json' for k in data['recipes']}
    if data.get('published'):
        keep.add(data['published']['key'].replace('|', '_') + '.json')
    d = path('agents')
    if os.path.isdir(d):
        for name in os.listdir(d):
            # agents/versions (de snapshots van het modelregister) nooit; tijdelijke bestanden ook niet.
            if name not in keep and name != 'versions' and '.tmp' not in name and os.path.isfile(os.path.join(d, name)):
                try:
                    os.remove(os.path.join(d, name))
                    removed += 1
                except OSError:
                    pass
    # Recepten die niet bij de beste 50 horen en al een week niet getest zijn: alleen de laatste
    # ronde bewaren (de status en "te riskant" blijven), zodat agents.json niet blijft groeien.
    top = {e['key'] for e in agent_search.leaderboard(data['recipes'], 50)}
    changed = False
    for k, e in data['recipes'].items():
        rounds = e.get('rounds') or []
        if k not in top and len(rounds) > 1 and now - (rounds[-1].get('ts') or now) > 7 * 86400:
            e['rounds'] = rounds[-1:]
            changed = True
    if changed:
        write_json('agents.json', data)
    if removed:
        log(f'Opgeruimd: {removed} oude bestanden')
    return removed


def agent_worker():
    """Leert doorlopend (of alleen op de leeruren): candle-tijd na candle-tijd, steeds met de
    nieuwste koersen. Elk uur ruimt hij oude bestanden op."""
    last_cleanup = 0.0
    while True:
        cfg = config()
        if time.time() - last_cleanup > 3600:
            last_cleanup = time.time()
            try:
                cleanup_files()
            except Exception as e:
                log(f'Opruimen mislukt: {e}')
        if not cfg['agent']['enabled']:
            agent_wake.clear()
            agent_wake.wait(timeout=60)
            continue
        if not agent_may_learn(cfg):
            hours = agent_hours(cfg)
            nxt = datetime.now().replace(minute=0, second=0, microsecond=0)
            while nxt.hour not in hours or nxt <= datetime.now():
                nxt += timedelta(hours=1)
            state['nextAgentAt'] = nxt.isoformat(timespec='minutes')
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
            # Sinds wanneer hij wacht op nieuwe data (alle recepten kort geleden getest), en de laatste beslissing.
            'waitingSince': state.get('agentWaiting'), 'lastDecision': state.get('lastDecision'),
            'recipes': board, 'tried': len(data.get('recipes', {})),
            'possible': len(agent_search.all_recipes(cfg['agent']['timeframes'] or agent_mod.DEFAULT_TIMEFRAMES)),
            'published': data.get('published'), 'coins': (pub or {}).get('coins'),
            'stage': (pub or {}).get('stage'), 'rounds': data.get('round', 0),
            'regimes': {reg: {k: v for k, v in p.items() if k != 'agent'} | {'text': agent_mod.recipe_text(data['recipes'][p['key']]['recipe']) if p.get('key') in data.get('recipes', {}) else None}
                        for reg, p in ((pub or {}).get('regimes') or {}).items()},
            'hours': agent_hours(cfg), 'trainJobs': resources.TRAIN_JOBS,
            'helpers': helpers_info(), 'helperToken': helper_token(), 'inflight': len(inflight),
            'liveCheck': (pub or {}).get('liveCheck'),
            'liveRules': {'minTrades': livecheck.MIN_TRADES, 'minDays': livecheck.MIN_DAYS, 'minAvg': livecheck.MIN_AVG, 'maxDd': livecheck.MAX_DD},
            # De lange paper-test: per week, sinds de nieuwe manier van meten.
            'paperTest': {'since': data.get('since'), 'weeks': livecheck.weeks(paper_rows(), data.get('since'))},
            # Klopt zijn verwachting? Per groep verwachtingen wat er echt van terechtkwam.
            'calibration': livecheck.calibration(read_json('agent_trades.json', [])),
            # Vindt de leerserver steeds betere recepten? Per dag de beste score op de validatie.
            'roundTrend': round_trend(data.get('recipes', {})),
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


_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


class QuietHTTPServer(ThreadingHTTPServer):
    """Verbreekt een client de verbinding (time-out, herstart van de bot), dan is dat geen fout:
    geen traceback in de log. Andere fouten wel."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], _GONE):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = 'vetobot-trainer'

    def log_message(self, *a):  # geen request-logs met mogelijk de token erin
        pass

    def send(self, code, body, ctype='application/json', extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except _GONE:
            self.close_connection = True  # de client (bot/proxy) heeft de verbinding al verbroken

    def authed(self, helper=False):
        """De hoofdcode mag alles; de helper-code alleen de /helper/-adressen."""
        got = self.headers.get('Authorization', '').encode()
        ok = hmac.compare_digest(got, f'Bearer {token()}'.encode())
        if not ok and helper:
            ok = hmac.compare_digest(got, f'Bearer {helper_token()}'.encode())
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
        if self.path.split('?')[0] == '/agent.json':
            a = read_json('agent.json', None)
            if not a:
                return self.send(404, {'error': 'Nog geen AI-trader'})
            data = load_agents()
            from urllib.parse import parse_qs, urlparse
            keep = [k for v in parse_qs(urlparse(self.path).query).get('keep', []) for k in v.split(',')]
            if keep:
                add_kept(a, keep, data)
            live = data.get('live', {})
            a['live'] = live.get(a.get('recipeKey') or a['timeframe'], {})
            # Eisen voor live steeds actueel (nieuwe paper-trades komen tussen de leerrondes binnen).
            for part in [a] + [p['agent'] for p in (a.get('regimes') or {}).values() if p.get('agent')] + list(a.get('extras') or []):
                part['live'] = live.get(part.get('recipeKey'), {})
                entry = data['recipes'].get(part.get('recipeKey'))
                if entry and part.get('stage') != 'geblokkeerd':
                    part['liveCheck'] = live_check(part['recipeKey'], entry, part.get('costPct'))
                    part['stage'] = agent_stage(entry, part['liveCheck'])
                if entry:
                    # Resultaat per volatiliteit (eindtests): de bot handelt niet waar het recept verliest.
                    part['volStats'] = agent_search.vol_stats(entry)
            data = json.dumps(a).encode()
            etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.end_headers()
                return
            return self.send(200, data, extra={'ETag': etag})
        if self.path.split('?')[0] == '/registry':
            try:
                return self.send(200, registry_info())
            except Exception as e:
                log(f'Modelregister: overzicht mislukt: {e}')
                return self.send(500, {'error': f'Modelregister niet beschikbaar: {e}'})
        if self.path == '/learnstats':
            # Voor het blok "Leert hij echt?" van de bot: leerrondes en ontvangen trades (alleen lezen).
            try:
                cfg = config()
                return self.send(200, learnstats.compute(registry().versions(500), read_json('agent_trades.json', []),
                                                         cfg['agent']['enabled'], agent_may_learn(cfg), time.time()))
            except Exception as e:
                log(f'Leercontrole: telling mislukt: {e}')
                return self.send(500, {'error': f'Telling niet beschikbaar: {e}'})
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
                'config': config(), 'nextRunAt': None if state['running'] or not next_run() else next_run().isoformat(timespec='minutes'), 'trainHour': TRAIN_HOUR,
                'cache': state.get('cache', []), 'feedback': feedback_info(), 'search': search_info(),
                'teamwork': read_json('teamwork.json', {'total': 0}), 'thoughts': state.get('thoughts', [])[-120:],
                'micro': micro_info(), 'agent': agent_info(),
                'model': model and model.get('meta'), 'history': state['history'], 'log': state['log'][-150:],
            })
        self.send(404, {'error': 'Niet gevonden'})

    def read_json(self, limit):
        """Body als JSON-object; None bij een ongeldige lengte, ongeldige JSON of geen object."""
        try:
            length = max(0, min(int(self.headers.get('Content-Length') or 0), limit))
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def do_POST(self):
        if self.path == '/helper/pair':  # zonder code: alleen met een geldige koppelcode
            body = self.read_json(2000)
            if body is None:
                return self.send(400, {'error': 'Ongeldige JSON'})
            code, out = helper_pair(body)
            return self.send(code, out)
        if not self.authed(helper=self.path.startswith('/helper/') and self.path != '/helper/pair-code'):
            return
        limit = {'/feedback': 500_000, '/helper/result': 60_000_000}.get(self.path, 20_000)
        body = self.read_json(limit)
        if body is None:
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
        if self.path == '/helper/pair-code':  # alleen met de hoofdcode (de bot, voor het dashboard)
            return self.send(200, new_pair_code())
        if self.path == '/helper/claim':
            return self.send(200, helper_claim(body))
        if self.path == '/helper/result':
            code, out = helper_result(body)
            return self.send(code, out)
        if self.path in ('/registry/rollback', '/registry/unpin'):
            try:
                code, out = registry_rollback(body) if self.path == '/registry/rollback' else registry_unpin()
            except Exception as e:
                log(f'Modelregister: {self.path} mislukt: {e}')
                code, out = 500, {'error': f'Modelregister niet beschikbaar: {e}'}
            return self.send(code, out)
        if self.path == '/train':
            started = run_training('handmatig vanuit vetobot')
            return self.send(200 if started else 409, {'ok': started, 'error': None if started else 'Er loopt al een training'})
        self.send(404, {'error': 'Niet gevonden'})


def main():
    if os.environ.get('ROLE') == 'helper':
        import helper
        return helper.main()
    nice = resources.lower_priority()
    resources.limit_threads()
    resources.set_warning_baseline()
    state['history'] = read_json('history.json', [])
    state['thoughts'] = read_json('thoughts.json', [])
    state['cache'] = cache_info()
    t = token()
    print('=' * 70, flush=True)
    print(' vetobot-trainer', flush=True)
    print(f' Code voor het dashboard (Instellingen -> Eigen model): {t}', flush=True)
    print(f' Code voor helpers (alleen recepten trainen): {helper_token()}', flush=True)
    print(f" Volgende training (voorspelmodel): {next_run():%Y-%m-%d %H:%M}" if next_run() else ' Training van het voorspelmodel staat uit', flush=True)
    hours = agent_hours(config())
    print(f" AI-trader leert: {'doorlopend' if not hours else 'op de uren ' + ', '.join(map(str, hours))}"
          f" · max {resources.TRAIN_JOBS} kernen (TRAIN_JOBS) · voorrang nice {nice}", flush=True)
    print('=' * 70, flush=True)
    _safe(ensure_baseline, 'bestaand model vastleggen')
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=search_worker, daemon=True).start()
    threading.Thread(target=micro_worker, daemon=True).start()
    threading.Thread(target=agent_worker, daemon=True).start()
    QuietHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
