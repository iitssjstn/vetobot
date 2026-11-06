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
import math
import os
import secrets
import threading
import time
import traceback
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import search as searcher
import train as trainer

DATA = os.environ.get('DATA_DIR', '/data')
PORT = int(os.environ.get('PORT', '8787'))
TRAIN_HOUR = int(os.environ.get('TRAIN_HOUR', '3'))  # elke nacht om dit uur (tijdzone via TZ)

DEFAULTS = {'timeframe': '5m', 'days': 60, 'targetPct': 3.0, 'stopPct': 2.0, 'horizon': 36,
            'costPct': 0.5, 'pairs': [], 'topN': 15, 'maxSamples': 300_000,
            # Wanneer trainen: 'times' = vaste uren, 'interval' = elke X uur, 'continuous' = na elke
            # training opnieuw (met een pauze van pauseMinutes).
            'schedule': {'mode': 'times', 'hours': [TRAIN_HOUR], 'everyHours': 6, 'pauseMinutes': 30},
            # Strategie-zoeker: na elke training nog een ronde andere strategieën proberen.
            # Doorlopend zoeken (met pauzeMinuten tussen rondes) en optioneel automatisch overstappen
            # op de beste bevestigde strategie.
            'search': {'enabled': False, 'timeframes': [], 'perRound': 6, 'pauseMinutes': 1, 'autoApply': False},
            'strategy': None}
LIMITS = {'days': (7, 365), 'targetPct': (0.2, 50), 'stopPct': (0.2, 50), 'horizon': (3, 2000),
          'costPct': (0, 5), 'topN': (1, 50), 'maxSamples': (20_000, 2_000_000)}

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


def set_progress(phase, done, total, text):
    p = state.get('progress') or {}
    state['progress'] = {**p, 'phase': phase, 'done': done, 'total': total, 'text': text, 'at': datetime.now().isoformat(timespec='seconds')}


def config():
    saved = read_json('config.json', {})
    cfg = {**DEFAULTS, **saved}
    cfg['schedule'] = {**DEFAULTS['schedule'], **(saved.get('schedule') or {})}
    cfg['search'] = {**DEFAULTS['search'], **(saved.get('search') or {})}
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
            'possible': len(searcher.all_candidates(config()['search']['timeframes'] or [config()['timeframe']], config()['costPct'])),
            'leaderboard': searcher.leaderboard(results), 'lastRoundAt': data.get('lastRoundAt'),
            'rounds': data.get('rounds', 0), 'champion': data.get('champion'),
            'searching': state.get('searching', False), 'progress': state.get('searchProgress') if state.get('searching') else None,
            'nextRoundAt': state.get('nextSearchAt')}


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


def add_feedback(trades):
    """Echte trades van de bot opslaan. Dubbele (zelfde coin, timeframe en tijdstip) tellen één keer."""
    clean = []
    for t in trades if isinstance(trades, list) else []:
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
            model, report = trainer.train(cfg, log=log, progress=set_progress, fetch=fetch, feedback=load_feedback())
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
        except Exception as e:
            log(f'Training mislukt: {e}')
            traceback.print_exc()
            state['history'] = ([{'startedAt': started, 'published': False, 'reason': f'Fout: {e}'}] + state['history'])[:10]
        finally:
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


def set_search_progress(phase, done, total, text):
    p = state.get('searchProgress') or {}
    state['searchProgress'] = {**p, 'phase': phase, 'done': done, 'total': total, 'text': text}


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
                searcher.run_round(cfg, data['results'], log=log, fetch=fetch, markets=trainer.top_markets,
                                   progress=set_search_progress, should_stop=lambda: state.get('wantMain'))
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
    if switch:
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
        if not cfg['search']['enabled']:
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
    state['cache'] = cache_info()
    t = token()
    print('=' * 70, flush=True)
    print(' vetobot-trainer', flush=True)
    print(f' Code voor het dashboard (Instellingen -> Eigen model): {t}', flush=True)
    print(f' Volgende training: {next_run():%Y-%m-%d %H:%M}', flush=True)
    print('=' * 70, flush=True)
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=search_worker, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
