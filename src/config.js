// Instellingen komen uit environment variables (zie README).
// API-keys staan hier bewust NIET in: die vul je in via het dashboard (zie secrets.js).

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
  // Handelsmodus: paper is de standaard. Live vereist LIVE_TRADING=true én Bitvavo-keys in het dashboard.
  liveTrading: bool('LIVE_TRADING', false),

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
    // Filters (0 = uit)
    trendEma: num('TREND_EMA', 0),
    adxMin: num('ADX_MIN', 0),
    volumeMult: num('VOLUME_MULT', 0),
    btcFilter: num('BTC_FILTER', 0),
    // Niet kopen als de koers sinds het signaal al meer dan zoveel procent is gestegen (0 = uit).
    maxChasePct: num('MAX_CHASE_PCT', 1),
    // 1 = ook de candle die nog loopt meenemen: sneller, maar signalen kunnen weer verdwijnen.
    useOpenCandle: num('USE_OPEN_CANDLE', 0),
    // Tegen whipsaw: verkopen op het verkoopsignaal pas als EMA fast zoveel candles op rij
    // onder EMA slow ligt, en pas na zoveel candles in de positie. Stops werken altijd direct.
    sellConfirmCandles: num('SELL_CONFIRM_CANDLES', 2),
    minHoldCandles: num('MIN_HOLD_CANDLES', 3),
    // Hoe streng de AI keurt: 0 = streng, 1 = normaal, 2 = soepel.
    aiStrictness: num('AI_STRICTNESS', 1),
    // Zelflerend: proefstrategieën (nog niet bevestigd) in paper ook echt laten traden.
    mlTrialPaper: num('ML_TRIAL_PAPER', 1),
    // 1 = de AI-trader van de trainer beslist zelf wanneer kopen en verkopen.
    agentMode: num('AGENT_MODE', 0),
    // 1 = de AI-controleur (taalmodel) keurt ook aankopen van de AI-trader; 0 = de AI-trader beslist alleen.
    agentVeto: num('AGENT_VETO', 1),
  },

  // Harde limieten. De AI kan hier nooit aan komen.
  risk: {
    stakeEur: num('STAKE_EUR', 25),
    maxOpenTrades: num('MAX_OPEN_TRADES', 2),
    stopLossPct: num('STOP_LOSS_PCT', 3),
    takeProfitPct: num('TAKE_PROFIT_PCT', 6),
    maxDailyLossEur: num('MAX_DAILY_LOSS_EUR', 20),
    feePct: num('FEE_PCT', 0.25),
    // Na een verkoop deze coin zoveel minuten niet opnieuw kopen (0 = uit).
    cooldownMinutes: num('COOLDOWN_MINUTES', 30),
    // Paper: koop iets duurder en verkoop iets goedkoper dan de laatste koers, zoals live met spread.
    slippagePct: num('PAPER_SLIPPAGE_PCT', 0.1),
    // Orderboek-check bij het kopen: max verschil bied/laat en max kosten van je aankoop in het boek (0 = uit).
    maxSpreadPct: num('MAX_SPREAD_PCT', 0.5),
    maxBookCostPct: num('MAX_BOOK_COST_PCT', 0.3),
    // Live: nooit meer dan dit bedrag tegelijk in posities, ongeacht je saldo (0 = uit).
    liveBudgetEur: num('LIVE_BUDGET_EUR', 0),
    // Trailing stop: verkoop als de koers zoveel % onder het hoogste punt sinds aankoop zakt (0 = uit).
    trailingStopPct: num('TRAILING_STOP_PCT', 0),
    // ATR-stop: stop-loss op instapkoers − zoveel × ATR, in plaats van het vaste percentage (0 = uit).
    atrStopMult: num('ATR_STOP_MULT', 0),
    // Open posities elke zoveel seconden bewaken (stop-loss, take-profit, trailing), los van de check (0 = alleen bij de check).
    watchSeconds: num('WATCH_SECONDS', 15),
    // AI laten beslissen over winst nemen vanaf zoveel % winst (0 = uit), hooguit eens per zoveel minuten per positie.
    aiExitMinPct: num('AI_EXIT_MIN_PCT', 1),
    aiExitEveryMin: num('AI_EXIT_EVERY_MIN', 3),
    // Winst herinvesteren: zoveel % van de gerealiseerde winst gaat naar de inzet per trade (0 = uit).
    reinvestPct: num('REINVEST_PCT', 0),
    // Maximale inzet per trade als de inzet meegroeit met de winst (0 = geen maximum).
    maxStakeEur: num('MAX_STAKE_EUR', 0),
    // Limietorders voor kopen en winst nemen (maker-fee); stop-losses blijven market (0 = uit, 1 = aan).
    limitOrders: num('LIMIT_ORDERS', 0),
    // Hoe lang een limietorder mag wachten op een vulling, in seconden.
    limitWaitSec: num('LIMIT_WAIT_SEC', 20),
    makerFeePct: num('MAKER_FEE_PCT', 0.15),
    // Maximale tijd in een positie in minuten; daarna verkopen (0 = uit).
    maxHoldMinutes: num('MAX_HOLD_MINUTES', 0),
  },

  paper: {
    startBalanceEur: num('PAPER_START_BALANCE_EUR', 500),
  },

  ai: {
    // none | gemini | openai (OpenAI-compatibel: Groq, OpenRouter, Ollama, ...)
    provider: str('AI_PROVIDER', 'none'),
    model: str('AI_MODEL', ''),
    baseUrl: str('AI_BASE_URL', 'https://api.groq.com/openai/v1'),
    // Wat te doen als de AI niet reageert of onzin terugstuurt: reject (veilig) of approve.
    failMode: str('AI_FAIL_MODE', 'reject'),
    timeoutMs: num('AI_TIMEOUT_MS', 45000),
  },

  server: {
    port: num('PORT', 3000),
  },

  dataDir: str('DATA_DIR', './data'),
};

export function validateConfig() {
  const errors = [];
  if (!['none', 'gemini', 'openai'].includes(config.ai.provider)) {
    errors.push(`Onbekende AI_PROVIDER "${config.ai.provider}" (kies none, gemini of openai).`);
  }
  if (config.strategy.emaFast >= config.strategy.emaSlow) {
    errors.push('EMA_FAST moet kleiner zijn dan EMA_SLOW.');
  }
  if (config.pairs.length === 0) errors.push('PAIRS is leeg.');
  return errors;
}
