import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE, readCookie } from './auth.js';
import { SECRET_NAMES } from './secrets.js';
import { AI_PROVIDERS, MAX_PAIRS, TIMEFRAMES, RISK_LIMITS, STRATEGY_LIMITS } from './settings.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer({ config, bot, settings, secrets, auth, log = console }) {
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

  const setCookie = (req, res, token) => {
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`);
  };
  const clearCookie = (res) => res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  const fail = (res, err, status = 400) => res.status(status).json({ error: err.message });

  // --- Openbaar -------------------------------------------------------------
  app.get('/healthz', (_req, res) => res.json({ ok: true, lastTickAt: bot.lastTickAt }));
  app.use(express.static(publicDir));

  app.get('/api/auth/status', (req, res) => {
    const user = auth.verify(readCookie(req, COOKIE));
    res.json({ setupRequired: !auth.isSetUp(), loggedIn: Boolean(user), username: user });
  });

  app.post('/api/auth/setup', (req, res) => {
    try {
      const token = auth.setup(req.body ?? {}, req.ip);
      log.info(`Admin-account "${auth.data.username}" aangemaakt.`);
      setCookie(req, res, token);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      setCookie(req, res, auth.login(req.body ?? {}, req.ip));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 401);
    }
  });

  // --- Alles hieronder vereist een ingelogde sessie ------------------------
  app.use('/api', (req, res, next) => {
    const user = auth.verify(readCookie(req, COOKIE));
    if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
    // Extra CSRF-bescherming naast SameSite=Strict.
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type moet application/json zijn' });
    }
    req.user = user;
    next();
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.logout(readCookie(req, COOKIE));
    clearCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    try {
      auth.changePassword(req.body ?? {}, req.ip);
      clearCookie(res);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/settings/keys', (_req, res) => res.json(secrets.status()));

  app.post('/api/settings/keys', (req, res) => {
    try {
      const updates = {};
      for (const name of SECRET_NAMES) if (name in (req.body ?? {})) updates[name] = req.body[name];
      const removesBitvavo = ['bitvavoApiKey', 'bitvavoApiSecret'].some((n) => n in updates && !updates[n]);
      if (bot.mode === 'live' && removesBitvavo) {
        throw new Error('Schakel eerst terug naar paper voordat je de Bitvavo-keys verwijdert');
      }
      secrets.update(updates);
      log.info(`API-keys bijgewerkt door ${req.user}: ${Object.keys(updates).join(', ') || 'geen'}`);
      res.json(secrets.status());
    } catch (err) {
      fail(res, err);
    }
  });

  // Toon hooguit een korte foutmelding naar buiten; nooit stacktraces of keys.
  const wrap = (fn) => async (req, res) => {
    try {
      res.json((await fn(req)) ?? { ok: true });
    } catch (err) {
      fail(res, err);
    }
  };

  app.get('/api/state', (_req, res) => {
    const store = bot.store;
    const s = store.state;
    const closed = s.trades;
    const wins = closed.filter((t) => t.pnlEur > 0).length;
    const keys = secrets.status();
    res.json({
      mode: bot.mode,
      modeChangedAt: settings.data.modeChangedAt,
      pairs: settings.pairs,
      maxPairs: MAX_PAIRS,
      timeframe: settings.timeframe,
      timeframes: TIMEFRAMES,
      ai: settings.ai,
      aiProviders: AI_PROVIDERS,
      aiKeySet: keys.aiApiKey.set,
      bitvavoKeysSet: keys.bitvavoApiKey.set && keys.bitvavoApiSecret.set,
      risk: bot.risk,
      riskLimits: RISK_LIMITS,
      strategy: bot.strategy,
      strategyLimits: STRATEGY_LIMITS,
      balanceEur: s.balanceEur,
      startBalanceEur: s.startBalanceEur,
      liveBalance: bot.liveBalance,
      halted: s.halted,
      positions: Object.values(s.positions).map((p) => {
        const ps = bot.pairStatus[p.pair];
        const current = ps?.price ?? null;
        return { ...p, currentPrice: current, changePct: current ? ((current - p.entryPrice) / p.entryPrice) * 100 : null };
      }),
      trades: closed.slice(0, 100),
      decisions: s.decisions.slice(0, 100),
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
      checkIntervalMinutes: settings.checkIntervalMinutes,
      pairStatus: settings.pairs.map((pair) => ({ pair, ...bot.pairStatus[pair] })),
      activity: bot.activity.slice(0, 100),
      serverTime: new Date().toISOString(),
    });
  });

  app.post('/api/pause', wrap(() => {
    bot.store.state.halted = { at: new Date().toISOString(), reason: 'Handmatig gepauzeerd', manual: true };
    bot.store.save();
  }));

  app.post('/api/resume', wrap(() => {
    bot.store.state.halted = null;
    bot.store.save();
  }));

  app.post('/api/tick', wrap(async () => {
    await bot.tick();
    return { ok: true, lastTickAt: bot.lastTickAt };
  }));

  app.post('/api/positions/close', wrap(async (req) => {
    const pair = String(req.body?.pair ?? '');
    await bot.closeManual(pair);
    log.info(`Positie ${pair} handmatig gesloten door ${req.user}`);
  }));

  // Overschakelen tussen paper en live. Live vereist het wachtwoord en het woord LIVE.
  app.post('/api/settings/mode', wrap(async (req) => {
    const { mode, password, confirm } = req.body ?? {};
    auth.confirmPassword(password, req.ip);
    if (mode === 'live' && String(confirm ?? '').trim() !== 'LIVE') {
      throw new Error('Typ LIVE ter bevestiging');
    }
    await bot.switchMode(mode);
    log.warn(`Modus gewijzigd naar ${mode} door ${req.user}`);
    return { ok: true, mode: bot.mode, liveBalance: bot.liveBalance };
  }));

  // In live-modus gaat het om echt geld, dus dan is je wachtwoord nodig.
  app.post('/api/settings/risk', wrap(async (req) => {
    if (bot.mode === 'live') auth.confirmPassword(req.body?.password, req.ip);
    await bot.setRisk(req.body?.risk);
    log.info(`Risico gewijzigd door ${req.user}: ${JSON.stringify(settings.risk)}`);
    return { ok: true, risk: bot.risk };
  }));

  app.post('/api/settings/strategy', wrap(async (req) => {
    if (bot.mode === 'live') auth.confirmPassword(req.body?.password, req.ip);
    await bot.setStrategy(req.body?.strategy);
    return { ok: true, strategy: bot.strategy };
  }));

  app.post('/api/paper/reset', wrap(async (req) => {
    auth.confirmPassword(req.body?.password, req.ip);
    await bot.resetPaper(req.body?.startBalanceEur);
    log.warn(`Paper-account gereset door ${req.user}`);
  }));

  app.post('/api/settings/schedule', wrap(async (req) => {
    await bot.setSchedule({ timeframe: req.body?.timeframe, checkIntervalMinutes: req.body?.checkIntervalMinutes });
    log.info(`Planning gewijzigd door ${req.user}: ${settings.checkIntervalMinutes} min, ${settings.timeframe}`);
    return { ok: true, timeframe: settings.timeframe, checkIntervalMinutes: settings.checkIntervalMinutes, nextTickAt: bot.nextTickAt };
  }));

  app.get('/api/markets', wrap(async () => ({ markets: await bot.listMarkets() })));

  app.post('/api/settings/pairs', wrap(async (req) => {
    await bot.setPairs(req.body?.pairs);
    log.info(`Coins gewijzigd door ${req.user}: ${settings.pairs.join(', ')}`);
    return { ok: true, pairs: settings.pairs };
  }));

  app.post('/api/settings/ai', wrap((req) => {
    settings.setAi(req.body ?? {});
    log.info(`AI-instelling gewijzigd door ${req.user}: ${settings.ai.provider}`);
    return { ok: true, ai: settings.ai };
  }));

  // Test de Bitvavo-keys zonder van modus te wisselen.
  app.post('/api/settings/keys/test', wrap(async () => ({ ok: true, liveBalance: await bot.refreshLiveBalance() })));

  return app.listen(config.server.port, () => log.info(`Dashboard op poort ${config.server.port}`));
}
