// Beslissingsdagboek (leerdata): elke echte kans die de bot zag, gekocht of niet, met wat hij
// op dat moment wist (kenmerken, indicatoren, orderboek, AI-oordeel). Later rekent hij uit hoe de
// koers daarna liep (labels), en bij gekochte kansen hoe de trade afliep. Zo zie je of de AI en de
// regels terecht afwezen, en kan de trainer van gemiste kansen leren.
//
// Opslag in SQLite (node:sqlite, ingebouwd in Node 22): learning.db in de map van de gebruiker.
// Het dagboek is een extraatje: het mag de handel NOOIT breken. Elke publieke methode vangt zijn
// eigen fouten af en logt hooguit één keer per minuut. Lukt openen niet (kapotte db), dan hernoemt
// hij het bestand en begint opnieuw; lukt ook dat niet, dan staat hij uit en doet niets.
//
// Geen data leakage: in een beslissing staat alleen wat er op het moment van besluiten bekend was.
// Labels (de koers NA het besluit) staan in een aparte tabel en worden pas berekend als de horizon
// voorbij is, uitsluitend met candles die strikt na het besluit openen.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { atr } from './indicators.js';

const FIVE_MIN = 5 * 60000;
const DAY = 86400000;

export const KINDS = ['agent', 'rules', 'explore', 'arm'];
export const OUTCOMES = ['accepted', 'rejected'];
export const STAGES = ['toelating', 'risk', 'pauze', 'risicoregels', 'orderboek', 'ai-veto', 'approved', 'not-filled', 'error'];
// Afwijzingen waarvan we achteraf kunnen zeggen of ze terecht waren (niet-gevuld en fouten niet:
// daar besliste niemand "nee").
const REJECT_STAGES = new Set(['toelating', 'risk', 'pauze', 'risicoregels', 'orderboek', 'ai-veto']);

export const JOURNAL_DEFAULTS = { horizons: [60, 240, 1440], mainHorizon: 240, retentionDays: 180, giveUpDays: 3, maxCandles: 300 };

// Instellingen uit environment variables (zie README):
//   JOURNAL_ENABLED=0        dagboek uit
//   JOURNAL_HORIZONS=60,240,1440   horizons in minuten
//   JOURNAL_MAIN_HORIZON=240 horizon waarop terecht/onterecht afgewezen wordt beoordeeld
//   JOURNAL_RETENTION_DAYS=180     beslissingen ouder dan dit worden opgeruimd
export function journalOptionsFromEnv(env = process.env) {
  const num = (v, def) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? def : Number(v));
  const horizons = String(env.JOURNAL_HORIZONS ?? '').split(',').map((x) => Math.round(Number(x))).filter((x) => x > 0 && x <= 30 * 1440);
  const opts = {
    enabled: !['0', 'false', 'nee', 'no'].includes(String(env.JOURNAL_ENABLED ?? '').toLowerCase()),
    horizons: horizons.length ? [...new Set(horizons)].sort((a, b) => a - b) : JOURNAL_DEFAULTS.horizons,
    retentionDays: Math.max(1, num(env.JOURNAL_RETENTION_DAYS, JOURNAL_DEFAULTS.retentionDays)),
  };
  const main = Math.round(num(env.JOURNAL_MAIN_HORIZON, JOURNAL_DEFAULTS.mainHorizon));
  opts.mainHorizon = opts.horizons.includes(main) ? main : opts.horizons.includes(JOURNAL_DEFAULTS.mainHorizon) ? JOURNAL_DEFAULTS.mainHorizon : opts.horizons[Math.floor(opts.horizons.length / 2)];
  return opts;
}

// ---------- Volatiliteitsregime ----------
// ratio = atrPct (ATR 14 / close × 100) op de laatste candle ÷ mediaan van atrPct over de
// voorgaande 500 candles (alleen verleden, de laatste candle zelf telt niet mee).
// > 1,5 → 'hoog', < 0,67 → 'laag', anders 'normaal'. Minder dan 100 bruikbare voorgaande waarden → null.
// De trainer gebruikt exact dezelfde regel.
export const VOL_REGIME = { lookback: 500, minHistory: 100, high: 1.5, low: 0.67 };
export function volRegimeOf(candles, rules = VOL_REGIME) {
  try {
    if (!Array.isArray(candles) || candles.length < rules.minHistory + 15) return null;
    const a = atr(candles, 14);
    const pct = (i) => {
      const c = candles[i]?.[4];
      return a[i] != null && c > 0 ? (a[i] / c) * 100 : null;
    };
    const i = candles.length - 1;
    const now = pct(i);
    if (!(now > 0)) return null;
    const prev = [];
    for (let k = Math.max(0, i - rules.lookback); k < i; k++) {
      const v = pct(k);
      if (Number.isFinite(v) && v > 0) prev.push(v);
    }
    if (prev.length < rules.minHistory) return null;
    prev.sort((x, y) => x - y);
    const m = prev.length % 2 ? prev[(prev.length - 1) / 2] : (prev[prev.length / 2 - 1] + prev[prev.length / 2]) / 2;
    const ratio = now / m;
    return ratio > rules.high ? 'hoog' : ratio < rules.low ? 'laag' : 'normaal';
  } catch {
    return null;
  }
}

// ---------- Hulpjes om een beslissing samen te stellen ----------
const fin = (v) => (Number.isFinite(v) ? v : null);
const round = (v, d = 6) => (Number.isFinite(v) ? +v.toFixed(d) : null);

// Indicatoren die er zijn (trend, RSI, ATR, volume, EMA's). Zonder indicatoren (AI-trader) uit de kenmerken.
export function pickIndicators(ind, features = null) {
  const out = {};
  const put = (k, v) => { if (Number.isFinite(v)) out[k] = round(v); };
  if (ind) {
    for (const k of ['close', 'emaFast', 'emaSlow', 'emaTrend', 'rsi', 'adx', 'atr', 'atrPct', 'volumeRatio', 'change24', 'movedSinceSignalPct', 'mlProb']) put(k, ind[k]);
    if (Number.isFinite(ind.emaFast) && Number.isFinite(ind.emaSlow)) out.trend = ind.emaFast > ind.emaSlow ? 'up' : 'down';
  }
  if (features) {
    if (out.rsi == null) put('rsi', features.rsi14);
    if (out.adx == null) put('adx', features.adx14);
    if (out.atrPct == null) put('atrPct', features.atrPct);
    if (out.volumeRatio == null) put('volumeRatio', features.volRatio);
    if (!out.trend && Number.isFinite(features.emaSpreadPct)) out.trend = features.emaSpreadPct > 0 ? 'up' : 'down';
  }
  return Object.keys(out).length ? out : null;
}

// Regelgebaseerd signaal of advies bij deze beslissing.
export function ruleOf(ind, reason = null) {
  const g = ind?.agent;
  if (g) {
    return { type: g.explore ? 'verkenner' : 'ai-trader', expectedPct: fin(g.expectedPct), adjustedPct: fin(g.adjustedPct), threshold: fin(g.threshold),
      recipe: g.recipe ?? null, timeframe: g.timeframe ?? null, ...(g.explore ? { why: g.exploreWhy ?? null } : {}) };
  }
  const a = ind?.mlArm;
  if (a) return { type: 'strategie', key: a.key ?? null, prob: fin(ind.mlProb), minProb: fin(a.minProb), estimatePct: fin(a.estimatePct), timeframe: a.timeframe ?? null };
  if (!ind) return null;
  return { type: 'ema-rsi', signal: 'buy', reason: reason ?? null, mlProb: fin(ind.mlProb), mlRegime: ind.mlRegime ?? null };
}

const json = (v) => {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
};
const parse = (s) => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
};
const toMs = (v) => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Label voor één beslissing en horizon, of null als het (nog) niet kan.
// Alleen candles met openingstijd ≥ t (strikt na het besluit) en < t + horizon, en alleen gesloten
// candles. ret = close van de laatste candle in het venster / p − 1 (in %) − rondekosten.
export function computeLabel({ at, price }, horizonMin, candles, { now = Date.now(), costPct = 0 } = {}) {
  const end = at + horizonMin * 60000;
  if (now < end) return null; // horizon nog niet voorbij: nooit vooruitkijken
  if (!(price > 0) || !Array.isArray(candles)) return null;
  const win = candles.filter((c) => Array.isArray(c) && c[0] >= at && c[0] < end && c[0] + FIVE_MIN <= now
    && c[2] > 0 && c[3] > 0 && c[4] > 0).sort((x, y) => x[0] - y[0]);
  // De laatste candle moet dicht bij het einde liggen (hooguit 2 ontbrekende candles aan het eind).
  if (!win.length || win.at(-1)[0] < end - 3 * FIVE_MIN) return null;
  const last = win.at(-1)[4];
  const hi = Math.max(...win.map((c) => c[2]));
  const lo = Math.min(...win.map((c) => c[3]));
  return {
    retPct: round((last / price - 1) * 100 - (Number(costPct) || 0), 4),
    mfePct: round((hi / price - 1) * 100, 4),
    maePct: round((lo / price - 1) * 100, 4),
  };
}

// node:sqlite laden zonder de ExperimentalWarning, maar alleen díe waarschuwing: alle andere gaan gewoon door.
let sqlite = null;
function loadSqlite() {
  if (sqlite) return sqlite;
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(msg))) return;
    return orig.call(process, warning, ...rest);
  };
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite');
  } finally {
    process.emitWarning = orig;
  }
  return sqlite;
}

// ---------- Schema ----------
// Elke migratie één keer, in een eigen transactie. Nieuwe migraties alleen achteraan toevoegen.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        mode TEXT, pair TEXT, timeframe TEXT, price REAL,
        kind TEXT, outcome TEXT, stage TEXT, reason TEXT,
        features TEXT, indicators TEXT, book TEXT, ai TEXT, rule TEXT,
        recipe TEXT, model_version TEXT, expected_pct REAL,
        regime TEXT, vol_regime TEXT, trade_ref TEXT, ai_provider TEXT
      );
      CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
      CREATE INDEX IF NOT EXISTS decisions_mode_at ON decisions (mode, at);
      CREATE TABLE IF NOT EXISTS labels (
        decision_id INTEGER NOT NULL,
        horizon_min INTEGER NOT NULL,
        ret_pct REAL, mfe_pct REAL, mae_pct REAL,
        settled_at INTEGER NOT NULL,
        PRIMARY KEY (decision_id, horizon_min)
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER,
        mode TEXT, pair TEXT, opened_at INTEGER, closed_at INTEGER,
        entry_price REAL, exit_price REAL, cost_eur REAL, fees_eur REAL,
        spread_pct REAL, entry_slip_pct REAL, exit_slip_pct REAL,
        pnl_eur REAL, pnl_pct REAL, mfe_pct REAL, mae_pct REAL,
        exit_reason TEXT, recipe TEXT, regime TEXT, vol_regime TEXT, ai_provider TEXT
      );
      CREATE INDEX IF NOT EXISTS trades_closed ON trades (closed_at);
      CREATE INDEX IF NOT EXISTS trades_decision ON trades (decision_id);
    `,
  },
];

export class Journal {
  // file: pad naar learning.db (null = uit). opts: horizons, mainHorizon, retentionDays, giveUpDays, enabled, log.
  constructor(file, opts = {}) {
    this.file = file ?? null;
    this.horizons = (opts.horizons ?? JOURNAL_DEFAULTS.horizons).slice();
    this.mainHorizon = this.horizons.includes(opts.mainHorizon) ? opts.mainHorizon
      : this.horizons.includes(JOURNAL_DEFAULTS.mainHorizon) ? JOURNAL_DEFAULTS.mainHorizon : this.horizons[0];
    this.retentionDays = opts.retentionDays ?? JOURNAL_DEFAULTS.retentionDays;
    this.giveUpDays = opts.giveUpDays ?? JOURNAL_DEFAULTS.giveUpDays;
    this.maxCandles = opts.maxCandles ?? JOURNAL_DEFAULTS.maxCandles;
    this.log = opts.log ?? console;
    this.enabled = Boolean(this.file) && opts.enabled !== false;
    this.db = null;
    this.lastLogAt = 0;
    this.lastPruneAt = 0;
  }

  // Fouten loggen, hooguit één keer per minuut.
  #fail(what, err) {
    const now = Date.now();
    if (now - this.lastLogAt < 60000) return;
    this.lastLogAt = now;
    try { (this.log.warn ?? this.log.info ?? (() => {})).call(this.log, `Leerdagboek: ${what} mislukt: ${err?.message ?? err}`); } catch { /* ook loggen mag niets breken */ }
  }

  #connect() {
    const { DatabaseSync } = loadSqlite();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // Een kapot bestand valt hier al op ("file is not a database").
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      Journal.migrate(db);
      return db;
    } catch (err) {
      try { db.close(); } catch { /* al dicht */ }
      throw err;
    }
  }

  static migrate(db) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const cur = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= cur) continue;
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* niets te herstellen */ }
        throw err;
      }
    }
  }

  // Opent de db bij het eerste gebruik. Kapot: hernoemen naar learning.db.corrupt-<tijd> en opnieuw.
  #open() {
    if (this.db) return this.db;
    if (!this.enabled) return null;
    try {
      this.db = this.#connect();
      return this.db;
    } catch (err) {
      this.#fail(`openen van ${path.basename(this.file)}`, err);
    }
    try {
      if (fs.existsSync(this.file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(this.file, `${this.file}.corrupt-${stamp}`);
        for (const ext of ['-wal', '-shm']) fs.rmSync(`${this.file}${ext}`, { force: true });
      }
      this.db = this.#connect();
      this.log.warn?.(`Leerdagboek was onleesbaar en is opnieuw begonnen (oude bestand bewaard als .corrupt)`);
      return this.db;
    } catch (err) {
      this.enabled = false;
      this.db = null;
      this.lastLogAt = 0;
      this.#fail('opnieuw beginnen (dagboek staat nu uit)', err);
      return null;
    }
  }

  // Slaat een beslissing op. Geeft het id terug, of null.
  record(d = {}) {
    try {
      const db = this.#open();
      if (!db) return null;
      const at = toMs(d.at) ?? Date.now();
      const kind = KINDS.includes(d.kind) ? d.kind : 'rules';
      const outcome = OUTCOMES.includes(d.outcome) ? d.outcome : 'rejected';
      const stage = STAGES.includes(d.stage) ? d.stage : 'error';
      const ai = d.ai ?? null;
      // Alles wordt hier meteen naar tekst omgezet: wat er later met de objecten gebeurt, verandert de beslissing niet.
      const r = db.prepare(`INSERT INTO decisions (at, mode, pair, timeframe, price, kind, outcome, stage, reason, features, indicators, book, ai, rule,
        recipe, model_version, expected_pct, regime, vol_regime, trade_ref, ai_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        at, d.mode ?? null, d.pair ?? null, d.timeframe ?? null, fin(d.price), kind, outcome, stage, d.reason == null ? null : String(d.reason).slice(0, 500),
        json(d.features), json(d.indicators), json(d.book), json(ai), json(d.rule),
        d.recipe == null ? null : String(d.recipe), d.modelVersion == null ? null : String(d.modelVersion), fin(d.expectedPct),
        d.regime ?? null, d.volRegime ?? null, d.tradeRef == null ? null : String(d.tradeRef), ai?.provider == null ? null : String(ai.provider));
      return Number(r.lastInsertRowid);
    } catch (err) {
      this.#fail('beslissing opslaan', err);
      return null;
    }
  }

  linkTrade(decisionId, tradeRef) {
    try {
      const db = this.#open();
      if (!db || decisionId == null) return false;
      return db.prepare('UPDATE decisions SET trade_ref = ? WHERE id = ?').run(tradeRef == null ? null : String(tradeRef), decisionId).changes > 0;
    } catch (err) {
      this.#fail('trade koppelen', err);
      return false;
    }
  }

  // Een afgesloten trade. Ontbrekende spread, regime, vol-regime en AI vult hij aan uit de gekoppelde beslissing.
  recordTrade(t = {}) {
    try {
      const db = this.#open();
      if (!db) return null;
      const dec = t.decisionId != null ? db.prepare('SELECT book, regime, vol_regime, ai_provider, recipe FROM decisions WHERE id = ?').get(t.decisionId) : null;
      const book = parse(dec?.book);
      const r = db.prepare(`INSERT INTO trades (decision_id, mode, pair, opened_at, closed_at, entry_price, exit_price, cost_eur, fees_eur, spread_pct,
        entry_slip_pct, exit_slip_pct, pnl_eur, pnl_pct, mfe_pct, mae_pct, exit_reason, recipe, regime, vol_regime, ai_provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t.decisionId ?? null, t.mode ?? null, t.pair ?? null, toMs(t.openedAt), toMs(t.closedAt) ?? Date.now(),
        fin(t.entryPrice), fin(t.exitPrice), fin(t.costEur), fin(t.feesEur), fin(t.spreadPct) ?? fin(book?.spreadPct),
        fin(t.entrySlipPct), fin(t.exitSlipPct), fin(t.pnlEur), fin(t.pnlPct), fin(t.mfePct), fin(t.maePct),
        t.exitReason == null ? null : String(t.exitReason).slice(0, 300), t.recipe ?? dec?.recipe ?? null,
        t.regime ?? dec?.regime ?? null, t.volRegime ?? dec?.vol_regime ?? null, t.aiProvider ?? dec?.ai_provider ?? null);
      return Number(r.lastInsertRowid);
    } catch (err) {
      this.#fail('trade opslaan', err);
      return null;
    }
  }

  // Beslissingen waarvan minstens één horizon voorbij is zonder label. Oudste eerst.
  // [{ id, at, pair, price, horizons: [minuten] }]
  due(now = Date.now(), limit = 50) {
    try {
      const db = this.#open();
      if (!db) return [];
      const map = new Map();
      const q = db.prepare(`SELECT d.id, d.at, d.pair, d.price FROM decisions d WHERE d.at <= ?
        AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.decision_id = d.id AND l.horizon_min = ?) ORDER BY d.at LIMIT ?`);
      for (const h of this.horizons) {
        for (const row of q.all(now - h * 60000, h, limit)) {
          const e = map.get(row.id) ?? { id: row.id, at: row.at, pair: row.pair, price: row.price, horizons: [] };
          e.horizons.push(h);
          map.set(row.id, e);
        }
      }
      return [...map.values()].sort((a, b) => a.at - b.at || a.id - b.id).slice(0, limit);
    } catch (err) {
      this.#fail('openstaande labels zoeken', err);
      return [];
    }
  }

  // Labels berekenen. fetchCandles(pair, since, limit) geeft 5m-candles [ts, o, h, l, c, v] vanaf since.
  // Ontbreken de candles: later opnieuw; na giveUpDays opgeven (label null, met settled_at).
  async settle(fetchCandles, { costPct = 0, now = Date.now(), limit = 50 } = {}) {
    const out = { labeled: 0, gaveUp: 0, waiting: 0 };
    try {
      if (!this.#open()) return out;
      this.prune(now, { throttle: true });
      const list = this.due(now, limit);
      const byPair = new Map();
      for (const d of list) byPair.set(d.pair, [...(byPair.get(d.pair) ?? []), d]);
      const put = this.db.prepare('INSERT OR REPLACE INTO labels (decision_id, horizon_min, ret_pct, mfe_pct, mae_pct, settled_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [pair, items] of byPair) {
        let candles = null;
        const since = Math.min(...items.map((d) => d.at));
        const end = Math.max(...items.flatMap((d) => d.horizons.map((h) => d.at + h * 60000)));
        const n = Math.max(2, Math.min(this.maxCandles, Math.ceil((end - since) / FIVE_MIN) + 2));
        if (pair) {
          try {
            candles = await fetchCandles(pair, since, n);
          } catch {
            candles = null; // geen data: later opnieuw
          }
        }
        const lastTs = Array.isArray(candles) && candles.length ? Math.max(...candles.map((c) => c?.[0] ?? 0)) : null;
        for (const d of items) {
          for (const h of d.horizons) {
            const hEnd = d.at + h * 60000;
            if (now < hEnd) continue;
            const lab = computeLabel(d, h, candles, { now, costPct });
            if (lab) {
              put.run(d.id, h, lab.retPct, lab.mfePct, lab.maePct, now);
              out.labeled++;
            } else if (!(d.price > 0) || !pair || (now > hEnd + this.giveUpDays * DAY && (lastTs == null || lastTs >= hEnd))) {
              // Opgeven: geen bruikbare prijs, of na dagen nog steeds geen (volledige) data voor dit venster.
              put.run(d.id, h, null, null, null, now);
              out.gaveUp++;
            } else {
              out.waiting++;
            }
          }
        }
      }
    } catch (err) {
      this.#fail('labels berekenen', err);
    }
    return out;
  }

  // Ruimt beslissingen (met hun labels) en trades op die ouder zijn dan de bewaartermijn.
  prune(now = Date.now(), { throttle = false } = {}) {
    try {
      if (throttle && now - this.lastPruneAt < 3600000) return 0;
      const db = this.#open();
      if (!db) return 0;
      this.lastPruneAt = now;
      const cut = now - this.retentionDays * DAY;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM labels WHERE decision_id IN (SELECT id FROM decisions WHERE at < ?)').run(cut);
        const n = db.prepare('DELETE FROM decisions WHERE at < ?').run(cut).changes;
        db.prepare('DELETE FROM trades WHERE closed_at < ?').run(cut);
        db.exec('COMMIT');
        return Number(n);
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* niets te herstellen */ }
        throw err;
      }
    } catch (err) {
      this.#fail('opruimen', err);
      return 0;
    }
  }

  // Lege stats in exact dezelfde vorm.
  #emptyStats() {
    return {
      enabled: this.enabled, horizons: this.horizons.slice(),
      counts: { decisions: 0, accepted: 0, rejected: 0, labeled: 0, pending: 0, trades: 0 },
      outcomes: { good: 0, bad: 0, correctRejections: 0, missedOpportunities: 0, wrongRejections: 0 },
      byAi: [], byPair: [], byRegime: [], byStage: [], recent: [],
    };
  }

  // Overzicht voor het dashboard. mode: 'paper' | 'live' | null (alles); days: periode.
  // Percentages (winRate, positiveShare) in 0-100. Ontbrekende gegevens: 0 of null.
  stats({ mode = null, days = 30, now = Date.now() } = {}) {
    const out = this.#emptyStats();
    try {
      const db = this.#open();
      if (!db) return out;
      const since = now - Math.max(0, Number(days) || 30) * DAY;
      const m = mode ?? null;
      const decisions = db.prepare(`SELECT id, at, pair, kind, outcome, stage, reason, price, expected_pct, regime, vol_regime, ai_provider, ai
        FROM decisions WHERE at >= ? AND (? IS NULL OR mode = ?) ORDER BY at DESC, id DESC`).all(since, m, m);
      const labelRows = db.prepare(`SELECT l.decision_id, l.horizon_min, l.ret_pct FROM labels l JOIN decisions d ON d.id = l.decision_id
        WHERE d.at >= ? AND (? IS NULL OR d.mode = ?)`).all(since, m, m);
      const trades = db.prepare(`SELECT id, decision_id, pair, pnl_eur, pnl_pct, mfe_pct, mae_pct, regime, vol_regime FROM trades
        WHERE closed_at >= ? AND (? IS NULL OR mode = ?)`).all(since, m, m);
      const linked = db.prepare(`SELECT t.decision_id, t.pnl_eur, t.pnl_pct, t.mfe_pct, t.mae_pct FROM trades t JOIN decisions d ON d.id = t.decision_id
        WHERE d.at >= ? AND (? IS NULL OR d.mode = ?) ORDER BY t.id`).all(since, m, m);

      const labels = new Map(); // id -> { horizon: ret | null }
      for (const l of labelRows) {
        const e = labels.get(l.decision_id) ?? {};
        e[l.horizon_min] = l.ret_pct;
        labels.set(l.decision_id, e);
      }
      const tradeOf = new Map(linked.map((t) => [t.decision_id, t]));
      const H = this.mainHorizon;
      const mainRet = (id) => {
        const v = labels.get(id)?.[H];
        return Number.isFinite(v) ? v : null;
      };
      const avg = (arr) => (arr.length ? round(arr.reduce((a, v) => a + v, 0) / arr.length, 3) : null);
      const share = (n, d) => (d ? round((n / d) * 100, 1) : null);

      const c = out.counts;
      const o = out.outcomes;
      c.decisions = decisions.length;
      c.trades = trades.length;
      const byAi = new Map(), byPair = new Map(), byRegime = new Map(), byStage = new Map();
      const regimeKey = (r, v) => `${r ?? ''}|${v ?? ''}`;
      const regimeRow = (r, v) => {
        const k = regimeKey(r, v);
        if (!byRegime.has(k)) byRegime.set(k, { regime: r ?? null, volRegime: v ?? null, decisions: 0, accepted: 0, trades: 0, pnl: [], ret: [] });
        return byRegime.get(k);
      };
      const pairRow = (p) => {
        if (!byPair.has(p)) byPair.set(p, { pair: p, decisions: 0, accepted: 0, trades: 0, pnl: [], wins: 0, missed: 0 });
        return byPair.get(p);
      };
      for (const d of decisions) {
        const ret = mainRet(d.id);
        const accepted = d.outcome === 'accepted';
        if (accepted) c.accepted++; else c.rejected++;
        if (ret != null) c.labeled++;
        else if (!(labels.get(d.id) && H in labels.get(d.id))) c.pending++;
        const t = tradeOf.get(d.id);
        if (accepted && t && Number.isFinite(t.pnl_eur)) {
          if (t.pnl_eur > 0) o.good++; else o.bad++;
        }
        const rejectable = !accepted && REJECT_STAGES.has(d.stage);
        if (rejectable && ret != null) {
          if (ret <= 0) o.correctRejections++;
          else if (d.stage === 'ai-veto') o.wrongRejections++;
          else o.missedOpportunities++;
        }
        const pr = pairRow(d.pair);
        pr.decisions++;
        if (accepted) pr.accepted++;
        if (rejectable && ret != null && ret > 0) pr.missed++;
        const rr = regimeRow(d.regime, d.vol_regime);
        rr.decisions++;
        if (accepted) rr.accepted++;
        if (ret != null) rr.ret.push(ret);
        const st = byStage.get(d.stage) ?? { stage: d.stage, decisions: 0, rets: [] };
        st.decisions++;
        if (ret != null) st.rets.push(ret);
        byStage.set(d.stage, st);
        if (d.ai_provider) {
          const ai = parse(d.ai);
          const a = byAi.get(d.ai_provider) ?? { provider: d.ai_provider, decisions: 0, approved: 0, vetoed: 0, vetoRight: 0, vetoWrong: 0 };
          a.decisions++;
          if (d.stage === 'ai-veto') {
            a.vetoed++;
            if (ret != null) { if (ret > 0) a.vetoWrong++; else a.vetoRight++; }
          } else if (ai?.decision === 'approve' || accepted) a.approved++;
          byAi.set(d.ai_provider, a);
        }
      }
      for (const t of trades) {
        const pr = pairRow(t.pair);
        pr.trades++;
        if (Number.isFinite(t.pnl_pct)) pr.pnl.push(t.pnl_pct);
        if (t.pnl_eur > 0) pr.wins++;
        const rr = regimeRow(t.regime, t.vol_regime);
        rr.trades++;
        if (Number.isFinite(t.pnl_pct)) rr.pnl.push(t.pnl_pct);
      }
      out.byAi = [...byAi.values()].sort((a, b) => b.decisions - a.decisions);
      out.byPair = [...byPair.values()].map((p) => ({ pair: p.pair, decisions: p.decisions, accepted: p.accepted, trades: p.trades,
        avgPnlPct: avg(p.pnl), winRate: share(p.wins, p.trades), missed: p.missed })).sort((a, b) => b.decisions - a.decisions || b.trades - a.trades);
      out.byRegime = [...byRegime.values()].map((r) => ({ regime: r.regime, volRegime: r.volRegime, decisions: r.decisions, accepted: r.accepted,
        trades: r.trades, avgPnlPct: avg(r.pnl), avgRetPct: avg(r.ret) })).sort((a, b) => b.decisions - a.decisions || b.trades - a.trades);
      out.byStage = [...byStage.values()].map((s) => ({ stage: s.stage, decisions: s.decisions, labeled: s.rets.length, avgRetPct: avg(s.rets),
        positiveShare: share(s.rets.filter((v) => v > 0).length, s.rets.length) })).sort((a, b) => b.decisions - a.decisions);
      out.recent = decisions.slice(0, 50).map((d) => {
        const t = tradeOf.get(d.id);
        const lab = labels.get(d.id) ?? {};
        return {
          id: d.id, at: iso(d.at), pair: d.pair, kind: d.kind, outcome: d.outcome, stage: d.stage, reason: d.reason, price: d.price,
          expectedPct: d.expected_pct, regime: d.regime, volRegime: d.vol_regime, aiProvider: d.ai_provider,
          labels: Object.fromEntries(this.horizons.map((h) => [h, Number.isFinite(lab[h]) ? lab[h] : null])),
          trade: t ? { pnlPct: t.pnl_pct, pnlEur: t.pnl_eur, mfePct: t.mfe_pct, maePct: t.mae_pct } : null,
        };
      });
      return out;
    } catch (err) {
      this.#fail('overzicht maken', err);
      return this.#emptyStats();
    }
  }

  close() {
    try {
      this.db?.close();
    } catch (err) {
      this.#fail('sluiten', err);
    }
    this.db = null;
  }
}
