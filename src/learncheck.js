// "Leert hij echt?": zes controles of het leren werkt en iets oplevert, met een totaaloordeel.
//
// Alleen rekenwerk (pure functies), zodat alles makkelijk te testen is. Het verzamelen van de gegevens
// (leerserver, trades van de bot) gebeurt in BotManager.learnCheck (src/manager.js); meldingen ook daar.
//
// Elke controle geeft { key, title, status, text, action, progress? }:
//   status 'ok' (✅), 'warn' (⚠️), 'bad' (❌) of 'nodata' (nog te weinig data, progress = { have, need }).
//
// Bronnen per controle:
//   1. training  leerrondes in de laatste 24 uur: GET /learnstats van de leerserver (uit het modelregister;
//                oudere leerserver zonder /learnstats: de sessies uit GET /registry).
//   2. feedback  trades van de AI-trader in de bot (paper, live en de verkenner) tegenover wat de leerserver
//                ontving (GET /learnstats → agentTrades), en of het versturen (BotManager.flushFeedback) lukt.
//   3. versions  het modelregister (GET /registry): is de actieve versie gekozen met de statistische toets
//                op de eindtest (stat_test in trainer/server.py), en haalde ze de proefperiode (probation)?
//   4. practice  de echte trades van de bot met het recept van de actieve versie, zolang die actief was,
//                tegenover wat de eindtest beloofde (zoals trainer/probation.py, maar met een t-toets).
//   5. trend     gemiddelde winst per trade (pnlPct, na kosten): laatste 30 dagen tegenover de 30 daarvoor.
//   6. error     gemiddelde absolute fout van de verwachting (agent.expectedPct tegenover pnlPct), idem.
// Bij 4–6 tellen alleen echte trades van de AI-trader (paper en live; geen verkenner, geen handmatige verkoop).
import { meanUpper, welch } from './stats.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

// Drempels (één plek, zodat ze in de uitleg en de tests hetzelfde zijn).
export const LEARN_CHECK = {
  roundWindowHours: 24,        // 1. ❌ als er zo lang geen leerronde was terwijl leren aan staat
  feedbackWindowDays: 3,       // 2. ❌ als de bot in deze periode trades had en de leerserver niets ontving
  feedbackGraceMinutes: 30,    // 2. trades die net gesloten zijn, kunnen nog onderweg zijn: die tellen niet mee
  feedbackFailHours: 6,        // 2. ❌ als het versturen naar de leerserver al zo lang mislukt
  rollbackRecentDays: 7,       // 3. ❌ zolang een automatische terugzetting (proef gezakt) zo recent is
  staleVersionDays: 30,        // 3. ⚠️ (geen fout) als er zo lang geen nieuwe versie gepromoot is
  practiceMinTrades: 30,       // 4. minimaal zoveel echte trades van de actieve versie (en apart voor live)
  confidence: 0.95,            // 4–6. eenzijdige toetsen met 95% betrouwbaarheid
  trendDays: 30,               // 5–6. laatste 30 dagen tegenover de 30 daarvoor
  trendMinTrades: 20,          // 5–6. minimaal zoveel trades in elke periode
  realertDays: 7,              // meldingen: een ❌ opnieuw melden pas na herstel of na 7 dagen
  cacheMinutes: 5,             // gegevens van de leerserver zo lang bewaren
};

export const LEARN_TITLES = {
  training: 'Leerserver traint',
  feedback: 'Nieuwe leerstof komt aan',
  versions: 'Nieuwe versies zijn aantoonbaar beter',
  practice: 'Praktijk haalt de belofte',
  trend: 'Resultaat wordt beter',
  error: 'Voorspelling wordt scherper',
};

export const STATUS_ICON = { ok: '✅', warn: '⚠️', bad: '❌', nodata: '⏳' };

// ---------- opmaak ----------
const nl = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(d).replace('.', ','));
const pct = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nl(Math.abs(v), d)}%`);
const pp = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nl(Math.abs(v), d)} %-punt`);
const ago = (h) => (h == null ? 'nooit' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min geleden` : h < 48 ? `${Math.round(h)} uur geleden` : `${Math.round(h / 24)} dagen geleden`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const make = (key, status, text, action = null, extra = {}) => ({ key, title: LEARN_TITLES[key], status, text, action, ...extra });
const nodata = (key, have, need, text, action = null) => make(key, 'nodata', text, action, { progress: { have, need } });

// ---------- trades ----------
const ts = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
// Een afgesloten trade van de AI-trader (geen handmatige verkoop).
const agentTrade = (t) => t && t.agent && Number.isFinite(t.pnlPct) && ts(t.closedAt) != null && !/^Handmatig/.test(String(t.exitReason ?? ''));
// Echte trade van de AI-trader zelf (geen verkenner, niet virtueel).
const realAgentTrade = (t) => agentTrade(t) && !t.agent.explore && !t.virtual;

// ---------- 1. Leerserver traint ----------
function trainerProblem(trainer) {
  if (!trainer?.configured) return { text: 'Er is geen leerserver gekoppeld, dus er wordt niets geleerd.', action: 'Vul het adres en de code van de leerserver in bij Instellingen → Trainer-koppeling.' };
  if (!trainer.stats && !trainer.registry) {
    const why = trainer.statsError || trainer.registryError || 'geen antwoord';
    return { text: `De leerserver is niet bereikbaar (${why}), dus dit is nu niet na te gaan.`, action: 'Kijk of de leerserver draait en of adres en code kloppen (Trainer → Leerserver).' };
  }
  return null;
}

export function checkTraining({ trainer, now = Date.now() }) {
  const C = LEARN_CHECK;
  const prob = trainerProblem(trainer);
  if (prob) return make('training', 'warn', prob.text, prob.action, { unreachable: true });
  const s = trainer.stats;
  if (s?.rounds) {
    const n = s.rounds.lastDay ?? 0;
    if (!s.enabled) return make('training', 'warn', `Leren staat uit op de leerserver (laatste leerronde ${ago(s.rounds.ageHours)}).`, 'Zet de AI-trader aan bij Trainer → Leerserver als hij moet blijven leren.', { off: true });
    if (n > 0) return make('training', 'ok', `${plural(n, 'leerronde', 'leerrondes')} in de laatste ${C.roundWindowHours} uur (laatste ${ago(s.rounds.ageHours)}).`);
    return make('training', 'bad', s.rounds.lastAt
      ? `Al ${ago(s.rounds.ageHours).replace(' geleden', '')} geen leerronde, terwijl leren aan staat.`
      : 'Er is nog nooit een leerronde geweest, terwijl leren aan staat.',
    'Kijk bij Trainer → Leerserver of hij vastzit of geen data krijgt (logs van de leerserver); herstart hem zo nodig.');
  }
  // Oudere leerserver zonder /learnstats: de sessies uit het modelregister (met de klok van de bot).
  const rounds = (trainer.registry?.versions ?? []).filter((v) => v.decision !== 'rollback').map((v) => ts(v.at)).filter((t) => t != null);
  const n = rounds.filter((t) => t > now - C.roundWindowHours * HOUR).length;
  const age = rounds.length ? (now - Math.max(...rounds)) / HOUR : null;
  const old = 'De leerserver is te oud voor een exacte meting (werk hem bij).';
  if (n > 0) return make('training', 'ok', `${plural(n, 'leerronde', 'leerrondes')} in de laatste ${C.roundWindowHours} uur (laatste ${ago(age)}). ${old}`);
  return make('training', 'warn', `Geen leerronde in de laatste ${C.roundWindowHours} uur (laatste ${ago(age)}). ${old} Of leren aan staat, is zo niet te zien.`,
    'Werk de leerserver bij en kijk bij Trainer → Leerserver of leren aan staat.');
}

// ---------- 2. Nieuwe leerstof komt aan ----------
// Andere beurs: ' op Bybit' in de teksten. Bitvavo: leeg, zodat de teksten precies blijven zoals ze waren.
const VENUE_LABEL = { bitvavo: 'Bitvavo', bybit: 'Bybit' };
const venueText = (venue) => (venue && venue !== 'bitvavo' ? ` op ${VENUE_LABEL[venue] ?? venue}` : '');

export function checkFeedback({ trainer, feedback = {}, trades = [], virtualTrades = [], now = Date.now(), venue = 'bitvavo' }) {
  const C = LEARN_CHECK;
  const from = now - C.feedbackWindowDays * DAY;
  const to = now - C.feedbackGraceMinutes * 60000;
  const mine = [...trades, ...virtualTrades].filter((t) => agentTrade(t) && ts(t.closedAt) > from && ts(t.closedAt) <= to).length;
  const failingH = feedback.error && feedback.queued > 0 && ts(feedback.errorSince) != null ? (now - ts(feedback.errorSince)) / HOUR : null;
  if (failingH != null && failingH >= C.feedbackFailHours) {
    return make('feedback', 'bad', `Trades naar de leerserver sturen mislukt al ${Math.round(failingH)} uur (${feedback.error}); ${plural(feedback.queued, 'trade wacht', 'trades wachten')}.`,
      'Kijk of de leerserver bereikbaar is (Trainer → Leerserver). Er gaat niets verloren: de trades wachten in de wachtrij.');
  }
  if (!trainer?.configured) return make('feedback', 'warn', 'Er is geen leerserver gekoppeld, dus je trades worden niet gebruikt om van te leren.', 'Koppel een leerserver bij Instellingen → Trainer-koppeling.');
  const got = trainer.stats?.agentTrades;
  if (!got) {
    const why = trainer.statsError ? `de leerserver gaf geen telling (${trainer.statsError})` : 'de leerserver gaf geen telling';
    return make('feedback', 'warn', `Niet na te gaan of je trades aankomen: ${why}. Is de leerserver bijgewerkt?`, 'Werk de leerserver bij (docker compose pull vetobot-trainer).');
  }
  const failing = failingH != null ? ` Versturen mislukt nu (${feedback.error}); de bot probeert het opnieuw.` : '';
  const on = venueText(venue);
  const recv = `De leerserver ontving er ${got.recent ?? 0}${on} in de laatste ${C.feedbackWindowDays} dagen (alle bots samen; laatste ${ago(got.ageHours)}).`;
  if (!mine) {
    return nodata('feedback', 0, 1, `Je bot sloot de laatste ${C.feedbackWindowDays} dagen geen trades van de AI-trader${on}, dus er was niets te versturen. ${recv}${failing}`);
  }
  if (!(got.recent > 0)) {
    return make('feedback', 'bad', `Je bot sloot ${plural(mine, 'trade', 'trades')} van de AI-trader${on} in de laatste ${C.feedbackWindowDays} dagen, maar de leerserver ontving niets nieuws (laatste ${ago(got.ageHours)}).${failing}`,
      'Kijk bij Trainer → Leerserver of de feedback binnenkomt; staan er trades in de wachtrij, dan lukt het versturen niet.');
  }
  return make('feedback', failing ? 'warn' : 'ok', `Je bot sloot ${plural(mine, 'trade', 'trades')} van de AI-trader${on} in de laatste ${C.feedbackWindowDays} dagen. ${recv}${failing}`);
}

// ---------- 3. Nieuwe versies zijn aantoonbaar beter ----------
const keyOf = (v) => v?.publishedKey || v?.recipeKey || null;

// Hoe kwam deze versie in gebruik? Volgt hertrainingen van hetzelfde recept terug tot de echte keuze.
export function provenance(v, versions, depth = 0) {
  const r = String(v?.reason ?? '');
  if (/zekerheid beter/.test(r)) {
    const m = r.match(/met [\d,.]+% zekerheid beter: [^()]*(\([^)]*\))?/);
    return { kind: 'test', version: v.version, text: m ? m[0] : 'statistische toets op de eindtest gehaald' };
  }
  if (/^hetzelfde recept opnieuw getraind/.test(r)) {
    const prev = versions.filter((x) => x.version < v.version && x.decision === 'promoted' && keyOf(x) === keyOf(v)).sort((a, b) => b.version - a.version)[0];
    if (!prev || depth > 100) return { kind: 'unknown', version: v.version, text: 'hertraining van een recept waarvan de oorspronkelijke keuze niet meer in het register staat' };
    return { ...provenance(prev, versions, depth + 1), retrained: true };
  }
  if (/eerste model|model dat al in gebruik was/.test(r)) return { kind: 'first', version: v.version, text: r };
  return { kind: 'untested', version: v.version, text: r || 'onbekende reden' };
}

export function checkVersions({ trainer, now = Date.now() }) {
  const C = LEARN_CHECK;
  const prob = trainerProblem(trainer);
  if (prob) return make('versions', 'warn', prob.text, prob.action);
  const reg = trainer.registry;
  if (!reg) return make('versions', 'warn', `Het modelregister is niet op te halen (${trainer.registryError ?? 'onbekend'}).`, 'Werk de leerserver bij.');
  const versions = reg.versions ?? [];
  const act = versions.find((v) => v.active) ?? versions.find((v) => v.version === reg.active);
  if (!act) return nodata('versions', 0, 1, 'Er is nog geen gepromote versie; de leerserver heeft nog geen model gekozen.');
  const name = `v${act.version}`;
  const p = act.probation ?? {};
  const probTxt = p.status === 'proef' ? ` Op proef: ${p.trades ?? 0} van ${p.need ?? '?'} echte trades.` : p.status === 'geslaagd' ? ' Proefperiode geslaagd.' : '';
  if (p.status === 'mislukt') {
    return make('versions', 'bad', `De actieve versie ${name} haalde haar proefperiode niet (${p.reason ?? 'slechter dan beloofd'}) en is nog in gebruik.`,
      reg.pinned === act.version ? 'Je hebt deze versie zelf vastgezet: maak hem los of zet een eerdere versie terug (Learning → Modelprestaties).' : 'Zet een eerdere versie terug bij Learning → Modelprestaties.');
  }
  // Automatisch teruggezet omdat een nieuwe versie haar proef niet haalde (en daarna geen nieuwe promotie).
  const events = versions.filter((v) => (v.decision === 'promoted' && v.hasSnapshot !== false) || (v.decision === 'rollback' && v.restoredVersion != null)).sort((a, b) => b.version - a.version);
  const lastEvent = events[0];
  if (lastEvent?.decision === 'rollback' && lastEvent.failedVersion != null && ts(lastEvent.at) > now - C.rollbackRecentDays * DAY) {
    return make('versions', 'bad', `Versie v${lastEvent.failedVersion} haalde haar proefperiode niet en is automatisch teruggezet naar v${lastEvent.restoredVersion} (${Math.max(0, Math.round((now - ts(lastEvent.at)) / DAY))} dagen geleden). Een nieuwe versie bleek in de praktijk slechter dan de eindtest beloofde.`,
      'Geen actie nodig voor de veiligheid (hij gebruikt weer de vorige versie). Blijft dit gebeuren, kijk dan bij Learning welke recepten zakken.');
  }
  if (reg.pinned != null && reg.pinned === act.version) {
    return make('versions', 'warn', `Je hebt ${name} zelf vastgezet; de leerserver promoveert zolang geen nieuwe versie.${probTxt}`, 'Maak de versie los bij Learning → Modelprestaties als hij weer zelf mag kiezen.');
  }
  const prov = provenance(act, versions);
  const promoted = versions.filter((v) => v.decision === 'promoted').map((v) => ts(v.at)).filter((t) => t != null);
  const lastPromo = promoted.length ? Math.max(...promoted) : null;
  const staleDays = lastPromo != null ? (now - lastPromo) / DAY : null;
  const stale = staleDays != null && staleDays >= C.staleVersionDays
    ? ` Al ${Math.round(staleDays)} dagen geen nieuwe versie: geen kandidaat was aantoonbaar beter (geen fout).` : '';
  if (prov.kind === 'untested') {
    return make('versions', 'bad', `De actieve versie ${name} is in gebruik zonder de statistische toets op de eindtest: ${prov.text}.${probTxt}`,
      'Werk de leerserver bij; de volgende promotie gaat dan via de toets. Twijfel je, zet dan een getoetste versie terug bij Learning.');
  }
  if (prov.kind === 'first') {
    return make('versions', 'warn', `De actieve versie ${name} is het eerste model: er was niets om mee te vergelijken, dus nog geen bewijs dat een nieuwe versie beter is.${probTxt}${stale}`);
  }
  if (prov.kind === 'unknown') return make('versions', 'warn', `Niet na te gaan hoe ${name} gekozen werd: ${prov.text}.${probTxt}${stale}`);
  const via = prov.retrained ? `een hertraining van v${prov.version}, dat gekozen werd ${prov.text}` : `gekozen ${prov.text}`;
  return make('versions', stale ? 'warn' : 'ok', `De actieve versie ${name} is ${via} (statistische toets op eindtestdata die het model nooit zag).${probTxt}${stale}`);
}

// ---------- 4. Praktijk haalt de belofte ----------
// Wanneer welke versie actief was, oud → nieuw: [{ at, version, key }] (zoals Registry.activations).
export function activations(versions) {
  return [...versions].sort((a, b) => a.version - b.version).flatMap((v) => {
    if (v.decision === 'promoted' && v.hasSnapshot !== false) return [{ at: ts(v.at), version: v.version, key: keyOf(v) }];
    if (v.decision === 'rollback' && v.restoredVersion != null) return [{ at: ts(v.at), version: Number(v.restoredVersion), key: keyOf(v) }];
    return [];
  }).filter((a) => a.at != null);
}

export function expectedOf(v) {
  for (const x of [v?.probation?.expectedPct, v?.expectedPct, v?.practice?.expectedPct, v?.metrics?.score?.testAvg]) {
    if (x != null && Number.isFinite(Number(x))) return Number(x);
  }
  return null;
}

function practiceTest(pcts, expected, label) {
  const C = LEARN_CHECK;
  const r = meanUpper(pcts, C.confidence);
  const bad = r.upper != null && r.upper < expected;
  return { ...r, bad, text: `${label}: gemiddeld ${pct(r.mean)} per trade over ${r.n} trades (met ${C.confidence * 100}% zekerheid hooguit ${pct(r.upper)})` };
}

export function checkPractice({ trainer, trades = [], now = Date.now() }) {
  const C = LEARN_CHECK;
  void now;
  const prob = trainerProblem(trainer);
  if (prob) return make('practice', 'warn', prob.text, prob.action);
  const versions = trainer.registry?.versions;
  if (!versions) return make('practice', 'warn', `Het modelregister is niet op te halen (${trainer.registryError ?? 'onbekend'}), dus de actieve versie is onbekend.`);
  const act = versions.find((v) => v.active) ?? versions.find((v) => v.version === trainer.registry.active);
  if (!act) return nodata('practice', 0, C.practiceMinTrades, 'Er is nog geen gepromote versie om te vergelijken.');
  const acts = activations(versions);
  const windows = acts.map((a, i) => ({ ...a, end: acts[i + 1]?.at ?? null })).filter((w) => w.version === act.version && w.key);
  if (!windows.length) windows.push({ at: ts(act.at) ?? 0, end: null, key: keyOf(act) });
  const rows = trades.filter((t) => {
    if (!realAgentTrade(t)) return false;
    const open = ts(t.openedAt) ?? ts(t.closedAt);
    return windows.some((w) => t.agent.recipe === w.key && open >= w.at && (w.end == null || open < w.end));
  });
  const exp = expectedOf(act);
  const promise = exp != null ? `de eindtest beloofde ${pct(exp)} per trade` : 'de belofte van de eindtest is onbekend, dus vergeleken met 0%';
  const target = exp ?? 0;
  const live = rows.filter((t) => t.mode === 'live').map((t) => t.pnlPct);
  if (rows.length < C.practiceMinTrades) {
    return nodata('practice', rows.length, C.practiceMinTrades, `${plural(rows.length, 'echte trade', 'echte trades')} met v${act.version} (minstens ${C.practiceMinTrades} nodig voor een toets); ${promise}.`);
  }
  const all = practiceTest(rows.map((t) => t.pnlPct), target, `Paper en live samen (v${act.version})`);
  const parts = [all];
  if (live.length >= C.practiceMinTrades) parts.push(practiceTest(live, target, 'Alleen live'));
  const liveNote = live.length && live.length < C.practiceMinTrades ? ` Live: ${plural(live.length, 'trade', 'trades')} (te weinig voor een aparte toets).` : '';
  const text = `${parts.map((x) => x.text).join('. ')}; ${promise}.${liveNote}`;
  if (parts.some((x) => x.bad)) {
    return make('practice', 'bad', `Aantoonbaar slechter dan beloofd. ${text}`, 'De proefperiode zet een versie die slechter is dan beloofd vanzelf terug. Gebeurt dat niet (vastgezet?), kijk dan bij Learning → Praktijk tegen verwachting.');
  }
  return make('practice', 'ok', `Niet aantoonbaar slechter dan beloofd. ${text}`);
}

// ---------- 5 en 6. Laatste 30 dagen tegenover de 30 daarvoor ----------
function periods(trades, now, value) {
  const C = LEARN_CHECK;
  const span = C.trendDays * DAY;
  const recent = [], before = [];
  for (const t of trades) {
    if (!realAgentTrade(t)) continue;
    const x = value(t);
    if (x == null || !Number.isFinite(x)) continue;
    const at = ts(t.closedAt);
    if (at > now - span && at <= now) recent.push(x);
    else if (at > now - 2 * span && at <= now - span) before.push(x);
  }
  return { recent, before };
}

export function checkTrend({ trades = [], now = Date.now() }) {
  const C = LEARN_CHECK;
  const { recent, before } = periods(trades, now, (t) => t.pnlPct);
  const need = C.trendMinTrades;
  if (recent.length < need || before.length < need) {
    const have = Math.min(recent.length, before.length);
    return nodata('trend', have, need, `Laatste ${C.trendDays} dagen ${plural(recent.length, 'trade', 'trades')}, de ${C.trendDays} dagen daarvoor ${before.length}; minstens ${need} per periode nodig.`);
  }
  const w = welch(recent, before, C.confidence);
  const text = `Gemiddeld ${pct(w.a.mean)} per trade in de laatste ${C.trendDays} dagen (${w.a.n} trades) tegenover ${pct(w.b.mean)} daarvoor (${w.b.n} trades): ${pp(w.diff)}`;
  if (w.lower > 0) return make('trend', 'ok', `Aantoonbaar beter. ${text}, met ${C.confidence * 100}% zekerheid minstens ${pp(w.lower)}.`);
  if (w.upper < 0) return make('trend', 'bad', `Aantoonbaar slechter. ${text}, met ${C.confidence * 100}% zekerheid minstens ${pp(-w.upper).replace(/^\+/, '')} lager.`,
    'Kijk bij Learning welke recepten en marktfases verliezen; overweeg minder inzet of minder recepten live tot het weer beter gaat.');
  return make('trend', 'warn', `Geen aantoonbaar verschil. ${text} (kan toeval zijn).`);
}

export function checkError({ trades = [], now = Date.now() }) {
  const C = LEARN_CHECK;
  const { recent, before } = periods(trades, now, (t) => (Number.isFinite(t.agent?.expectedPct) ? Math.abs(t.pnlPct - t.agent.expectedPct) : null));
  const need = C.trendMinTrades;
  if (recent.length < need || before.length < need) {
    const have = Math.min(recent.length, before.length);
    return nodata('error', have, need, `Trades met een verwachting: laatste ${C.trendDays} dagen ${recent.length}, de ${C.trendDays} dagen daarvoor ${before.length}; minstens ${need} per periode nodig.`);
  }
  const w = welch(recent, before, C.confidence);
  const text = `Gemiddeld ${nl(w.a.mean)} %-punt naast de verwachting in de laatste ${C.trendDays} dagen (${w.a.n} trades) tegenover ${nl(w.b.mean)} daarvoor (${w.b.n} trades)`;
  if (w.upper < 0) return make('error', 'ok', `Aantoonbaar scherper. ${text}.`);
  if (w.lower > 0) return make('error', 'bad', `Aantoonbaar minder scherp. ${text}.`,
    'De markt gedraagt zich mogelijk anders dan in de training. Kijk bij Learning of de nieuwste versie later is getraind en of de proef loopt.');
  return make('error', 'warn', `Geen aantoonbaar verschil. ${text} (kan toeval zijn).`);
}

// ---------- totaal ----------
export const VERDICTS = {
  bad: 'Er is iets mis met het leren',
  better: 'Hij leert en wordt beter',
  learning: 'Hij leert, nog geen bewijs dat hij beter wordt',
  unknown: 'Niet na te gaan of hij leert',
};

export function verdict(checks) {
  const by = Object.fromEntries(checks.map((c) => [c.key, c]));
  const bad = checks.filter((c) => c.status === 'bad');
  if (bad.length) return { level: 'bad', key: 'bad', text: VERDICTS.bad, detail: bad.map((c) => c.title).join(', ') };
  if (by.training?.status !== 'ok') return { level: 'warn', key: 'unknown', text: VERDICTS.unknown, detail: by.training?.text ?? '' };
  if (by.trend?.status === 'ok') return { level: 'ok', key: 'better', text: VERDICTS.better, detail: by.trend.text };
  return { level: 'warn', key: 'learning', text: VERDICTS.learning, detail: 'het resultaat is (nog) niet aantoonbaar beter dan de maand ervoor' };
}

export function evaluate(input) {
  const now = input.now ?? Date.now();
  const x = { ...input, now };
  const checks = [checkTraining(x), checkFeedback(x), checkVersions(x), checkPractice(x), checkTrend(x), checkError(x)];
  const out = { at: new Date(now).toISOString(), checks, verdict: verdict(checks), thresholds: LEARN_CHECK };
  // Andere beurs: welke beurs, en wat er per beurs telt (Bitvavo: precies als vroeger, zonder deze velden).
  if (input.venue && input.venue !== 'bitvavo') {
    const label = VENUE_LABEL[input.venue] ?? input.venue;
    out.venue = input.venue;
    out.venueNote = `Je handelt nu op ${label}. Trades, praktijk, trend en voorspelling gaan hier alleen over je trades op ${label}; ` +
      `de leerrondes en modelversies zijn die van de leerserver (getraind en gekozen op Bitvavo, ook op ${label}-koersen getest).`;
  }
  return out;
}

// ---------- meldingen ----------
// Welke controles moeten nu een melding krijgen? Een ❌ één keer per overgang, opnieuw pas na herstel
// (✅ of te weinig data) of na realertDays dagen. Een ⚠️ (bv. leerserver even weg) is geen herstel.
// prev: { [key]: { status, since, notifiedAt } } (bewaard in de instellingen). Geeft { send, state }.
export function learnAlerts(prev = {}, checks = [], now = Date.now()) {
  const send = [];
  const state = {};
  const iso = new Date(now).toISOString();
  for (const c of checks) {
    const p = prev?.[c.key] ?? {};
    const since = p.status === c.status && p.since ? p.since : iso;
    let notifiedAt = c.status === 'bad' || c.status === 'warn' ? p.notifiedAt ?? null : null;
    if (c.status === 'bad' && (!notifiedAt || now - ts(notifiedAt) >= LEARN_CHECK.realertDays * DAY)) {
      send.push(c);
      notifiedAt = iso;
    }
    state[c.key] = { status: c.status, since, ...(notifiedAt ? { notifiedAt } : {}) };
  }
  return { send, state };
}

// ISO-week (lokale tijd), bv. '2026-W48'.
export function isoWeekKey(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // maandag = 0
  x.setDate(x.getDate() - day + 3);
  const year = x.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((x - jan4) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Moet de wekelijkse samenvatting nu? Maandag vanaf de tijd van het dagoverzicht; was de bot toen uit,
// dan later in dezelfde week. Eén keer per week (lastWeek komt uit de instellingen, dus ook na een herstart).
export function weeklyDue(now, summaryTime = '08:00', lastWeek = null) {
  const week = isoWeekKey(now);
  if (week === lastWeek) return null;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (now.getDay() === 1 && hhmm < summaryTime) return null;
  return week;
}

const line = (c) => `${STATUS_ICON[c.status]} **${c.title}**${c.status === 'nodata' && c.progress ? ` — nog te weinig data (${c.progress.have} van ${c.progress.need})` : ''}: ${c.text}`;

export function weeklyMessage(result) {
  const v = result.verdict;
  const icon = { ok: '✅', warn: '⚠️', bad: '❌' }[v.level];
  const todo = result.checks.filter((c) => c.action && (c.status === 'bad' || c.status === 'warn')).map((c) => `• ${c.title}: ${c.action}`);
  return {
    title: `Leert hij echt? ${icon} ${v.text}`,
    message: [...result.checks.map(line), ...(todo.length ? ['', '**Wat je kunt doen**', ...todo] : [])].join('\n'),
    level: v.level === 'ok' ? 'ok' : v.level === 'bad' ? 'error' : 'warn',
  };
}

export function alertMessage(c) {
  return {
    title: `❌ Leren: ${c.title}`,
    message: `${c.text}${c.action ? `\n\n**Wat je kunt doen:** ${c.action}` : ''}\n\nZie Learning → "Leert hij echt?" op het dashboard.`,
    level: 'error',
  };
}
