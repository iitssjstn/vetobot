"""Helper: traint recepten van de AI-trader voor de leerserver, op een ander apparaat.

De leerserver (VPS) blijft de baas: hij kiest de recepten, beoordeelt de uitkomsten en bepaalt wat de
bot gebruikt. De helper vraagt om een recept, haalt zelf de koersen bij Bitvavo (publieke data), traint
en test het recept met precies dezelfde code, en stuurt de uitkomst terug. Valt de helper uit, dan
gaat de leerserver gewoon door; het recept komt na een tijd vanzelf weer vrij.

Instellingen (omgevingsvariabelen):
  TRAINER_URL    adres van de leerserver, bijv. https://trainer.jouwdomein.nl (verplicht)
  HELPER_TOKEN   de helper-code (staat op de pagina Trainer en in de log van de leerserver);
                 of in het bestand $DATA_DIR/helper-token (aanbevolen: geen code in je compose)
  HELPER_NAME    naam op het dashboard (standaard de computernaam)
  TRAIN_JOBS     zoveel processorkernen (standaard 2)
  DATA_DIR       opslag voor koersen en kenmerken (standaard /data, of ~/.vetobot-helper)

Starten: python helper.py   (of in Docker: ROLE=helper, zie de README)
"""
import resources  # als eerste: begrenst de threads (TRAIN_JOBS)

import json
import os
import platform
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request

PROTOCOL = 1
VERSION = 1


def _data_dir():
    d = os.environ.get('DATA_DIR')
    if d:
        return d
    return '/data' if os.path.isdir('/data') and os.access('/data', os.W_OK) else os.path.expanduser('~/.vetobot-helper')


def settings():
    data = _data_dir()
    os.makedirs(data, exist_ok=True)
    tok = os.environ.get('HELPER_TOKEN', '').strip()
    if not tok:
        try:
            with open(os.path.join(data, 'helper-token')) as f:
                tok = f.read().strip()
        except OSError:
            tok = ''
    st = {'url': os.environ.get('TRAINER_URL', '').strip().rstrip('/'), 'token': tok, 'data': data,
          'name': (os.environ.get('HELPER_NAME') or socket.gethostname() or 'helper').strip()[:40]}
    if st['url'] and not st['url'].startswith(('http://', 'https://')):
        st['url'] = 'https://' + st['url']
    return st


def pair(st, code):
    """Koppelcode (6 cijfers uit het dashboard) inwisselen voor de helper-code en die bewaren."""
    req = urllib.request.Request(st['url'] + '/helper/pair', data=json.dumps({'code': code, 'name': st['name']}).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'User-Agent': f'vetobot-helper/{VERSION}'})
    with urllib.request.urlopen(req, timeout=30) as r:
        tok = json.loads(r.read())['token']
    p = os.path.join(st['data'], 'helper-token')
    with open(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.write(tok)
    st['token'] = tok
    return tok


def log(msg):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}', flush=True)


def call(st, path, body, timeout=60):
    req = urllib.request.Request(st['url'] + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Authorization': f"Bearer {st['token']}", 'Content-Type': 'application/json',
                                          # Eigen naam: sommige proxies/firewalls weigeren 'Python-urllib' (403).
                                          'User-Agent': f'vetobot-helper/{VERSION}', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


def _who(st):
    return {'name': st['name'], 'protocol': PROTOCOL, 'version': VERSION, 'jobs': resources.TRAIN_JOBS,
            'platform': f'{platform.system()} {platform.machine()} · {os.cpu_count()} kernen'}


def run_once(st, fetch=None):
    """Eén opdracht: ophalen, trainen, terugsturen. Geeft het aantal seconden om te wachten."""
    import agent as agent_mod
    import train
    got = call(st, '/helper/claim', _who(st))
    job = got.get('job')
    if not job:
        if got.get('error'):
            log(f"Leerserver: {got['error']}")
        return int(got.get('waitSeconds') or 60)
    recipe = job['recipe']
    log(f"Opdracht: {agent_mod.recipe_text(recipe)} ({len(job['pairs'])} coins)")
    cache = os.path.join(st['data'], 'candles')
    fetch = fetch or (lambda pair, tf, days: train.fetch_candles(pair, tf, days, cache_dir=cache))
    started = time.time()
    out = {**_who(st), 'id': job['id'], 'recipe': recipe, 'agentsVersion': job.get('agentsVersion')}
    try:
        agent, report = agent_mod.train_agent({**job['cfg'], 'featureCache': os.path.join(st['data'], 'features')}, recipe, fetch,
                                              job['pairs'], log=lambda *_: None, extra=[tuple(x) for x in job.get('extra') or []],
                                              seed=job.get('seed', 1))
        out.update({'agent': agent, 'report': report, 'seconds': time.time() - started})
        log(f"Klaar in {time.time() - started:.0f} s: {'goed' if report.get('ok') else 'niet goed genoeg'}"
            f"{'' if report.get('test') else ' (' + str(report.get('reason')) + ')'}")
    except Exception as e:
        traceback.print_exc()
        out['error'] = f'{type(e).__name__}: {e}'
    for attempt in range(5):
        try:
            res = call(st, '/helper/result', out, timeout=300)
            if not res.get('ok'):
                log(f"Leerserver gebruikte de uitkomst niet: {res.get('error')}")
            return 0
        except urllib.error.HTTPError as e:
            log(f'Uitkomst niet aangenomen ({e.code}): {e.read()[:200]!r}')
            return 0
        except (urllib.error.URLError, OSError) as e:
            log(f'Terugsturen mislukt ({e}); opnieuw over {10 * 2 ** attempt} s')
            time.sleep(10 * 2 ** attempt)
    return 0


def cleanup(st, now=None):
    """Oude opslag opruimen: kenmerken 14 dagen, koersen 30 dagen niet gebruikt."""
    now = now or time.time()
    for sub, days in (('features', 14), ('candles', 30)):
        d = os.path.join(st['data'], sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            p = os.path.join(d, name)
            try:
                if now - os.path.getmtime(p) > days * 86400:
                    os.remove(p)
            except OSError:
                pass


def main():
    st = settings()
    code = os.environ.get('PAIR_CODE', '').strip()
    if st['url'] and code and not st['token']:
        try:
            pair(st, code)
            print('Gekoppeld: de helper-code is bewaard op dit apparaat.')
        except urllib.error.HTTPError as e:
            msg = json.loads(e.read() or b'{}').get('error') if e.code in (403, 429) else None
            print(f'Koppelen lukte niet ({e.code}): {msg or e.reason}')
            return 3
        except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
            print(f'Koppelen lukte niet: {e}')
            return 3
    if not st['url'] or not st['token']:
        print('TRAINER_URL en de helper-code zijn nodig (HELPER_TOKEN, of het bestand '
              f"{os.path.join(st['data'], 'helper-token')}). De code staat op de pagina Trainer van je dashboard.")
        return 2
    nice = resources.lower_priority()
    resources.limit_threads()
    resources.set_warning_baseline()
    print('=' * 64)
    print(f" vetobot-helper '{st['name']}' voor {st['url']}")
    print(f' {resources.TRAIN_JOBS} kernen (TRAIN_JOBS) · voorrang nice {nice} · opslag {st["data"]}')
    print('=' * 64, flush=True)
    backoff, last_cleanup = 10, 0.0
    while True:
        if time.time() - last_cleanup > 3600:
            last_cleanup = time.time()
            cleanup(st)
        try:
            wait = run_once(st)
            backoff = 10
        except urllib.error.HTTPError as e:
            wait = 600 if e.code in (401, 403) else 60
            log({401: 'Onjuiste helper-code (401). Controleer de code op de pagina Trainer.',
                 403: 'Geweigerd (403) door iets vóór de leerserver (proxy, Cloudflare of een toegangslijst), niet door de '
                      'leerserver zelf. Sta de adressen /helper/claim en /helper/result toe, of het IP-adres van deze helper.',
                 404: 'Niet gevonden (404): is de leerserver bijgewerkt, en klopt het adres?'}.get(e.code, f'Leerserver gaf fout {e.code}'))
        except (urllib.error.URLError, OSError) as e:
            wait, backoff = backoff, min(600, backoff * 2)
            log(f'Leerserver niet bereikbaar ({e}); opnieuw over {wait} s')
        if wait:
            time.sleep(wait)


if __name__ == '__main__':
    sys.exit(main() or 0)
