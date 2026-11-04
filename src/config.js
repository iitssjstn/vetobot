// Alle instellingen komen uit environment variables (zie .env.example).

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} moet een getal zijn, kreeg "${v}"`);
  return n;
};
const str = (name, def) => (process.env[name] ?? '') || def;
const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'ja'].includes(v.toLowerCase());
};

export const config = {
  // Handelsmodus: paper is de standaard. Live vereist LIVE_TRADING=true én API-keys.
  liveTrading: bool('LIVE_TRADING', false),

  exchange: {
    id: 'bitvavo',
    apiKey: str('BITVAVO_API_KEY', ''),
    secret: str('BITVAVO_API_SECRET', ''),
  },

  pairs: str('PAIRS', 'BTC/EUR,ETH/EUR')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  timeframe: str('TIMEFRAME', '1h'),
  checkIntervalMinutes: num('CHECK_INTERVAL_MINUTES', 15),

  strategy: {
    emaFast: num('EMA_FAST', 12),
    emaSlow: num('EMA_SLOW', 26),
    rsiPeriod: num('RSI_PERIOD', 14),
    rsiMaxEntry: num('RSI_MAX_ENTRY', 70),
  },

  // Harde limieten. De AI kan hier nooit aan komen.
  risk: {
    stakeEur: num('STAKE_EUR', 25),
    maxOpenTrades: num('MAX_OPEN_TRADES', 2),
    stopLossPct: num('STOP_LOSS_PCT', 3),
    takeProfitPct: num('TAKE_PROFIT_PCT', 6),
    maxDailyLossEur: num('MAX_DAILY_LOSS_EUR', 20),
    feePct: num('FEE_PCT', 0.25),
  },

  paper: {
    startBalanceEur: num('PAPER_START_BALANCE_EUR', 500),
  },

  ai: {
    // none | gemini | openai (OpenAI-compatibel: Groq, OpenRouter, Ollama, ...)
    provider: str('AI_PROVIDER', 'none'),
    model: str('AI_MODEL', ''),
    apiKey: str('AI_API_KEY', ''),
    baseUrl: str('AI_BASE_URL', 'https://api.groq.com/openai/v1'),
    // Wat te doen als de AI niet reageert of onzin terugstuurt: reject (veilig) of approve.
    failMode: str('AI_FAIL_MODE', 'reject'),
    timeoutMs: num('AI_TIMEOUT_MS', 20000),
  },

  server: {
    port: num('PORT', 3000),
    password: str('DASHBOARD_PASSWORD', ''),
  },

  dataDir: str('DATA_DIR', './data'),
};

export function validateConfig() {
  const errors = [];
  if (config.liveTrading && (!config.exchange.apiKey || !config.exchange.secret)) {
    errors.push('LIVE_TRADING=true maar BITVAVO_API_KEY of BITVAVO_API_SECRET ontbreekt.');
  }
  if (!['none', 'gemini', 'openai'].includes(config.ai.provider)) {
    errors.push(`Onbekende AI_PROVIDER "${config.ai.provider}" (kies none, gemini of openai).`);
  }
  if (config.ai.provider !== 'none' && !config.ai.apiKey) {
    errors.push('AI_PROVIDER is ingesteld maar AI_API_KEY ontbreekt.');
  }
  if (config.strategy.emaFast >= config.strategy.emaSlow) {
    errors.push('EMA_FAST moet kleiner zijn dan EMA_SLOW.');
  }
  if (config.pairs.length === 0) errors.push('PAIRS is leeg.');
  return errors;
}
