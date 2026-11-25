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

// Stopprijs van de noodstop van een positie, of null (geen stop).
// - eigen plan (AI-trader: de veiligheidsstop van het recept; zelflerende strategie: haar stop);
// - anders de ATR-stop als die aan staat en er bij de aankoop een ATR was, of de vaste stop-loss.
export function exchangeStopPrice(position, risk = {}) {
  const entry = Number(position?.entryPrice);
  if (!(entry > 0)) return null;
  if (position.plan) {
    const pct = Number(position.plan.stopLossPct);
    return pct > 0 && pct < 100 ? entry * (1 - pct / 100) : null;
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
  const row = { pair: position.pair, orderId: s?.orderId ?? null, stopPrice: s?.stopPrice ?? null, placedAt: s?.placedAt ?? null, status: 'geen', error: s?.error ?? s?.skipped ?? null };
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

// Vergelijkt de posities van de bot met het saldo op Bitvavo. Doet zelf niets; geeft de afwijkingen.
// positions: { pair: positie }, balance: ccxt-balans ({ total: { BTC: 0.1 }, BTC: { total } }),
// prices: { 'BTC/EUR': koers } (voor de waarde van coins zonder positie),
// openStops: Set met orderId's die nu openstaan bij Bitvavo (of null als onbekend),
// stopOn: exchange-stop staat aan. Geeft [{ pair, kind: 'mist'|'extra'|'stop-mist', botAmount, exchangeAmount, note }];
// bij 'mist' ook gone: true als de coin (vrijwel) helemaal weg is.
export function compareBalances({ positions = {}, balance = {}, prices = {}, markets = {}, precisionMode, openStops = null, stopOn = true, rules = SAFETY }) {
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
        note: ex <= tol ? 'De coin staat niet (meer) op Bitvavo: handmatig verkocht of de stop-order bij Bitvavo is uitgevoerd?'
          : 'Minder op Bitvavo dan de bot denkt te hebben' });
    } else if (ex > p.amount + tol) {
      const extraEur = prices[p.pair] > 0 ? (ex - p.amount) * prices[p.pair] : null;
      if (extraEur == null || extraEur > rules.extraMinEur) {
        issues.push({ pair: p.pair, kind: 'extra', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: `Meer op Bitvavo dan in de positie van de bot${extraEur != null ? ` (± € ${extraEur.toFixed(2).replace('.', ',')})` : ''}; misschien eigen coins. De bot doet er niets mee.` });
      }
    }
    if (stopOn) {
      const id = p.exchangeStop?.orderId;
      if (!id) {
        issues.push({ pair: p.pair, kind: 'stop-mist', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: p.exchangeStop?.error ? `Geen stop-order bij Bitvavo: plaatsen mislukte (${p.exchangeStop.error})`
            : p.exchangeStop?.skipped ? `Geen stop-order bij Bitvavo: ${p.exchangeStop.skipped}` : 'Geen stop-order bij Bitvavo voor deze positie' });
      } else if (openStops && !openStops.has(String(id))) {
        issues.push({ pair: p.pair, kind: 'stop-mist', botAmount: fmt(p.amount), exchangeAmount: fmt(ex),
          note: `Stop-order ${id} staat niet (meer) open bij Bitvavo` });
      }
    }
  }
  const all = new Set([...Object.keys(balance?.total ?? {}), ...Object.keys(balance ?? {}).filter((k) => balance[k] && typeof balance[k] === 'object' && 'total' in balance[k])]);
  for (const cur of all) {
    if (cur === 'EUR' || held.has(cur) || ['info', 'free', 'used', 'total', 'timestamp', 'datetime'].includes(cur)) continue;
    const amt = totalOf(cur);
    if (!(amt > 0)) continue;
    const price = prices[`${cur}/EUR`];
    if (!(price > 0)) continue; // geen koers in euro: geen waarde, niet melden
    const eur = amt * price;
    if (eur <= rules.extraMinEur) continue;
    issues.push({ pair: `${cur}/EUR`, kind: 'extra', botAmount: 0, exchangeAmount: fmt(amt),
      note: `${cur} op Bitvavo (± € ${eur.toFixed(2).replace('.', ',')}) zonder positie in de bot; misschien eigen coins. De bot doet er niets mee.` });
  }
  return issues;
}

// Sleutel van een afwijking, om alleen nieuwe afwijkingen te melden.
export const issueKey = (i) => `${i.pair}|${i.kind}`;
