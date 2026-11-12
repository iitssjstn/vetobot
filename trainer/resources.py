"""Hoeveel van de server de leerserver mag gebruiken.

Moet geïmporteerd worden vóór numpy en scikit-learn (server.py doet dat als eerste), want de
thread-instellingen voor OpenMP/BLAS worden bij het laden van die bibliotheken vastgelegd.

- TRAIN_JOBS (standaard 2): zoveel processorkernen mag het trainen gebruiken. scikit-learn
  (HistGradientBoosting, via OpenMP) en numpy (BLAS) nemen anders alle kernen van de server.
- TRAIN_NICE (standaard 10): lagere voorrang, zodat andere programma's op dezelfde server voorgaan
  als ze de processor nodig hebben. 0 = gewone voorrang.
"""
import os
import threading
import warnings
from contextlib import contextmanager

TRAIN_JOBS = max(1, int(os.environ.get('TRAIN_JOBS') or 2))
TRAIN_NICE = max(0, min(19, int(os.environ.get('TRAIN_NICE') or 10)))

_THREAD_VARS = ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
                'VECLIB_MAXIMUM_THREADS', 'BLIS_NUM_THREADS')
for _v in _THREAD_VARS:
    os.environ.setdefault(_v, str(TRAIN_JOBS))


def lower_priority():
    """Zet de voorrang van dit proces (en alle threads die daarna starten) lager."""
    if not TRAIN_NICE:
        return 0
    try:
        os.setpriority(os.PRIO_PROCESS, 0, max(os.getpriority(os.PRIO_PROCESS, 0), TRAIN_NICE))
        return os.getpriority(os.PRIO_PROCESS, 0)
    except (AttributeError, OSError):
        return None


def limit_threads():
    """Ook als numpy/scikit-learn al geladen waren: het aantal threads begrenzen."""
    try:
        from threadpoolctl import threadpool_limits
        threadpool_limits(TRAIN_JOBS)
        return True
    except Exception:
        return False


# ---------- scikit-learn veilig trainen vanuit threads ----------
# HistGradientBoosting zoekt de grenzen per kenmerk met scikit-learn's Parallel (threading). Elke
# worker-thread past de warning-instellingen van Python tijdelijk aan (catch_warnings +
# resetwarnings). Tot en met Python 3.13 is dat niet thread-safe: lopen zulke aanpassingen in
# verschillende threads door elkaar, dan kan warnings.filters leeg achterblijven. Daarna geeft
# scikit-learn bij élke training "`sklearn.utils.parallel.delayed` should be used with
# `sklearn.utils.parallel.Parallel`..." (het vindt geen filters meer om door te geven).
# Daarom: (1) nooit twee trainingen tegelijk, (2) vóór en na elke training de filters herstellen als
# ze beschadigd zijn. Zo blijft de toestand kloppen en verschijnt de waarschuwing niet meer.
_fit_lock = threading.RLock()
_baseline = list(warnings.filters)
repairs = {'count': 0}


def set_warning_baseline():
    """Na het opstarten (als alle eigen filters gezet zijn) de goede toestand vastleggen."""
    global _baseline
    _baseline = list(warnings.filters)


def _repair():
    if not warnings.filters and _baseline:
        warnings.filters[:] = list(_baseline)
        mutated = getattr(warnings, '_filters_mutated', None) or getattr(warnings, '_filters_mutated_lock_held', None)
        if mutated:
            mutated()
        repairs['count'] += 1


@contextmanager
def fit_guard():
    with _fit_lock:
        _repair()
        try:
            yield
        finally:
            _repair()
