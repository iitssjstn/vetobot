import fs from 'node:fs';
import path from 'node:path';

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
};
export const LIVE_MIN_STAKE_EUR = 5;
export const STRATEGY_LIMITS = {
  emaFast: [2, 500],
  emaSlow: [3, 1000],
  rsiPeriod: [2, 200],
  rsiMaxEntry: [1, 100],
  trendEma: [0, 1000],
  adxMin: [0, 100],
  volumeMult: [0, 20],
  btcFilter: [0, 1],
};
export const AI_FAIL_MODES = ['reject', 'approve'];
const NOTIFY_DEFAULTS = {
  discordUserId: '',
  events: { startup: true, trades: true, stoploss: true, errors: true, dailyLimit: true, mode: true, aiVeto: false, dailySummary: true, aiFallback: true, aiFailed: true },
  mentions: { startup: true, trades: false, stoploss: true, errors: true, dailyLimit: true, mode: true, aiVeto: false, dailySummary: false, aiFallback: false, aiFailed: true },
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
  liveBudgetEur: 'Live budgetplafond',
  trailingStopPct: 'Trailing stop',
  atrStopMult: 'ATR-stop',
  trendEma: 'Trend-EMA',
  adxMin: 'Minimale ADX',
  volumeMult: 'Volumefilter',
  btcFilter: 'BTC-filter',
  feePct: 'Fee',
  emaFast: 'EMA fast',
  emaSlow: 'EMA slow',
  rsiPeriod: 'RSI-periode',
  rsiMaxEntry: 'Max RSI bij instap',
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
    this.data = {
      mode: saved.mode ?? (defaults.liveTrading ? 'live' : 'paper'),
      ai: {
        provider: saved.ai?.provider ?? defaults.ai.provider,
        model: saved.ai?.model ?? defaults.ai.model,
        baseUrl: saved.ai?.baseUrl ?? defaults.ai.baseUrl,
        failMode: saved.ai?.failMode ?? defaults.ai.failMode ?? 'reject',
        fallbacks: Array.isArray(saved.ai?.fallbacks) ? saved.ai.fallbacks : [],
      },
      strategy: Object.fromEntries(Object.keys(STRATEGY_LIMITS).map((k) => [k, saved.strategy?.[k] ?? defaults.strategy?.[k] ?? 0])),
      pairs: saved.pairs ?? defaults.pairs,
      timeframe: saved.timeframe ?? defaults.timeframe,
      checkIntervalMinutes: saved.checkIntervalMinutes ?? defaults.checkIntervalMinutes,
      risk: Object.fromEntries(Object.keys(RISK_LIMITS).map((k) => [k, saved.risk?.[k] ?? defaults.risk?.[k] ?? 0])),
      notify: {
        discordUserId: saved.notify?.discordUserId ?? NOTIFY_DEFAULTS.discordUserId,
        events: { ...NOTIFY_DEFAULTS.events, ...saved.notify?.events },
        mentions: { ...NOTIFY_DEFAULTS.mentions, ...saved.notify?.mentions },
        summaryTime: saved.notify?.summaryTime ?? NOTIFY_DEFAULTS.summaryTime,
      },
      summaryLastSent: saved.summaryLastSent ?? null,
      modeChangedAt: saved.modeChangedAt ?? null,
    };
  }

  get mode() {
    return this.data.mode;
  }

  get ai() {
    return this.data.ai;
  }

  get pairs() {
    return this.data.pairs;
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
    this.data.risk = validated({ ...this.data.risk, ...values }, RISK_LIMITS, ['maxOpenTrades', 'cooldownMinutes']);
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

  get strategy() {
    return this.data.strategy;
  }

  setStrategy(values) {
    const next = validated({ ...this.data.strategy, ...values }, STRATEGY_LIMITS, ['emaFast', 'emaSlow', 'rsiPeriod', 'trendEma', 'btcFilter']);
    if (next.emaFast >= next.emaSlow) throw new Error('EMA fast moet kleiner zijn dan EMA slow');
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

  setMode(mode) {
    if (!['paper', 'live'].includes(mode)) throw new Error(`Ongeldige modus "${mode}"`);
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
    if (unknown.length) throw new Error(`Onbekend op Bitvavo: ${unknown.join(', ')}`);
    this.data.pairs = unique;
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
