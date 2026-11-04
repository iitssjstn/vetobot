import { RISK_LIMITS, STRATEGY_LIMITS, TIMEFRAMES } from './settings.js';

// Instellingen die de AI in het dagoverzicht mag voorstellen. Bewust GEEN bedragen:
// inzet per trade, aantal open trades en de daglimiet bepaal je altijd zelf.
// Een voorstel wordt nooit vanzelf toegepast; je neemt het over op het dashboard.
export const SUGGESTABLE = {
  emaFast: { group: 'strategy', label: 'EMA fast', int: true, limits: STRATEGY_LIMITS.emaFast },
  emaSlow: { group: 'strategy', label: 'EMA slow', int: true, limits: STRATEGY_LIMITS.emaSlow },
  rsiPeriod: { group: 'strategy', label: 'RSI-periode', int: true, limits: STRATEGY_LIMITS.rsiPeriod },
  rsiMaxEntry: { group: 'strategy', label: 'Max RSI bij instap', limits: STRATEGY_LIMITS.rsiMaxEntry },
  trendEma: { group: 'strategy', label: 'Trend-EMA', int: true, limits: STRATEGY_LIMITS.trendEma },
  adxMin: { group: 'strategy', label: 'Minimale ADX', limits: STRATEGY_LIMITS.adxMin },
  volumeMult: { group: 'strategy', label: 'Volumefilter (×)', limits: STRATEGY_LIMITS.volumeMult },
  btcFilter: { group: 'strategy', label: 'BTC-filter (1 = aan)', int: true, limits: STRATEGY_LIMITS.btcFilter },
  trailingStopPct: { group: 'risk', label: 'Trailing stop (%)', limits: RISK_LIMITS.trailingStopPct },
  atrStopMult: { group: 'risk', label: 'ATR-stop (×)', limits: RISK_LIMITS.atrStopMult },
  stopLossPct: { group: 'risk', label: 'Stop-loss (%)', limits: RISK_LIMITS.stopLossPct },
  takeProfitPct: { group: 'risk', label: 'Take-profit (%)', limits: RISK_LIMITS.takeProfitPct },
  cooldownMinutes: { group: 'risk', label: 'Afkoelperiode (min)', int: true, limits: RISK_LIMITS.cooldownMinutes },
  timeframe: { group: 'schedule', label: 'Candle-tijd', options: TIMEFRAMES },
  checkIntervalMinutes: { group: 'schedule', label: 'Check elke (min)', int: true, limits: [1, 240] },
};

export function currentValues(bot) {
  return {
    ...bot.strategy,
    stopLossPct: bot.risk.stopLossPct,
    takeProfitPct: bot.risk.takeProfitPct,
    cooldownMinutes: bot.risk.cooldownMinutes,
    trailingStopPct: bot.risk.trailingStopPct ?? 0,
    atrStopMult: bot.risk.atrStopMult ?? 0,
    timeframe: bot.settings.timeframe,
    checkIntervalMinutes: bot.settings.checkIntervalMinutes,
  };
}

// Maakt van wat de AI teruggeeft een lijst geldige wijzigingen ten opzichte van nu.
// Onbekende velden, ongeldige waarden en "geen verandering" vallen weg.
export function cleanSuggestions(raw, current) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [key, spec] of Object.entries(SUGGESTABLE)) {
    if (!(key in raw)) continue;
    let to = raw[key];
    if (spec.options) {
      to = String(to);
      if (!spec.options.includes(to)) continue;
    } else {
      to = Number(to);
      if (!Number.isFinite(to)) continue;
      const [min, max] = spec.limits;
      if (to < min || to > max) continue;
      to = spec.int ? Math.round(to) : Math.round(to * 100) / 100;
    }
    if (to === current[key]) continue;
    out.push({ key, label: spec.label, group: spec.group, from: current[key], to });
  }
  // EMA fast moet kleiner blijven dan EMA slow, ook na het voorstel.
  const fast = out.find((s) => s.key === 'emaFast')?.to ?? current.emaFast;
  const slow = out.find((s) => s.key === 'emaSlow')?.to ?? current.emaSlow;
  if (fast >= slow) return out.filter((s) => s.key !== 'emaFast' && s.key !== 'emaSlow');
  return out;
}

// Past de gekozen voorstellen toe via de normale, gevalideerde routes van de bot.
export async function applySuggestions(bot, suggestions, keys) {
  const chosen = suggestions.filter((s) => keys.includes(s.key));
  if (!chosen.length) throw new Error('Kies minimaal één voorstel');
  const val = (k, fallback) => chosen.find((s) => s.key === k)?.to ?? fallback;
  const groups = new Set(chosen.map((s) => s.group));

  const pick = (group) => Object.fromEntries(chosen.filter((x) => x.group === group).map((x) => [x.key, x.to]));
  if (groups.has('strategy')) await bot.setStrategy({ ...bot.settings.strategy, ...pick('strategy') });
  if (groups.has('risk')) await bot.setRisk({ ...bot.settings.risk, ...pick('risk') });
  if (groups.has('schedule')) {
    await bot.setSchedule({
      timeframe: val('timeframe', bot.settings.timeframe),
      checkIntervalMinutes: val('checkIntervalMinutes', bot.settings.checkIntervalMinutes),
    });
  }
  return chosen;
}
