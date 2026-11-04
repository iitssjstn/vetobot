import { config, validateConfig } from './config.js';
import { createExchange, PaperBroker, LiveBroker } from './exchange.js';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { Auth } from './auth.js';
import { Bot } from './bot.js';
import { startServer } from './server.js';

const errors = validateConfig();
if (errors.length) {
  for (const e of errors) console.error(`Configuratiefout: ${e}`);
  process.exit(1);
}

const mode = config.liveTrading ? 'live' : 'paper';
const secrets = new SecretStore(config.dataDir);
const auth = new Auth(config.dataDir);
const exchange = createExchange(secrets);
const broker = mode === 'live' ? new LiveBroker(exchange) : new PaperBroker(exchange, config.risk.feePct);
const store = new Store(config.dataDir, mode, config.paper.startBalanceEur);
const bot = new Bot({ config, exchange, broker, store, secrets });

console.info(
  `vetobot start in ${mode.toUpperCase()}-modus | pairs: ${config.pairs.join(', ')} | ` +
    `timeframe: ${config.timeframe} | AI: ${config.ai.provider}`,
);
if (mode === 'live') console.warn('LET OP: live trading staat aan. Er worden echte orders geplaatst.');

if (!auth.isSetUp()) {
  console.warn('==================================================================');
  console.warn(' Nog geen admin-account. Open het dashboard en maak er een aan.');
  console.warn(` Setup-code: ${auth.setupCode}`);
  console.warn(' Deze code is eenmalig en verandert bij elke herstart tot de setup klaar is.');
  console.warn('==================================================================');
}

const server = startServer({ config, bot, store, secrets, auth });

const run = () => bot.tick().catch((err) => console.error('Tick mislukt:', err));
run();
const timer = setInterval(run, config.checkIntervalMinutes * 60 * 1000);

function shutdown(sig) {
  console.info(`${sig} ontvangen, afsluiten...`);
  clearInterval(timer);
  store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
