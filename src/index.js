import { config, validateConfig } from './config.js';
import { Users } from './users.js';
import { BotManager } from './manager.js';
import { startServer } from './server.js';

const errors = validateConfig();
if (errors.length) {
  for (const e of errors) console.error(`Configuratiefout: ${e}`);
  process.exit(1);
}

// Elke gebruiker heeft een eigen bot, keys en instellingen. De BotManager beheert ze
// allemaal, met één gedeelde verbinding voor marktdata.
const users = new Users(config.dataDir);
const manager = new BotManager({ config, users });

if (!users.isSetUp()) {
  console.warn('==================================================================');
  console.warn(' Nog geen admin-account. Open het dashboard en maak er een aan.');
  console.warn(` Setup-code: ${users.setupCode}`);
  console.warn(' Deze code is eenmalig en verandert bij elke herstart tot de setup klaar is.');
  console.warn('==================================================================');
} else {
  manager.startAll();
}

for (const ctx of manager.contexts.values()) {
  const { bot, settings, notifier, user } = ctx;
  console.info(
    `[${user.username}] ${settings.mode.toUpperCase()} | ${bot.following ? 'volgt de admin' : `coins: ${bot.pairs.join(', ')}`} | ` +
      `elke ${bot.checkIntervalMinutes * 60} sec, ${bot.timeframe} | AI: ${settings.ai.provider}`,
  );
  if (settings.mode === 'live') console.warn(`LET OP: live trading staat aan voor ${user.username}. Er worden echte orders geplaatst.`);
  const open = Object.keys(bot.store.state.positions);
  notifier.send('startup', {
    title: 'vetobot is gestart',
    message: open.length
      ? `Weer online. Er staan ${open.length} positie(s) open die weer bewaakt worden: ${open.join(', ')}.`
      : 'Weer online. Er staan geen posities open.',
    level: settings.mode === 'live' ? 'live' : 'ok',
    fields: [
      { name: 'Modus', value: settings.mode === 'live' ? 'LIVE' : 'paper' },
      { name: 'Coins', value: bot.following ? 'volgt de admin' : String(bot.pairs.length) },
    ],
  }).catch(() => {});
}

const server = startServer({ config, users, manager });

function shutdown(sig) {
  console.info(`${sig} ontvangen, afsluiten...`);
  manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
