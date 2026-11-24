"""Modelversiebeheer van de AI-trader: elke afgeronde leerronde (sessie) wordt een versie.

Een SQLite-database (registry.db in DATA_DIR) met per sessie: versienummer (oplopend), wanneer, door
wie (VPS of helper), welk recept, op welke data, met welke kenmerken en instellingen, de cijfers, en
de beslissing met een leesbare reden:
  promoted  het model van deze sessie is gepubliceerd (voor paper; live blijft altijd de eigenaar);
  rejected  het recept van deze sessie is niet het beste, of de ronde leverde geen bruikbaar model;
  kept      er was een kandidaat, maar die is niet aantoonbaar beter: het actieve model blijft;
  rollback  de eigenaar zette een eerdere versie terug.
Van elke gepubliceerde versie wordt agent.json bewaard in agents/versions/v<n>.json: dat is de
terugvaloptie. Die snapshots worden nooit opgeruimd; oude afgewezen en behouden sessies wel (boven
MAX_SESSIONS).

De database mag de trainer nooit laten vastlopen: is hij onleesbaar of kapot, dan wordt hij hernoemd
naar registry.db.corrupt-<tijd> en begint hij opnieuw (de snapshots blijven bestaan).
"""
import json
import math
import os
import sqlite3
import threading
from datetime import datetime

DB_NAME = 'registry.db'
MAX_SESSIONS = 2000      # boven zoveel sessies worden de oudste afgewezen/behouden sessies opgeruimd
SCHEMA_VERSION = 2
DECISIONS = ('promoted', 'rejected', 'kept', 'rollback')


def _clean(v):
    """JSON-veilig: geen NaN of oneindig (dat kan de bot niet lezen)."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


# ---------- Migraties ----------
# Elke migratie brengt het schema één versie verder. Ze draaien in volgorde en alleen als ze nog
# niet gedaan zijn (schema_version), dus opnieuw openen doet niets.

def _m1(db):
    db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    db.execute('''CREATE TABLE IF NOT EXISTS sessions (
        version INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        by TEXT,
        recipe_key TEXT,
        recipe_text TEXT,
        decision TEXT NOT NULL,
        reason TEXT,
        body TEXT NOT NULL)''')


def _m2(db):
    # Snapshot-vlag als eigen kolom (snel zoeken naar terugvalopties) en een index op de beslissing.
    cols = {r[1] for r in db.execute('PRAGMA table_info(sessions)')}
    if 'has_snapshot' not in cols:
        db.execute('ALTER TABLE sessions ADD COLUMN has_snapshot INTEGER NOT NULL DEFAULT 0')
    db.execute('CREATE INDEX IF NOT EXISTS sessions_decision ON sessions (decision)')


MIGRATIONS = {1: _m1, 2: _m2}


def schema_version(db):
    try:
        row = db.execute('SELECT version FROM schema_version').fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row[0]) if row else 0


def migrate(db):
    """Brengt de database naar SCHEMA_VERSION. Idempotent."""
    db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    cur = schema_version(db)
    if not db.execute('SELECT 1 FROM schema_version').fetchone():
        db.execute('INSERT INTO schema_version (version) VALUES (0)')
    for v in range(cur + 1, SCHEMA_VERSION + 1):
        MIGRATIONS[v](db)
        db.execute('UPDATE schema_version SET version = ?', (v,))
    db.commit()
    return schema_version(db)


class Registry:
    def __init__(self, data_dir, log=print):
        self.dir = data_dir
        self.file = os.path.join(data_dir, DB_NAME)
        self.snap_dir = os.path.join(data_dir, 'agents', 'versions')
        self.log = log
        self.lock = threading.RLock()
        self._ready = False

    # ----- verbinding, migratie en herstel -----

    def _connect(self):
        db = sqlite3.connect(self.file, timeout=10)
        db.execute('PRAGMA journal_mode=DELETE')
        return db

    def _open(self):
        """Open de database (en migreer hem de eerste keer). Kapot: opzij zetten en opnieuw."""
        os.makedirs(self.dir, exist_ok=True)
        if self._ready:
            try:
                return self._connect()
            except sqlite3.DatabaseError:
                self._ready = False
        try:
            db = self._connect()
            try:
                db.execute('PRAGMA quick_check').fetchone()
                migrate(db)
            except Exception:
                db.close()
                raise
        except sqlite3.DatabaseError as e:
            self._set_aside(e)
            db = self._connect()
            migrate(db)
        self._ready = True
        return db

    def _set_aside(self, err):
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        dest = f'{self.file}.corrupt-{stamp}'
        n = 1
        while os.path.exists(dest):
            n += 1
            dest = f'{self.file}.corrupt-{stamp}-{n}'
        try:
            os.replace(self.file, dest)
        except OSError:
            try:
                os.remove(self.file)
            except OSError:
                pass
        for ext in ('-journal', '-wal', '-shm'):
            try:
                os.remove(self.file + ext)
            except OSError:
                pass
        self.log(f'Modelregister: database onleesbaar ({err}); bewaard als {os.path.basename(dest)}, ik begin opnieuw.')

    def _run(self, fn):
        """Voer fn(db) uit; bij een kapotte database één keer opnieuw beginnen."""
        with self.lock:
            for attempt in (0, 1):
                db = self._open()
                try:
                    out = fn(db)
                    db.commit()
                    return out
                except sqlite3.DatabaseError as e:
                    if attempt or isinstance(e, sqlite3.IntegrityError):
                        raise
                    db.close()
                    self._ready = False
                    self._set_aside(e)
                finally:
                    try:
                        db.close()
                    except Exception:
                        pass

    # ----- meta -----

    @staticmethod
    def _get(db, key, default=None):
        row = db.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def _put(db, key, value):
        db.execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                   (key, json.dumps(value)))

    def _highest_snapshot(self):
        try:
            nums = [int(n[1:-5]) for n in os.listdir(self.snap_dir) if n.startswith('v') and n.endswith('.json') and n[1:-5].isdigit()]
        except OSError:
            return 0
        return max(nums, default=0)

    def _next_version(self, db):
        last = self._get(db, 'lastVersion')
        if last is None:
            # Nieuwe (of na een kapotte opnieuw begonnen) database: nooit een bestaande snapshot overschrijven.
            row = db.execute('SELECT MAX(version) FROM sessions').fetchone()
            last = max(row[0] or 0, self._highest_snapshot())
        self._put(db, 'lastVersion', last + 1)
        return last + 1

    def active(self):
        return self._run(lambda db: self._get(db, 'active'))

    def pinned(self):
        return self._run(lambda db: self._get(db, 'pinned'))

    def set_active(self, version):
        self._run(lambda db: self._put(db, 'active', version))

    def set_pinned(self, version):
        self._run(lambda db: self._put(db, 'pinned', version))

    # ----- sessies -----

    def snapshot_path(self, version):
        return os.path.join(self.snap_dir, f'v{int(version)}.json')

    def has_snapshot(self, version):
        return version is not None and os.path.exists(self.snapshot_path(version))

    def read_snapshot(self, version):
        try:
            with open(self.snapshot_path(version)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write_snapshot(self, version, agent):
        os.makedirs(self.snap_dir, exist_ok=True)
        p = self.snapshot_path(version)
        tmp = f'{p}.tmp.{os.getpid()}.{threading.get_ident()}'
        try:
            with open(tmp, 'w') as f:
                json.dump(_clean(agent), f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    def record(self, rec, snapshot=None):
        """Een sessie vastleggen. rec: {at, by, recipeKey, recipeText, dataset, features, settings,
        metrics, decision, reason, comparedTo, ...}. Met snapshot (de gepubliceerde agent.json, alleen
        bij promoted) wordt die bewaard als terugvaloptie en wordt deze versie de actieve.
        Geeft het volledige record (met version)."""
        if rec.get('decision') not in DECISIONS:
            raise ValueError(f"onbekende beslissing: {rec.get('decision')}")
        rec = _clean(dict(rec))
        rec.setdefault('at', datetime.now().isoformat(timespec='seconds'))

        def go(db):
            v = self._next_version(db)
            rec['version'] = v
            if snapshot is not None:
                self._write_snapshot(v, snapshot)
            body = {k: x for k, x in rec.items() if k not in ('version', 'at', 'by', 'recipeKey', 'recipeText', 'decision', 'reason')}
            db.execute('INSERT INTO sessions (version, at, by, recipe_key, recipe_text, decision, reason, body, has_snapshot) '
                       'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                       (v, rec['at'], rec.get('by'), rec.get('recipeKey'), rec.get('recipeText'), rec['decision'], rec.get('reason'),
                        json.dumps(body), 1 if snapshot is not None else 0))
            self._put(db, 'sessions', (self._get(db, 'sessions', 0) or 0) + 1)
            if snapshot is not None:
                self._put(db, 'active', v)
            self._prune(db)
            return v
        self._run(go)
        rec['hasSnapshot'] = snapshot is not None
        return rec

    @staticmethod
    def _prune(db):
        """Boven MAX_SESSIONS: de oudste afgewezen/behouden sessies weg. Gepubliceerde versies en
        terugzettingen blijven altijd (en hun snapshots ook)."""
        n = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        extra = n - MAX_SESSIONS
        if extra > 0:
            db.execute("DELETE FROM sessions WHERE version IN (SELECT version FROM sessions WHERE decision IN ('rejected', 'kept') "
                       'AND has_snapshot = 0 ORDER BY version LIMIT ?)', (extra,))

    def _row(self, r, active=None):
        version, at, by, key, text, decision, reason, body, snap = r
        try:
            extra = json.loads(body)
        except ValueError:
            extra = {}
        out = {'version': version, 'at': at, 'by': by, 'recipeKey': key, 'recipeText': text, 'decision': decision, 'reason': reason}
        for k in ('dataset', 'features', 'settings', 'metrics', 'comparedTo'):
            out[k] = extra.get(k)
        out.update({k: x for k, x in extra.items() if k not in out})
        out['active'] = active is not None and version == active
        out['hasSnapshot'] = bool(snap) and self.has_snapshot(version)
        return out

    _COLS = 'version, at, by, recipe_key, recipe_text, decision, reason, body, has_snapshot'

    def get(self, version):
        def go(db):
            r = db.execute(f'SELECT {self._COLS} FROM sessions WHERE version = ?', (int(version),)).fetchone()
            return self._row(r, self._get(db, 'active')) if r else None
        return self._run(go)

    def versions(self, limit=200):
        def go(db):
            act = self._get(db, 'active')
            rows = db.execute(f'SELECT {self._COLS} FROM sessions ORDER BY version DESC LIMIT ?', (int(limit),)).fetchall()
            return [self._row(r, act) for r in rows]
        return self._run(go)

    def summary(self, limit=200, thresholds=None):
        """Wat GET /registry teruggeeft."""
        def go(db):
            act, pin = self._get(db, 'active'), self._get(db, 'pinned')
            rows = db.execute(f'SELECT {self._COLS} FROM sessions ORDER BY version DESC LIMIT ?', (int(limit),)).fetchall()
            versions = [self._row(r, act) for r in rows]
            total = self._get(db, 'sessions', None)
            if total is None:
                total = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
            last = next((v for v in versions if v['decision'] != 'rollback'), None)
            return {'versions': versions, 'active': act, 'pinned': pin, 'sessions': total, 'lastSession': last,
                    'thresholds': thresholds or {}}
        return self._run(go)

    def last_snapshot_for(self, recipe_key):
        """Nieuwste gepubliceerde versie (met snapshot) van een recept, of None."""
        def go(db):
            rows = db.execute('SELECT version FROM sessions WHERE recipe_key = ? AND has_snapshot = 1 ORDER BY version DESC',
                              (recipe_key,)).fetchall()
            return next((r[0] for r in rows if self.has_snapshot(r[0])), None)
        return self._run(go)

