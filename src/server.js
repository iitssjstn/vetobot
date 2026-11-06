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
import { analyzeTrades } from './analysis.js';
import { AI_PROVIDERS, MAX_PAIRS, TIMEFRAMES, RISK_LIMITS, STRATEGY_LIMITS } from './settings.js';

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
  app.get('/healthz', (_req, res) => res.json({ ok: true, lastTickAt: manager.leaderBot?.lastTickAt ?? null }));
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
    if (openPairs.length) await bot.refreshPrices(openPairs).catch(() => {});
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
      // Zonder het (grote) AI-gesprek; dat haalt de pagina AI-chat apart op.
      decisions: s.decisions.slice(0, 100).map(({ team, ...d }) => (team ? { ...d, hasChat: true } : d)),
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
      serverTime: new Date().toISOString(),
    });
  });

  // Gesprekken van het AI-team, nieuwste eerst.
  app.get('/api/aichat', wrap((req, { bot, settings }) => ({
    mode: settings.ai.mode ?? 'single',
    chats: bot.store.state.decisions.filter((d) => d.team).slice(0, 60)
      .map((d) => ({ at: d.at, pair: d.pair, outcome: d.outcome, reason: d.reason, provider: d.provider, strategyReason: d.strategyReason, team: d.team })),
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
  app.post('/api/settings/mode', wrap(async (req, { bot }) => {
    const { mode, password, confirm: word } = req.body ?? {};
    confirm(req, password);
    if (mode === 'live' && String(word ?? '').trim() !== 'LIVE') {
      throw new Error('Typ LIVE ter bevestiging');
    }
    await bot.switchMode(mode);
    log.warn(`Modus gewijzigd naar ${mode} door ${req.user.username}`);
    return { ok: true, mode: bot.mode, liveBalance: bot.liveBalance };
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

  // Test de Bitvavo-keys zonder van modus te wisselen.
  app.post('/api/settings/keys/test', wrap(async (_req, { bot }) => ({ ok: true, liveBalance: await bot.refreshLiveBalance() })));

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

  // Strategie-zoeker aan/uit en instellingen.
  app.post('/api/admin/trainer/search', adminOnly, wrap(async (req) => {
    const b = req.body ?? {};
    const search = { enabled: Boolean(b.enabled), timeframes: Array.isArray(b.timeframes) ? b.timeframes.map(String) : [], perRound: Number(b.perRound) || 6,
      pauseMinutes: Number.isFinite(Number(b.pauseMinutes)) ? Number(b.pauseMinutes) : 1, autoApply: Boolean(b.autoApply) };
    const r = await manager.trainerRequest('/config', { method: 'POST', body: { search } });
    log.info(`Strategie-zoeker gewijzigd door ${req.user.username}: ${JSON.stringify(search)}`);
    return { ok: true, config: r.data.config };
  }));

  // Een bevestigde strategie van de zoeker toepassen: stop, winstdoel, maximale duur, candle-tijd
  // en minimale modelkans van de admin aanpassen, en meteen een model met die instellingen trainen.
  app.post('/api/admin/trainer/apply', adminOnly, wrap(async (req, { bot, settings }) => {
    const status = (await manager.trainerRequest('/status')).data;
    const s = (status.search?.leaderboard ?? []).find((x) => x.key === req.body?.key);
    if (!s) throw new Error('Deze strategie staat niet (meer) in de ranglijst');
    if (s.status !== 'bevestigd') throw new Error('Alleen bevestigde strategieën kunnen worden toegepast');
    if (s.timeframe !== bot.timeframe) await bot.setSchedule({ timeframe: s.timeframe, checkIntervalMinutes: bot.checkIntervalMinutes });
    await bot.setRisk({ stopLossPct: s.stopPct, takeProfitPct: s.targetPct, maxHoldMinutes: s.holdMinutes });
    const minProb = s.val?.best?.minProb ? Math.round(s.val.best.minProb * 100) : null;
    if (minProb) await bot.setStrategy({ mlMinProb: minProb });
    const started = await startTraining(trainerConfig(bot, settings));
    log.warn(`Strategie toegepast door ${req.user.username}: ${s.key} (min. modelkans ${minProb ?? '-'}%)`);
    return { ok: true, started, applied: { timeframe: s.timeframe, stopLossPct: s.stopPct, takeProfitPct: s.targetPct, maxHoldMinutes: s.holdMinutes, mlMinProb: minProb } };
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
