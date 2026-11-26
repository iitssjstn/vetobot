import { config, validateConfig } from './config.js';
import { Users } from './users.js';
import { BotManager } from './manager.js';
import { startServer } from './server.js';
import { openRunState } from './runstate.js';

const errors = validateConfig();
if (errors.length) {
  for (const e of errors) console.error(`Configuratiefout: ${e}`);
  process.exit(1);
}

// Elke gebruiker heeft een eigen bot, keys en instellingen. De BotManager beheert ze
// allemaal, met één gedeelde verbinding voor marktdata.
const users = new Users(config.dataDir);
const manager = new BotManager({ config, users });

// Onverwacht gestopt? Bij elke start: is de vorige keer netjes afgesloten (SIGTERM/SIGINT)? Zo niet
// (crash, stroom weg, Docker die de container afschoot), dan meldt de bot dat bij het opstarten.
// Elke minuut wordt 'lastAlive' bijgewerkt, zodat bekend is wanneer hij voor het laatst leefde.
const runState = openRunState(config.dataDir);
manager.uncleanRestart = runState.unclean;
setInterval(() => runState.alive(), 60000).unref();

// Een fout die nergens wordt opgevangen mag niet alleen in de console belanden.
process.on('unhandledRejection', (err) => manager.reportProcessError('niet opgevangen fout (promise)', err));
process.on('uncaughtException', (err) => {
  // Na een exception is de toestand onzeker: melden, dan stoppen. Docker start de container opnieuw;
  // bij die start ziet de bot dat het niet netjes ging, meldt dat en bewaakt de posities weer.
  manager.reportProcessError('onverwachte crash', err);
  setTimeout(() => process.exit(1), 3000).unref();
});

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
  const unclean = manager.uncleanRestart;
  if (unclean) bot.health.recovered(`herstart na een onverwachte stop (laatst actief ${unclean.lastAlive ?? 'onbekend'}); posities weer bewaakt`);
  const msg = open.length
    ? `Weer online. Er staan ${open.length} positie(s) open die weer bewaakt worden: ${open.join(', ')}.`
    : 'Weer online. Er staan geen posities open.';
  notifier.send(unclean ? 'health' : 'startup', {
    title: unclean ? '🟠 vetobot is onverwacht herstart' : 'vetobot is gestart',
    message: unclean
      ? `De vorige keer stopte vetobot niet netjes (crash, stroomuitval of een geforceerde herstart). Laatst actief: ${unclean.lastAlive ?? 'onbekend'}. ${msg} ` +
        'Live controleert hij eerst saldo en stop-orders bij Bitvavo voordat hij iets nieuws koopt.'
      : msg,
    level: unclean ? 'warn' : settings.mode === 'live' ? 'live' : 'ok',
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
  runState.clean();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
