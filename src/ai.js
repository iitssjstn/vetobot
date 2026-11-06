// AI-veto: de AI mag een koopsignaal alleen goedkeuren of afwijzen.
// Positiegrootte en stops worden nooit door de AI bepaald. Optioneel mag de AI bij een
// positie in de winst adviseren om eerder te verkopen (winst nemen), zie askExitChain.

const SYSTEM_PROMPT = `Je bent een gedisciplineerde crypto daytrader die alleen trades neemt met een duidelijk positieve verwachting.
Een regelgebaseerde strategie geeft een koopsignaal. Jij beslist of de bot instapt. Je bepaalt NOOIT bedragen,
positiegrootte of stops; die liggen vast en staan in de data. Liever een goede trade missen dan een slechte nemen.

Werkwijze, in deze volgorde:
1. HARDE FILTERS. Staat er bij "Harde filters" ook maar één ✗, dan wijs je af. Geen uitzonderingen.
   Regels met ○ zijn geen harde eis, alleen informatie om mee te wegen; wijs daar nooit alleen op af.
   Gebruik bij de andere stappen de grenzen die in de data staan, niet je eigen strengere grenzen.
2. MARKTBEELD. Bij voorkeur kopen in een trend of bij een uitbraak uit een zijwaartse markt met volume.
   Staat "marktbeeld" bij de harde filters met ✗, dan wijs je af. Staat er ○, dan heeft de gebruiker
   gekozen om ook in een richtingloze markt te handelen: weeg het dan alleen mee in je winstkans,
   en wijs niet af alleen omdat de markt richtingloos is.
   Tegen de hogere-timeframe-trend in koop je alleen bij een uitzonderlijk sterk signaal.
3. RISK/REWARD. 1R = het verlies tot de stop-loss (staat in de data). Schat:
   - de realistische reward in R: de afstand tot de eerstvolgende weerstand (recente high), of tot de take-profit;
     meer dan 3R verwacht je alleen in een sterke trend met ruimte naar boven;
   - de winstkans: hoe groot de kans is dat die winst eerder geraakt wordt dan de stop.
   Keur alleen goed als winstkans × reward − (1 − winstkans) × 1R − kosten (in R) minstens de
   "minimale verwachte winst" uit de data is.
   Ligt een recente high binnen ±1R boven de koers en is die nog niet doorbroken, dan is de reward klein.
4. MOMENTUM EN VOLUME. Een stijging op dalend of laag volume is zwak. Een kruising na een al grote stijging
   (koers ver boven de EMA's, veel groene candles op rij, RSI hoog) is te laat: je koopt dan de top.
5. FEEDBACK. Kijk naar de eerdere AI-beslissingen en trades in deze coin. Verloor deze setup recent
   (winrate laag of gemiddelde R negatief), dan wees je extra streng. Herhaal geen fout die er al staat.

Antwoord uitsluitend met JSON, zonder tekst eromheen:
{"decision": "approve" | "reject", "reason": "max. 2 zinnen"}

Schrijf de reden in gewoon, begrijpelijk Nederlands voor iemand zonder tradingkennis. Geen formules,
geen losse letters of afkortingen (dus niet "p" of "R"), geen Engelse termen. Noem de winstkans in procenten
en de verwachte winst als "x keer het risico". Voorbeeld: "Duidelijke stijgende trend met veel volume;
winstkans ongeveer 55% en verwachte winst zo'n 2 keer het risico." of "Geen duidelijke richting en weinig
volume, dus de kans op winst na kosten is te klein."`;

// ---------- Hulpfuncties voor de prompts (alleen rekenwerk, geen beslissingen) ----------
const fx = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? 'onbekend' : Number(v).toFixed(d));
// Prijzen met 6 significante cijfers (werkt voor BTC én voor PEPE).
const px = (v) => (v == null || !Number.isFinite(Number(v)) ? 'onbekend' : String(parseFloat(Number(v).toPrecision(6))));
const sgn = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'onbekend' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

// Candles samengevat: richting, efficiëntie (trend vs. ruis), highs/lows, volumeverloop.
function candleStats(candles, close, atrPct) {
  const c = (candles ?? []).filter((x) => Array.isArray(x) && x.length >= 6);
  if (c.length < 4) return null;
  const closes = c.map((x) => x[4]);
  const last = close ?? closes.at(-1);
  // Efficiency ratio (Kaufman): netto beweging ÷ totale beweging. ~1 = strakke trend, ~0 = heen en weer.
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const er = path ? Math.abs(closes.at(-1) - closes[0]) / path : 0;
  // Vorige high/low: zonder de laatste candle, zodat die zelf niet als "weerstand" telt.
  const hi = Math.max(...c.slice(0, -1).map((x) => x[2]));
  const lo = Math.min(...c.slice(0, -1).map((x) => x[3]));
  const pct = (a, b) => ((a - b) / b) * 100;
  const atrUnits = (p) => (atrPct ? p / atrPct : null);
  // Groene candles op rij aan het eind, en hoe groot die stijging samen is.
  let greens = 0;
  for (let i = c.length - 1; i >= 0 && c[i][4] > c[i][1]; i--) greens++;
  const half = Math.floor(c.length / 2);
  const avgVol = (a) => a.reduce((s, x) => s + x[5], 0) / (a.length || 1);
  const volTrend = avgVol(c.slice(-3)) / (avgVol(c.slice(0, -3)) || 1);
  const upVol = c.filter((x) => x[4] >= x[1]).reduce((s, x) => s + x[5], 0);
  const downVol = c.filter((x) => x[4] < x[1]).reduce((s, x) => s + x[5], 0);
  // Hogere highs/lows in de tweede helft t.o.v. de eerste helft.
  const h1 = Math.max(...c.slice(0, half).map((x) => x[2])), h2 = Math.max(...c.slice(half).map((x) => x[2]));
  const l1 = Math.min(...c.slice(0, half).map((x) => x[3])), l2 = Math.min(...c.slice(half).map((x) => x[3]));
  return {
    n: c.length, er, hi, lo,
    toHighPct: pct(hi, last), fromLowPct: pct(last, lo),
    toHighAtr: atrUnits(pct(hi, last)), fromLowAtr: atrUnits(pct(last, lo)),
    rangePct: pct(hi, lo),
    netPct: pct(closes.at(-1), closes[0]),
    last3Pct: closes.length > 3 ? pct(closes.at(-1), closes.at(-4)) : null,
    greens,
    volTrend, upDownVol: downVol ? upVol / downVol : null,
    structure: h2 > h1 && l2 > l1 ? 'hogere highs en hogere lows' : h2 < h1 && l2 < l1 ? 'lagere highs en lagere lows' : 'gemengd',
    brokeHigh: last > hi,
  };
}

// Regime uit ADX en efficiency ratio. Bewust grof: het model krijgt ook de onderliggende cijfers.
function regimeOf(adx, er) {
  if (adx == null || er == null) return 'onbekend';
  if (adx >= 25 && er >= 0.35) return 'trend';
  if (er < 0.2 || adx < 18) return 'richtingloos';
  return 'zijwaarts';
}

function volumeText(ratio) {
  if (ratio == null) return 'onbekend';
  const label = ratio < 0.7 ? 'droog (weinig interesse)' : ratio < 1.2 ? 'normaal' : ratio < 2 ? 'sterk (echte interesse)' : 'uitzonderlijk (mogelijk uitbraak of piek)';
  return `${fx(ratio, 1)}× gemiddeld: ${label}`;
}

// Risico in procenten tot de stop, en de kosten van een volledige ronde.
function riskOf(risk, atrPct) {
  if (!risk) return null;
  const stopPct = risk.atrStopMult > 0 && atrPct ? risk.atrStopMult * atrPct : risk.stopLossPct > 0 ? risk.stopLossPct : null;
  const feesPct = risk.roundCostPct != null ? risk.roundCostPct : (risk.feePct ?? 0) * 2 + (risk.slippagePct ?? 0) * 2;
  return { stopPct, feesPct, feesR: stopPct ? feesPct / stopPct : null };
}

// Winrate en gemiddelde R van eerdere trades (pnlPct gedeeld door het stop-percentage).
function perfOf(trades, stopPct) {
  const t = (trades ?? []).filter((x) => Number.isFinite(x.pnlPct));
  if (!t.length) return null;
  const wins = t.filter((x) => x.pnlPct > 0).length;
  const avgPct = t.reduce((s, x) => s + x.pnlPct, 0) / t.length;
  return { n: t.length, winRate: (wins / t.length) * 100, avgPct, avgR: stopPct ? avgPct / stopPct : null };
}

// Context voor de koopbeslissing. Alle velden in extra zijn optioneel; ontbreekt iets, dan staat er "onbekend".
// extra: { btcTrend, recentTrades, plan, risk: { stopLossPct, atrStopMult, takeProfitPct, trailingStopPct,
//   feePct, slippagePct }, htfTrend: { timeframe, up, close, ema, changePct }, setupStats: { trades, winRate, avgR },
//   aiHistory: [{ at, decision, reason, resultPct, outcome }] }
// Scorebord van de trainer: hoe liepen de signalen af die de AI goedkeurde of afwees, en de
// gevallen waarin model en AI het oneens waren. Zo kan de AI leren wanneer het model gelijk heeft.
function teamworkText(tw) {
  if (!tw || !(tw.total >= 15)) return '';
  const fx2 = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
  const line = (name, x) => (x?.n ? `- ${name}: ${x.n}×, gemiddeld ${fx2(x.avgReturnPct)} per trade, ${x.winRate.toFixed(0)}% bereikte het doel` : null);
  const rows = [
    line('Jij keurde goed', tw.approved),
    line('Jij wees af (wat het zou hebben opgeleverd)', tw.rejected),
    line(`Model zei ja (≥ ${tw.modelThreshold.toFixed(0)}%) maar jij wees af`, tw.modelYesAiNo),
    line('Model zei nee maar jij keurde goed', tw.modelNoAiYes),
    line('Allebei ja', tw.bothYes),
  ].filter(Boolean);
  let advice = '';
  const a = tw.approved, r = tw.rejected;
  if (a?.n >= 10 && r?.n >= 10) {
    if (r.avgReturnPct > a.avgReturnPct) advice = 'Let op: de signalen die jij afwees deden het gemiddeld BETER dan die je goedkeurde. Je wijst te vaak goede trades af; vertrouw het model meer.';
    else if (r.avgReturnPct > 0) advice = 'Ook je afgewezen signalen maakten gemiddeld winst: je bent mogelijk te streng.';
    else advice = 'Je afwijzingen voorkwamen gemiddeld verlies: je oordeel voegt waarde toe.';
  }
  const ym = tw.modelYesAiNo, ny = tw.modelNoAiYes;
  if (ym?.n >= 8 && ym.avgReturnPct > 0) advice += ' Als het model ja zei en jij nee, had het model vaak gelijk.';
  if (ny?.n >= 8 && ny.avgReturnPct < 0) advice += ' Als het model nee zei en jij ja, maakte dat gemiddeld verlies: volg het model daar vaker.';
  return `== Samenwerking met het model: wie had gelijk? (laatste ${tw.total} signalen) ==
${rows.join('\n')}
${advice}`.trim() + '\n';
}

export function buildPrompt({ pair, timeframe, indicators, recentCandles, extra = {} }) {
  const ind = indicators ?? {};
  const st = candleStats(recentCandles, ind.close, ind.atrPct);
  const rk = riskOf(extra.risk, ind.atrPct);
  const regime = regimeOf(ind.adx, st?.er);
  const isBtc = /^BTC\//.test(pair);
  const distSlowAtr = ind.close && ind.emaSlow && ind.atr ? (ind.close - ind.emaSlow) / ind.atr : null;

  // Harde filters, vooraf uitgerekend zodat het model niet hoeft te rekenen. ✗ = afwijzen, ○ = alleen info.
  // Grenzen uit extra.filters (AI-strengheid + je eigen strategie-instellingen); anders de strenge standaard.
  const F = { label: 'streng', adxMin: 20, volMin: 0.8, rsiMax: 72, atrMax: 3, greensMax: 4, costRMax: 0.35, evMinR: 0.3, chopHard: true, btcHard: true, ...(extra.filters ?? {}) };
  const nl = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
  const filters = [];
  const add = (ok, text, hard = true) => filters.push(`${ok == null ? '?' : !hard ? '○' : ok ? '✓' : '✗'} ${text}`);
  add(ind.adx == null ? null : ind.adx >= F.adxMin, `ADX ${fx(ind.adx, 1)} (min. ${nl(F.adxMin)}: er moet een trend zijn)`);
  add(ind.volumeRatio == null ? null : ind.volumeRatio >= F.volMin, `volume ${fx(ind.volumeRatio, 1)}× gemiddeld (min. ${nl(F.volMin)}×)`);
  add(ind.rsi == null ? null : ind.rsi <= F.rsiMax, `RSI ${fx(ind.rsi, 1)} (max. ${nl(F.rsiMax)}: niet oververhit)`);
  add(distSlowAtr == null ? null : distSlowAtr <= F.atrMax, `koers ${fx(distSlowAtr, 1)} ATR boven EMA slow (max. ${nl(F.atrMax)}: niet te ver doorgeschoten)`);
  add(st ? st.greens <= F.greensMax : null, `${st?.greens ?? '?'} groene candles op rij (max. ${F.greensMax})`);
  add(regime === 'onbekend' ? null : regime !== 'richtingloos', `marktbeeld: ${regime}`, F.chopHard);
  if (!isBtc) add(extra.btcTrend ? extra.btcTrend.up : null, `Bitcoin-trend ${extra.btcTrend ? (extra.btcTrend.up ? 'omhoog' : 'omlaag') : 'onbekend'}`, F.btcHard);
  if (rk?.stopPct) add(rk.feesR <= F.costRMax, `kosten ${fx(rk.feesPct)}% = ${fx(rk.feesR)}R per ronde (max. ${nl(F.costRMax)}R)`);

  const htf = extra.htfTrend
    ? `${extra.htfTrend.timeframe ?? 'hoger'}: ${extra.htfTrend.up ? 'omhoog' : 'omlaag'}${extra.htfTrend.changePct != null ? ` (${sgn(extra.htfTrend.changePct)}%)` : ''}`
    : ind.emaTrend != null ? `koers ${ind.close > ind.emaTrend ? 'boven' : 'onder'} de lange trend-EMA (${fx(((ind.close - ind.emaTrend) / ind.emaTrend) * 100)}%)` : 'onbekend';

  const rr = rk?.stopPct
    ? [`1R (verlies tot stop): ${fx(rk.stopPct)}%${extra.risk?.atrStopMult > 0 ? ` (${extra.risk.atrStopMult}× ATR)` : ''}`,
      `Kosten per ronde: ${fx(rk.feesPct)}% = ${fx(rk.feesR)}R`,
      st ? (st.brokeHigh ? `Koers staat boven de vorige high (uitbraak): geen directe weerstand binnen dit venster` : `Ruimte tot vorige high (weerstand): ${fx(st.toHighPct)}% = ${fx(st.toHighPct / rk.stopPct)}R`) : null,
      extra.risk?.takeProfitPct > 0 ? `Take-profit: +${fx(extra.risk.takeProfitPct)}% = ${fx(extra.risk.takeProfitPct / rk.stopPct)}R` : 'Geen vaste take-profit',
      extra.risk?.trailingStopPct > 0 ? `Trailing stop: ${fx(extra.risk.trailingStopPct)}% onder de top` : null,
    ].filter(Boolean).join('\n')
    : extra.plan ? `Plan: ${extra.plan}` : 'Stop en kosten onbekend: wees voorzichtig met de risk/reward.';

  const bk = extra.book;
  const bookTxt = bk ? `Orderboek nu: verschil bied/laat ${fx(bk.spreadPct)}%` +
    (bk.buyCostPct != null ? `, deze aankoop wordt ~${fx(bk.buyCostPct)}% boven de middenprijs gevuld` : '') +
    (bk.buyersShare != null ? `, binnen 1% van de prijs ${fx(bk.buyersShare * 100, 0)}% kopers en ${fx(100 - bk.buyersShare * 100, 0)}% verkopers` +
      (bk.buyersShare > 0.6 ? ' (meer koopinteresse)' : bk.buyersShare < 0.4 ? ' (meer verkoopdruk)' : '') : '') + '.' : '';
  const perf = perfOf(extra.recentTrades, rk?.stopPct);
  const perfTxt = perf
    ? `${perf.n} trades: winrate ${fx(perf.winRate, 0)}%, gemiddeld ${sgn(perf.avgPct)}%${perf.avgR != null ? ` = ${sgn(perf.avgR)}R` : ''}. Laatste: ${extra.recentTrades.slice(0, 5).map((t) => `${sgn(t.pnlPct, 1)}% (${String(t.exit ?? '').split(/[:(]/)[0].trim()})`).join(', ')}`
    : 'nog geen trades in deze coin';
  const setup = extra.setupStats
    ? `\nDeze strategie over alle coins: ${extra.setupStats.trades} trades, winrate ${fx(extra.setupStats.winRate, 0)}%, gemiddeld ${sgn(extra.setupStats.avgR)}R`
    : '';
  const history = extra.aiHistory?.length
    ? extra.aiHistory.slice(0, 6).map((h) => `- ${h.decision === 'approve' ? 'goedgekeurd' : 'afgewezen'}${h.outcome ? ` → ${h.outcome}` : ''}${h.resultPct != null ? ` (${sgn(h.resultPct, 1)}%)` : ''}: ${String(h.reason ?? '').slice(0, 120)}`).join('\n')
    : 'geen';

  // Laatste candles compact: verandering t.o.v. de vorige slotkoers, bereik en volume t.o.v. gemiddeld.
  const c = (recentCandles ?? []).slice(-10);
  const avgV = c.reduce((a, x) => a + x[5], 0) / (c.length || 1);
  const rows = c.map((x, i) => {
    const prev = i ? c[i - 1][4] : x[1];
    return `${sgn(((x[4] - prev) / prev) * 100)}% ${x[4] >= x[1] ? 'groen' : 'rood'}, bereik ${fx(((x[2] - x[3]) / x[3]) * 100)}%, vol ${fx(avgV ? x[5] / avgV : null, 1)}×`;
  }).join('\n');

  return `Pair: ${pair} · timeframe ${timeframe} · signaal: KOPEN (${extra.ml?.arm ? `${extra.signalReason ?? 'zelflerend gekozen strategie'}; deze strategie draait op ${extra.ml.arm.timeframe}-candles, de cijfers hieronder zijn van ${timeframe}` : 'EMA fast kruist boven EMA slow'})
Koers: ${px(ind.close)}

== Harde filters (één ✗ = afwijzen; ○ = alleen ter info) · strengheid: ${F.label} ==
${filters.join('\n')}
Minimale verwachte winst: ${F.evMinR > 0 ? `+${nl(F.evMinR)}R` : 'positief (meer dan 0)'}

== Markt ==
Marktbeeld: ${regime} (ADX ${fx(ind.adx, 1)}, rechtheid van de beweging ${fx(st?.er)}: 1 = strakke trend, 0 = heen en weer)
Hogere timeframe: ${htf}
Bitcoin: ${isBtc ? 'dit is BTC zelf' : extra.btcTrend ? `${extra.btcTrend.up ? 'omhoog' : 'omlaag'} (koers ${fx(extra.btcTrend.close, 0)} vs EMA50 ${fx(extra.btcTrend.ema50, 0)})` : 'onbekend'}
Structuur laatste ${st?.n ?? '?'} candles: ${st?.structure ?? 'onbekend'}, netto ${sgn(st?.netPct)}%, laatste 3 candles ${sgn(st?.last3Pct)}%
Vorige high: ${st ? (st.brokeHigh ? 'doorbroken (koers erboven)' : `${fx(st.toHighPct)}% boven de koers (${fx(st.toHighAtr, 1)} ATR)`) : 'onbekend'} · vorige low: ${st ? `${fx(st.fromLowPct)}% eronder (${fx(st.fromLowAtr, 1)} ATR)` : 'onbekend'}
24 candles: ${sgn(ind.change24)}%

== Momentum en volume ==
RSI ${fx(ind.rsi, 1)} · EMA fast ${px(ind.emaFast)} / slow ${px(ind.emaSlow)} · ATR ${fx(ind.atrPct)}% per candle
Volume signaalcandle: ${volumeText(ind.volumeRatio)}
Volume laatste 3 candles vs. ervoor: ${st?.volTrend == null ? 'onbekend' : `${fx(st.volTrend, 2)}×`} · volume op stijgende vs. dalende candles: ${st?.upDownVol == null ? 'alleen stijgende candles' : `${fx(st.upDownVol, 2)}×`}

== Risk/reward (vast, bepaald door de gebruiker) ==
${rr}${bookTxt ? `\n${bookTxt}` : ''}

${extra.ml ? `== Eigen voorspelmodel (getraind op ${extra.ml.meta?.days ?? '?'} dagen koersgeschiedenis) ==
Winstkans volgens het model: ${fx(extra.ml.prob, 0)}% (kans dat de koers eerst +${extra.ml.meta?.targetPct ?? '?'}% stijgt voordat hij −${extra.ml.meta?.stopPct ?? '?'}% daalt)
${extra.ml.meta?.metrics?.base ? `Ter vergelijking: zomaar kopen won op de testperiode ${fx(extra.ml.meta.metrics.base.winRate, 0)}% van de keren. Gebruik dit als één van je argumenten, niet als enige.` : ''}
${(() => {
  const rg = extra.ml.regime;
  const rs = rg && extra.ml.meta?.metrics?.regimes?.[rg];
  if (!rg) return '';
  const label = { stijgend: 'stijgende', zijwaarts: 'zijwaartse', dalend: 'dalende' }[rg] ?? rg;
  if (!rs || rs.avgReturnPct == null || rs.nSelected < 30) return `Soort markt nu: ${label} markt (het model heeft hier te weinig testtrades om iets over te zeggen).`;
  return `Soort markt nu: ${label} markt. In dit soort markt maakten de trades die het model zou nemen op de test gemiddeld ${rs.avgReturnPct > 0 ? '+' : ''}${fx(rs.avgReturnPct, 2)}% per trade (${rs.nSelected} trades)` +
    (rs.avgReturnPct <= 0 ? '. Het model scoort in dit soort markt dus slecht: wees extra kritisch.' : '.');
})()}
${extra.ml.why?.length ? `Waarom het model dit zegt (wat de winstkans het meest omhoog of omlaag duwde):
${extra.ml.why.map((w) => `- ${w.label}: ${w.text} → ${w.effect > 0 ? '+' : ''}${fx(w.effect, 1)} procentpunt`).join('\n')}
Kijk of je het met deze redenen eens bent op basis van de grafiek en het nieuws dat jij ziet. Noem in je reden kort waar je het model volgt of juist niet.` : ''}
${teamworkText(extra.teamwork)}
` : ''}== Feedback ==
Deze coin: ${perfTxt}${setup}
Eerdere AI-beslissingen in deze coin (nieuwste eerst):
${history}

== Laatste candles (oud → nieuw) ==
${rows || 'geen'}`;
}

// Haalt het JSON-object uit een AI-antwoord. Robuust voor:
// - "denkende" modellen (Qwen, DeepSeek, ...) die eerst <think>...</think> schrijven,
// - tekst of ```json-blokken rond de JSON,
// - accolades in de uitleg vóór de JSON.
// Probeert van achter naar voren elk { tot de bijpassende }, en neemt het laatste geldige object.
export function extractJson(text) {
  let t = String(text ?? '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Afgebroken denkblok zonder </think>: alles tot en met <think> weg.
  if (/<think>/i.test(t)) t = t.slice(t.toLowerCase().lastIndexOf('<think>') + 7);
  t = t.trim();
  try {
    const whole = JSON.parse(t);
    if (whole && typeof whole === 'object') return whole;
  } catch {}
  for (let start = t.lastIndexOf('{'); start >= 0; start = t.lastIndexOf('{', start - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(t.slice(start, i + 1));
          // Alleen het buitenste object met de velden die we zoeken telt; een los { } in de tekst niet.
          if (obj && typeof obj === 'object' && ('decision' in obj || 'analyse' in obj || 'analysis' in obj)) return obj;
        } catch {}
        break;
      }
      if (start === 0 && i === t.length - 1) break;
    }
    if (start === 0) break;
  }
  return null;
}

// De uitleg uit een AI-antwoord. Sommige (kleine) modellen gebruiken een andere veldnaam dan
// "reason", zoals "feedback" of "uitleg"; die accepteren we ook.
function reasonOf(obj) {
  const v = obj.reason ?? obj.reden ?? obj.feedback ?? obj.uitleg ?? obj.toelichting ?? obj.explanation ?? obj.rationale ?? '';
  return String(v).slice(0, 500);
}

export function parseDecision(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const obj = extractJson(text);
  if (!obj) throw new Error(`Geen JSON in AI-antwoord: "${String(text).replace(/\s+/g, ' ').slice(0, 120)}"`);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: reasonOf(obj) };
}

// Hoe lang een provider vraagt te wachten na een rate limit (HTTP 429), in ms, of null.
// Groq: "Please try again in 3.67s" / "in 450ms"; Gemini: "retry in 3.2s" / "retryDelay": "3s";
// of de standaard Retry-After-header (seconden).
export function retryAfterMs(message, header) {
  const h = Number(header);
  if (header != null && header !== '' && Number.isFinite(h)) return h * 1000;
  const m = String(message).match(/(?:try again|retry)(?: in)?[^0-9]{0,12}([\d.]+)\s*(ms|s)\b/i) ?? String(message).match(/retryDelay"?:\s*"([\d.]+)(s)"/i);
  if (!m) return null;
  return Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
}

// Bij een rate limit met een korte wachttijd eerst even wachten en het opnieuw proberen,
// in plaats van meteen naar het back-upmodel te gaan. Langer dan 20 seconden wachten
// heeft geen zin; dan neemt het back-upmodel het over.
const MAX_RATE_WAIT_MS = 20000;
export const rateLimit = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

async function fetchWithTimeout(url, options, timeoutMs, attempt = 0) {
  try {
    return await fetchOnce(url, options, timeoutMs);
  } catch (err) {
    if (err.status === 429 && attempt < 2) {
      const wait = retryAfterMs(err.message, err.retryAfter);
      if (wait != null && wait <= MAX_RATE_WAIT_MS) {
        await rateLimit.sleep(wait + 250);
        return fetchWithTimeout(url, options, timeoutMs, attempt + 1);
      }
    }
    throw err;
  }
}

async function fetchOnce(url, options, timeoutMs) {
  const ctrl = new AbortController();
  // Zonder ingestelde time-out niet meteen afbreken, maar na 30 seconden.
  const t = setTimeout(() => ctrl.abort(), timeoutMs > 0 ? timeoutMs : 30000);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      // Toon de foutmelding van de provider zelf, zonder de JSON eromheen.
      const body = await res.text();
      let message = body;
      try {
        const j = JSON.parse(body);
        message = j.error?.message ?? j.message ?? j.error ?? body;
      } catch {}
      throw Object.assign(new Error(`HTTP ${res.status}: ${String(message).slice(0, 500)}`), {
        status: res.status, retryAfter: res.headers.get('retry-after'),
      });
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// system en json zijn optioneel, zodat dezelfde functies ook het dagoverzicht kunnen schrijven.
async function askGemini(cfg, prompt, { system = SYSTEM_PROMPT, json = true, temperature = 0.2 } = {}) {
  const model = cfg.model || defaultModel('gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    },
    cfg.timeoutMs,
  );
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

async function askOpenAICompatible(cfg, prompt, { system = SYSTEM_PROMPT, json = true, temperature = 0.2 } = {}) {
  const model = cfg.model || defaultModel('openai');
  const call = (withJsonMode) => fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    },
    cfg.timeoutMs,
  );
  try {
    const data = await call(json);
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    // Sommige (kleinere) modellen kunnen de strenge JSON-modus niet aan; Groq geeft dan
    // "Failed to generate JSON" of "json_validate_failed". Probeer het één keer zonder;
    // de JSON wordt dan uit de tekst gehaald.
    if (json && /HTTP 400/.test(err.message) && /json|response_format/i.test(err.message)) {
      const data = await call(false);
      return data?.choices?.[0]?.message?.content ?? '';
    }
    throw err;
  }
}

const SUMMARY_PROMPT = `Je schrijft het dagelijkse overzicht van een crypto trading bot voor de eigenaar.
Schrijf in het Nederlands, zakelijk en concreet, maximaal 120 woorden, zonder opsommingstekens of kopjes.
Behandel: hoe het de afgelopen 24 uur ging, wat opvalt in de markt voor de gevolgde coins, en of de
huidige instellingen passen bij wat je ziet (bijv. veel stop-losses, geen enkel signaal, veel AI-afwijzingen).
Verzin geen cijfers die niet in de data staan. Geef geen garanties en voorspel geen koersen.

Doe daarnaast, alleen als de data daar echt aanleiding toe geeft, een voorstel voor andere instellingen.
Je mag ALLEEN deze velden voorstellen: emaFast, emaSlow, rsiPeriod, rsiMaxEntry, trendEma (0 = uit), adxMin (0 = uit),
volumeMult (0 = uit), btcFilter (0 of 1), stopLossPct, takeProfitPct, trailingStopPct (0 = uit), atrStopMult (0 = uit), cooldownMinutes,
timeframe (een van 1m, 5m, 15m, 30m, 1h, 2h, 4h, 1d) en checkIntervalMinutes. Stel nooit bedragen voor.
Laat velden weg die je niet wilt veranderen. Geen goede reden? Laat "voorstel" dan leeg ({}).

Antwoord uitsluitend met JSON in deze vorm:
{"analyse": "de tekst van maximaal 120 woorden", "voorstel": {"veld": waarde}, "toelichting": "waarom, in 1 of 2 zinnen"}`;

// Schrijft de analyse en een eventueel voorstel voor het dagoverzicht.
// Gooit bij een fout; de aanroeper vangt dat op.
export async function writeSummary(cfg, data) {
  if (cfg.provider === 'none' || !cfg.apiKey) return null;
  const prompt = `Data van de bot (JSON):\n${JSON.stringify(data, null, 1)}`;
  const opts = { system: SUMMARY_PROMPT, json: true, temperature: 0.4 };
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt, opts) : await askOpenAICompatible(cfg, prompt, opts);
  return parseSummary(text);
}

export function parseSummary(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const obj = extractJson(raw);
    if (!obj) throw new Error('geen JSON');
    return {
      analysis: String(obj.analyse ?? obj.analysis ?? '').trim().slice(0, 1500) || null,
      suggestions: obj.voorstel && typeof obj.voorstel === 'object' ? obj.voorstel : {},
      rationale: String(obj.toelichting ?? '').trim().slice(0, 500) || null,
    };
  } catch {
    // Geen geldige JSON: gebruik de tekst als analyse, zonder voorstel.
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { analysis: clean.slice(0, 1500) || null, suggestions: {}, rationale: null };
  }
}

// Voor de testknop in het dashboard: dezelfde aanroep als een echte veto, maar
// fouten worden doorgegeven in plaats van opgevangen door de fail-mode.
export async function testConnection(cfg, context) {
  if (cfg.provider === 'none') throw new Error('Er is geen AI-provider gekozen');
  if (!cfg.apiKey) throw new Error('Er is geen AI-key ingesteld');
  const started = Date.now();
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, buildPrompt(context)) : await askOpenAICompatible(cfg, buildPrompt(context));
  const ms = Date.now() - started;
  let parsed;
  try {
    parsed = parseDecision(text);
  } catch (err) {
    throw new Error(`De AI antwoordt, maar niet in het verwachte formaat (${err.message}). Antwoord: ${String(text).slice(0, 200)}`);
  }
  return { ...parsed, provider: cfg.provider, model: cfg.model || defaultModel(cfg.provider), ms };
}

// Standaardmodellen als je zelf niets kiest. Providers schrappen regelmatig oude modellen;
// met listModels() haal je in het dashboard de actuele lijst op.
export const defaultModel = (provider) => (provider === 'gemini' ? 'gemini-3.8-flash' : 'llama-3.3-70b-versatile');

// Haalt de modellen op die je key mag gebruiken.
export async function listModels(cfg) {
  if (cfg.provider === 'none') throw new Error('Er is geen AI-provider gekozen');
  if (!cfg.apiKey) throw new Error('Er is geen AI-key ingesteld');
  if (cfg.provider === 'gemini') {
    const data = await fetchWithTimeout(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': cfg.apiKey } },
      cfg.timeoutMs,
    );
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name, context: m.inputTokenLimit ?? null }))
      .filter((m) => isTextModel(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }
  const data = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/models`,
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    cfg.timeoutMs,
  );
  return (data.data ?? [])
    .filter((m) => m.active !== false && isTextModel(m.id))
    .map((m) => ({
      id: m.id,
      label: m.name && m.name !== m.id ? m.name : m.id,
      context: m.context_window ?? m.context_length ?? null,
      // OpenRouter: modellen met ":free" of prijs 0 zijn gratis
      free: /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) || undefined,
    }))
    .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id));
}

// Modellen voor spraak, beeld, video, embeddings of moderatie kunnen geen veto geven.
export const isTextModel = (id) =>
  !/(embed|whisper|tts|audio|speech|transcri|imagen|image|veo|video|vision-only|aqa|guard|moderation|rerank|orpheus|playai|dall-e|sora|realtime|live)/i.test(id);

// ---------- AI-volgorde (back-ups) ----------
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^api\./, '');
  } catch {
    return 'openai';
  }
};
export const aiLabel = (cfg) => `${cfg.provider === 'gemini' ? 'Gemini' : hostOf(cfg.baseUrl)} · ${cfg.model || defaultModel(cfg.provider)}`;
const callModel = (cfg, prompt, opts) => (cfg.provider === 'gemini' ? askGemini(cfg, prompt, opts) : askOpenAICompatible(cfg, prompt, opts));

// ---------- Winst nemen ----------
// Bij een open positie in de winst mag de AI adviseren om nu te verkopen. Hij kan alleen
// eerder verkopen dan de regels; stop-loss en trailing stop blijven altijd gelden.
const EXIT_PROMPT = `Je beheert een open, winstgevende positie van een crypto trading bot. Beslis: winst NU nemen (sell) of vasthouden (hold).
Je bepaalt geen bedragen of stops; stop-loss en trailing stop blijven altijd actief, los van jou.

Verkoop (sell) als één van deze geldt:
- Twee of meer zwaktesignalen bij "Momentum" staan op ⚠ (lagere highs, kleinere candles, lange bovenwieken,
  dalend volume, rode candles op rij, RSI boven 70 en draaiend).
- De koers heeft al 40% of meer van de hoogste winst teruggegeven.
- De koers staat vlak onder een recente high (binnen 0,5 ATR) en het momentum zwakt af: daar keert hij vaak.
- De winst is minstens 1,5R en er is geen duidelijk nieuw momentum meer.
Houd vast (hold) alleen als de stijging aantoonbaar doorzet: nieuwe highs, groene candles met stijgend volume,
geen zwaktesignalen. Twijfel je, verkoop dan: een zekere winst na fees is beter dan een winst die verdampt.

Antwoord uitsluitend met JSON, zonder tekst eromheen:
{"decision": "sell" | "hold", "reason": "max. 2 zinnen"}

Schrijf de reden in gewoon, begrijpelijk Nederlands voor iemand zonder tradingkennis: welke signalen de
doorslag gaven, zonder formules, losse letters of afkortingen en zonder Engelse termen.`;

// Context voor de winstcheck. risk is optioneel (zelfde vorm als bij buildPrompt).
export function buildExitPrompt({ pair, timeframe, position, price, indicators, recentCandles, feePct = 0.25, risk = null }) {
  const ind = indicators ?? {};
  const change = ((price - position.entryPrice) / position.entryPrice) * 100;
  const top = Math.max(position.highest ?? position.entryPrice, price);
  const peakGain = ((top - position.entryPrice) / position.entryPrice) * 100;
  const gaveBack = peakGain > 0 ? ((peakGain - change) / peakGain) * 100 : 0;
  const minutes = position.openedAt ? Math.round((Date.now() - Date.parse(position.openedAt)) / 60000) : null;
  const rk = riskOf(risk ?? { feePct }, ind.atrPct);
  const feesPct = rk?.feesPct ?? feePct * 2;
  const stopPct = rk?.stopPct ?? null;
  const st = candleStats(recentCandles, price, ind.atrPct);

  // Zwaktesignalen uit de laatste candles (de laatste loopt nog).
  const c = (recentCandles ?? []).slice(-6);
  const signals = [];
  const add = (weak, text) => signals.push(`${weak == null ? '?' : weak ? '⚠' : '✓'} ${text}`);
  if (c.length >= 4) {
    const highs = c.map((x) => x[2]);
    const lowerHighs = highs.at(-1) < highs.at(-2) && highs.at(-2) < highs.at(-3);
    const body = (x) => Math.abs(x[4] - x[1]);
    const bodiesShrink = body(c.at(-1)) < body(c.at(-2)) && body(c.at(-2)) < body(c.at(-3));
    const wick = (x) => (x[2] - Math.max(x[1], x[4])) / ((x[2] - x[3]) || 1);
    const longWicks = c.slice(-3).filter((x) => wick(x) > 0.5).length >= 2;
    let reds = 0;
    for (let i = c.length - 1; i >= 0 && c[i][4] < c[i][1]; i--) reds++;
    const volFalling = c.at(-1)[5] < c.at(-2)[5] && c.at(-2)[5] < c.at(-3)[5];
    add(lowerHighs, 'lagere highs in de laatste 3 candles');
    add(bodiesShrink, 'candles worden kleiner (momentum zwakt af)');
    add(longWicks, 'lange bovenwieken (verkopers drukken de koers terug)');
    add(reds >= 2, `${reds} rode candle(s) op rij`);
    add(volFalling, 'volume daalt 3 candles op rij');
  }
  add(ind.rsi == null ? null : ind.rsi >= 70, `RSI ${fx(ind.rsi, 1)} (≥ 70 = oververhit)`);
  add(ind.emaFast == null || ind.emaSlow == null ? null : ind.emaFast < ind.emaSlow, `EMA fast ${ind.emaFast > ind.emaSlow ? 'boven' : 'onder'} EMA slow`);
  const weakCount = signals.filter((x) => x.startsWith('⚠')).length;

  const avgV6 = c.reduce((a, x) => a + x[5], 0) / (c.length || 1);
  const rows = c.map((x, i) => {
    const prev = i ? c[i - 1][4] : x[1];
    return `${sgn(((x[4] - prev) / prev) * 100)}% ${x[4] >= x[1] ? 'groen' : 'rood'}, bovenwiek ${fx(Math.max(0, ((x[2] - Math.max(x[1], x[4])) / x[4]) * 100))}%, vol ${fx(avgV6 ? x[5] / avgV6 : null, 1)}×`;
  }).join('\n');

  return `Pair: ${pair} · timeframe ${timeframe} · open sinds ${minutes == null ? 'onbekend' : `${minutes} min`}

== Positie ==
Instap ${px(position.entryPrice)} · nu ${px(price)} · resultaat ${sgn(change)}% (na kosten ± ${sgn(change - feesPct)}%)${stopPct ? ` = ${sgn(change / stopPct)}R (1R = ${fx(stopPct)}%)` : ''}
Hoogste winst ${sgn(peakGain)}% · daarvan teruggegeven: ${fx(gaveBack, 0)}%
${st ? (st.brokeHigh ? 'Koers staat boven de vorige high: geen directe weerstand' : `Vorige high (weerstand) ${fx(st.toHighPct)}% boven de koers (${fx(st.toHighAtr, 1)} ATR)${st.toHighAtr != null && st.toHighAtr <= 0.5 ? ' ⚠ vlak eronder' : ''}`) : ''}

== Momentum (${weakCount} ${weakCount === 1 ? 'zwaktesignaal' : 'zwaktesignalen'}) ==
${signals.join('\n')}
ADX ${fx(ind.adx, 1)} · volume laatste candle ${volumeText(ind.volumeRatio)}

== Laatste candles (oud → nieuw, de laatste loopt nog) ==
${rows || 'geen'}`;
}

export function parseExit(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const obj = extractJson(text);
  if (!obj) throw new Error(`Geen JSON in AI-antwoord: "${String(text).replace(/\s+/g, ' ').slice(0, 120)}"`);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['sell', 'hold'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: reasonOf(obj) };
}

// Gooit nooit. Lukt geen enkel model, dan "hold" met error: true (de regels blijven gelden).
export async function askExitChain(chain, context) {
  if (!chain.length) return { decision: 'hold', reason: 'Geen AI ingesteld', provider: 'none', error: true };
  const prompt = buildExitPrompt(context);
  try {
    const r = await runChain(chain, async (cfg) => parseExit(await callModel(cfg, prompt, { system: EXIT_PROMPT })));
    return { ...r.result, provider: aiLabel(r.cfg), usedSlot: r.cfg.slot, fallbackErrors: r.errors };
  } catch (err) {
    return { decision: 'hold', reason: `Alle AI-modellen faalden: ${err.message}`, provider: 'geen', error: true, chainErrors: err.chainErrors ?? [] };
  }
}

// Probeert de modellen op volgorde. Gooit fn een fout (verbinding, quota, time-out,
// onleesbaar antwoord), dan volgt het volgende model. Lukt geen enkele, dan gooit runChain
// een fout met chainErrors: [{ slot, label, error }].
export async function runChain(chain, fn) {
  const errors = [];
  for (const cfg of chain) {
    if (!cfg.apiKey) {
      errors.push({ slot: cfg.slot, label: aiLabel(cfg), error: 'Geen API-key ingesteld' });
      continue;
    }
    try {
      return { result: await fn(cfg), cfg, errors };
    } catch (err) {
      errors.push({ slot: cfg.slot, label: aiLabel(cfg), error: err.message });
    }
  }
  const e = new Error(errors.map((x) => `${x.label}: ${x.error}`).join(' | ') || 'Geen AI ingesteld');
  e.chainErrors = errors;
  throw e;
}

// ---------- Team van drie: analist, criticus, beslisser ----------
// Drie rollen, elk met een eigen model uit de volgorde (model 1, 2 en 3). Heb je er minder,
// dan speelt een model meerdere rollen. Faalt een model, dan neemt het volgende in de volgorde
// die rol over. Alleen de beslisser antwoordt met JSON; de anderen schrijven gewone tekst.
export const TEAM_ROLES = [
  { key: 'analyst', label: 'Analist' },
  { key: 'critic', label: 'Criticus' },
  { key: 'decider', label: 'Beslisser' },
];

const ANALYST_PROMPT = `Je bent de ANALIST in een team van drie AI's dat beslist of een crypto trading bot een positie opent.
Je krijgt de marktdata bij een koopsignaal. Schrijf een beknopte, eerlijke analyse voor je teamgenoten:
- het marktbeeld en de trend (ook de hogere timeframe en Bitcoin);
- momentum en volume: zet de stijging door of zwakt hij af?
- waar de eerstvolgende weerstand ligt en hoeveel ruimte er naar boven is;
- je schatting van de winstkans (in %) en de verwachte winst als "x keer het risico", na kosten;
- je voorlopige advies: kopen of niet, en waarom.
Houd je aan de cijfers in de data; verzin niets. Je bepaalt geen bedragen of stops.
Schrijf in gewoon Nederlands, maximaal 8 zinnen, zonder opsommingstekens of kopjes, zonder JSON.`;

const CRITIC_PROMPT = `Je bent de CRITICUS in een team van drie AI's dat beslist of een crypto trading bot een positie opent.
Je krijgt de marktdata en de analyse van de analist. Jouw taak is advocaat van de duivel:
- controleer de cijfers van de analist tegen de data; noem elke fout of overdreven schatting;
- zoek de sterkste redenen waarom deze trade verlies kan opleveren (valse uitbraak, te laat, te weinig
  volume, weerstand vlakbij, kosten te hoog ten opzichte van het risico, harde filters met ✗);
- zeg ook eerlijk als je weinig tegenargumenten vindt.
Sluit af met jouw schatting van de winstkans (in %) en of je het advies van de analist steunt.
Schrijf in gewoon Nederlands, maximaal 8 zinnen, zonder opsommingstekens of kopjes, zonder JSON.`;

const DECIDER_PROMPT = `${SYSTEM_PROMPT}

Je bent de BESLISSER in een team van drie AI's. Je krijgt de marktdata, de analyse van de analist en de
kritiek van de criticus. Weeg beide eerlijk af tegen de data en tegen de regels hierboven; volg niet
blind de analist of de criticus. Noem in je reden kort welk argument de doorslag gaf.`;

// Geeft de modellen voor een rol: het toegewezen model eerst, daarna de rest als reserve.
function roleChain(chain, index) {
  const usable = chain.filter((c) => c.apiKey);
  if (!usable.length) return chain;
  const start = index % usable.length;
  return [...usable.slice(start), ...usable.slice(0, start)];
}

// Gooit nooit. Geeft de beslissing plus het hele gesprek (transcript) terug.
export async function askTeamChain(chain, failMode, context) {
  if (!chain.length) return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none', transcript: [] };
  const data = buildPrompt(context);
  const transcript = [];
  const errors = [];
  const say = async (roleIndex, system, prompt, json, parse) => {
    const role = TEAM_ROLES[roleIndex];
    const started = Date.now();
    const r = await runChain(roleChain(chain, roleIndex), async (cfg) => {
      const raw = await callModel(cfg, prompt, { system, json, temperature: roleIndex === 2 ? 0.1 : 0.3 });
      return parse ? parse(raw) : cleanText(raw);
    });
    errors.push(...r.errors);
    const text = parse ? r.result.reason : r.result;
    transcript.push({ role: role.key, label: role.label, model: aiLabel(r.cfg), ms: Date.now() - started, text, ...(parse ? { decision: r.result.decision } : {}) });
    return r.result;
  };

  // Harde filters met een kruisje: dan staat de uitkomst al vast; geen drie AI-vragen verspillen.
  const hard = data.split('\n').filter((l) => l.startsWith('✗ ')).map((l) => l.slice(2).trim());
  if (hard.length) {
    const reason = `Afgewezen op ${hard.length === 1 ? 'een harde eis' : `${hard.length} harde eisen`}: ${hard.join('; ')}.`;
    transcript.push({ role: 'filters', label: 'Harde filters', model: 'vetobot', ms: 0, text: reason, decision: 'reject' });
    return { decision: 'reject', reason, provider: 'team (harde filters)', transcript, skipped: true };
  }

  try {
    const analysis = await say(0, ANALYST_PROMPT, data, false);
    const critique = await say(1, CRITIC_PROMPT, `${data}\n\n== Analyse van de analist ==\n${analysis}`, false);
    const verdict = await say(2, DECIDER_PROMPT, `${data}\n\n== Analyse van de analist ==\n${analysis}\n\n== Kritiek van de criticus ==\n${critique}`, true, parseDecision);
    return { ...verdict, provider: `team: ${transcript.map((t) => t.model).join(' → ')}`, usedSlot: null, fallbackErrors: errors, transcript };
  } catch (err) {
    const decision = failMode === 'approve' ? 'approve' : 'reject';
    transcript.push({ role: 'error', label: 'Fout', model: 'vetobot', ms: 0, text: `Het team kon geen besluit nemen: ${err.message}` });
    return { decision, reason: `Team-AI faalde, fail-mode "${decision}"`, provider: 'geen', error: true, chainErrors: err.chainErrors ?? [], transcript };
  }
}

// Gewone tekst van een rol: denkblokken weg, en niet eindeloos lang.
function cleanText(raw) {
  const t = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!t) throw new Error('Leeg antwoord');
  return t.slice(0, 2500);
}

// Veto via de volgorde. Een afwijzing is een geldig antwoord; alleen fouten gaan door naar het volgende model.
// Geeft altijd een beslissing terug en gooit nooit.
export async function askVetoChain(chain, failMode, context) {
  if (!chain.length) return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none' };
  const prompt = buildPrompt(context);
  try {
    const r = await runChain(chain, async (cfg) => parseDecision(await callModel(cfg, prompt)));
    return { ...r.result, provider: aiLabel(r.cfg), usedSlot: r.cfg.slot, fallbackErrors: r.errors };
  } catch (err) {
    const decision = failMode === 'approve' ? 'approve' : 'reject';
    return { decision, reason: `Alle AI-modellen faalden, fail-mode "${decision}"`, provider: 'geen', error: true, chainErrors: err.chainErrors ?? [] };
  }
}

export async function writeSummaryChain(chain, data) {
  if (!chain.length) return null;
  const r = await runChain(chain, async (cfg) => {
    const res = await writeSummary(cfg, data);
    if (!res?.analysis) throw new Error('Leeg antwoord');
    return res;
  });
  return { ...r.result, model: aiLabel(r.cfg), fallbackErrors: r.errors };
}

// Test elk model in de volgorde los, zodat je ziet welke werken.
export async function testChain(chain, context) {
  const out = [];
  for (const cfg of chain) {
    try {
      out.push({ slot: cfg.slot, label: aiLabel(cfg), ok: true, ...(await testConnection(cfg, context)) });
    } catch (err) {
      out.push({ slot: cfg.slot, label: aiLabel(cfg), ok: false, error: err.message });
    }
  }
  return out;
}

// Geeft altijd { decision, reason, provider, error? } terug en gooit nooit.
export async function askVeto(cfg, context) {
  if (cfg.provider === 'none') {
    return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none' };
  }
  if (!cfg.apiKey) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return { decision, reason: `Geen AI-key ingesteld in het dashboard, fail-mode "${decision}"`, provider: cfg.provider, error: true };
  }
  const prompt = buildPrompt(context);
  try {
    const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt) : await askOpenAICompatible(cfg, prompt);
    return { ...parseDecision(text), provider: cfg.provider };
  } catch (err) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return {
      decision,
      reason: `AI-fout, fail-mode "${decision}": ${err.message}`,
      provider: cfg.provider,
      error: true,
    };
  }
}
