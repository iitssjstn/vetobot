// "Leert hij echt?": de zes controles, het totaaloordeel, meldingen (dedupe, weekoverzicht één keer)
// en de leerserver onbereikbaar. Geen netwerk: de leerserver en Discord zijn nep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tQuantile, meanUpper, welch, normInv } from '../src/stats.js';
import {
  LEARN_CHECK, checkTraining, checkFeedback, checkVersions, checkPractice, checkTrend, checkError, verdict, evaluate,
  learnAlerts, weeklyDue, isoWeekKey, weeklyMessage, alertMessage, provenance, activations,
} from '../src/learncheck.js';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { createApp } from '../src/server.js';

const H = 3600000;
const D = 24 * H;
const NOW = Date.parse('2026-11-27T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const quiet = { info() {}, warn() {}, error() {} };

// Vaste "willekeur": een reeks met gemiddelde m en spreiding s.
const series = (n, m, s, seed = 1) => {
  let x = seed;
  return [...Array(n)].map(() => { x = (x * 16807) % 2147483647; return m + s * ((x / 2147483647) * 2 - 1) * 1.7; });
};
// Een trade van de AI-trader die `daysAgo` dagen geleden sloot.
const trade = (pnlPct, daysAgo, extra = {}) => ({
  pair: 'BTC/EUR', mode: 'paper', openedAt: iso(daysAgo * D + H), closedAt: iso(daysAgo * D), pnlPct, pnlEur: pnlPct / 4, exitReason: 'Model: verkopen',
  agent: { recipe: 'R1', expectedPct: 0.3, ...(extra.agent ?? {}) }, ...extra, ...(extra.agent ? { agent: { recipe: 'R1', expectedPct: 0.3, ...extra.agent } } : {}),
});
const stats = (o = {}) => ({ now: iso(0), enabled: true, learningNow: true, rounds: { windowHours: 24, lastDay: 5, lastAt: iso(H), ageHours: 1 },
  agentTrades: { windowDays: 3, total: 100, recent: 12, recentReal: 8, lastAt: iso(2 * H), ageHours: 2 }, ...o });
const trainer = (o = {}) => ({ configured: true, stats: stats(), statsError: null, registry: { versions: [], active: null }, registryError: null, ...o });

// Modelregister: v1 eerste model, v2 via de toets, v3 afgewezen, v4 hertraining van v2 (actief).
const regOk = (o = {}) => ({
  active: 4, pinned: null,
  versions: [
    { version: 4, at: iso(5 * D), decision: 'promoted', hasSnapshot: true, recipeKey: 'R1', publishedKey: 'R1', active: true,
      reason: 'hetzelfde recept opnieuw getraind en niet slechter dan de vorige training van dit recept',
      probation: { status: 'proef', trades: 4, need: 20, expectedPct: 0.3 }, ...o.v4 },
    { version: 3, at: iso(8 * D), decision: 'kept', recipeKey: 'R9', reason: 'kandidaat X is niet aantoonbaar beter: …' },
    { version: 2, at: iso(10 * D), decision: 'promoted', hasSnapshot: true, recipeKey: 'R1', publishedKey: 'R1',
      reason: 'R1: aantoonbaar beter (met 95% zekerheid beter: +0,12% per trade (ondergrens +0,03%, gecorrigeerd voor 4 geteste recepten)): score 1,2 tegen 0,8' },
    { version: 1, at: iso(40 * D), decision: 'promoted', hasSnapshot: true, recipeKey: 'R0', publishedKey: 'R0', reason: 'eerste model van de AI-trader' },
  ],
  ...o.reg,
});

// ---------- statistiek ----------
test('t-kwantiel gelijk aan trainer/stats.py en tabellen', () => {
  for (const [p, df, want] of [[0.95, 1, 6.313751514675031], [0.95, 2, 2.9199855803537242], [0.95, 3, 2.3533634348018224], [0.999, 3, 10.21453185240738],
    [0.95, 10, 1.812461122811677], [0.95, 29, 1.6991270265334937], [0.975, 5, 2.570581835636314], [0.99, 7.5, 2.9430993234067198]]) {
    assert.ok(Math.abs(tQuantile(p, df) - want) < 1e-9, `t(${p}, ${df})`);
  }
  assert.ok(Math.abs(tQuantile(0.05, 10) + 1.812461122811677) < 1e-9, 'symmetrisch');
  assert.ok(Math.abs(normInv(0.95) - 1.6448536269514722) < 1e-8);
});

test('bovengrens van een gemiddelde en Welch (zoals trainer/stats.py)', () => {
  const r = meanUpper([1, 2, 3, 4, 5], 0.95);
  assert.equal(r.mean, 3);
  assert.ok(Math.abs(r.upper - (3 + 2.1318467863266495 * Math.sqrt(2.5) / Math.sqrt(5))) < 1e-9);
  assert.equal(meanUpper([1]).upper, null);
  const w = welch([1, 2, 3, 4], [0, 1, 2, 3, 4, 5], 0.95);
  assert.ok(Math.abs(w.diff - 0) < 1e-12);
  assert.ok(w.lower < 0 && w.upper > 0);
  assert.equal(welch([1], [1, 2]), null);
});

// ---------- 1. Leerserver traint ----------
test('1. leerserver traint: ✅ / ❌ / leren uit / niet gekoppeld / onbereikbaar / oude leerserver', () => {
  assert.equal(checkTraining({ trainer: trainer(), now: NOW }).status, 'ok');
  const bad = checkTraining({ trainer: trainer({ stats: stats({ rounds: { lastDay: 0, lastAt: iso(30 * H), ageHours: 30 } }) }), now: NOW });
  assert.equal(bad.status, 'bad');
  assert.match(bad.text, /30 uur geen leerronde/);
  const off = checkTraining({ trainer: trainer({ stats: stats({ enabled: false, rounds: { lastDay: 0, ageHours: 50 } }) }), now: NOW });
  assert.equal(off.status, 'warn');
  assert.match(off.text, /Leren staat uit/);
  assert.equal(checkTraining({ trainer: { configured: false }, now: NOW }).status, 'warn');
  const down = checkTraining({ trainer: { configured: true, stats: null, registry: null, statsError: 'Kan de trainer niet bereiken; klopt het adres en draait hij?' }, now: NOW });
  assert.equal(down.status, 'warn');
  assert.match(down.text, /niet bereikbaar.*Kan de trainer niet bereiken/);
  // Oude leerserver zonder /learnstats: sessies uit het register.
  const old = trainer({ stats: null, statsError: 'Niet gevonden', registry: regOk({ reg: { versions: [{ version: 9, at: iso(2 * H), decision: 'kept' }] } }) });
  assert.equal(checkTraining({ trainer: old, now: NOW }).status, 'ok');
  const old2 = trainer({ stats: null, statsError: 'Niet gevonden', registry: { versions: [{ version: 9, at: iso(30 * H), decision: 'kept' }, { version: 10, at: iso(H), decision: 'rollback' }] } });
  assert.equal(checkTraining({ trainer: old2, now: NOW }).status, 'warn', 'terugzetten is geen leerronde; zonder telling geen ❌');
});

// ---------- 2. Nieuwe leerstof komt aan ----------
test('2. leerstof: ✅ / ❌ niets ontvangen / ❌ versturen blijft mislukken / te weinig data / geen telling', () => {
  const trades = [trade(0.5, 1), trade(-0.2, 2)];
  const ok = checkFeedback({ trainer: trainer(), trades, now: NOW });
  assert.equal(ok.status, 'ok');
  assert.match(ok.text, /2 trades .* ontving er 12/);
  const none = checkFeedback({ trainer: trainer({ stats: stats({ agentTrades: { recent: 0, total: 50, ageHours: 100 } }) }), trades, now: NOW });
  assert.equal(none.status, 'bad');
  assert.match(none.text, /ontving niets nieuws/);
  const failing = checkFeedback({ trainer: trainer(), trades, feedback: { queued: 3, error: 'De trainer reageert niet (time-out)', errorSince: iso(7 * H) }, now: NOW });
  assert.equal(failing.status, 'bad');
  assert.match(failing.text, /mislukt al 7 uur/);
  const brief = checkFeedback({ trainer: trainer(), trades, feedback: { queued: 3, error: 'time-out', errorSince: iso(H) }, now: NOW });
  assert.equal(brief.status, 'warn', 'kort mislukt: de bot probeert het opnieuw');
  const quiet3 = checkFeedback({ trainer: trainer(), trades: [trade(0.5, 5)], now: NOW });
  assert.equal(quiet3.status, 'nodata');
  assert.deepEqual(quiet3.progress, { have: 0, need: 1 });
  // Net gesloten (nog onderweg) telt niet; handmatig verkocht ook niet.
  const fresh = checkFeedback({ trainer: trainer({ stats: stats({ agentTrades: { recent: 0 } }) }), now: NOW,
    trades: [{ ...trade(0.5, 0), closedAt: iso(5 * 60000) }, { ...trade(0.5, 1), exitReason: 'Handmatig verkocht' }] });
  assert.equal(fresh.status, 'nodata');
  // De verkenner (virtueel) telt wel als leerstof.
  assert.equal(checkFeedback({ trainer: trainer(), virtualTrades: [{ ...trade(0.1, 1, { agent: { explore: true } }), virtual: true }], now: NOW }).status, 'ok');
  assert.equal(checkFeedback({ trainer: trainer({ stats: null, statsError: 'Niet gevonden' }), trades, now: NOW }).status, 'warn');
  assert.equal(checkFeedback({ trainer: { configured: false }, trades, now: NOW }).status, 'warn');
});

// ---------- 3. Nieuwe versies zijn aantoonbaar beter ----------
test('3. versies: ✅ via de toets (ook na hertraining) / ❌ zonder toets / ❌ proef gezakt / ❌ net teruggezet / ⚠️', () => {
  const ok = checkVersions({ trainer: trainer({ registry: regOk() }), now: NOW });
  assert.equal(ok.status, 'ok', ok.text);
  assert.match(ok.text, /hertraining van v2.*95% zekerheid beter/);
  assert.match(ok.text, /Op proef: 4 van 20/);
  assert.equal(provenance(regOk().versions[0], regOk().versions).kind, 'test');
  // Gekozen met de oude regel (geen toets mogelijk) → ❌
  const untested = regOk({ v4: { reason: 'R1: aantoonbaar beter: score 1,4 tegen 1,1, terugval 3% tegen 4%' } });
  assert.equal(checkVersions({ trainer: trainer({ registry: untested }), now: NOW }).status, 'bad');
  // Proef gezakt maar nog in gebruik → ❌
  const failed = regOk({ v4: { probation: { status: 'mislukt', reason: 'gemiddeld −0,40% per trade' } } });
  assert.equal(checkVersions({ trainer: trainer({ registry: failed }), now: NOW }).status, 'bad');
  // Automatisch teruggezet (proef gezakt), recent → ❌; na 7 dagen weer gewoon beoordeeld.
  const rb = (ago) => regOk({ reg: { active: 2, versions: [
    { version: 5, at: iso(ago), decision: 'rollback', restoredVersion: 2, failedVersion: 4, publishedKey: 'R1', by: 'trainer' },
    ...regOk().versions.map((v) => ({ ...v, active: v.version === 2 })),
  ] } });
  const recent = checkVersions({ trainer: trainer({ registry: rb(2 * D) }), now: NOW });
  assert.equal(recent.status, 'bad');
  assert.match(recent.text, /v4 haalde haar proefperiode niet .* teruggezet naar v2/);
  assert.equal(checkVersions({ trainer: trainer({ registry: rb(9 * D) }), now: NOW }).status, 'ok');
  // Eerste model: niets om mee te vergelijken → ⚠️
  const first = { active: 1, versions: [{ ...regOk().versions[3], active: true }] };
  assert.equal(checkVersions({ trainer: trainer({ registry: first }), now: NOW }).status, 'warn');
  // Al 30 dagen geen nieuwe versie: ⚠️, geen fout.
  const stale = regOk({ reg: { versions: regOk().versions.map((v) => ({ ...v, at: iso((40 + v.version) * D) })) } });
  const st = checkVersions({ trainer: trainer({ registry: stale }), now: NOW });
  assert.equal(st.status, 'warn');
  assert.match(st.text, /geen nieuwe versie: geen kandidaat was aantoonbaar beter \(geen fout\)/);
  // Zelf vastgezet → ⚠️
  assert.equal(checkVersions({ trainer: trainer({ registry: regOk({ reg: { pinned: 4 } }) }), now: NOW }).status, 'warn');
  assert.equal(checkVersions({ trainer: trainer({ registry: { versions: [] } }), now: NOW }).status, 'nodata');
  assert.equal(checkVersions({ trainer: { configured: true, stats: null, registry: null, registryError: 'time-out' }, now: NOW }).status, 'warn');
});

// ---------- 4. Praktijk haalt de belofte ----------
test('4. praktijk: te weinig data / ✅ / ❌ aantoonbaar slechter / ❌ alleen live slechter / alleen trades van de actieve versie', () => {
  const t = trainer({ registry: regOk() }); // v4 actief sinds 5 dagen, recept R1, belofte +0,30%
  const ofV4 = (pcts, mode = 'paper') => pcts.map((p, i) => trade(p, 4 - (i % 40) / 10, { mode }));
  const few = checkPractice({ trainer: t, trades: ofV4(series(12, 0.3, 0.5)), now: NOW });
  assert.equal(few.status, 'nodata');
  assert.deepEqual(few.progress, { have: 12, need: 30 });
  assert.equal(checkPractice({ trainer: t, trades: ofV4(series(40, 0.25, 0.8)), now: NOW }).status, 'ok');
  const worse = checkPractice({ trainer: t, trades: ofV4(series(40, -0.4, 0.5)), now: NOW });
  assert.equal(worse.status, 'bad');
  assert.match(worse.text, /Aantoonbaar slechter dan beloofd.*beloofde \+0,30%/);
  // Paper goed, live slecht (genoeg live trades voor een eigen toets).
  const mixed = [...ofV4(series(60, 0.6, 0.4)), ...ofV4(series(35, -0.5, 0.4, 7), 'live')];
  const m = checkPractice({ trainer: t, trades: mixed, now: NOW });
  assert.equal(m.status, 'bad');
  assert.match(m.text, /Alleen live/);
  // Trades van een ander recept, van de verkenner of van vóór de activatie tellen niet.
  const other = [...ofV4(series(40, -1, 0.3)).map((x) => ({ ...x, agent: { ...x.agent, recipe: 'R9' } })),
    ...series(40, -1, 0.3).map((p) => trade(p, 7)), ...ofV4(series(40, -1, 0.3)).map((x) => ({ ...x, agent: { ...x.agent, explore: true } }))];
  assert.equal(checkPractice({ trainer: t, trades: other, now: NOW }).status, 'nodata');
  // Activaties: alleen promoties met snapshot en terugzettingen, oud → nieuw.
  const acts = activations(regOk().versions);
  assert.deepEqual(acts.map((a) => a.version), [1, 2, 4]);
  assert.equal(checkPractice({ trainer: { configured: false }, trades: [], now: NOW }).status, 'warn');
});

// ---------- 5. Resultaat wordt beter ----------
test('5. resultaat: ✅ aantoonbaar beter / ⚠️ gelijk / ❌ aantoonbaar slechter / te weinig data', () => {
  const mk = (a, b) => [...series(30, a, 0.5, 3).map((p, i) => trade(p, 1 + i * 0.9)), ...series(30, b, 0.5, 5).map((p, i) => trade(p, 31 + i * 0.9))];
  const up = checkTrend({ trades: mk(0.6, -0.2), now: NOW });
  assert.equal(up.status, 'ok', up.text);
  assert.match(up.text, /Aantoonbaar beter/);
  assert.equal(checkTrend({ trades: mk(0.2, 0.2), now: NOW }).status, 'warn');
  assert.equal(checkTrend({ trades: mk(-0.3, 0.5), now: NOW }).status, 'bad');
  const few = checkTrend({ trades: [...series(25, 0.3, 0.3).map((p) => trade(p, 3)), ...series(8, 0.3, 0.3).map((p) => trade(p, 40))], now: NOW });
  assert.equal(few.status, 'nodata');
  assert.deepEqual(few.progress, { have: 8, need: LEARN_CHECK.trendMinTrades });
});

// ---------- 6. Voorspelling wordt scherper ----------
test('6. voorspelling: ✅ kleinere fout / ⚠️ gelijk / ❌ aantoonbaar grotere fout / te weinig data', () => {
  // Verwachting +0,3%; fout = |uitkomst − verwachting|.
  const mk = (errNow, errBefore) => [
    ...series(30, errNow, errNow / 2, 3).map((e, i) => trade(0.3 + (i % 2 ? e : -e), 1 + i * 0.9)),
    ...series(30, errBefore, errBefore / 2, 5).map((e, i) => trade(0.3 + (i % 2 ? e : -e), 31 + i * 0.9)),
  ];
  assert.equal(checkError({ trades: mk(0.3, 1.2), now: NOW }).status, 'ok');
  assert.equal(checkError({ trades: mk(0.8, 0.8), now: NOW }).status, 'warn');
  assert.equal(checkError({ trades: mk(1.5, 0.4), now: NOW }).status, 'bad');
  const noExp = mk(0.3, 1.2).map((t) => ({ ...t, agent: { recipe: 'R1' } }));
  assert.equal(checkError({ trades: noExp, now: NOW }).status, 'nodata');
});

// ---------- totaal ----------
test('totaaloordeel', () => {
  const c = (key, status) => ({ key, title: key, status, text: '' });
  const base = ['training', 'feedback', 'versions', 'practice', 'error'].map((k) => c(k, 'ok'));
  assert.equal(verdict([...base, c('trend', 'ok')]).text, 'Hij leert en wordt beter');
  assert.equal(verdict([...base, c('trend', 'warn')]).text, 'Hij leert, nog geen bewijs dat hij beter wordt');
  assert.equal(verdict([...base, c('trend', 'nodata')]).key, 'learning');
  assert.equal(verdict([...base.slice(1), c('training', 'warn'), c('trend', 'ok')]).key, 'unknown');
  const bad = verdict([...base, c('trend', 'bad')]);
  assert.equal(bad.text, 'Er is iets mis met het leren');
  const r = evaluate({ trainer: { configured: false }, trades: [], now: NOW });
  assert.equal(r.checks.length, 6);
  assert.equal(r.verdict.key, 'unknown');
  const msg = weeklyMessage(r);
  assert.match(msg.title, /Leert hij echt\?/);
  assert.match(msg.message, /nog te weinig data \(0 van 20\)/);
  assert.match(alertMessage({ title: 'X', text: 'kapot', action: 'doe iets' }).message, /Wat je kunt doen:\*\* doe iets/);
});

// ---------- meldingen ----------
test('melding bij ❌: één keer per overgang, opnieuw na herstel of na 7 dagen; ⚠️ is geen herstel', () => {
  const c = (status) => [{ key: 'training', status }];
  let st = {};
  let r = learnAlerts(st, c('ok'), NOW);
  assert.equal(r.send.length, 0);
  r = learnAlerts(r.state, c('bad'), NOW + H);
  assert.equal(r.send.length, 1, 'naar ❌: melden');
  r = learnAlerts(r.state, c('bad'), NOW + 2 * H);
  assert.equal(r.send.length, 0, 'nog steeds ❌: niet opnieuw');
  r = learnAlerts(r.state, c('warn'), NOW + 3 * H);
  r = learnAlerts(r.state, c('bad'), NOW + 4 * H);
  assert.equal(r.send.length, 0, 'even ⚠️ (bv. leerserver weg) is geen herstel');
  r = learnAlerts(r.state, c('bad'), NOW + H + 7 * D);
  assert.equal(r.send.length, 1, 'na 7 dagen nog ❌: opnieuw melden');
  r = learnAlerts(r.state, c('ok'), NOW + 8 * D);
  assert.equal(r.state.training.notifiedAt, undefined);
  r = learnAlerts(r.state, c('bad'), NOW + 8 * D + H);
  assert.equal(r.send.length, 1, 'na herstel en weer ❌: opnieuw melden');
  st = r.state;
  assert.equal(st.training.status, 'bad');
});

test('weekoverzicht: maandag vanaf de tijd, één keer per week, inhalen later in de week', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
  const mon = (h, mi) => at(2026, 11, 30, h, mi); // maandag 30 november 2026
  assert.equal(mon(7, 59).getDay(), 1);
  assert.equal(isoWeekKey(mon(8, 0)), '2026-W49');
  assert.equal(isoWeekKey(at(2027, 1, 1, 12, 0)), '2026-W53');
  assert.equal(isoWeekKey(at(2026, 1, 1, 12, 0)), '2026-W01');
  assert.equal(weeklyDue(mon(7, 59), '08:00', '2026-W48'), null);
  assert.equal(weeklyDue(mon(8, 0), '08:00', '2026-W48'), '2026-W49');
  assert.equal(weeklyDue(mon(9, 0), '08:00', '2026-W49'), null, 'al verstuurd deze week');
  assert.equal(weeklyDue(at(2026, 12, 2, 10, 0), '08:00', '2026-W48'), '2026-W49', 'maandag gemist: woensdag inhalen');
  assert.equal(weeklyDue(at(2026, 12, 6, 23, 0), '08:00', '2026-W49'), null);
});

// ---------- manager: verzamelen, meldingen, onbereikbaar ----------
function setup(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-lc-'))) {
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: {}, ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const ex = { markets: {}, parseTimeframe: () => 3600, async loadMarkets() { return {}; }, async fetchOHLCV() { return []; }, async fetchTicker() { return { last: 100 }; }, async fetchTickers() { return {}; } };
  const users = new Users(dir);
  if (!users.admin) users.setup({ username: 'justin', password: 'lang-genoeg-123', code: users.setupCode }, 'x');
  const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket(ex), makePrivateExchange: () => ({}) });
  const ctx = manager.ensure(users.admin);
  ctx.secrets.update({ trainerUrl: 'http://leerserver.test', trainerToken: 'geheim', discordWebhook: 'https://discord.com/api/webhooks/1/test' });
  const sent = [];
  ctx.notifier.fetch = async (_url, opts) => { sent.push(JSON.parse(opts.body).embeds[0]); return { ok: true, text: async () => '' }; };
  return { dir, manager, ctx, sent };
}

const fakeTrainer = (o) => async (url) => {
  if (o.down) throw new Error('fetch failed');
  const p = new URL(url).pathname;
  const body = p === '/learnstats' ? o.stats : p === '/registry' ? o.registry : null;
  if (!body) return { status: 404, ok: false, headers: new Map(), json: async () => ({ error: 'Niet gevonden' }) };
  return { status: 200, ok: true, headers: new Map(), json: async () => body };
};

test('manager: weekoverzicht één keer (ook na een herstart), ❌ direct en één keer, alleen admin', async () => {
  const s0 = setup();
  const { manager, ctx, sent } = s0;
  const live = Date.now();
  const nowStats = { ...stats(), rounds: { lastDay: 0, lastAt: new Date(live - 30 * H).toISOString(), ageHours: 30 } };
  manager.fetchImpl = fakeTrainer({ stats: nowStats, registry: regOk() });
  ctx.stores.paper.state.trades.push(trade(0.4, 0), trade(0.1, 0));
  // Maandag na de tijd van het dagoverzicht: weekoverzicht + melding voor de ❌ (geen leerronde in 24 uur).
  const monday = new Date(2026, 10, 30, 9, 0);
  const r1 = await manager.checkLearning(monday);
  assert.deepEqual(r1.sent, ['training']);
  assert.equal(r1.weekly, '2026-W49');
  assert.equal(sent.length, 2);
  assert.match(sent[0].title, /❌ Leren: Leerserver traint/);
  assert.match(sent[1].title, /Leert hij echt\? ❌ Er is iets mis met het leren/);
  // Vijf minuten later: niets nieuws.
  manager.learnCheckCache = null;
  const r2 = await manager.checkLearning(new Date(2026, 10, 30, 9, 5));
  assert.deepEqual(r2.sent, []);
  assert.equal(r2.weekly, null);
  assert.equal(sent.length, 2);
  // Herstart: nieuwe manager op dezelfde map, de toestand staat in de instellingen.
  manager.stopAll();
  const s1 = setup(s0.dir);
  s1.manager.fetchImpl = fakeTrainer({ stats: nowStats, registry: regOk() });
  const r3 = await s1.manager.checkLearning(new Date(2026, 10, 30, 10, 0));
  assert.deepEqual(r3.sent, [], 'na een herstart niet opnieuw');
  assert.equal(r3.weekly, null, 'weekoverzicht niet dubbel na een herstart');
  assert.equal(s1.sent.length, 0);
  // Melding uit: niets.
  s1.ctx.settings.setNotify({ events: { ...s1.ctx.settings.notify.events, learning: false } });
  assert.equal(await s1.manager.checkLearning(new Date(2026, 11, 7, 9, 0)), null);
  s1.manager.stopAll();
});

test('manager: leerserver onbereikbaar → ⚠️ met reden, geen fout en geen ❌-melding', async () => {
  const { manager, ctx, sent } = setup();
  manager.fetchImpl = fakeTrainer({ down: true });
  const r = await manager.learnCheck(ctx.user.id);
  assert.equal(r.checks.length, 6);
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(by.training.status, 'warn');
  assert.match(by.training.text, /niet bereikbaar.*Kan de trainer niet bereiken/);
  assert.equal(by.versions.status, 'warn');
  assert.equal(r.verdict.key, 'unknown');
  const out = await manager.checkLearning(new Date(2026, 10, 25, 9, 0)); // woensdag: weekoverzicht van deze week ontbrak nog
  assert.deepEqual(out.sent, []);
  assert.ok(sent.every((e) => !/❌ Leren/.test(e.title)));
  assert.ok(!JSON.stringify(r).includes('geheim'), 'geen secrets');
  // Kort bewaard: een tweede keer vraagt niets opnieuw.
  let calls = 0;
  manager.fetchImpl = async (...a) => { calls++; return fakeTrainer({ down: true })(...a); };
  await manager.learnCheck(ctx.user.id);
  assert.equal(calls, 0);
  manager.stopAll();
});

test('manager: feedback die blijft mislukken wordt bijgehouden (sinds wanneer)', async () => {
  const { manager, ctx } = setup();
  manager.fetchImpl = async () => { throw new Error('fetch failed'); };
  await manager.queueFeedback({ kind: 'agentTrade', pair: 'BTC/EUR', pct: 0.2 });
  const since = manager.ml.feedbackErrorSince;
  assert.ok(since);
  await manager.flushFeedback();
  assert.equal(manager.ml.feedbackErrorSince, since, 'blijft het eerste moment');
  manager.fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), json: async () => ({ ok: true }) });
  await manager.flushFeedback();
  assert.equal(manager.ml.feedbackErrorSince, null);
  assert.equal(ctx.settings.notify.events.learning, true, 'standaard aan');
  assert.equal(ctx.settings.notify.mentions.learning, false, 'standaard zonder tag');
  manager.stopAll();
});

test('GET /api/learncheck: alleen ingelogd', async () => {
  const { manager } = setup();
  manager.fetchImpl = fakeTrainer({ down: true });
  const server = createApp({ users: manager.users, manager, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const anon = await fetch(`${base}/api/learncheck`);
  assert.equal(anon.status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'justin', password: 'lang-genoeg-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/learncheck`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.checks.length, 6);
  assert.ok(body.verdict.text);
  server.close();
  manager.stopAll();
});
