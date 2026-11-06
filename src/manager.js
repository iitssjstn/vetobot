import fs from 'node:fs';
import path from 'node:path';
import { createExchange, PaperBroker, LiveBroker, SharedMarket, userExchange } from './exchange.js';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { Settings } from './settings.js';
import { Bot } from './bot.js';
import { Notifier } from './notify.js';
import { validateModel } from './mlmodel.js';

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
    // Eigen voorspelmodel van de trainer (gedeeld door alle bots, ingesteld door de admin).
    this.ml = { model: null, etag: null, fetchedAt: null, error: null };
    this.#loadCachedModel();
  }

  // ---------- Eigen model (trainer op de VPS) ----------
  #modelFile() {
    return path.join(this.root, 'ml-model.json');
  }

  // ---------- Feedback: echte trades naar de trainer ----------
  // Trades wachten in een wachtrij (op schijf), zodat er niets verloren gaat als de trainer
  // even onbereikbaar is. Maximaal 2000; daarboven vallen de oudste af.
  #feedbackFile() {
    return path.join(this.root, 'ml-feedback-queue.json');
  }

  get feedbackQueue() {
    if (!this._fbQueue) {
      try {
        this._fbQueue = JSON.parse(fs.readFileSync(this.#feedbackFile(), 'utf8'));
        if (!Array.isArray(this._fbQueue)) this._fbQueue = [];
      } catch {
        this._fbQueue = [];
      }
    }
    return this._fbQueue;
  }

  #saveFeedbackQueue() {
    try {
      fs.writeFileSync(this.#feedbackFile(), JSON.stringify(this._fbQueue));
    } catch {
      // Niet erg; dan staan ze alleen in het geheugen.
    }
  }

  queueFeedback(trade) {
    const q = this.feedbackQueue;
    q.push(trade);
    if (q.length > 2000) q.splice(0, q.length - 2000);
    this.#saveFeedbackQueue();
    return this.flushFeedback();
  }

  async flushFeedback() {
    if (this._flushing || !this.feedbackQueue.length || !this.trainerAccess()) return;
    this._flushing = true;
    try {
      while (this.feedbackQueue.length) {
        const batch = this.feedbackQueue.slice(0, 200);
        await this.trainerRequest('/feedback', { method: 'POST', body: { trades: batch } });
        this.feedbackQueue.splice(0, batch.length);
        this.#saveFeedbackQueue();
        this.ml.feedbackSentAt = new Date().toISOString();
      }
      this.ml.feedbackError = null;
    } catch (err) {
      this.ml.feedbackError = err.message; // volgende keer opnieuw
    } finally {
      this._flushing = false;
    }
  }

  #loadCachedModel() {
    try {
      const m = JSON.parse(fs.readFileSync(this.#modelFile(), 'utf8'));
      if (!validateModel(m)) this.ml.model = m;
    } catch {
      // Nog geen model; geen probleem.
    }
  }

  // Adres en code van de trainer, uit de versleutelde keys van de admin.
  trainerAccess() {
    const admin = this.users.admin;
    const ctx = admin && this.contexts.get(admin.id);
    const url = ctx?.secrets.get('trainerUrl')?.replace(/\/+$/, '');
    const token = ctx?.secrets.get('trainerToken');
    return url && token ? { url, token } : null;
  }

  // Praat met de trainer. Gooit bij fouten een leesbare melding.
  async trainerRequest(pathname, { method = 'GET', body, etag } = {}) {
    const access = this.trainerAccess();
    if (!access) throw new Error('Vul eerst het adres en de code van de trainer in');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await (this.fetchImpl ?? fetch)(access.url + pathname, {
        method,
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 304) return { notModified: true };
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('De trainer weigert de code; controleer hem (staat in de logs van de trainer)');
      if (!res.ok) throw new Error(data.error || `Trainer antwoordt met HTTP ${res.status}`);
      return { data, etag: res.headers.get('etag') };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('De trainer reageert niet (time-out)');
      if (/fetch failed|ECONNREFUSED|ENOTFOUND/.test(err.message)) throw new Error('Kan de trainer niet bereiken; klopt het adres en draait hij?');
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  // Haalt het nieuwste model op (alleen als het veranderd is). Fouten zijn niet erg: het vorige
  // model blijft gewoon in gebruik.
  async refreshMicro() {
    if (!this.ml.model?.meta?.micro || !this.trainerAccess()) return;
    const r = await this.trainerRequest('/micro/latest').catch(() => null);
    if (r?.data?.features) this.ml.micro = { features: r.data.features, at: Date.now() };
  }

  async refreshModel() {
    if (!this.trainerAccess()) return this.ml;
    try {
      const r = await this.trainerRequest('/model.json', { etag: this.ml.etag });
      if (!r.notModified) {
        const problem = validateModel(r.data);
        if (problem) throw new Error(problem);
        this.ml.model = r.data;
        this.ml.etag = r.etag;
        fs.writeFileSync(this.#modelFile(), JSON.stringify(r.data));
        this.log.info(`Eigen model bijgewerkt (getraind ${r.data.meta?.trainedAt ?? 'onbekend'})`);
        await this.#autoApplyStrategy(r.data).catch((err) => this.log.error(`Strategie overnemen mislukt: ${err.message}`));
      }
      // Bevestigde strategieën met hun eigen model, voor het zelflerend kiezen.
      const arms = await this.trainerRequest('/arms.json', { etag: this.ml.armsEtag }).catch(() => null);
      if (arms && !arms.notModified && Array.isArray(arms.data?.arms)) {
        this.ml.arms = arms.data.arms.filter((a) => a?.model && !validateModel(a.model));
        this.ml.armsEtag = arms.etag;
      }
      // Scorebord van AI + model (wie had gelijk bij de laatste signalen).
      this.ml.teamwork = (await this.trainerRequest('/teamwork').catch(() => null))?.data ?? this.ml.teamwork ?? null;
      this.ml.error = null;
    } catch (err) {
      this.ml.error = err.message;
    }
    this.ml.fetchedAt = new Date().toISOString();
    return this.ml;
  }

  // De trainer vond een nieuwe beste strategie en trainde er een model op ("automatisch
  // overstappen" aan). Zet de admin-bot op die strategie: candle-tijd, stop, winstdoel, maximale
  // duur en minimale modelkans. Volgers volgen de admin vanzelf. Elke strategie maar één keer,
  // zodat je hem daarna zelf nog kunt aanpassen.
  #appliedFile() {
    return path.join(this.root, 'ml-applied.json');
  }

  async #autoApplyStrategy(model) {
    const s = model?.meta?.strategy;
    if (!s?.autoApply || !s.key) return false;
    let applied = {};
    try { applied = JSON.parse(fs.readFileSync(this.#appliedFile(), 'utf8')); } catch { applied = {}; }
    if (applied.key === s.key) return false;
    const admin = this.users.admin;
    const ctx = admin && this.contexts.get(admin.id);
    if (!ctx) return false;
    const { bot } = ctx;
    const before = { timeframe: bot.timeframe, stopLossPct: bot.risk.stopLossPct, takeProfitPct: bot.risk.takeProfitPct, maxHoldMinutes: bot.risk.maxHoldMinutes };
    if (s.timeframe !== bot.timeframe) await bot.setSchedule({ timeframe: s.timeframe, checkIntervalMinutes: bot.checkIntervalMinutes });
    await bot.setRisk({ stopLossPct: s.stopPct, takeProfitPct: s.targetPct, maxHoldMinutes: s.holdMinutes });
    const best = model.meta?.metrics?.best?.minProb ?? s.minProb;
    const minProb = best ? Math.round(best * 100) : null;
    if (minProb) await bot.setStrategy({ mlMinProb: minProb });
    fs.writeFileSync(this.#appliedFile(), JSON.stringify({ key: s.key, at: new Date().toISOString(), before }));
    this.ml.appliedStrategy = { key: s.key, at: new Date().toISOString() };
    const hold = s.holdMinutes >= 60 ? `${s.holdMinutes / 60} uur` : `${s.holdMinutes} min`;
    const text = `${s.timeframe}-candles, winstdoel +${s.targetPct}%, stop −${s.stopPct}%, maximaal ${hold}${minProb ? `, minimale modelkans ${minProb}%` : ''}`;
    this.log.warn(`Automatisch overgestapt op de beste strategie van de trainer: ${text}`);
    ctx.notifier?.send('strategy', {
      title: 'Nieuwe strategie van de trainer',
      message: `De trainer vond een betere strategie en de bot is overgestapt: ${text}. Dit is getest op het verleden; geen garantie voor de toekomst.`,
      level: 'info',
    }).catch(() => {});
    return true;
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
      paper: new PaperBroker(exchange, () => settings.risk.feePct, () => settings.risk.slippagePct, () => settings.risk.makerFeePct),
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
    bot.getModel = () => this.ml.model;
    bot.getTeamwork = () => this.ml.teamwork ?? null;
    bot.getArms = () => this.ml.arms ?? [];
    bot.getMicro = (pair) => this.ml.micro?.features?.[pair] ?? null;
    bot.onFeedback = (trade) => { this.queueFeedback(trade).catch(() => {}); };
    const ctx = { user, dir, settings, secrets, exchange, brokers, stores, notifier, bot, timer: null, watchTimer: null };
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

  // Snelle bewaking van open posities tussen de checks door (stops, take-profit, AI-winstcheck).
  // Het interval wordt elke keer opnieuw gelezen, zodat een wijziging in het dashboard direct geldt.
  #watch(ctx) {
    clearTimeout(ctx.watchTimer);
    const sec = Number(ctx.bot.risk.watchSeconds) || 0;
    // 0 = uit: dan alleen bij de gewone check. Toch elke 30 sec kijken of het weer aan staat.
    const wait = sec > 0 ? Math.max(5, sec) * 1000 : 30000;
    ctx.watchTimer = setTimeout(async () => {
      if (sec > 0) await ctx.bot.watchPositions().catch((err) => this.log.error(`Bewaken mislukt (${ctx.user.username}):`, err));
      if (this.contexts.get(ctx.user.id) === ctx) this.#watch(ctx);
    }, wait);
  }

  start(user) {
    const ctx = this.ensure(user);
    ctx.bot.onScheduleChange = () => this.#schedule(ctx);
    ctx.bot.runNow = () => this.#run(ctx);
    this.#run(ctx);
    this.#watch(ctx);
    return ctx;
  }

  startAll() {
    const admin = this.users.admin;
    if (admin) this.migrateLegacy(admin.id);
    for (const u of this.users.data.users) if (!u.disabled) this.start(u);
    // Dagoverzicht: elke minuut per gebruiker kijken of het tijd is.
    clearInterval(this.summaryTimer);
    this.summaryTimer = setInterval(() => this.checkSummaries(), 60 * 1000);
    // Eigen model: bij de start en daarna elk half uur kijken of er een nieuwe is.
    clearInterval(this.modelTimer);
    clearInterval(this.microTimer);
    this.refreshModel();
    this.modelTimer = setInterval(() => { this.refreshModel(); this.flushFeedback(); }, 30 * 60 * 1000);
    // Orderboek-kenmerken van de trainer, elke minuut, maar alleen als het model ze gebruikt.
    this.microTimer = setInterval(() => this.refreshMicro(), 60 * 1000);
    this.flushFeedback();
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
    clearTimeout(ctx.watchTimer);
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
    clearInterval(this.modelTimer);
    clearInterval(this.microTimer);
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
