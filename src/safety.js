// Veiligheid bij live handelen, los van de strategie:
// - een stop-loss bij Bitvavo zelf (exchange-stop), zodat een positie ook beschermd is als de bot
//   offline is of vastloopt;
// - een saldocontrole (reconciliation): klopt wat de bot denkt te hebben met wat er echt op Bitvavo staat?
// Hier staan de losse rekenregels (te testen zonder bot); de bot doet de orders en de meldingen.
// Live-veiligheid gaat voor alles: bij twijfel niets doen en melden.

export const SAFETY = {
  retryMs: 10 * 60000,        // plaatsen mislukt: hooguit elke zoveel ms een nieuwe poging
  checkMs: 60000,             // per positie hooguit zo vaak bij Bitvavo kijken of de stop is uitgevoerd
  reconcileMs: 24 * 3600000,  // saldocontrole elke 24 uur
  tolPct: 1,                  // afwijking in hoeveelheid die door afronding en fees mag
  extraMinEur: 1,             // coins zonder positie pas melden boven deze waarde
  filledShare: 0.99,          // zoveel van de positie uitgevoerd = de stop heeft de positie gesloten
};

// Uitschieter (winstgrens), alleen voor posities van de AI-trader (niet de verkenner): staat de top
// minstens pumpTriggerPct boven de instapprijs, dan gaat een meeschuivende winstgrens aan die nooit omlaag
// gaat: niveau = min(instap × (1 + (1 − teruggeven) × topwinst), top × (1 − minimale ruimte)).
// Live schuift de stop bij Bitvavo mee, hooguit eens per stopEveryMs en pas vanaf stopStepPct hoger.
export const PUMP = { stopStepPct: 0.3, stopEveryMs: 60000 };
export const PUMP_DEFAULTS = { pumpTriggerPct: 3, pumpGivebackPct: 30, pumpMinGapPct: 1 };

export const pumpApplies = (position) => Boolean(position?.agent) && !position.explore && !position.agent?.explore;

const pumpSetting = (risk, key) => {
  const v = Number(risk?.[key]);
  return Number.isFinite(v) ? v : PUMP_DEFAULTS[key];
};

// Niveau van de winstgrens bij deze instap en top (zonder het eerdere niveau), of null.
export function pumpRawLevel(entry, top, risk = {}) {
  const give = Math.min(90, Math.max(5, pumpSetting(risk, 'pumpGivebackPct')));
  const gap = Math.min(10, Math.max(0.2, pumpSetting(risk, 'pumpMinGapPct')));
  if (!(entry > 0) || !(top > 0)) return null;
  const gain = top / entry - 1;
  return Math.min(entry * (1 + (1 - give / 100) * gain), top * (1 - gap / 100));
}

// Winstgrens van een positie nu (rekening houdend met het eerdere niveau: nooit omlaag), of null als hij
// (nog) niet aan staat of uit staat (pumpTriggerPct 0). Verandert de positie niet.
export function pumpLevel(position, risk = {}) {
  if (!pumpApplies(position)) return null;
  const trigger = pumpSetting(risk, 'pumpTriggerPct');
  if (!(trigger > 0)) return null;
  const entry = Number(position.entryPrice);
  const top = Math.max(Number(position.highest) || 0, entry);
  if (!(entry > 0)) return null;
  if (!position.pump && (top / entry - 1) * 100 < trigger) return null;
  const lvl = pumpRawLevel(entry, top, risk);
  return Math.max(lvl ?? 0, Number(position.pump?.level) || 0) || null;
}

// Stopprijs van de noodstop van een positie, of null (geen stop).
// - eigen plan (AI-trader: de veiligheidsstop van het recept; zelflerende strategie: haar stop);
// - anders de ATR-stop als die aan staat en er bij de aankoop een ATR was, of de vaste stop-loss.
// Staat de winstgrens (uitschieter) aan, dan het hoogste van de noodstop en de winstgrens.
export function exchangeStopPrice(position, risk = {}) {
  const base = emergencyStopPrice(position, risk);
  const pump = pumpLevel(position, risk);
  return pump && pump > (base ?? 0) ? pump : base;
}

// Stop-loss (%) van een positie met een plan. AI-trader (niet de verkenner): met "Mijn stop-loss ook voor de
// AI-trader" aan geldt de strakste van de noodstop van het recept en jouw eigen stop-loss.
export function planStopPct(position, risk = {}) {
  let pct = Number(position?.plan?.stopLossPct);
  pct = pct > 0 && pct < 100 ? pct : null;
  const own = Number(risk.stopLossPct);
  if (position?.agent && !position.agent.explore && Number(risk.agentOwnStop ?? 1) !== 0 && own > 0 && own < 100) {
    pct = pct == null ? own : Math.min(pct, own);
  }
  return pct;
}

function emergencyStopPrice(position, risk = {}) {
  const entry = Number(position?.entryPrice);
  if (!(entry > 0)) return null;
  if (position.plan) {
    const pct = planStopPct(position, risk);
    return pct ? entry * (1 - pct / 100) : null;
  }
  if (Number(risk.atrStopMult) > 0 && Number(position.atrAtEntry) > 0) {
    const p = entry - risk.atrStopMult * position.atrAtEntry;
    return p > 0 ? p : null;
  }
  const pct = Number(risk.stopLossPct);
  return pct > 0 && pct < 100 ? entry * (1 - pct / 100) : null;
}

// Status van de exchange-stop van één positie voor het dashboard.
export function stopStatus(position, { live, enabled }) {
  const s = position?.exchangeStop ?? null;
  const row = { pair: position.pair, orderId: s?.orderId ?? null, stopPrice: s?.stopPrice ?? null, placedAt: s?.placedAt ?? null, status: 'geen', error: s?.error ?? s?.skipped ?? null,
    ...(position?.pump ? { pump: { level: position.pump.level ?? null, topPct: position.pump.topPct ?? null, levelPct: position.pump.levelPct ?? null } } : {}) };
  if (!live) return { ...row, status: 'n.v.t.', error: null };
  if (s?.orderId) return { ...row, status: 'actief' };
  if (s?.error) return { ...row, status: 'mislukt' };
  if (!enabled && !s) return { ...row, error: 'staat uit' };
  return row;
}

// Kleinste eenheid van een hoeveelheid voor deze markt (ccxt: TICK_SIZE = stapgrootte, anders decimalen).
export function amountUnit(market, precisionMode) {
  const p = Number(market?.precision?.amount);
  if (!(p > 0)) return 0;
  // ccxt: DECIMAL_PLACES = 2, SIGNIFICANT_DIGITS = 3, TICK_SIZE = 4. Bitvavo gebruikt TICK_SIZE.
  if (precisionMode === 2 || (precisionMode !== 4 && Number.isInteger(p) && p >= 1)) return 10 ** -p;
  return p;
}

const tolerance = (amount, unit, rules) => Math.max(Math.abs(amount) * rules.tolPct / 100, unit || 0);

// Vergelijkt de posities van de bot met het saldo op ${label}. Doet zelf niets; geeft de afwijkingen.
// positions: { pair: positie }, balance: ccxt-balans ({ total: { BTC: 0.1 }, BTC: { total } }),
// prices: { 'BTC/EUR': koers } (voor de waarde van coins zonder positie),
// openStops: Set met orderId's die nu openstaan bij ${label} (of null als onbekend),
// stopOn: exchange-stop staat aan. quote/label/eurRate: munt en naam van de beurs en euro per quote-munt
// (Bitvavo: EUR, 'Bitvavo', 1, de standaard; Bybit: USDT, 'Bybit', USDT/EUR-koers). prices zijn in de quote-munt. Geeft [{ pair, kind: 'mist'|'extra'|'stop-mist', botAmount, exchangeAmount, note }];
// bij 'mist' ook gone: true als de coin (vrijwel) helemaal weg is.
export function compareBalances({ positions = {}, balance = {}, prices = {}, markets = {}, precisionMode, openStops = null, stopOn = true, rules = SAFETY, quote = 'EUR', label = 'Bitvavo', eurRate = 1 }) {
  const issues = [];
  const totalOf = (cur) => {
    const v = balance?.total?.[cur] ?? balance?.[cur]?.total;
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  };
  const fmt = (n) => +Number(n).toPrecision(8);
  const held = new Set();
  for (const p of Object.values(positions)) {
    if (!p?.pair) continue;
    const base = p.pair.split('/')[0];
    held.add(base);
    const ex = totalOf(base);
    const tol = tolerance(p.amount, amountUnit(markets[p.pair], precisionMode), rules);
    if (ex < p.amount - tol) {
      issues.push({ pair: p.pair, kind: 'mist', botAmount: fmt(p.amount), exchangeAmount: fmt(ex), gone: ex <= tol,
        note: ex <= tol ? `De coin staat niet (meer) op ${label}: handmatig verkocht of de stop-order bij ${label} is uitgevoerd?`
          : `Minder op ${label} dan de bot denkt te hebben` });
    } else if (ex > p.amount + tol) {
      const extraEur = prices[p.pair] > 0 && eurRate > 0 ? (ex - p.amount) * prices[p.pair] * eurRate : null;
      if (extraEur == null || extraEur > rules.extraMinEur) {
        issues.push({ pair: p.pair, kind: 'extra', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: `Meer op ${label} dan in de positie van de bot${extraEur != null ? ` (± € ${extraEur.toFixed(2).replace('.', ',')})` : ''}; misschien eigen coins. De bot doet er niets mee.` });
      }
    }
    if (stopOn) {
      const id = p.exchangeStop?.orderId;
      if (!id) {
        issues.push({ pair: p.pair, kind: 'stop-mist', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: p.exchangeStop?.error ? `Geen stop-order bij ${label}: plaatsen mislukte (${p.exchangeStop.error})`
            : p.exchangeStop?.skipped ? `Geen stop-order bij ${label}: ${p.exchangeStop.skipped}` : `Geen stop-order bij ${label} voor deze positie` });
      } else if (openStops && !openStops.has(String(id))) {
        issues.push({ pair: p.pair, kind: 'stop-mist', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: `Stop-order ${id} staat niet (meer) open bij ${label}` });
      }
    }
  }
  const all = new Set([...Object.keys(balance?.total ?? {}), ...Object.keys(balance ?? {}).filter((k) => balance[k] && typeof balance[k] === 'object' && 'total' in balance[k])]);
  for (const cur of all) {
    if (cur === 'EUR' || cur === quote || held.has(cur) || ['info', 'free', 'used', 'total', 'timestamp', 'datetime'].includes(cur)) continue;
    const amt = totalOf(cur);
    if (!(amt > 0)) continue;
    const price = prices[`${cur}/${quote}`];
    if (!(price > 0)) continue; // geen koers in euro: geen waarde, niet melden
    const eur = amt * price * (eurRate > 0 ? eurRate : 0);
    if (eur <= rules.extraMinEur) continue;
    issues.push({ pair: `${cur}/${quote}`, kind: 'extra', botAmount: 0, exchangeAmount: fmt(amt),
      note: `${cur} op ${label} (± € ${eur.toFixed(2).replace('.', ',')}) zonder positie in de bot; misschien eigen coins. De bot doet er niets mee.` });
  }
  return issues;
}

// Sleutel van een afwijking, om alleen nieuwe afwijkingen te melden.
export const issueKey = (i) => `${i.pair}|${i.kind}`;
