import fs from 'node:fs';
import path from 'node:path';
import { createExchange, PaperBroker, LiveBroker, SharedMarket, userExchange } from './exchange.js';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { Settings } from './settings.js';
import { Bot } from './bot.js';
import { Notifier } from './notify.js';

// Beheert één bot per gebruiker.
//
// Elke gebruiker heeft een eigen map data/users/<id>/ met instellingen, paper- en live-state
// en versleutelde keys (met een eigen sleutel, afgeleid van data/master.key). Marktdata
// komt uit één gedeelde cache. De admin is de "leider": gebruikers die volgen aanzetten,
// kopen en verkopen mee met de trades van de admin.

const LEGACY_FILES = ['settings.json', 'state-paper.json', 'state-live.json'];

export class BotManager {
  constructor({ config, users, log = console, shared = null, makePrivateExchange = createExchange }) {
    this.config = config;
    this.users = users;
    this.log = log;
    this.shared = shared ?? new SharedMarket();
    this.makePrivateExchange = makePrivateExchange;
    this.contexts = new Map();
    this.root = config.dataDir;
  }

  dirOf(userId) {
    return path.join(this.root, 'users', userId);
  }

  // Zet de data van vóór meerdere gebruikers (direct in data/) over naar de map van de admin.
  migrateLegacy(adminId) {
    const dir = this.dirOf(adminId);
    if (fs.existsSync(dir)) return false;
    const legacy = LEGACY_FILES.filter((f) => fs.existsSync(path.join(this.root, f)));
    const oldSecrets = path.join(this.root, 'secrets.enc');
    if (!legacy.length && !fs.existsSync(oldSecrets)) return false;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of legacy) fs.renameSync(path.join(this.root, f), path.join(dir, f));
    if (fs.existsSync(oldSecrets)) {
      const old = new SecretStore(this.root);
      const fresh = new SecretStore(dir, { keyDir: this.root, scope: adminId });
      fresh.update({ ...old.values });
      fs.renameSync(oldSecrets, `${oldSecrets}.migrated`);
    }
    this.log.info(`Bestaande data overgezet naar het admin-account (${legacy.join(', ')}${fs.existsSync(`${oldSecrets}.migrated`) ? ', keys' : ''}).`);
    return true;
  }

  get leaderBot() {
    const admin = this.users.admin;
    return admin ? this.contexts.get(admin.id)?.bot ?? null : null;
  }

  // Maakt (eenmalig) de bot en alles eromheen voor een gebruiker.
  ensure(user) {
    if (this.contexts.has(user.id)) return this.contexts.get(user.id);
    const dir = this.dirOf(user.id);
    // Nieuwe gebruikers beginnen altijd in paper, ongeacht LIVE_TRADING in de compose.
    const settings = new Settings(dir, user.role === 'admin' ? this.config : { ...this.config, liveTrading: false });
    const secrets = new SecretStore(dir, { keyDir: this.root, scope: user.id });
    const privateEx = this.makePrivateExchange(secrets);
    const exchange = userExchange(this.shared, privateEx);
    const brokers = {
      paper: new PaperBroker(exchange, () => settings.risk.feePct, () => settings.risk.slippagePct),
      live: new LiveBroker(exchange),
    };
    const stores = {
      paper: new Store(dir, 'paper', this.config.paper.startBalanceEur),
      live: new Store(dir, 'live', this.config.paper.startBalanceEur),
    };
    const notifier = new Notifier({ secrets, settings });
    const bot = new Bot({ config: this.config, exchange, brokers, stores, settings, secrets, notifier });
    bot.userId = user.id;
    bot.username = user.username;
    // De heartbeat gaat over de server, dus alleen de admin stuurt hem.
    bot.heartbeatEnabled = user.role === 'admin';
    const ctx = { user, dir, settings, secrets, exchange, brokers, stores, notifier, bot, timer: null };
    this.contexts.set(user.id, ctx);
    this.#wire();
    return ctx;
  }

  get(userId) {
    return this.contexts.get(userId) ?? null;
  }

  // Koppelt de leider aan alle volgers. Opnieuw aanroepen is veilig.
  #wire() {
    const leader = this.leaderBot;
    for (const ctx of this.contexts.values()) {
      ctx.bot.leader = ctx.user.role === 'admin' ? null : leader;
    }
    if (leader) {
      leader.onTrade = (type, payload) => {
        for (const ctx of this.contexts.values()) {
          if (ctx.bot === leader || !ctx.bot.following) continue;
          ctx.bot.mirror(type, payload).catch((err) => this.log.error(`Volgen (${ctx.user.username}): ${err.message}`));
        }
      };
    }
  }

  // ---------- Planning per gebruiker ----------
  #schedule(ctx) {
    clearTimeout(ctx.timer);
    const ms = Math.max(10000, ctx.bot.checkIntervalMinutes * 60 * 1000);
    ctx.bot.nextTickAt = new Date(Date.now() + ms).toISOString();
    ctx.timer = setTimeout(() => this.#run(ctx), ms);
  }

  #run(ctx) {
    this.#schedule(ctx);
    return ctx.bot.tick().catch((err) => this.log.error(`Tick mislukt (${ctx.user.username}):`, err));
  }

  start(user) {
    const ctx = this.ensure(user);
    ctx.bot.onScheduleChange = () => this.#schedule(ctx);
    ctx.bot.runNow = () => this.#run(ctx);
    this.#run(ctx);
    return ctx;
  }

  startAll() {
    const admin = this.users.admin;
    if (admin) this.migrateLegacy(admin.id);
    for (const u of this.users.data.users) if (!u.disabled) this.start(u);
    // Dagoverzicht: elke minuut per gebruiker kijken of het tijd is.
    clearInterval(this.summaryTimer);
    this.summaryTimer = setInterval(() => this.checkSummaries(), 60 * 1000);
  }

  checkSummaries(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const sent = [];
    for (const ctx of this.contexts.values()) {
      const s = ctx.settings;
      if (!s.notify.events.dailySummary || hhmm < s.notify.summaryTime || s.data.summaryLastSent === today) continue;
      s.markSummarySent(today);
      sent.push(ctx.user.id);
      ctx.bot.dailySummary().catch((err) => this.log.error(`Dagoverzicht mislukt (${ctx.user.username}):`, err));
    }
    return sent;
  }

  stop(userId) {
    const ctx = this.contexts.get(userId);
    if (!ctx) return;
    clearTimeout(ctx.timer);
    ctx.stores.paper.save();
    ctx.stores.live.save();
    this.contexts.delete(userId);
    this.#wire();
  }

  // Verwijderen: bot stoppen en de map opzij zetten (niet wissen), zodat er niets
  // onherroepelijk verdwijnt.
  archive(userId) {
    this.stop(userId);
    const dir = this.dirOf(userId);
    if (!fs.existsSync(dir)) return;
    const target = path.join(this.root, 'users', '_verwijderd', `${userId}-${Date.now()}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(dir, target);
  }

  stopAll() {
    clearInterval(this.summaryTimer);
    for (const id of [...this.contexts.keys()]) this.stop(id);
  }

  // Overzicht voor de adminpagina, zonder keys.
  overview() {
    return this.users.list().map((u) => {
      const ctx = this.contexts.get(u.id);
      const b = ctx?.bot;
      const st = b?.store.state;
      return {
        ...u,
        running: Boolean(ctx),
        mode: ctx?.settings.mode ?? null,
        following: Boolean(b?.following),
        openPositions: st ? Object.keys(st.positions).length : 0,
        trades: st?.trades.length ?? 0,
        realizedEur: st ? st.trades.reduce((a, t) => a + t.pnlEur, 0) : 0,
        lastTickAt: b?.lastTickAt ?? null,
        bitvavoKeysSet: ctx ? Boolean(ctx.secrets.get('bitvavoApiKey') && ctx.secrets.get('bitvavoApiSecret')) : false,
      };
    });
  }
}
