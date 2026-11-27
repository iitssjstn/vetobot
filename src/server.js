import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { COOKIE, readCookie } from './users.js';
import { SECRET_NAMES, remapAiKeys } from './secrets.js';
import { NOTIFY_EVENTS } from './notify.js';
import { aiLabel } from './ai.js';
import { allAgentParts } from './agents.js';
import { analyzeTrades } from './analysis.js';
import { AI_PROVIDERS, MAX_PAIRS, TIMEFRAMES, RISK_LIMITS, STRATEGY_LIMITS } from './settings.js';
import { VENUES, VENUE_IDS, liveAllowedOnVenue, checkAccordInput } from './venue.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Keys die over de server gaan en niet over één gebruiker. Alleen de admin mag ze zetten.
const ADMIN_ONLY_SECRETS = new Set(['heartbeatUrl', 'trainerUrl', 'trainerToken']);

export function createApp({ users, manager, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Achter Nginx Proxy Manager: echte client-IP voor de login-blokkade.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(express.json({ limit: '20kb' }));
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  // Gzip voor JSON-antwoorden: /api/state wordt elke paar seconden opgehaald en is
  // tientallen kB groot; gecomprimeerd is dat een fractie, wat vooral op mobiel scheelt.
  const gzipOk = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (obj) => {
      const body = JSON.stringify(obj);
      if (body.length < 2048 || !gzipOk(req)) return json(obj);
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(zlib.gzipSync(body, { level: 6 }));
      return res;
    };
    next();
  });

  // Het dashboard (één HTML-bestand van ±150 kB) gecomprimeerd en met een ETag, zodat de
  // browser hem na de eerste keer niet opnieuw downloadt zolang hij niet veranderd is.
  // Wordt bij een wijziging van het bestand (nieuwe versie) opnieuw ingelezen.
  let page = null;
  const loadPage = () => {
    const file = path.join(publicDir, 'index.html');
    const mtime = fs.statSync(file).mtimeMs;
    if (page?.mtime === mtime) return page;
    const raw = fs.readFileSync(file);
    page = { mtime, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"` };
    return page;
  };
  const sendPage = (req, res) => {
    const p = loadPage();
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: p.etag, Vary: 'Accept-Encoding' });
    if (req.headers['if-none-match'] === p.etag) return res.status(304).end();
    if (gzipOk(req)) {
      res.set('Content-Encoding', 'gzip');
      return res.end(p.gz);
    }
    res.end(p.raw);
  };

  const setCookie = (req, res, token) => {
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`);
  };
  const clearCookie = (res) => res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  const fail = (res, err, status = err.status ?? 400) => res.status(status).json({ error: err.message });
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  // --- Openbaar -------------------------------------------------------------
  // Openbaar (voor Docker/uptime-monitors): alleen de algemene toestand, geen details. 503 als bij een bot
  // de handelsronde hangt of er geen checks meer draaien: dan is de bot niet gezond, ook al reageert hij.
  app.get('/healthz', (_req, res) => {
    const levels = [];
    let stuck = false;
    for (const ctx of manager.contexts.values()) {
      try {
        const r = ctx.bot.healthStatus({ scheduled: Boolean(ctx.timer) });
        levels.push(r.level);
        if (r.problems.some((p) => p.key === 'loop-hang' || p.key === 'scheduler')) stuck = true;
      } catch { levels.push('critical'); }
    }
    const order = ['healthy', 'paused', 'degraded', 'critical', 'stopped'];
    const status = levels.reduce((w, l) => (order.indexOf(l) > order.indexOf(w) ? l : w), 'healthy');
    res.status(stuck ? 503 : 200).json({ ok: !stuck, status, lastTickAt: manager.leaderBot?.lastTickAt ?? null });
  });
  app.get('/', sendPage);
  app.get('/index.html', sendPage);
  app.use(express.static(publicDir));

  app.get('/api/auth/status', (req, res) => {
    const user = users.verify(readCookie(req, COOKIE));
    res.json({ setupRequired: !users.isSetUp(), loggedIn: Boolean(user), user: users.publicUser(user) });
  });

  app.post('/api/auth/setup', (req, res) => {
    try {
      const { token, user } = users.setup(req.body ?? {}, req.ip);
      log.info(`Admin-account "${user.username}" aangemaakt.`);
      manager.startAll();
      setCookie(req, res, token);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { token } = users.login(req.body ?? {}, req.ip);
      setCookie(req, res, token);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 401);
    }
  });

  // Registreren kan alleen met een uitnodiging van de admin.
  app.post('/api/auth/invite/check', (req, res) => {
    res.json({ valid: users.checkInvite(req.body?.code) });
  });

  app.post('/api/auth/register', (req, res) => {
    try {
      const { token, user } = users.register(req.body ?? {}, req.ip);
      log.info(`Nieuwe gebruiker "${user.username}" via uitnodiging.`);
      manager.start(user);
      setCookie(req, res, token);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- Alles hieronder vereist een ingelogde sessie ------------------------
  app.use('/api', (req, res, next) => {
    const user = users.verify(readCookie(req, COOKIE));
    if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
    // Extra CSRF-bescherming naast SameSite=Strict.
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type moet application/json zijn' });
    }
    req.user = user;
    req.ctx = manager.get(user.id) ?? manager.start(user);
    next();
  });

  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Alleen voor de admin' }));
  const confirm = (req, password) => users.confirmPassword(req.user.id, password, req.ip);
  // Wie volgt, neemt coins, planning en strategie over van de admin.
  const notWhileFollowing = (bot, what) => {
    if (bot.following) throw new Error(`Je volgt de strategie van ${bot.leader?.username ?? 'de admin'}, dus ${what} komt van de admin. Zet volgen eerst uit.`);
  };

  // Toon hooguit een korte foutmelding naar buiten; nooit stacktraces of keys.
  const wrap = (fn) => async (req, res) => {
    try {
      res.json((await fn(req, req.ctx)) ?? { ok: true });
    } catch (err) {
      fail(res, err);
    }
  };

  app.post('/api/auth/logout', (req, res) => {
    users.logout(readCookie(req, COOKIE));
    clearCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    try {
      users.changePassword(req.user.id, req.body ?? {}, req.ip);
      clearCookie(res);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/auth/username', wrap((req, ctx) => {
    const old = req.user.username;
    const user = users.changeUsername(req.user.id, req.body ?? {}, req.ip);
    ctx.bot.username = user.username;
    log.info(`Gebruikersnaam gewijzigd: ${old} -> ${user.username}`);
    return { ok: true, user: users.publicUser(user) };
  }));

  const keyStatus = (req) => {
    const st = req.ctx.secrets.status();
    if (req.user.role !== 'admin') for (const n of ADMIN_ONLY_SECRETS) delete st[n];
    return st;
  };

  app.get('/api/settings/keys', (req, res) => res.json(keyStatus(req)));

  app.post('/api/settings/keys', wrap((req, { bot, secrets }) => {
    const updates = {};
    for (const name of SECRET_NAMES) {
      if (!(name in (req.body ?? {}))) continue;
      if (ADMIN_ONLY_SECRETS.has(name) && req.user.role !== 'admin') throw httpError(403, 'Alleen de admin kan dit instellen');
      updates[name] = req.body[name];
    }
    const removesBitvavo = ['bitvavoApiKey', 'bitvavoApiSecret'].some((n) => n in updates && !updates[n]);
    if (bot.mode === 'live' && removesBitvavo) {
      throw new Error('Schakel eerst terug naar paper voordat je de Bitvavo-keys verwijdert');
    }
    secrets.update(updates);
    log.info(`API-keys bijgewerkt door ${req.user.username}: ${Object.keys(updates).join(', ') || 'geen'}`);
    return keyStatus(req);
  }));

  // De analyse verandert alleen als er een trade bij komt; niet bij elke poll opnieuw rekenen.
  const analysisCache = new WeakMap();
  const cachedAnalysis = (bot, trades) => {
    const key = `${bot.mode}:${trades.length}:${trades[0]?.closedAt ?? ''}:${bot.risk.feePct}`;
    const hit = analysisCache.get(bot);
    if (hit?.key === key) return hit.value;
    const value = analyzeTrades(trades, { feePct: bot.risk.feePct });
    analysisCache.set(bot, { key, value });
    return value;
  };

  app.get('/api/state', async (req, res) => {
    const { bot, settings, secrets, notifier } = req.ctx;
    const isAdmin = req.user.role === 'admin';
    const openPairs = Object.keys(bot.store.state.positions);
    if (openPairs.length) bot.refreshPrices(openPairs).catch(() => {});
    const open = bot.openPositionsValue();
    const store = bot.store;
    const s = store.state;
    const closed = s.trades;
    const wins = closed.filter((t) => t.pnlEur > 0).length;
    const keys = secrets.status();
    const leader = manager.leaderBot;
    res.json({
      user: users.publicUser(req.user),
      follow: {
        available: !isAdmin && Boolean(leader),
        enabled: Boolean(settings.follow?.enabled),
        active: bot.following,
        since: settings.follow?.since ?? null,
        leader: leader?.username ?? null,
        leaderPositions: leader ? Object.keys(leader.store.state.positions) : [],
      },
      mode: bot.mode,
      modeChangedAt: settings.data.modeChangedAt,
      // Beurs: Bitvavo (euro) of Bybit (USDT-paren; live alleen op eigen risico). Bedragen altijd in euro.
      exchange: bot.venue,
      bybitHost: settings.bybitHost,
      exchangeLabel: bot.venueLabel,
      quote: bot.quote,
      fx: bot.venue === 'bitvavo' ? null : bot.fx?.info?.() ?? null,
      liveAllowed: liveAllowedOnVenue(bot.venue, settings),
      venues: VENUE_IDS.map((v) => ({ id: v, label: VENUES[v].label, quote: VENUES[v].quote, fees: VENUES[v].fees, live: liveAllowedOnVenue(v, settings) })),
      // Bybit live op eigen risico: verliesgrens en resultaat sinds het akkoord (null zonder akkoord).
      venueRisk: bot.venueRiskStatus?.() ?? null,
      bybitKeysSet: Boolean(keys.bybitApiKey?.set && keys.bybitApiSecret?.set),
      pairs: bot.pairs,
      ownPairs: settings.pairs,
      maxPairs: MAX_PAIRS,
      timeframe: bot.timeframe,
      timeframes: TIMEFRAMES,
      ai: settings.ai,
      aiProviders: AI_PROVIDERS,
      aiKeySet: bot.aiChain().some((c) => c.apiKey),
      aiChain: bot.aiChain().map((c) => ({ slot: c.slot, label: aiLabel(c), keySet: Boolean(c.apiKey), keyFrom: c.keyFrom })),
      bitvavoKeysSet: keys.bitvavoApiKey.set && keys.bitvavoApiSecret.set,
      risk: bot.risk,
      stake: bot.stakeInfo(),
      analysis: cachedAnalysis(bot, closed),
      riskLimits: RISK_LIMITS,
      strategy: bot.strategy,
      strategyLimits: STRATEGY_LIMITS,
      balanceEur: s.balanceEur,
      startBalanceEur: s.startBalanceEur,
      liveBalance: bot.liveBalance,
      halted: s.halted,
      positions: open.positions,
      open: { valueEur: open.valueEur, costEur: open.costEur, pnlEur: open.pnlEur, complete: open.complete },
      trades: closed.slice(0, 100),
      // Oude beslissingen kunnen nog een (groot) gesprek van het vroegere AI-team bevatten: niet meesturen.
      decisions: s.decisions.slice(0, 100).map(({ team, ...d }) => d),
      stats: {
        totalTrades: closed.length,
        winRate: closed.length ? (wins / closed.length) * 100 : null,
        realizedEur: closed.reduce((a, t) => a + t.pnlEur, 0),
        realizedTodayEur: store.realizedTodayEur(),
        vetoed: s.decisions.filter((d) => d.outcome === 'vetoed').length,
        approved: s.decisions.filter((d) => d.outcome === 'approved').length,
        blocked: s.decisions.filter((d) => d.outcome === 'blocked').length,
      },
      lastTickAt: bot.lastTickAt,
      lastError: bot.lastError,
      running: bot.running,
      currentStep: bot.currentStep,
      nextTickAt: bot.nextTickAt,
      checkIntervalMinutes: bot.checkIntervalMinutes,
      pairStatus: bot.pairs.map((pair) => ({ pair, ...bot.pairStatus[pair] })),
      activity: bot.activity.slice(0, 100),
      notify: settings.notify,
      notifyEvents: NOTIFY_EVENTS,
      discordSet: keys.discordWebhook.set,
      heartbeatSet: isAdmin ? keys.heartbeatUrl.set : false,
      lastHeartbeat: isAdmin ? notifier?.lastHeartbeat ?? null : null,
      lastSummary: bot.store.state.lastSummary ?? null,
      bandit: bot.banditSummary(),
      thoughts: bot.thoughts.slice(-40),
      agent: (() => {
        const a = bot.getAgent?.();
        if (!a) return null;
        // Per recept dat de bot kan gebruiken: haalt het de eisen voor live, en heb jij het live toegestaan?
        // Ook de extra recepten die de leerserver meestuurde (om live te zetten).
        const parts = allAgentParts(a);
        const { approved, risky } = settings.agentLive;
        // Live gezet maar niet (meer) bij de bot: dan kan hij er niet mee handelen. Laten zien.
        const present = new Set(parts.map((p) => p.recipeKey));
        const missing = [...new Set([...approved, ...Object.keys(risky ?? {})])].filter((k) => !present.has(k));
        return { timeframe: a.timeframe, stage: a.stage, coins: a.coins ?? null, allowed: bot.agentAllowed(a), live: a.live ?? null, team: bot.agentTeam(),
          recipes: [...new Map(parts.map((p) => [p.recipeKey, { recipe: p.recipeKey, stage: p.stage, extra: Boolean(p.extra), stale: Boolean(p.stale), ready: bot.agentLiveReady(p), approved: approved.includes(p.recipeKey),
            riskyAllowed: bot.agentRiskyStage(p),
            risky: risky[p.recipeKey] ? { ...risky[p.recipeKey], lossEur: +bot.agentRiskyLoss(p.recipeKey).pnlEur.toFixed(2), trades: bot.agentRiskyLoss(p.recipeKey).trades } : null,
            checks: p.liveCheck?.checks ?? [],
            // Op een andere beurs (Bybit): de cijfers van de leerserver voor die beurs, naast die van Bitvavo.
            ...(bot.venue !== 'bitvavo' ? { venue: { id: bot.venue, label: bot.venueLabel, stats: p.venueStats?.[bot.venue] ?? null,
              costPct: p.venueCosts?.[bot.venue]?.costPct ?? null, bitvavoCostPct: p.costPct ?? null, checks: p.venueLiveCheck?.[bot.venue]?.checks ?? [] } } : {}) }])).values()], smallStart: Number(bot.strategy.agentLiveSmallStart ?? 1) === 1, sizing: bot.sizingSummary(),
          missingLive: missing.map((k) => ({ recipe: k, risky: Boolean(risky?.[k]) })) };
      })(),
      // Live-veiligheid: stop-orders bij Bitvavo en de laatste saldocontrole (licht: geen API-verzoeken).
      safety: (() => { try { return bot.safetyStatus?.() ?? null; } catch { return null; } })(),
      // Gezondheid: laatste geslaagde check, positiecontrole en contact met Bitvavo, problemen.
      health: (() => { try { return bot.healthStatus({ scheduled: Boolean(req.ctx.timer) }); } catch { return null; } })(),
      serverTime: new Date().toISOString(),
    });
  });

  // Een recept van de AI-trader live toestaan (alleen als alle eisen gehaald zijn) of dat intrekken.
  // Of op eigen risico (risky): dan zonder alle eisen, met je eigen verliesgrens in euro.
  app.post('/api/agent/live', wrap((req, { bot, settings }) => {
    const { recipe, allow, password, risky, maxLossEur, confirmText } = req.body ?? {};
    confirm(req, password);
    const main = bot.getAgent?.();
    const part = allAgentParts(main).find((p) => p?.recipeKey === recipe);
    if (allow && risky) {
      if (!part) throw new Error('Dit recept gebruikt de AI-trader nu niet');
      if (!bot.agentRiskyStage(part)) throw new Error('Alleen een recept dat de backtests haalde (getest of betrouwbaar) mag op eigen risico live');
      if (String(confirmText ?? '').trim().toUpperCase() !== 'EIGEN RISICO') throw new Error('Typ EIGEN RISICO om te bevestigen');
      const n = Number(maxLossEur);
      if (!Number.isFinite(n) || n < 1) throw new Error('Kies een verliesgrens van minstens € 1');
      settings.setAgentLiveRisky(recipe, n);
      manager.refreshAgent?.().catch(() => {});
      log.warn(`AI-trader ${recipe} live op eigen risico gezet (verliesgrens € ${n.toFixed(2)}) door ${req.user.username}`);
      return { ok: true, risky: settings.agentLive.risky };
    }
    if (!allow) settings.setAgentLiveRisky(recipe, null);
    if (allow) {
      if (!part) throw new Error('Dit recept gebruikt de AI-trader nu niet');
      if (!bot.agentLiveReady(part)) throw new Error('Dit recept haalt nog niet alle eisen voor live');
    }
    settings.setAgentLive(recipe, Boolean(allow));
    manager.refreshAgent?.().catch(() => {});
    log.warn(`AI-trader ${recipe} live ${allow ? 'toegestaan' : 'ingetrokken'} door ${req.user.username}`);
    return { ok: true, approved: settings.agentLive.approved };
  }));

  // Meerdere recepten tegelijk op eigen risico live zetten (zelfde controles als bij één recept, per recept
  // een eigen verliesgrens van maxLossEur), of alles in één keer intrekken. Eén wachtwoord, één bevestiging.
  app.post('/api/agent/live/bulk', wrap((req, { bot, settings }) => {
    const { recipes, maxLossEur, confirmText, password, revokeAll } = req.body ?? {};
    confirm(req, password);
    if (revokeAll) {
      const { approved, risky } = settings.agentLive;
      const keys = [...new Set([...approved, ...Object.keys(risky ?? {})])];
      for (const k of keys) {
        settings.setAgentLiveRisky(k, null);
        settings.setAgentLive(k, false);
      }
      manager.refreshAgent?.().catch(() => {});
      log.warn(`AI-trader: alle ${keys.length} live recepten ingetrokken door ${req.user.username}`);
      return { ok: true, revoked: keys };
    }
    if (!Array.isArray(recipes) || !recipes.length) throw new Error('Kies minstens één recept');
    if (recipes.length > 50) throw new Error('Hooguit 50 recepten tegelijk');
    if (String(confirmText ?? '').trim().toUpperCase() !== 'EIGEN RISICO') throw new Error('Typ EIGEN RISICO om te bevestigen');
    const n = Number(maxLossEur);
    if (!Number.isFinite(n) || n < 1) throw new Error('Kies een verliesgrens van minstens € 1');
    const parts = allAgentParts(bot.getAgent?.());
    const done = [], skipped = [];
    for (const key of [...new Set(recipes.map(String))]) {
      const part = parts.find((p) => p?.recipeKey === key);
      if (!part) { skipped.push({ recipe: key, reason: 'dit recept gebruikt de AI-trader nu niet' }); continue; }
      if (!bot.agentRiskyStage(part)) { skipped.push({ recipe: key, reason: `staat op "${part.stage}"; alleen getest of betrouwbaar mag op eigen risico` }); continue; }
      settings.setAgentLiveRisky(key, n);
      done.push(key);
    }
    if (done.length) {
      manager.refreshAgent?.().catch(() => {});
      log.warn(`AI-trader: ${done.length} recepten live op eigen risico gezet (verliesgrens € ${n.toFixed(2)} per recept) door ${req.user.username}`);
    }
    return { ok: true, done, skipped };
  }));

  // Learning: wat de bot leert. Het beslissingsdagboek van deze gebruiker (goede en slechte beslissingen,
  // gemiste kansen, onterechte afwijzingen) en de modelversies van de leerserver (alleen lezen).
  app.get('/api/learning', wrap(async (req, { bot }) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const mode = ['paper', 'live'].includes(req.query.mode) ? req.query.mode : bot.mode;
    let journal = { enabled: false };
    try {
      journal = bot.learningStats ? (bot.learningStats({ mode, days }) ?? { enabled: false }) : { enabled: false };
    } catch (err) {
      journal = { enabled: false, error: err.message };
    }
    const registry = await manager.learningRegistry().catch((err) => ({ error: err.message }));
    return { mode, days, isAdmin: req.user.role === 'admin', journal, registry };
  }));

  // "Leert hij echt?": zes controles en een totaaloordeel (zie src/learncheck.js). Alleen ingelogd; de
  // leerserver is gedeeld, de trades zijn van deze gebruiker. Geen secrets in het antwoord.
  app.get('/api/learncheck', wrap(async (req) => manager.learnCheck(req.user.id)));

  // Terug naar een eerder goedgekeurde modelversie (vastzetten), of het vastzetten opheffen.
  // Dit raakt alleen paper/het gepubliceerde model; live blijft altijd jouw eigen akkoord per recept.
  app.post('/api/admin/learning/rollback', adminOnly, wrap(async (req) => {
    confirm(req, req.body?.password);
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) throw new Error('Ongeldige versie');
    const r = await manager.trainerRequest('/registry/rollback', { method: 'POST', body: { version } });
    manager.learningCache = null;
    manager.learnCheckCache = null;
    await manager.refreshAgent().catch(() => {});
    log.warn(`Modelversie v${version} teruggezet en vastgezet door ${req.user.username}`);
    return { ok: true, ...r.data };
  }));

  // Saldocontrole met Bitvavo nu uitvoeren (alleen controleren en melden, nooit zelf handelen).
  app.post('/api/safety/reconcile', wrap(async (_req, { bot }) => {
    if (bot.mode !== 'live') throw new Error('De saldocontrole is alleen voor live');
    if (!bot.reconcile) throw new Error('Deze versie van de bot heeft nog geen saldocontrole');
    await bot.reconcile();
    return { ok: true, safety: bot.safetyStatus?.() ?? null };
  }));

  app.post('/api/admin/learning/unpin', adminOnly, wrap(async (req) => {
    const r = await manager.trainerRequest('/registry/unpin', { method: 'POST', body: {} });
    manager.learningCache = null;
    manager.learnCheckCache = null;
    log.info(`Vastzetten van de modelversie opgeheven door ${req.user.username}`);
    return { ok: true, ...r.data };
  }));

  app.get('/api/aichat', wrap((req, { bot }) => ({
    // Overleg van de AI-trader en zijn team (Market, Strategy, Risk, Execution Agent) bij kopen, tegenhouden en verkopen.
    agentChats: (bot.store.state.agentChats ?? []).slice(0, 80),
  })));

  app.post('/api/pause', wrap((_req, { bot }) => {
    bot.store.state.halted = { at: new Date().toISOString(), reason: 'Handmatig gepauzeerd', manual: true };
    bot.store.save();
  }));

  app.post('/api/resume', wrap((_req, { bot }) => {
    bot.store.state.halted = null;
    bot.store.save();
  }));

  app.post('/api/tick', wrap(async (_req, { bot }) => {
    await (bot.runNow ? bot.runNow() : bot.tick());
    return { ok: true, lastTickAt: bot.lastTickAt, nextTickAt: bot.nextTickAt };
  }));

  app.post('/api/positions/close', wrap(async (req, { bot }) => {
    const pair = String(req.body?.pair ?? '');
    const trade = await bot.closeManual(pair);
    log.info(`Positie ${pair} handmatig gesloten door ${req.user.username}`);
    return { ok: true, trade };
  }));

  // Overschakelen tussen paper en live. Live vereist het wachtwoord en het woord LIVE.
  // Bybit (beurs met eigen-risico-akkoord): live vereist het wachtwoord, letterlijk EIGEN RISICO (confirmText)
  // en een verliesgrens in euro (maxLossEur); het akkoord geldt vanaf nu. De bestaande eisen (keys, inzet,
  // geen open posities) controleert de bot daarna; mislukt dat, dan vervalt het akkoord weer.
  app.post('/api/settings/mode', wrap(async (req, { bot, settings }) => {
    const { mode, password, confirm: word, confirmText, maxLossEur } = req.body ?? {};
    confirm(req, password);
    // Centrale check per beurs, vóór alles en los van wat het dashboard doet.
    const allowed = liveAllowedOnVenue(bot.venue, settings);
    if (mode === 'live' && allowed.accord) {
      const accord = { confirmText: confirmText ?? word, maxLossEur };
      const n = checkAccordInput(bot.venue, accord);
      await bot.switchMode('live', { accord });
      log.warn(`Modus gewijzigd naar live op ${bot.venueLabel}, op eigen risico (verliesgrens € ${n.toFixed(2)}) door ${req.user.username}`);
      return { ok: true, mode: bot.mode, liveBalance: bot.liveBalance, venueRisk: bot.venueRiskStatus() };
    }
    if (mode === 'live' && !allowed.ok) throw new Error(allowed.reason);
    if (mode === 'live' && String(word ?? '').trim() !== 'LIVE') {
      throw new Error('Typ LIVE ter bevestiging');
    }
    await bot.switchMode(mode);
    log.warn(`Modus gewijzigd naar ${mode} door ${req.user.username}`);
    return { ok: true, mode: bot.mode, liveBalance: bot.liveBalance };
  }));

  // Beurs kiezen (Bitvavo of Bybit). Alleen zonder open posities; live alleen waar live mag. Paper op Bybit is
  // nepgeld, dus geen wachtwoord; staat de bot live, dan wel.
  app.post('/api/settings/exchange', wrap(async (req, { bot }) => {
    const exchange = String(req.body?.exchange ?? '');
    if (!VENUE_IDS.includes(exchange)) throw new Error(`Onbekende beurs "${exchange}"`);
    if (bot.mode === 'live') confirm(req, req.body?.password);
    const r = await bot.switchVenue(exchange);
    bot.onScheduleChange?.();
    log.warn(`Beurs gewijzigd naar ${bot.venueLabel} door ${req.user.username}`);
    return { ok: true, exchange: bot.venue, notice: r?.notice ?? null, risk: bot.risk };
  }));

  // Welke Bybit-website (bybit.com, Bybit EU, Bybit NL): elk heeft eigen accounts en keys.
  app.post('/api/settings/bybit-host', wrap((req) => {
    const host = String(req.body?.host ?? '');
    const r = manager.setBybitHost(req.user.id, host);
    log.info(`Bybit-website gewijzigd naar ${r} door ${req.user.username}`);
    return { ok: true, bybitHost: r };
  }));

  // Strategie van de admin volgen (of niet). Bestaande eigen posities blijven gewoon bewaakt.
  app.post('/api/settings/follow', wrap((req, { bot, settings }) => {
    if (req.user.role === 'admin') throw new Error('De admin is zelf de leider en kan niet volgen');
    const enabled = Boolean(req.body?.enabled);
    if (bot.mode === 'live') confirm(req, req.body?.password);
    settings.setFollow(enabled);
    bot.onScheduleChange?.();
    log.info(`${req.user.username} ${enabled ? 'volgt nu' : 'volgt niet meer'} de strategie van de admin`);
    return { ok: true, follow: settings.follow, following: bot.following };
  }));

  // In live-modus gaat het om echt geld, dus dan is je wachtwoord nodig.
  app.post('/api/settings/risk', wrap(async (req, { bot, settings }) => {
    if (bot.mode === 'live') confirm(req, req.body?.password);
    await bot.setRisk(req.body?.risk);
    log.info(`Risico gewijzigd door ${req.user.username}: ${JSON.stringify(settings.risk)}`);
    return { ok: true, risk: bot.risk };
  }));

  app.post('/api/settings/strategy', wrap(async (req, { bot }) => {
    notWhileFollowing(bot, 'de strategie');
    if (bot.mode === 'live') confirm(req, req.body?.password);
    await bot.setStrategy(req.body?.strategy);
    return { ok: true, strategy: bot.strategy };
  }));

  // Geen wachtwoord nodig: het is nepgeld. Het dashboard vraagt wel om bevestiging.
  app.post('/api/paper/reset', wrap(async (req, { bot }) => {
    await bot.resetPaper(req.body?.startBalanceEur);
    log.warn(`Paper-account gereset door ${req.user.username}`);
  }));

  app.post('/api/settings/schedule', wrap(async (req, { bot }) => {
    notWhileFollowing(bot, 'de planning');
    await bot.setSchedule({ timeframe: req.body?.timeframe, checkIntervalMinutes: req.body?.checkIntervalMinutes });
    log.info(`Planning gewijzigd door ${req.user.username}: elke ${bot.checkIntervalMinutes * 60} sec, ${bot.timeframe}`);
    return { ok: true, timeframe: bot.timeframe, checkIntervalMinutes: bot.checkIntervalMinutes, nextTickAt: bot.nextTickAt };
  }));

  app.post('/api/settings/notify', wrap((req, { settings }) => {
    settings.setNotify(req.body ?? {});
    return { ok: true, notify: settings.notify };
  }));

  app.post('/api/summary/apply', wrap(async (req, { bot }) => {
    notWhileFollowing(bot, 'de strategie');
    if (bot.mode === 'live') confirm(req, req.body?.password);
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    const applied = await bot.applySummarySuggestions(keys);
    log.info(`AI-voorstel overgenomen door ${req.user.username}: ${applied.map((x) => x.key).join(', ')}`);
    return { ok: true, applied };
  }));

  app.post('/api/summary/now', wrap(async (_req, { bot }) => ({ ok: true, summary: await bot.dailySummary() })));

  app.post('/api/settings/notify/test', wrap(async (_req, { notifier }) => {
    await notifier.test();
  }));

  app.post('/api/settings/heartbeat/test', adminOnly, wrap(async (_req, { notifier }) => {
    const r = await notifier.heartbeat(true, { force: true });
    if (!r) throw new Error('Er is nog geen heartbeat-URL ingesteld');
    if (r.error) throw new Error(`Heartbeat mislukt: ${r.error}`);
    return { ok: true, lastHeartbeat: r };
  }));

  app.get('/api/markets', wrap(async (_req, { bot }) => ({ markets: await bot.listMarkets() })));

  app.post('/api/settings/pairs', wrap(async (req, { bot, settings }) => {
    notWhileFollowing(bot, 'de coinlijst');
    await bot.setPairs(req.body?.pairs);
    log.info(`Coins gewijzigd door ${req.user.username}: ${settings.pairs.join(', ')}`);
    return { ok: true, pairs: settings.pairs };
  }));

  app.post('/api/settings/ai', wrap((req, { settings, secrets }) => {
    const body = req.body ?? {};
    settings.setAi(body);
    // Keys verhuizen mee met het verschuiven of verwijderen van modellen.
    if (Array.isArray(body.keyMap)) remapAiKeys(secrets, body.keyMap, body.newKeys, 1 + settings.ai.fallbacks.length);
    log.info(`AI-instelling gewijzigd door ${req.user.username}: ${settings.ai.provider}`);
    return { ok: true, ai: settings.ai };
  }));

  app.post('/api/settings/ai/models', wrap(async (req, { bot }) => ({ ok: true, models: await bot.listAiModels(req.body ?? {}) })));

  app.post('/api/settings/ai/test', wrap(async (_req, { bot }) => ({ ok: true, ...(await bot.testAi()) })));

  // Test de keys van een beurs zonder van modus te wisselen (alleen saldo ophalen). Zonder venue: Bitvavo.
  app.post('/api/settings/keys/test', wrap(async (req, { bot }) => {
    const venue = String(req.body?.venue ?? 'bitvavo');
    if (!VENUE_IDS.includes(venue)) throw new Error(`Onbekende beurs "${venue}"`);
    if (venue === 'bitvavo' && bot.venue === 'bitvavo') return { ok: true, liveBalance: await bot.refreshLiveBalance() };
    return { ok: true, ...(await manager.testKeys(req.user.id, venue)) };
  }));

  // --- Eigen model / trainer -------------------------------------------------
  // Status van het model (voor iedereen zichtbaar; instellen alleen door de admin).
  app.get('/api/model', wrap(async (req) => {
    const ml = manager.ml;
    const out = { configured: Boolean(manager.trainerAccess()), meta: ml.model?.meta ?? null, fetchedAt: ml.fetchedAt, error: ml.error, trainer: null };
    if (req.user.role === 'admin' && out.configured) {
      out.trainer = await manager.trainerRequest('/status').then((r) => r.data).catch((err) => ({ error: err.message }));
    }
    return out;
  }));

  // Trainingsinstellingen afgeleid van de strategie en het risico van de admin.
  const trainerConfig = (bot, settings, days) => {
    const r = bot.risk;
    const tfMin = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 }[bot.timeframe] ?? 5;
    const cost = r.limitOrders ? (r.makerFeePct ?? 0.15) + (r.feePct ?? 0.25) : (r.feePct ?? 0.25) * 2;
    const stopPct = r.stopLossPct > 0 ? r.stopLossPct : 2;
    return {
      timeframe: bot.timeframe,
      stopPct,
      // Winstdoel: je take-profit; staat die uit, dan 1,5× de stop (en altijd ruim boven de kosten).
      targetPct: r.takeProfitPct > 0 ? r.takeProfitPct : Math.max(stopPct * 1.5, cost * 3),
      costPct: +cost.toFixed(3),
      // Hoe lang een trade mag duren: je maximale tijd in positie, anders ongeveer 3 uur.
      horizon: Math.max(6, Math.round((r.maxHoldMinutes > 0 ? r.maxHoldMinutes : 180) / tfMin)),
      pairs: settings.pairs,
      // Hoeveel dagen geschiedenis: alleen meesturen als je het hier opgeeft; anders blijft de
      // keuze op de pagina Trainer staan.
      ...(days ? { days: Math.min(365, Math.max(14, Number(days))) } : {}),
    };
  };
  const startTraining = async (cfg) => {
    await manager.trainerRequest('/config', { method: 'POST', body: cfg });
    return manager.trainerRequest('/train', { method: 'POST', body: {} }).then(() => true).catch((err) => {
      if (/loopt al/.test(err.message)) return false;
      throw err;
    });
  };

  // Stuurt de instellingen van de admin naar de trainer en start een training.
  app.post('/api/admin/trainer/train', adminOnly, wrap(async (req, { bot, settings }) => {
    const cfg = trainerConfig(bot, settings, req.body?.days);
    const started = await startTraining(cfg);
    log.info(`Training gestart door ${req.user.username}: ${JSON.stringify(cfg)}`);
    return { ok: true, started, config: cfg };
  }));

  // AI-trader: aan/uit, candle-tijden, noodstop, pauze.
  app.post('/api/admin/trainer/agent', adminOnly, wrap(async (req, { bot }) => {
    const b = req.body ?? {};
    const agent = { enabled: Boolean(b.enabled), timeframes: Array.isArray(b.timeframes) ? b.timeframes.map(String) : [],
      safetyStopPct: Number(b.safetyStopPct) || 10, pauseMinutes: Number.isFinite(Number(b.pauseMinutes)) ? Number(b.pauseMinutes) : 1,
      coinPool: b.coinPool === 'eigen' ? 'eigen' : 'top',
      // Leeruren van de AI-trader ('0-7', '1,2,3'; leeg = doorlopend). De leerserver controleert.
      hours: typeof b.hours === 'string' ? b.hours.slice(0, 80) : '',
      // De portefeuille in de backtest rekent met evenveel open trades als de bot.
      maxOpen: Math.max(1, Math.min(20, Number(bot?.risk?.maxOpenTrades) || 2)) };
    const r = await manager.trainerRequest('/config', { method: 'POST', body: { agent } });
    log.info(`AI-trader gewijzigd door ${req.user.username}: ${JSON.stringify(agent)}`);
    return { ok: true, config: r.data.config };
  }));

  // Orderboek en transacties opnemen aan/uit.
  // Koppelcode voor een helper (6 cijfers, 15 minuten geldig) plus het adres van de leerserver,
  // zodat het dashboard een kant-en-klaar startcommando kan tonen.
  app.post('/api/admin/trainer/helper-pair', adminOnly, wrap(async (req) => {
    const r = await manager.trainerRequest('/helper/pair-code', { method: 'POST', body: {} });
    log.info(`Koppelcode voor een helper gemaakt door ${req.user.username}`);
    return { ...r.data, url: manager.trainerAccess()?.url ?? null };
  }));

  app.post('/api/admin/trainer/micro', adminOnly, wrap(async (req) => {
    const r = await manager.trainerRequest('/config', { method: 'POST', body: { micro: { enabled: Boolean(req.body?.enabled) } } });
    return { ok: true, config: r.data.config };
  }));

  // Strategie-zoeker aan/uit en instellingen.
  app.post('/api/admin/trainer/search', adminOnly, wrap(async (req) => {
    const b = req.body ?? {};
    const search = { enabled: Boolean(b.enabled), timeframes: Array.isArray(b.timeframes) ? b.timeframes.map(String) : [], perRound: Number(b.perRound) || 6,
      pauseMinutes: Number.isFinite(Number(b.pauseMinutes)) ? Number(b.pauseMinutes) : 1, autoApply: Boolean(b.autoApply) };
    const r = await manager.trainerRequest('/config', { method: 'POST', body: { search } });
    log.info(`Strategie-zoeker gewijzigd door ${req.user.username}: ${JSON.stringify(search)}`);
    return { ok: true, config: r.data.config };
  }));

  // Een bevestigde strategie van de zoeker toepassen: stop, winstdoel, maximale duur en candle-tijd
  // van de admin aanpassen, en meteen een model met die instellingen trainen.
  app.post('/api/admin/trainer/apply', adminOnly, wrap(async (req, { bot, settings }) => {
    const status = (await manager.trainerRequest('/status')).data;
    const s = (status.search?.leaderboard ?? []).find((x) => x.key === req.body?.key);
    if (!s) throw new Error('Deze strategie staat niet (meer) in de ranglijst');
    if (s.status !== 'bevestigd') throw new Error('Alleen bevestigde strategieën kunnen worden toegepast');
    if (s.timeframe !== bot.timeframe) await bot.setSchedule({ timeframe: s.timeframe, checkIntervalMinutes: bot.checkIntervalMinutes });
    await bot.setRisk({ stopLossPct: s.stopPct, takeProfitPct: s.targetPct, maxHoldMinutes: s.holdMinutes });
    const started = await startTraining(trainerConfig(bot, settings));
    log.warn(`Strategie toegepast door ${req.user.username}: ${s.key}`);
    return { ok: true, started, applied: { timeframe: s.timeframe, stopLossPct: s.stopPct, takeProfitPct: s.targetPct, maxHoldMinutes: s.holdMinutes } };
  }));

  // Live status voor de pagina Trainer.
  app.get('/api/admin/trainer/status', adminOnly, wrap(async () => {
    const ml = manager.ml;
    const base = { configured: Boolean(manager.trainerAccess()), model: ml.model?.meta ?? null, fetchedAt: ml.fetchedAt, fetchError: ml.error,
      feedbackQueued: manager.feedbackQueue.length, feedbackError: ml.feedbackError ?? null, feedbackSentAt: ml.feedbackSentAt ?? null };
    if (!base.configured) return base;
    try {
      const trainer = (await manager.trainerRequest('/status')).data;
      // Heeft de trainer een nieuwer model dan de bot? Dan nu meteen ophalen in plaats van
      // te wachten op de volgende halfuurlijkse controle.
      // AI-trader en strategieën meteen ophalen als de trainer iets nieuws heeft (met ETag: goedkoop).
      if (trainer?.agent?.published?.at && trainer.agent.published.at !== manager.ml.agentSeenAt) {
        manager.ml.agentSeenAt = trainer.agent.published.at;
        await manager.refreshAgent().catch(() => {});
      }
      if (trainer?.model?.trainedAt && trainer.model.trainedAt !== ml.model?.meta?.trainedAt) {
        await manager.refreshModel();
        Object.assign(base, { model: manager.ml.model?.meta ?? null, fetchedAt: manager.ml.fetchedAt, fetchError: manager.ml.error });
      }
      return { ...base, trainer };
    } catch (err) {
      return { ...base, trainerError: err.message };
    }
  }));

  // Wanneer trainen en hoeveel geschiedenis (pagina Trainer).
  app.post('/api/admin/trainer/schedule', adminOnly, wrap(async (req) => {
    const b = req.body ?? {};
    const body = {
      schedule: {
        mode: String(b.mode ?? 'times'),
        hours: Array.isArray(b.hours) ? b.hours.map(Number) : undefined,
        everyHours: b.everyHours != null ? Number(b.everyHours) : undefined,
        pauseMinutes: b.pauseMinutes != null ? Number(b.pauseMinutes) : undefined,
      },
      ...(b.days ? { days: Number(b.days) } : {}),
      ...(b.maxSamples ? { maxSamples: Number(b.maxSamples) } : {}),
    };
    const r = await manager.trainerRequest('/config', { method: 'POST', body });
    log.info(`Trainingsschema gewijzigd door ${req.user.username}: ${JSON.stringify(body)}`);
    return { ok: true, config: r.data.config };
  }));

  app.post('/api/admin/trainer/fetch', adminOnly, wrap(async () => {
    const ml = await manager.refreshModel();
    if (ml.error) throw new Error(ml.error);
    return { ok: true, meta: ml.model?.meta ?? null };
  }));

  // --- Gebruikersbeheer (alleen admin) ---------------------------------------
  app.get('/api/admin/users', adminOnly, wrap(() => ({ users: manager.overview(), invites: users.listInvites() })));

  app.post('/api/admin/invites', adminOnly, wrap((req) => {
    const { code, invite } = users.createInvite(req.user.id, req.body?.note ?? '');
    log.info(`Uitnodiging aangemaakt door ${req.user.username}${invite.note ? ` (${invite.note})` : ''}`);
    // De code wordt alleen nu getoond; opgeslagen wordt alleen een hash.
    return { ok: true, code, invite };
  }));

  app.post('/api/admin/invites/revoke', adminOnly, wrap((req) => {
    users.revokeInvite(String(req.body?.id ?? ''));
  }));

  app.post('/api/admin/users/disable', adminOnly, wrap((req) => {
    const id = String(req.body?.id ?? '');
    const disabled = Boolean(req.body?.disabled);
    users.setDisabled(id, disabled);
    if (disabled) manager.stop(id);
    else manager.start(users.get(id));
    log.warn(`Gebruiker ${users.get(id)?.username} ${disabled ? 'uitgeschakeld' : 'weer ingeschakeld'} door ${req.user.username}`);
    return { ok: true, users: manager.overview() };
  }));

  app.post('/api/admin/users/remove', adminOnly, wrap((req) => {
    const id = String(req.body?.id ?? '');
    const u = users.get(id);
    if (!u) throw new Error('Gebruiker niet gevonden');
    const ctx = manager.get(id);
    if (ctx?.settings.mode === 'live' && Object.keys(ctx.stores.live.state.positions).length) {
      throw new Error(`${u.username} heeft nog open live-posities. Schakel het account eerst uit of laat de posities sluiten.`);
    }
    confirm(req, req.body?.password);
    users.remove(id);
    manager.archive(id);
    log.warn(`Gebruiker ${u.username} verwijderd door ${req.user.username}`);
    return { ok: true, users: manager.overview() };
  }));

  return app;
}

export function startServer({ config, users, manager, log = console }) {
  const app = createApp({ users, manager, log });
  return app.listen(config.server.port, () => log.info(`Dashboard op poort ${config.server.port}`));
}
