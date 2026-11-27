import fs from 'node:fs';
import path from 'node:path';
import { PUMP_DEFAULTS } from './safety.js';
import { VENUES, venueOf, venueLabel, toVenuePair, liveAllowedOnVenue } from './venue.js';

// Instellingen die je in het dashboard wijzigt: handelsmodus en AI-provider.
// Opgeslagen in data/settings.json. Bij de eerste start komen de waarden uit
// de environment variables (LIVE_TRADING, AI_PROVIDER, ...), daarna uit dit bestand.

export const AI_PROVIDERS = ['none', 'gemini', 'openai'];
export const MAX_PAIRS = 100;
// Grenzen die alleen onzin tegenhouden (negatieve bedragen, typfouten met tien nullen).
// Binnen deze grenzen bepaal je alles zelf. 0 betekent "uit" bij stop-loss,
// take-profit en de dagelijkse verlieslimiet. Bitvavo hanteert een minimum order van € 5.
export const RISK_LIMITS = {
  // In paper vanaf € 0,10; live geldt het minimum van Bitvavo (LIVE_MIN_STAKE_EUR), dat controleert de bot.
  stakeEur: [0.1, 1000000],
  maxOpenTrades: [1, 100],
  stopLossPct: [0, 100],
  takeProfitPct: [0, 10000],
  maxDailyLossEur: [0, 100000000],
  feePct: [0, 5],
  cooldownMinutes: [0, 10080],
  slippagePct: [0, 5],
  liveBudgetEur: [0, 100000000],
  trailingStopPct: [0, 100],
  atrStopMult: [0, 20],
  watchSeconds: [0, 3600],
  aiExitMinPct: [0, 1000],
  aiExitEveryMin: [0, 1440],
  reinvestPct: [0, 100],
  maxStakeEur: [0, 1000000],
  limitOrders: [0, 2],
  limitWaitSec: [0, 300],
  makerFeePct: [0, 5],
  maxHoldMinutes: [0, 43200],
  maxSpreadPct: [0, 10],
  maxBookCostPct: [0, 10],
  // 1 = live na elke aankoop ook een stop-loss-order bij Bitvavo zelf zetten (op de noodstop).
  exchangeStop: [0, 1],
  // Uitschieter (AI-trader): vanaf zoveel % winst een meeschuivende winstgrens (0 = uit), hooguit zoveel %
  // van de winst teruggeven, en minstens zoveel % ruimte onder de top.
  pumpTriggerPct: [0, 50],
  pumpGivebackPct: [5, 90],
  pumpMinGapPct: [0.2, 10],
};
export const LIVE_MIN_STAKE_EUR = 5;
// Bybit-websites met eigen accounts en API-adres (api.<site>).
export const BYBIT_HOSTS = ['bybit.com', 'bybit.eu', 'bybit.nl'];
export const STRATEGY_LIMITS = {
  mlBandit: [0, 1],
  mlTrialPaper: [0, 1],
  agentMode: [0, 1],
  agentVeto: [0, 1],
  agentExplore: [0, 1],
  agentLiveSmallStart: [0, 1],
  agentSizing: [0, 1],
  agentVolGuard: [0, 1],
  // Eigen bijstelling van de koopdrempel van de AI-trader (%-punt; negatief = eerder kopen). Nooit onder 0%.
  agentThrAdjust: [-1, 1],
};
export const AI_FAIL_MODES = ['reject', 'approve'];
// Instellingen die aan staan als ze nergens zijn opgegeven.
const DEFAULT_ON = new Set(['agentLiveSmallStart', 'agentSizing', 'agentVolGuard', 'exchangeStop']);
const NOTIFY_DEFAULTS = {
  discordUserId: '',
  events: { startup: true, trades: true, stoploss: true, errors: true, dailyLimit: true, mode: true, aiVeto: false, dailySummary: true, aiFallback: true, aiFailed: true, strategy: true, health: true, learning: true },
  mentions: { startup: true, trades: false, stoploss: true, errors: true, dailyLimit: true, mode: true, aiVeto: false, dailySummary: false, aiFallback: false, aiFailed: true, strategy: true, health: true, learning: false },
  summaryTime: '08:00',
};
const RISK_LABELS = {
  stakeEur: 'Inzet per trade',
  maxOpenTrades: 'Maximaal open trades',
  stopLossPct: 'Stop-loss',
  takeProfitPct: 'Take-profit',
  maxDailyLossEur: 'Dagelijkse verlieslimiet',
  cooldownMinutes: 'Afkoelperiode',
  slippagePct: 'Slippage (paper)',
  maxSpreadPct: 'Max verschil bied/laat',
  maxBookCostPct: 'Max kosten in het orderboek',
  liveBudgetEur: 'Live budgetplafond',
  trailingStopPct: 'Trailing stop',
  atrStopMult: 'ATR-stop',
  watchSeconds: 'Posities bewaken elke',
  mlBandit: 'Zelflerend kiezen tussen strategieën',
  mlTrialPaper: 'Proefstrategieën in paper',
  agentMode: 'AI-trader',
  agentVeto: 'AI-controleur bij de AI-trader',
  agentExplore: 'Verkenner (alleen paper)',
  agentLiveSmallStart: 'Live beginnen met de kleinste inzet',
  agentSizing: 'AI-trader kiest zelf de inzet',
  agentVolGuard: 'Strategy Agent let op volatiliteit',
  agentThrAdjust: 'Koopdrempel bijstellen',
  exchangeStop: 'Stop-loss ook bij Bitvavo zetten (live)',
  aiExitMinPct: 'AI winst nemen vanaf',
  aiExitEveryMin: 'AI winstcheck elke',
  reinvestPct: 'Winst herinvesteren',
  maxStakeEur: 'Maximale inzet per trade',
  limitOrders: 'Limietorders',
  limitWaitSec: 'Wachttijd limietorder',
  makerFeePct: 'Maker-fee',
  maxHoldMinutes: 'Maximale tijd in positie',
  feePct: 'Fee',
  pumpTriggerPct: 'Uitschieter: winstgrens vanaf',
  pumpGivebackPct: 'Uitschieter: hooguit teruggeven',
  pumpMinGapPct: 'Uitschieter: minimale ruimte onder de top',
};

function validated(values, limits, integers) {
  const next = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    const n = Number(values?.[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${RISK_LABELS[key]} moet tussen ${min} en ${max} liggen`);
    next[key] = integers.includes(key) ? Math.round(n) : Math.round(n * 10000) / 10000;
  }
  return next;
}
export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d'];
export const TIMEFRAME_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 };

// "10 sec", "1,5 min", "15 min"
export const fmtInterval = (min) => {
  const sec = Math.round(min * 60);
  if (sec < 60) return `${sec} sec`;
  return `${String(Math.round((sec / 60) * 100) / 100).replace('.', ',')} min`;
};

export class Settings {
  constructor(dataDir, defaults) {
    this.file = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    // Beurs: Bitvavo, tenzij de gebruiker zelf Bybit koos (oude settings.json zonder dit veld: Bitvavo).
    const exchange = venueOf(saved.exchange);
    // Live alleen op een beurs waar live mag (Bybit: alleen met een eigen-risico-akkoord), ook als het bestand iets
    // anders zegt. Een akkoord dat door de verliesgrens gestopt is houdt live aan (afbouwen: open live posities
    // blijven bewaakt; de bot gaat zelf naar paper zodra ze dicht zijn), maar zonder nieuwe aankopen.
    const wantMode = saved.mode ?? (defaults.liveTrading ? 'live' : 'paper');
    const liveOk = liveAllowedOnVenue(exchange, { venueLive: saved.venueLive });
    this.data = {
      mode: wantMode === 'live' && !liveOk.ok && !liveOk.stopped ? 'paper' : wantMode,
      ai: {
        provider: saved.ai?.provider ?? defaults.ai.provider,
        model: saved.ai?.model ?? defaults.ai.model,
        baseUrl: saved.ai?.baseUrl ?? defaults.ai.baseUrl,
        failMode: saved.ai?.failMode ?? defaults.ai.failMode ?? 'reject',
        fallbacks: Array.isArray(saved.ai?.fallbacks) ? saved.ai.fallbacks : [],
      },
      // Ontbreekt een instelling, dan 0 (uit); alleen de kleinste live-start, de eigen inzet van de AI-trader (die
      // alleen werkt als je een maximale inzet instelt) en de volatiliteitscheck staan standaard aan.
      strategy: Object.fromEntries(Object.keys(STRATEGY_LIMITS).map((k) => [k, saved.strategy?.[k] ?? defaults.strategy?.[k] ?? (DEFAULT_ON.has(k) ? 1 : 0)])),
      pairs: saved.pairs ?? defaults.pairs,
      timeframe: saved.timeframe ?? defaults.timeframe,
      checkIntervalMinutes: saved.checkIntervalMinutes ?? defaults.checkIntervalMinutes,
      // De stop-loss bij Bitvavo (live) staat standaard aan.
      // De uitschieter-instellingen hebben eigen standaardwaarden (ook voor een oud settings.json zonder deze velden).
      risk: Object.fromEntries(Object.keys(RISK_LIMITS).map((k) => [k, saved.risk?.[k] ?? defaults.risk?.[k] ?? PUMP_DEFAULTS[k] ?? (DEFAULT_ON.has(k) ? 1 : 0)])),
      notify: {
        discordUserId: saved.notify?.discordUserId ?? NOTIFY_DEFAULTS.discordUserId,
        events: { ...NOTIFY_DEFAULTS.events, ...saved.notify?.events },
        mentions: { ...NOTIFY_DEFAULTS.mentions, ...saved.notify?.mentions },
        summaryTime: saved.notify?.summaryTime ?? NOTIFY_DEFAULTS.summaryTime,
      },
      summaryLastSent: saved.summaryLastSent ?? null,
      // "Leert hij echt?": laatst verzonden weekoverzicht (ISO-week) en de toestand per controle (meldingen).
      learnCheck: { weekSent: saved.learnCheck?.weekSent ?? null, alerts: saved.learnCheck?.alerts && typeof saved.learnCheck.alerts === 'object' ? saved.learnCheck.alerts : {} },
      modeChangedAt: saved.modeChangedAt ?? null,
      follow: { enabled: Boolean(saved.follow?.enabled), since: saved.follow?.since ?? null },
    };
    // Alleen opslaan als het bestand ze al had, zodat een Bitvavo-settings.json er precies hetzelfde uit blijft zien.
    if (saved.exchange !== undefined) this.data.exchange = exchange;
    if (saved.venuePairs && typeof saved.venuePairs === 'object') this.data.venuePairs = saved.venuePairs;
    if (BYBIT_HOSTS.includes(saved.bybitHost)) this.data.bybitHost = saved.bybitHost;
    if (saved.venueLive && typeof saved.venueLive === 'object') this.data.venueLive = saved.venueLive;
  }

  // ---------- Live op eigen risico per beurs (Bybit) ----------
  // { bybit: { maxLossEur, at, stoppedAt?, stopReason? } }. Zie liveAllowedOnVenue in venue.js.
  get venueLive() {
    return this.data.venueLive ?? {};
  }

  // Akkoord geven (maxLossEur) of intrekken (null). Een nieuw akkoord begint opnieuw te tellen vanaf nu.
  setVenueLive(venue, maxLossEur) {
    const v = venueOf(venue);
    const next = { ...this.venueLive };
    if (maxLossEur == null) delete next[v];
    else {
      const n = Number(maxLossEur);
      if (!Number.isFinite(n) || n < 1 || n > 100000000) throw new Error('Verliesgrens moet tussen € 1 en € 100.000.000 liggen');
      next[v] = { maxLossEur: Math.round(n * 100) / 100, at: new Date().toISOString() };
    }
    if (Object.keys(next).length) this.data.venueLive = next;
    else delete this.data.venueLive;
    this.#save();
  }

  // Verliesgrens bereikt: het akkoord is beëindigd (geen nieuwe aankopen), maar blijft bewaard tot de laatste
  // live positie dicht is, zodat een herstart de open posities niet in de steek laat.
  stopVenueLive(venue, reason) {
    const v = venueOf(venue);
    const cur = this.venueLive[v];
    if (!cur || cur.stoppedAt) return;
    this.data.venueLive = { ...this.venueLive, [v]: { ...cur, stoppedAt: new Date().toISOString(), stopReason: String(reason ?? '').slice(0, 300) } };
    this.#save();
  }

  // ---------- Beurs ----------
  // Welke Bybit-website: elke site heeft eigen accounts en API-keys (bybit.com, Bybit EU, Bybit NL).
  get bybitHost() {
    const h = this.data.bybitHost ?? process.env.BYBIT_HOSTNAME;
    return BYBIT_HOSTS.includes(h) ? h : 'bybit.com';
  }

  setBybitHost(host) {
    if (!BYBIT_HOSTS.includes(host)) throw new Error(`Onbekende Bybit-website "${host}"; kies ${BYBIT_HOSTS.join(', ')}`);
    this.data.bybitHost = host;
    this.#save();
  }

  get exchange() {
    return venueOf(this.data.exchange);
  }

  // Coins voor een beurs. Bitvavo: de gewone lijst (pairs). Andere beurs: een eigen lijst; nog niet gekozen,
  // dan de Bitvavo-lijst vertaald (SOL/EUR → SOL/USDT).
  pairsFor(venue) {
    const v = venueOf(venue);
    if (v === 'bitvavo') return this.data.pairs;
    const own = this.data.venuePairs?.[v];
    return Array.isArray(own) && own.length ? own : this.data.pairs.map((p) => toVenuePair(p, v));
  }

  // Wisselt van beurs. Fees: stond de fee nog op de standaard van de oude beurs, dan de standaard van de
  // nieuwe beurs (bijv. Bybit 0,1%); had je zelf iets ingesteld, dan blijft dat staan. Geeft een korte uitleg terug.
  setExchange(venue) {
    const next = venueOf(venue);
    if (venue !== next && venue !== undefined) throw new Error(`Onbekende beurs "${venue}"`);
    const prev = this.exchange;
    if (next === prev) return null;
    if (this.data.mode === 'live' && !liveAllowedOnVenue(next, this).ok) throw new Error(liveAllowedOnVenue(next, this).reason);
    const oldF = VENUES[prev].fees;
    const newF = VENUES[next].fees;
    const r = this.data.risk;
    const pctText = (n) => `${String(n).replace('.', ',')}%`;
    let notice;
    if (Number(r.feePct) === oldF.feePct && Number(r.makerFeePct) === oldF.makerFeePct) {
      this.data.risk = { ...r, feePct: newF.feePct, makerFeePct: newF.makerFeePct };
      notice = `Fee aangepast naar de standaard van ${venueLabel(next)}: ${pctText(newF.feePct)} (taker) en ${pctText(newF.makerFeePct)} (maker). Aan te passen bij Risico.`;
    } else {
      notice = `Je eigen fee (${pctText(r.feePct)} taker, ${pctText(r.makerFeePct)} maker) blijft staan; ${venueLabel(next)} rekent standaard ${pctText(newF.feePct)} taker en ${pctText(newF.makerFeePct)} maker.`;
    }
    this.data.exchange = next;
    this.data.exchangeChangedAt = new Date().toISOString();
    this.#save();
    return notice;
  }

  get mode() {
    return this.data.mode;
  }

  get ai() {
    return this.data.ai;
  }

  // Coins van de huidige beurs (Bitvavo: precies de opgeslagen lijst).
  get pairs() {
    return this.pairsFor(this.exchange);
  }

  get timeframe() {
    return this.data.timeframe;
  }

  get checkIntervalMinutes() {
    return this.data.checkIntervalMinutes;
  }

  get risk() {
    return this.data.risk;
  }

  setRisk(values) {
    // Velden die ontbreken houden hun huidige waarde.
    this.data.risk = validated({ ...this.data.risk, ...values }, RISK_LIMITS, ['maxOpenTrades', 'cooldownMinutes', 'watchSeconds', 'limitOrders', 'limitWaitSec', 'exchangeStop']);
    this.#save();
  }

  get notify() {
    return this.data.notify;
  }

  setNotify({ discordUserId, events, mentions, summaryTime }) {
    const id = String(discordUserId ?? this.data.notify.discordUserId ?? '').trim();
    if (id && !/^\d{15,22}$/.test(id)) throw new Error('Een Discord user ID bestaat uit 15 tot 22 cijfers');
    const pick = (src, def) => Object.fromEntries(Object.keys(def).map((k) => [k, Boolean(src?.[k])]));
    const time = String(summaryTime ?? this.data.notify.summaryTime).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Tijd voor het dagoverzicht moet de vorm UU:MM hebben, bijv. 08:00');
    this.data.notify = {
      summaryTime: time,
      discordUserId: id,
      // Ontbreekt een lijst in het verzoek, dan blijven de huidige keuzes staan.
      events: pick(events ?? this.data.notify.events, NOTIFY_DEFAULTS.events),
      mentions: pick(mentions ?? this.data.notify.mentions, NOTIFY_DEFAULTS.mentions),
    };
    this.#save();
  }

  // Datum (JJJJ-MM-DD, lokale tijd) waarop het laatste dagoverzicht is verstuurd.
  markSummarySent(date) {
    this.data.summaryLastSent = date;
    this.#save();
  }

  get learnCheck() {
    return this.data.learnCheck;
  }

  // Toestand van "Leert hij echt?" bewaren (weekSent en/of alerts), zodat een herstart niet dubbel meldt.
  setLearnCheck(patch) {
    this.data.learnCheck = { ...this.data.learnCheck, ...patch };
    this.#save();
  }

  get strategy() {
    return this.data.strategy;
  }

  setStrategy(values) {
    const next = validated({ ...this.data.strategy, ...values }, STRATEGY_LIMITS, ['mlBandit', 'mlTrialPaper', 'agentMode', 'agentVeto', 'agentExplore', 'agentLiveSmallStart', 'agentSizing', 'agentVolGuard']);
    this.data.strategy = next;
    this.#save();
  }

  setSchedule({ timeframe, checkIntervalMinutes }) {
    if (!TIMEFRAMES.includes(timeframe)) throw new Error(`Ongeldige candle-tijd "${timeframe}"`);
    // In minuten, maar ook delen van een minuut (minimaal 10 seconden), afgerond op hele seconden.
    const sec = Math.round(Number(checkIntervalMinutes) * 60);
    if (!Number.isFinite(sec) || sec < 10 || sec > 240 * 60) throw new Error('Check-interval moet tussen 10 seconden en 240 minuten liggen');
    this.data.timeframe = timeframe;
    this.data.checkIntervalMinutes = sec / 60;
    this.#save();
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get follow() {
    return this.data.follow;
  }

  // Recepten van de AI-trader die de eigenaar zelf live heeft toegestaan (nadat alle eisen gehaald waren).
  get agentLive() {
    return { approved: [], risky: {}, ...(this.data.agentLive ?? {}) };
  }

  // Live op eigen risico: een recept dat niet alle eisen haalt toch live, met je eigen inzet en een
  // verliesgrens in euro die jij kiest. Haalt hij die grens, dan stopt de bot hem vanzelf.
  setAgentLiveRisky(recipe, maxLossEur) {
    const key = String(recipe ?? '');
    if (!key) throw new Error('Geen recept opgegeven');
    const cur = this.agentLive;
    const risky = { ...cur.risky };
    if (maxLossEur == null) delete risky[key];
    else {
      const n = Number(maxLossEur);
      if (!Number.isFinite(n) || n < 1 || n > 100000000) throw new Error('Verliesgrens moet tussen € 1 en € 100.000.000 liggen');
      risky[key] = { maxLossEur: Math.round(n * 100) / 100, at: new Date().toISOString() };
    }
    this.data.agentLive = { ...cur, risky, changedAt: new Date().toISOString() };
    this.#save();
  }

  setAgentLive(recipe, allowed) {
    const key = String(recipe ?? '');
    if (!key) throw new Error('Geen recept opgegeven');
    const cur = new Set(this.agentLive.approved);
    if (allowed) cur.add(key);
    else cur.delete(key);
    this.data.agentLive = { ...this.agentLive, approved: [...cur], changedAt: new Date().toISOString() };
    this.#save();
  }

  setFollow(enabled) {
    this.data.follow = { enabled: Boolean(enabled), since: enabled ? new Date().toISOString() : null };
    this.#save();
  }

  setMode(mode) {
    if (!['paper', 'live'].includes(mode)) throw new Error(`Ongeldige modus "${mode}"`);
    if (mode === 'live' && !liveAllowedOnVenue(this.exchange, this).ok) throw new Error(liveAllowedOnVenue(this.exchange, this).reason);
    // Terug naar paper: een eigen-risico-akkoord voor deze beurs vervalt (opnieuw live = nieuw akkoord).
    if (mode === 'paper' && this.data.venueLive?.[this.exchange]) {
      const next = { ...this.data.venueLive };
      delete next[this.exchange];
      if (Object.keys(next).length) this.data.venueLive = next;
      else delete this.data.venueLive;
    }
    this.data.mode = mode;
    this.data.modeChangedAt = new Date().toISOString();
    this.#save();
  }

  // validPairs: de markten die Bitvavo echt aanbiedt, zodat er geen typfouten in komen.
  setPairs(pairs, validPairs) {
    if (!Array.isArray(pairs)) throw new Error('pairs moet een lijst zijn');
    const unique = [...new Set(pairs.map((p) => String(p).trim().toUpperCase()))].filter(Boolean);
    if (!unique.length) throw new Error('Kies minimaal één coin');
    if (unique.length > MAX_PAIRS) throw new Error(`Maximaal ${MAX_PAIRS} coins tegelijk`);
    const unknown = unique.filter((p) => !validPairs.has(p));
    if (unknown.length) throw new Error(`Onbekend op ${venueLabel(this.exchange)}: ${unknown.join(', ')}`);
    if (this.exchange === 'bitvavo') this.data.pairs = unique;
    else this.data.venuePairs = { ...this.data.venuePairs, [this.exchange]: unique };
    this.#save();
  }

  // fallbacks: maximaal 4 back-upmodellen, op volgorde. Ontbreekt de lijst, dan blijft hij gelijk.
  setAi({ provider, model, baseUrl, failMode, fallbacks }) {
    const entry = (e, n) => {
      if (!['gemini', 'openai'].includes(e?.provider)) throw new Error(`Model ${n}: kies Gemini of OpenAI-compatibel`);
      const url = String(e.baseUrl ?? '').trim();
      if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error(`Model ${n}: base-URL moet met http:// of https:// beginnen`);
      return { provider: e.provider, model: String(e.model ?? '').trim().slice(0, 100), baseUrl: url || 'https://api.groq.com/openai/v1' };
    };
    if (!AI_PROVIDERS.includes(provider)) throw new Error(`Onbekende AI-provider "${provider}"`);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Base-URL moet met http:// of https:// beginnen');
    const list = fallbacks === undefined ? this.data.ai.fallbacks ?? [] : fallbacks;
    if (!Array.isArray(list) || list.length > 4) throw new Error('Maximaal 4 back-upmodellen');
    this.data.ai = {
      provider,
      model: String(model ?? '').trim().slice(0, 100),
      baseUrl: String(baseUrl ?? '').trim() || 'https://api.groq.com/openai/v1',
      failMode: AI_FAIL_MODES.includes(failMode) ? failMode : 'reject',
      fallbacks: list.map((e, i) => entry(e, i + 2)),
    };
    this.#save();
  }
}
