import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function basicAuth(password) {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
      const given = Buffer.from(pass);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="vetobot"').status(401).send('Inloggen vereist');
  };
}

export function startServer({ config, bot, store, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.json({ ok: true, lastTickAt: bot.lastTickAt }));

  if (config.server.password) app.use(basicAuth(config.server.password));
  else log.warn('DASHBOARD_PASSWORD is niet ingesteld: het dashboard is zonder wachtwoord bereikbaar.');

  app.use(express.static(publicDir));

  app.get('/api/state', (_req, res) => {
    const s = store.state;
    const closed = s.trades;
    const wins = closed.filter((t) => t.pnlEur > 0).length;
    res.json({
      mode: bot.broker.mode,
      pairs: config.pairs,
      timeframe: config.timeframe,
      aiProvider: config.ai.provider,
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
