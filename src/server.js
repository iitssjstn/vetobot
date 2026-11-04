import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE, readCookie } from './auth.js';
import { SECRET_NAMES } from './secrets.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer({ config, bot, store, secrets, auth, log = console }) {
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
      secrets.update(updates);
      log.info(`API-keys bijgewerkt door ${req.user}: ${Object.keys(updates).join(', ') || 'geen'}`);
      res.json(secrets.status());
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/state', (_req, res) => {
    const s = store.state;
    const closed = s.trades;
    const wins = closed.filter((t) => t.pnlEur > 0).length;
    const keys = secrets.status();
    res.json({
      mode: bot.broker.mode,
      pairs: config.pairs,
      timeframe: config.timeframe,
      aiProvider: config.ai.provider,
      aiKeySet: keys.aiApiKey.set,
      bitvavoKeysSet: keys.bitvavoApiKey.set && keys.bitvavoApiSecret.set,
      risk: config.risk,
      balanceEur: s.balanceEur,
      startBalanceEur: s.startBalanceEur,
      halted: s.halted,
      positions: Object.values(s.positions),
      trades: closed.slice(0, 100),
      decisions: s.decisions.slice(0, 100),
      stats: {
        totalTrades: closed.length,
        winRate: closed.length ? (wins / closed.length) * 100 : null,
        realizedEur: closed.reduce((a, t) => a + t.pnlEur, 0),
        realizedTodayEur: store.realizedTodayEur(),
        vetoed: s.decisions.filter((d) => d.outcome === 'vetoed').length,
        approved: s.decisions.filter((d) => d.outcome === 'approved').length,
      },
      lastTickAt: bot.lastTickAt,
      lastError: bot.lastError,
    });
  });

  app.post('/api/pause', (_req, res) => {
    store.state.halted = { at: new Date().toISOString(), reason: 'Handmatig gepauzeerd', manual: true };
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/resume', (_req, res) => {
    store.state.halted = null;
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/tick', async (_req, res) => {
    await bot.tick();
    res.json({ ok: true, lastTickAt: bot.lastTickAt });
  });

  return app.listen(config.server.port, () => log.info(`Dashboard op poort ${config.server.port}`));
}
