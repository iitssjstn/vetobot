// Het team achter de AI-trader. Het leren gebeurt op de leerserver (Learning Agent); hier zit wat
// de bot zelf beslist, als losse functies zodat het te testen is:
// - Market Agent: in welke marktfase zit een coin (stijgend, zijwaarts, dalend), op 1h-candles;
// - Strategy Agent: welk recept past bij die fase (de keuze komt van de leerserver, in agent.json);
// - Risk Agent: is deze trade verantwoord, en met welke inzet;
// - Execution Agent: hoe goed werd een order uitgevoerd (prijs t.o.v. verwacht).

export const MARKET_TF = '1h';

// ---------- Strategy Agent ----------
// Alle AI-traders die de bot kan gebruiken: het hoofdrecept en de recepten per marktfase.
export function agentParts(main) {
  if (!main) return [];
  const subs = Object.values(main.regimes ?? {}).map((p) => p?.agent).filter(Boolean);
  return [main, ...subs];
}

// De AI-trader van een recept (voor het verkopen: dezelfde die kocht).
export function agentForRecipe(main, key) {
  if (!main) return null;
  if (!key) return main;
  return agentParts(main).find((a) => a.recipeKey === key) ?? main;
}

// Alle coins die de AI-trader(s) willen handelen.
export function allAgentCoins(main) {
  return [...new Set(agentParts(main).flatMap((a) => a.coins ?? []))];
}

// Welke AI-trader in deze marktfase? Geeft { agent, why, edge, trades }; agent null = niet handelen.
// Zonder plan of zonder bekende fase: het hoofdrecept.
export function chooseForRegime(main, regime) {
  const p = regime ? main?.regimes?.[regime] : null;
  if (!p) return { agent: main, why: regime ? 'geen plan' : 'fase onbekend', edge: null, trades: 0 };
  if (!p.key) return { agent: main, why: 'pauze', edge: p.edge ?? null, trades: p.trades ?? 0 };
  const agent = p.key === main.recipeKey ? main : p.agent ?? null;
  return { agent: agent ?? main, why: agent ? p.why : 'weinig bewijs', edge: p.edge ?? null, trades: p.trades ?? 0 };
}

// ---------- Risk Agent ----------
export const RISK = {
  lossStreak: 3,        // zoveel verliezen op rij van de AI-trader ...
  pauseHours: 6,        // ... dan zoveel uur geen nieuwe aankopen
  carefulFactor: 0.5,   // inzet bij weinig bewijs voor deze marktfase
  maxSlipPct: 0.5,      // gemiddelde afwijking bij de laatste orders in deze coin: daarboven niet kopen
  slipOrders: 3,
  minStakeEur: 5,       // kleinste order bij Bitvavo
};

// Verliezen op rij van de AI-trader (trades nieuwste eerst).
export function lossStreak(trades) {
  let n = 0;
  for (const t of trades) {
    if (!t.agent || t.agent.explore) continue;
    if (t.pnlEur < 0) n++;
    else break;
  }
  return n;
}

// Is deze aankoop verantwoord? Geeft { block: reden | null, stakeFactor, notes: [] }.
// trades: gesloten trades (nieuwste eerst), choice: uitkomst van chooseForRegime,
// execLog: uitgevoerde orders (nieuwste eerst), now: tijd in ms.
export function assessRisk({ pair, trades = [], choice = null, execLog = [], now = Date.now(), rules = RISK }) {
  const notes = [];
  const streak = lossStreak(trades);
  if (streak >= rules.lossStreak) {
    const last = trades.find((t) => t.agent && !t.agent.explore);
    const left = rules.pauseHours * 3600000 - (now - Date.parse(last?.closedAt ?? 0));
    if (left > 0) {
      return { block: `${streak} verliezen op rij: ik koop ${Math.ceil(left / 3600000)} uur niets om af te koelen`, stakeFactor: 0, notes };
    }
  }
  const fills = execLog.filter((x) => x.pair === pair && Number.isFinite(x.slipPct)).slice(0, rules.slipOrders);
  if (fills.length >= rules.slipOrders) {
    const avg = fills.reduce((a, x) => a + x.slipPct, 0) / fills.length;
    if (avg > rules.maxSlipPct) {
      return { block: `orders in ${pair} kwamen gemiddeld ${avg.toFixed(2).replace('.', ',')}% slechter uit dan verwacht: te duur om te handelen`, stakeFactor: 0, notes };
    }
  }
  let stakeFactor = 1;
  if (!choice || choice.why !== 'best') {
    stakeFactor = rules.carefulFactor;
    notes.push('halve inzet: nog weinig bewijs voor deze marktfase');
  }
  return { block: null, stakeFactor, notes };
}

// Inzet na de Risk Agent, nooit onder de kleinste order en nooit boven de gewone inzet.
export function riskStake(stake, factor, rules = RISK) {
  if (!(factor > 0) || factor >= 1) return stake;
  return Math.min(stake, Math.max(rules.minStakeEur, Math.floor(stake * factor * 100) / 100));
}

// ---------- Execution Agent ----------
// Afwijking van de verwachte prijs in %, positief = slechter dan verwacht.
export function slippagePct(side, expected, fill) {
  if (!(expected > 0) || !(fill > 0)) return null;
  return side === 'buy' ? (fill / expected - 1) * 100 : (expected / fill - 1) * 100;
}

export function execSummary(log = []) {
  const s = log.filter((x) => Number.isFinite(x.slipPct));
  if (!s.length) return null;
  const avg = s.reduce((a, x) => a + x.slipPct, 0) / s.length;
  const worst = s.reduce((a, x) => (x.slipPct > a.slipPct ? x : a), s[0]);
  return { orders: s.length, avgSlipPct: +avg.toFixed(3), worst: { pair: worst.pair, side: worst.side, slipPct: +worst.slipPct.toFixed(3) } };
}

// ---------- Verkenner (alleen paper) ----------
// Koopt kansen die de AI-trader zelf laat liggen (onder zijn drempel, een coin die hij niet koos,
// een marktfase waarin de Strategy Agent niet handelt, of tegengehouden), zodat hij leert hoe die
// aflopen. Virtueel, begrensd en zonder saldo of orderplek; hij kiest waar hij het meest kan leren.
// Nooit live.
export function exploreWanted({ mode, enabled }) {
  return mode === 'paper' && Boolean(enabled);
}

export function explorationOutcome(position, { price, exitValue = null, now = Date.now() }) {
  if (!(price > 0) || now <= position.at) return null;
  const held = (now - position.at) / position.tfMs;
  const change = (price / position.entryPrice - 1) * 100;
  const reason = position.safetyStopPct > 0 && change <= -position.safetyStopPct ? 'veiligheidsstop'
    : held >= position.maxHoldCandles ? 'maximale duur'
    : held >= position.minHoldCandles && Number.isFinite(exitValue) && exitValue < -position.exitMarginPct ? 'AI-verkoop'
    : null;
  if (!reason) return null;
  const exitPrice = price * (1 - position.slippagePct / 100);
  const pct = (exitPrice / position.entryPrice * (1 - position.feePct / 100) ** 2 - 1) * 100;
  const costPct = 2 * position.feePct + position.slippagePct + (position.entryPrice / position.signalPrice - 1) * 100;
  return { pct, costPct, exitPrice, reason, closedAt: new Date(now).toISOString() };
}

export const EXPLORE = {
  maxOpen: 100,
  maxPerMarket: 3,
  feedbackWeight: 0.25,
  nearScale: 0.3,     // hoe snel de kans afneemt met de afstand tot de koopdrempel (procentpunt)
  knownTrades: 10,    // bij zoveel trades in een vakje weet hij er al redelijk veel van
  provenTrades: 30,   // vanaf zoveel trades mag hij iets "bewezen slecht" noemen
  provenBad: -0.3,    // ... als het daar gemiddeld zoveel procentpunt slechter uitkwam dan verwacht
  farBelow: 0.3,      // ... en de kans zoveel onder de drempel ligt
  floor: 0.1,         // ook ver weg nog af en toe kijken (de markt verandert)
};

// Hoe waardevol is deze twijfelkans om te verkennen? Geeft { p (kans om te kopen), skip (reden of
// null), parts (uitleg) }. q: bijgestuurde verwachting, thr: koopdrempel, corr: directe bijsturing.
export function exploreScore({ q, thr, pair, regime, corr, rules = EXPLORE }) {
  const gap = Math.max(0, thr - q);
  const coin = corr?.coins?.[pair] ?? { n: 0, adj: 0 };
  const bin = corr?.bins?.[binOf(q, corr?.edges ?? LEARN.edges)] ?? { n: 0, adj: 0 };
  const cell = corr?.cells?.[`${pair}|${regime ?? 'onbekend'}`] ?? 0;
  const reg = corr?.regimes?.[regime ?? 'onbekend'] ?? 0;
  // Bewezen slecht: veel trades, duidelijk slechter dan verwacht, en ver onder de drempel.
  if (coin.n >= rules.provenTrades && coin.adj <= rules.provenBad && gap >= rules.farBelow) {
    return { p: 0, skip: `${pair} kwam in ${coin.n} trades steeds slechter uit dan verwacht`, parts: null };
  }
  if (bin.n >= rules.provenTrades && bin.adj <= rules.provenBad && gap >= rules.farBelow && q < 0) {
    return { p: 0, skip: `bij deze verwachting kwamen ${bin.n} trades steeds slechter uit`, parts: null };
  }
  const near = Math.exp(-gap / rules.nearScale);                                  // 1 op de drempel
  const unknown = 1 / Math.sqrt(1 + Math.min(cell, coin.n, bin.n, reg) / rules.knownTrades); // 1 = nog niets bekend
  const optimism = Math.min(0.5, Math.max(0, coin.adj + bin.adj)) / 0.5;          // echte uitkomsten beter dan verwacht
  const p = clamp(rules.floor + 0.5 * near + 0.4 * unknown + 0.3 * optimism, 1);
  return { p: Math.max(rules.floor, p), skip: null, parts: { near, unknown, optimism, cell, coinN: coin.n } };
}

// ---------- Directe bijsturing (leert meteen van elke afgesloten trade) ----------
// Het model zelf wordt alleen op de leerserver opnieuw getraind, en echte trades tellen daar pas mee
// als ze vóór de validatie liggen (anders lekt de controle). De bot stuurt zijn verwachting wél
// direct bij: per groep verwachtingen en per coin het verschil tussen verwacht en echt, over de
// laatste trades (verkenner en AI-trader samen). Met weinig trades voorzichtig (krimp naar 0).
export const LEARN = {
  edges: [-0.5, 0, 0.2, 0.5],  // grenzen van de groepen verwachtingen (%)
  prior: 20,                   // zoveel "denkbeeldige" trades met verschil 0: voorzichtig bij weinig data
  window: 300,                 // laatste zoveel trades
  maxAdj: 1.0,                 // nooit meer dan zoveel procentpunt bijsturen
};

const binOf = (q, edges) => edges.filter((e) => q >= e).length;
const clamp = (v, m) => Math.max(-m, Math.min(m, v));

export function onlineCorrection(trades, rules = LEARN) {
  const eligible = trades.filter((t) => t.agent && Number.isFinite(t.agent.expectedPct) && Number.isFinite(t.pnlPct));
  const rows = [...eligible.filter((t) => !t.agent.virtual).slice(0, rules.window),
    ...eligible.filter((t) => t.agent.virtual).slice(0, rules.window)];
  const bins = Array.from({ length: rules.edges.length + 1 }, () => ({ n: 0, sum: 0 }));
  for (const t of rows) {
    const weight = t.agent.virtual ? EXPLORE.feedbackWeight : 1;
    const b = bins[binOf(t.agent.expectedPct, rules.edges)];
    b.n += weight;
    b.sum += (t.pnlPct - t.agent.expectedPct) * weight;
  }
  const binAdj = bins.map((b) => ({ n: b.n, adj: clamp(b.sum / (b.n + rules.prior), rules.maxAdj) }));
  const coins = {};
  for (const t of rows) {
    const weight = t.agent.virtual ? EXPLORE.feedbackWeight : 1;
    const c = (coins[t.pair] ??= { n: 0, sum: 0 });
    c.n += weight;
    c.sum += (t.pnlPct - t.agent.expectedPct - binAdj[binOf(t.agent.expectedPct, rules.edges)].adj) * weight;
  }
  for (const c of Object.values(coins)) c.adj = clamp(c.sum / (c.n + rules.prior), rules.maxAdj);
  // Hoeveel ervaring per marktfase en per coin in een marktfase (voor de verkenner).
  const regimes = {};
  const cells = {};
  for (const t of rows) {
    const weight = t.agent.virtual ? EXPLORE.feedbackWeight : 1;
    const r = t.agent.marketRegime ?? 'onbekend';
    regimes[r] = (regimes[r] ?? 0) + weight;
    cells[`${t.pair}|${r}`] = (cells[`${t.pair}|${r}`] ?? 0) + weight;
  }
  return { trades: rows.length, bins: binAdj, coins, regimes, cells, edges: rules.edges };
}

// Bijgestuurde verwachting: model + groep + coin.
export function correctedExpectation(q, pair, corr) {
  if (!corr?.trades) return { q, adj: 0 };
  const adj = (corr.bins[binOf(q, corr.edges)]?.adj ?? 0) + (corr.coins[pair]?.adj ?? 0);
  return { q: q + adj, adj };
}

// ---------- Beloningen door de tijd: wordt de AI-trader beter? ----------
// Elke afgesloten trade is een beloning (winst na kosten) of een straf (verlies). Geeft de punten
// voor de grafiek, een overzicht per week en een conclusie in gewone taal.
const isoWeek = (ms) => {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
};

export function rewardSummary(trades, now = Date.now(), maxPoints = 600) {
  const rows = trades.filter((t) => t.agent && Number.isFinite(t.pnlPct) && t.closedAt)
    .map((t) => ({ at: Date.parse(t.closedAt), pct: t.pnlPct, who: t.agent.explore ? 'verkenner' : 'ai', pair: t.pair,
      exp: Number.isFinite(t.agent.expectedPct) ? t.agent.expectedPct : null }))
    .filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const weeks = {};
  for (const r of rows) {
    const w = (weeks[isoWeek(r.at)] ??= { week: isoWeek(r.at), n: 0, wins: 0, sum: 0, ai: 0, aiSum: 0, err: 0, nErr: 0 });
    w.n++;
    w.wins += r.pct > 0;
    w.sum += r.pct;
    if (r.who === 'ai') { w.ai++; w.aiSum += r.pct; }
    if (r.exp != null) { w.err += Math.abs(r.pct - r.exp); w.nErr++; }
  }
  const wk = Object.values(weeks).sort((a, b) => (a.week < b.week ? -1 : 1)).map((w, i, all) => ({
    week: w.week, trades: w.n, rewards: w.wins, penalties: w.n - w.wins, avgPct: w.sum / w.n,
    aiAvgPct: w.ai ? w.aiSum / w.ai : null, expectError: w.nErr ? w.err / w.nErr : null,
    vsPrev: i ? w.sum / w.n - all[i - 1].sum / all[i - 1].n : null,
  }));
  // Conclusie: laatste 14 dagen tegenover de 14 dagen daarvoor (gewone trades en verkenner samen).
  const day = 86400000;
  const avg = (xs) => (xs.length ? xs.reduce((a, r) => a + r.pct, 0) / xs.length : null);
  const recent = rows.filter((r) => r.at > now - 14 * day);
  const before = rows.filter((r) => r.at <= now - 14 * day && r.at > now - 28 * day);
  const a1 = avg(recent);
  const a0 = avg(before);
  const errOf = (xs) => { const e = xs.filter((r) => r.exp != null); return e.length ? e.reduce((a, r) => a + Math.abs(r.pct - r.exp), 0) / e.length : null; };
  const e1 = errOf(recent);
  const e0 = errOf(before);
  let verdict = 'te weinig';
  if (recent.length >= 10 && before.length >= 10) verdict = a1 - a0 > 0.02 ? 'beter' : a0 - a1 > 0.02 ? 'slechter' : 'gelijk';
  return {
    points: rows.slice(-maxPoints).map((r) => ({ at: r.at, pct: +r.pct.toFixed(3), who: r.who, pair: r.pair, exp: r.exp })),
    weeks: wk.reverse(),
    trend: { recent: { n: recent.length, avgPct: a1, expectError: e1 }, before: { n: before.length, avgPct: a0, expectError: e0 }, verdict },
  };
}
