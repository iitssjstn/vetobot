// Resultaatanalyse: waar komen winst en verlies vandaan? Alleen rekenwerk over de gesloten
// trades, geen AI. Wordt op het dashboard getoond, zodat je ziet waar het lekt.

// Hoe een trade eindigde, op basis van de verkoopreden.
export const EXIT_KINDS = [
  ['stoploss', 'Stop-loss', /^(Stop-loss|ATR-stop)/],
  ['trailing', 'Trailing stop', /^Trailing stop/],
  ['takeprofit', 'Take-profit', /^Take-profit/],
  ['ai', 'AI neemt winst', /^AI neemt winst/],
  ['signal', 'Verkoopsignaal (trend omlaag)', /^(Trend omlaag|EMA fast kruist onder)/],
  ['manual', 'Handmatig gesloten', /^Handmatig/i],
  ['follow', 'Gevolgd (leider verkocht)', /^Gevolgd/],
];

export function exitKind(reason) {
  const r = String(reason ?? '');
  return EXIT_KINDS.find(([, , re]) => re.test(r))?.[0] ?? 'other';
}

// trades: nieuwste eerst (zoals in de store). feePct: om fees te schatten bij oudere trades
// waarin ze nog niet werden opgeslagen.
export function analyzeTrades(trades, { feePct = 0.25 } = {}) {
  const list = (trades ?? []).filter((t) => Number.isFinite(t.pnlEur));
  const n = list.length;
  if (!n) return { trades: 0 };
  const wins = list.filter((t) => t.pnlEur > 0);
  const losses = list.filter((t) => t.pnlEur <= 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const avg = (a, f) => (a.length ? sum(a, f) / a.length : null);
  const fees = (t) => (Number.isFinite(t.feesEur) ? t.feesEur : ((t.costEur ?? 0) * feePct * 2) / 100);
  const holdMin = (t) => (t.openedAt && t.closedAt ? (Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 60000 : null);

  const byExit = {};
  for (const [key, label] of [...EXIT_KINDS, ['other', 'Overig']]) byExit[key] = { key, label, count: 0, wins: 0, pnlEur: 0 };
  for (const t of list) {
    const b = byExit[exitKind(t.exitReason)];
    b.count++;
    if (t.pnlEur > 0) b.wins++;
    b.pnlEur += t.pnlEur;
  }

  const byPair = {};
  for (const t of list) {
    const b = (byPair[t.pair] ??= { pair: t.pair, count: 0, wins: 0, pnlEur: 0 });
    b.count++;
    if (t.pnlEur > 0) b.wins++;
    b.pnlEur += t.pnlEur;
  }

  // Snelle verliezen: binnen 15 minuten met verlies dicht. Typisch voor whipsaw.
  const quick = losses.filter((t) => (holdMin(t) ?? Infinity) <= 15);
  const holds = list.map(holdMin).filter((x) => x != null);

  const avgWin = avg(wins, (t) => t.pnlEur);
  const avgLoss = avg(losses, (t) => t.pnlEur);
  const feesEur = sum(list, fees);
  const out = {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / n) * 100,
    pnlEur: sum(list, (t) => t.pnlEur),
    avgWinEur: avgWin,
    avgLossEur: avgLoss,
    avgWinPct: avg(wins, (t) => t.pnlPct ?? 0),
    avgLossPct: avg(losses, (t) => t.pnlPct ?? 0),
    // Hoeveel een gemiddelde winst is ten opzichte van een gemiddeld verlies.
    payoff: avgWin != null && avgLoss ? avgWin / Math.abs(avgLoss) : null,
    // Gemiddeld resultaat per trade.
    expectancyEur: sum(list, (t) => t.pnlEur) / n,
    feesEur,
    feesShareOfLosses: losses.length ? feesEur / Math.abs(sum(losses, (t) => t.pnlEur) || 1) : null,
    avgHoldMin: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    quickLosses: quick.length,
    quickLossesEur: sum(quick, (t) => t.pnlEur),
    byExit: Object.values(byExit).filter((b) => b.count),
    byPair: Object.values(byPair).sort((a, b) => a.pnlEur - b.pnlEur),
    since: list.at(-1)?.closedAt ?? null,
  };
  out.advice = advise(out);
  return out;
}

// Concrete tips op basis van de cijfers. Alleen als er genoeg trades zijn.
function advise(a) {
  const tips = [];
  if (a.trades < 8) return tips;
  const sig = a.byExit.find((b) => b.key === 'signal');
  if (sig && sig.count >= a.trades * 0.3 && sig.pnlEur < 0) {
    tips.push(`${sig.count} van de ${a.trades} trades eindigden op een verkoopsignaal, samen ${fmt(sig.pnlEur)}. ` +
      'De trend draait vaak snel weer om (whipsaw). Zet bij Strategie "Verkoopsignaal bevestigen" en "Minimaal in positie" hoger, of kies langere candles.');
  }
  if (a.quickLosses >= a.trades * 0.25) {
    tips.push(`${a.quickLosses} trades werden binnen 15 minuten met verlies gesloten (samen ${fmt(a.quickLossesEur)}). ` +
      'Op zulke korte termijn is de beweging vaak kleiner dan de fees. Langere candles (15 min of meer) helpen.');
  }
  if (a.payoff != null && a.payoff < 1 && a.winRate < 60) {
    tips.push(`Een gemiddelde winst (${fmt(a.avgWinEur)}) is kleiner dan een gemiddeld verlies (${fmt(a.avgLossEur)}), terwijl je minder dan 60% wint. ` +
      'Laat winst langer lopen (hogere drempel voor de AI-winstcheck of een trailing stop) of verklein het verlies per trade.');
  }
  if (a.pnlEur < 0 && a.feesEur > Math.abs(a.pnlEur) * 0.5) {
    tips.push(`Je betaalde ${fmt(a.feesEur)} aan fees: ${Math.round((a.feesEur / Math.abs(a.pnlEur)) * 100)}% van je verlies. Minder, maar betere trades scheelt direct.`);
  }
  const sl = a.byExit.find((b) => b.key === 'stoploss');
  if (sl && sl.count >= a.trades * 0.4) {
    tips.push(`${sl.count} trades raakten de stop-loss. Mogelijk staat hij te krap voor de beweeglijkheid van deze coins; probeer de ATR-stop.`);
  }
  const worst = a.byPair[0];
  if (worst && worst.count >= 3 && worst.pnlEur < 0 && worst.wins === 0) {
    tips.push(`${worst.pair} verloor ${worst.count} keer op rij (${fmt(worst.pnlEur)}). Overweeg deze coin uit je lijst te halen.`);
  }
  return tips;
}

const fmt = (n) => `${n < 0 ? '−' : ''}€ ${Math.abs(n ?? 0).toFixed(2).replace('.', ',')}`;
