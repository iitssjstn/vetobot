import { config, validateConfig } from './config.js';
import { createExchange, PaperBroker, LiveBroker } from './exchange.js';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { Settings } from './settings.js';
import { Auth } from './auth.js';
import { Bot } from './bot.js';
import { Notifier } from './notify.js';
import { startServer } from './server.js';

const errors = validateConfig();
if (errors.length) {
  for (const e of errors) console.error(`Configuratiefout: ${e}`);
  process.exit(1);
}

const secrets = new SecretStore(config.dataDir);
const settings = new Settings(config.dataDir, config);
const auth = new Auth(config.dataDir);
const exchange = createExchange(secrets);

// Paper en live hebben elk een eigen broker en state-bestand, zodat ze nooit door elkaar lopen.
const brokers = { paper: new PaperBroker(exchange, () => settings.risk.feePct), live: new LiveBroker(exchange) };
const stores = {
  paper: new Store(config.dataDir, 'paper', config.paper.startBalanceEur),
  live: new Store(config.dataDir, 'live', config.paper.startBalanceEur),
};
const notifier = new Notifier({ secrets, settings });
const bot = new Bot({ config, exchange, brokers, stores, settings, secrets, notifier });

console.info(
  `vetobot start in ${settings.mode.toUpperCase()}-modus | pairs: ${settings.pairs.join(', ')} | ` +
    `elke ${settings.checkIntervalMinutes} min, ${settings.timeframe}-candles | AI: ${settings.ai.provider}`,
);
if (settings.mode === 'live') console.warn('LET OP: live trading staat aan. Er worden echte orders geplaatst.');

if (!auth.isSetUp()) {
  console.warn('==================================================================');
  console.warn(' Nog geen admin-account. Open het dashboard en maak er een aan.');
  console.warn(` Setup-code: ${auth.setupCode}`);
  console.warn(' Deze code is eenmalig en verandert bij elke herstart tot de setup klaar is.');
  console.warn('==================================================================');
}

const server = startServer({ config, bot, settings, secrets, auth, notifier });

{
  const open = Object.keys(bot.store.state.positions);
  notifier.send('startup', {
    title: 'vetobot is gestart',
    message: open.length
      ? `Weer online. Er staan ${open.length} positie(s) open die weer bewaakt worden: ${open.join(', ')}.`
      : 'Weer online. Er staan geen posities open.',
    level: settings.mode === 'live' ? 'live' : 'ok',
    fields: [
      { name: 'Modus', value: settings.mode === 'live' ? 'LIVE' : 'paper' },
      { name: 'Coins', value: String(settings.pairs.length) },
    ],
  }).catch(() => {});
}

// Timer met instelbaar interval. Na een wijziging in het dashboard wordt de
// volgende check opnieuw ingepland vanaf nu.
let timer;
const schedule = () => {
  clearTimeout(timer);
  const ms = settings.checkIntervalMinutes * 60 * 1000;
  bot.nextTickAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(run, ms);
};
const run = () => {
  schedule();
  return bot.tick().catch((err) => console.error('Tick mislukt:', err));
};
bot.onScheduleChange = schedule;
// Een handmatige check vanuit het dashboard start de aftelling ook opnieuw.
bot.runNow = run;
run();

function shutdown(sig) {
  console.info(`${sig} ontvangen, afsluiten...`);
  clearTimeout(timer);
  stores.paper.save();
  stores.live.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
