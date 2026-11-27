import fs from 'node:fs';
import path from 'node:path';
import { createExchange, createSharedMarket, PaperBroker, LiveBroker, BlockedLiveBroker, SharedMarket, userExchange } from './exchange.js';
import { BybitLiveBroker } from './bybit-broker.js';
import { EUR_RATE, QuoteRate, venueOf, venueLabel, venueAgent, liveAllowedOnVenue } from './venue.js';
import { Store } from './store.js';
import { SecretStore } from './secrets.js';
import { Settings } from './settings.js';
import { Bot } from './bot.js';
import { Notifier } from './notify.js';
import { validateModel, validateAgent } from './mlmodel.js';
import { activeAgent } from './agents.js';
import { evaluate as evaluateLearning, learnAlerts, weeklyDue, weeklyMessage, alertMessage, LEARN_CHECK } from './learncheck.js';

// Beheert één bot per gebruiker.
//
// Elke gebruiker heeft een eigen map data/users/<id>/ met instellingen, paper- en live-state
// en versleutelde keys (met een eigen sleutel, afgeleid van data/master.key). Marktdata
// komt uit één gedeelde cache. De admin is de "leider": gebruikers die volgen aanzetten,
// kopen en verkopen mee met de trades van de admin.

const LEGACY_FILES = ['settings.json', 'state-paper.json', 'state-live.json'];

export class BotManager {
  // shared: gedeelde marktdata van Bitvavo; sharedVenues: die van andere beurzen ({ bybit }), anders bij het
  // eerste gebruik aangemaakt. makePrivateExchange(secrets, venue): eigen verbinding (keys) per beurs.
  constructor({ config, users, log = console, shared = null, sharedVenues = {}, makePrivateExchange = createExchange }) {
    this.config = config;
    this.users = users;
    this.log = log;
    this.shared = shared ?? new SharedMarket();
    this.sharedVenues = { ...sharedVenues, bitvavo: this.shared };
    this.rates = {};
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
      this.ml.feedbackErrorSince = null;
    } catch (err) {
      this.ml.feedbackError = err.message; // volgende keer opnieuw
      this.ml.feedbackErrorSince ??= new Date().toISOString(); // voor "Leert hij echt?": hoe lang al
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
  // Strategieën (met hun eigen model en rol) voor het zelflerend kiezen. Elke 5 minuten; met
  // ETag, dus als er niets veranderd is kost het bijna niets.
  async refreshArms() {
    if (!this.trainerAccess()) return;
    const arms = await this.trainerRequest('/arms.json', { etag: this.ml.armsEtag }).catch(() => null);
    if (arms && !arms.notModified && Array.isArray(arms.data?.arms)) {
      this.ml.arms = arms.data.arms.filter((a) => a?.model && !validateModel(a.model));
      this.ml.armsEtag = arms.etag;
    }
  }

  // De AI-trader van de trainer (elke 5 minuten, met ETag).
  async refreshAgent() {
    if (!this.trainerAccess()) return;
    // De recepten die iemand live heeft gezet (toegestaan of op eigen risico) altijd meevragen, zodat
    // ze niet wegvallen als het plan per marktfase of de top van de leerserver verandert.
    const keep = [...new Set([...this.contexts.values()].flatMap(({ settings }) => {
      const l = settings.agentLive;
      return [...l.approved, ...Object.keys(l.risky ?? {})];
    }))].sort();
    const q = keep.length ? `?keep=${encodeURIComponent(keep.join(','))}` : '';
    if (q !== this.ml.agentKeep) this.ml.agentEtag = null; // andere vraag: niet op de oude ETag vertrouwen
    this.ml.agentKeep = q;
    const r = await this.trainerRequest(`/agent.json${q}`, { etag: this.ml.agentEtag }).catch(() => null);
    if (r && !r.notModified && r.data && !validateAgent(r.data)) {
      // Recepten per marktfase (Strategy Agent): een onbruikbaar recept valt terug op het hoofdrecept.
      for (const [reg, p] of Object.entries(r.data.regimes ?? {})) {
        if (p?.agent && validateAgent(p.agent)) r.data.regimes[reg] = { ...p, key: r.data.recipeKey ?? null, why: 'weinig bewijs', agent: undefined };
      }
      // Extra recepten (om live te zetten): een onbruikbaar recept laten we weg.
      r.data.extras = (r.data.extras ?? []).filter((p) => p?.recipeKey && !validateAgent(p));
      // Een live gezet recept mag nooit uit beeld verdwijnen (dan kun je het ook niet intrekken, en
      // verkoopt de bot zijn posities met het hoofdrecept). Laatst bekende versie onthouden en gebruiken
      // als de leerserver hem even niet meestuurt.
      this.ml.liveParts ??= new Map();
      const present = new Map([r.data, ...Object.values(r.data.regimes ?? {}).map((p) => p?.agent), ...r.data.extras]
        .filter((p) => p?.recipeKey).map((p) => [p.recipeKey, p]));
      for (const k of keep) {
        if (present.has(k)) this.ml.liveParts.set(k, present.get(k));
        else if (this.ml.liveParts.has(k)) r.data.extras.push({ ...this.ml.liveParts.get(k), extra: true, stale: true });
      }
      for (const k of [...this.ml.liveParts.keys()]) if (!keep.includes(k)) this.ml.liveParts.delete(k);
      const before = this.ml.agent;
      this.ml.agent = r.data;
      this.ml.agentEtag = r.etag;
      if (before?.meta?.trainedAt !== r.data.meta?.trainedAt) this.log.info(`AI-trader bijgewerkt: ${r.data.timeframe}, ${r.data.stage}`);
    }
  }

  // Modelversies van de leerserver voor de pagina Learning (één minuut bewaard).
  async learningRegistry() {
    if (!this.trainerAccess()) return { available: false, reason: 'Geen leerserver gekoppeld' };
    if (this.learningCache && Date.now() - this.learningCache.at < 60000) return this.learningCache.data;
    const r = await this.trainerRequest('/registry');
    const data = { available: true, ...r.data };
    this.learningCache = { at: Date.now(), data };
    return data;
  }

  // ---------- "Leert hij echt?" (src/learncheck.js) ----------
  // Gegevens van de leerserver: de telling (/learnstats) en het modelregister (/registry). Vijf minuten
  // bewaard; fouten komen als reden terug (dan wordt een controle ⚠️), nooit als exceptie.
  async #learnTrainerData() {
    if (!this.trainerAccess()) return { configured: false };
    const c = this.learnCheckCache;
    if (c && Date.now() - c.at < LEARN_CHECK.cacheMinutes * 60000) return c.data;
    const [stats, registry] = await Promise.all([
      this.trainerRequest('/learnstats').then((r) => ({ data: r.data })).catch((err) => ({ error: err.message })),
      this.learningRegistry().then((data) => ({ data })).catch((err) => ({ error: err.message })),
    ]);
    const data = { configured: true, stats: stats.data ?? null, statsError: stats.error ?? null, registry: registry.data ?? null, registryError: registry.error ?? null };
    this.learnCheckCache = { at: Date.now(), data };
    return data;
  }

  // Alle zes controles voor één gebruiker: de leerserver is gedeeld, de trades zijn van die gebruiker
  // (paper en live samen). Geen secrets in het antwoord.
  async learnCheck(userId, now = Date.now()) {
    const ctx = this.contexts.get(userId);
    if (!ctx) throw new Error('Geen bot voor deze gebruiker');
    const trainer = await this.#learnTrainerData();
    const stores = Object.entries(ctx.stores ?? {}).filter(([, st]) => st?.state);
    return evaluateLearning({
      now, trainer,
      feedback: { queued: this.feedbackQueue.length, error: this.ml.feedbackError ?? null, errorSince: this.ml.feedbackErrorSince ?? null, sentAt: this.ml.feedbackSentAt ?? null },
      trades: stores.flatMap(([mode, st]) => (st.state.trades ?? []).map((t) => (t.mode ? t : { ...t, mode }))),
      virtualTrades: stores.flatMap(([, st]) => (st.state.explorationTrades ?? []).map((t) => ({ ...t, virtual: true }))),
    });
  }

  // Meldingen (alleen het admin-account: de leerserver is van de admin en alleen die kan er iets aan doen):
  // direct bij een controle die ❌ wordt (één keer per overgang, opnieuw na herstel of na 7 dagen) en een
  // weekoverzicht op maandag vanaf de tijd van het dagoverzicht. Toestand in de instellingen, dus een herstart
  // stuurt niets dubbel. Loopt los van de handel; fouten alleen in het log.
  async checkLearning(now = new Date()) {
    if (this._learnBusy) return null;
    const admin = this.users.admin;
    const ctx = admin && this.contexts.get(admin.id);
    if (!ctx) return null;
    const s = ctx.settings;
    if (!s.notify.events.learning) return null;
    this._learnBusy = true;
    try {
      const result = await this.learnCheck(admin.id, now.getTime());
      const lc = s.learnCheck ?? { alerts: {} };
      const { send, state } = learnAlerts(lc.alerts, result.checks, now.getTime());
      const week = weeklyDue(now, s.notify.summaryTime, lc.weekSent);
      s.setLearnCheck({ alerts: state, ...(week ? { weekSent: week } : {}) });
      for (const c of send) {
        this.log.warn(`Leert hij echt? ${c.title}: ${c.text}`);
        await ctx.notifier?.send('learning', alertMessage(c)).catch(() => {});
      }
      if (week) await ctx.notifier?.send('learning', weeklyMessage(result)).catch(() => {});
      return { result, sent: send.map((c) => c.key), weekly: week };
    } catch (err) {
      this.log.error(`Leercontrole mislukt: ${err.message}`);
      return null;
    } finally {
      this._learnBusy = false;
    }
  }

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
      await this.refreshArms();
      await this.refreshAgent();
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
    fs.writeFileSync(this.#appliedFile(), JSON.stringify({ key: s.key, at: new Date().toISOString(), before }));
    this.ml.appliedStrategy = { key: s.key, at: new Date().toISOString() };
    const hold = s.holdMinutes >= 60 ? `${s.holdMinutes / 60} uur` : `${s.holdMinutes} min`;
    const text = `${s.timeframe}-candles, winstdoel +${s.targetPct}%, stop −${s.stopPct}%, maximaal ${hold}`;
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

  // ---------- Beurzen ----------
  // Eén publieke verbinding per beurs voor alle gebruikers (rate limit per IP, korte cache).
  sharedFor(venue) {
    const v = venueOf(venue);
    this.sharedVenues[v] ??= createSharedMarket(v);
    return this.sharedVenues[v];
  }

  // Omrekenkoers euro per quote-munt, gedeeld door alle gebruikers op die beurs. Bitvavo: altijd 1.
  rateFor(venue) {
    const v = venueOf(venue);
    if (v === 'bitvavo') return EUR_RATE;
    this.rates[v] ??= new QuoteRate(this.sharedFor(v), v);
    return this.rates[v];
  }

  // Alles van één gebruiker op één beurs: verbinding, brokers en eigen state-bestanden. Bitvavo precies zoals
  // altijd (state-paper.json, state-live.json, LiveBroker). Bybit: paper in USDT met omrekenen naar euro,
  // eigen bestanden (state-paper-bybit.json, state-live-bybit.json) en live alleen op eigen risico (fase 2).
  #venueRuntime(ctx, venue) {
    const v = venueOf(venue);
    if (ctx.venues[v]) return ctx.venues[v];
    const { dir, settings, secrets } = ctx;
    const privateEx = this.makePrivateExchange(secrets, v);
    const exchange = userExchange(this.sharedFor(v), privateEx);
    const fx = this.rateFor(v);
    const brokers = {
      paper: new PaperBroker(exchange, () => settings.risk.feePct, () => settings.risk.slippagePct, () => settings.risk.makerFeePct, v === 'bitvavo' ? null : fx),
      // Bybit live: echte orders in USDT, maar alleen als liveAllowedOnVenue het toestaat (eigen-risico-akkoord);
      // de bot schakelt zonder akkoord nooit naar live, en zonder live gebruikt hij deze broker niet.
      live: v === 'bitvavo' ? new LiveBroker(exchange) : v === 'bybit' ? new BybitLiveBroker(exchange, fx, { allowed: () => liveAllowedOnVenue(v, settings) }) : new BlockedLiveBroker(v),
    };
    const stores = {
      paper: new Store(dir, 'paper', this.config.paper.startBalanceEur, v),
      live: new Store(dir, 'live', this.config.paper.startBalanceEur, v),
    };
    ctx.venues[v] = { venue: v, privateEx, exchange, brokers, stores, fx };
    return ctx.venues[v];
  }

  // Keys van een beurs testen door het saldo op te halen (alleen lezen, nooit handelen). Voor Bitvavo op de
  // actieve beurs doet de bot dat zelf (refreshLiveBalance); dit is voor de andere gevallen (o.a. Bybit).
  async testKeys(userId, venue) {
    const ctx = this.contexts.get(userId);
    if (!ctx) throw new Error('Geen bot voor deze gebruiker');
    const v = venueOf(venue);
    const { privateEx } = this.#venueRuntime(ctx, v);
    if (!privateEx?.apiKey || !privateEx?.secret) throw new Error(`${venueLabel(v)}-keys ontbreken, vul ze in bij Instellingen`);
    if (typeof privateEx.fetchBalance !== 'function') throw new Error(`Keys testen bij ${venueLabel(v)} is niet mogelijk`);
    let bal;
    try {
      bal = await privateEx.fetchBalance();
    } catch (err) {
      throw new Error(`${venueLabel(v)}-keys werken niet: ${err.message}`);
    }
    const pick = (c) => ({ free: Number(bal?.[c]?.free) || 0, total: Number(bal?.[c]?.total) || 0 });
    return { venue: v, label: venueLabel(v), balances: { EUR: pick('EUR'), USDT: pick('USDT') }, at: new Date().toISOString() };
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
    // Per beurs eigen verbinding, brokers en state-bestanden (ctx.venues). ctx.exchange/brokers/stores blijven
    // die van Bitvavo (o.a. voor "Leert hij echt?": de leerserver kent alleen Bitvavo-trades); de bot gebruikt
    // die van de gekozen beurs.
    const ctx0 = { dir, settings, secrets, venues: {} };
    const bv = this.#venueRuntime(ctx0, 'bitvavo');
    const { exchange, brokers, stores } = bv;
    const active = this.#venueRuntime(ctx0, settings.exchange);
    const notifier = new Notifier({ secrets, settings });
    const bot = new Bot({ config: this.config, exchange: active.exchange, brokers: active.brokers, stores: active.stores, settings, secrets, notifier });
    bot.fx = active.fx;
    bot.venueRuntime = (v) => this.#venueRuntime(ctx0, v);
    bot.userId = user.id;
    bot.uncleanRestart = this.uncleanRestart ?? null;
    bot.username = user.username;
    // De heartbeat gaat over de server, dus alleen de admin stuurt hem.
    bot.heartbeatEnabled = user.role === 'admin';
    bot.getModel = () => this.ml.model;
    bot.getTeamwork = () => this.ml.teamwork ?? null;
    bot.getArms = () => this.ml.arms ?? [];
    // Orderboek-kenmerken komen van Bitvavo: op een andere beurs niet gebruiken.
    bot.getMicro = (pair) => (bot.venue === 'bitvavo' ? this.ml.micro?.features?.[pair] ?? null : null);
    // Extra recepten van de leerserver gebruikt de bot alleen live, en alleen als je ze zelf live
    // toestond of op eigen risico live zette. Onthouden zolang er niets verandert.
    let memo = null;
    bot.getAgent = () => {
      const raw = this.ml.agent ?? null;
      if (!raw) return null;
      const { approved, risky } = settings.agentLive;
      const sig = `${bot.mode}|${bot.venue}|${approved.join(',')}|${Object.keys(risky ?? {}).join(',')}`;
      if (memo?.raw !== raw || memo.sig !== sig) {
        const active = (k) => bot.mode === 'live' && (approved.includes(k) || Boolean(risky?.[k]));
        // Coins van de leerserver (X/EUR) naar de beurs vertalen (Bybit: X/USDT); Bitvavo ongewijzigd.
        memo = { raw, sig, agent: venueAgent(activeAgent(raw, active), bot.venue) };
      }
      return memo.agent;
    };
    // Feedback naar de leerserver alleen van Bitvavo: de leerserver leert (fase 1) op Bitvavo-data, en trades
    // van een andere beurs (andere kosten, andere koersen) zouden de livecheck en de kostenschatting vervuilen.
    bot.onFeedback = (trade) => {
      if (bot.venue !== 'bitvavo') return;
      this.queueFeedback(trade).catch(() => {});
    };
    const ctx = Object.assign(ctx0, { user, exchange, brokers, stores, notifier, bot, timer: null, watchTimer: null, privateEx: bv.privateEx });
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

  // Bewaking van de bots zelf (elke 30 sec): hangt de handelsronde, lopen de checks nog, worden de
  // open posities nog gecontroleerd, is Bitvavo bereikbaar? Meldt via Discord (zonder spam) en herstelt
  // wat veilig kan: een planner die niet meer loopt opnieuw starten. Een hangende check wordt nooit
  // afgebroken (een lopende order zou dan dubbel kunnen gaan); dan alleen melden.
  async checkHealth() {
    for (const ctx of [...this.contexts.values()]) {
      try {
        if (this.contexts.get(ctx.user.id) !== ctx) continue;
        const r = await ctx.bot.healthCheck({ scheduled: Boolean(ctx.timer) });
        // Intussen gestopt (uitgeschakeld/verwijderd)? Dan niet opnieuw inplannen.
        if (this.contexts.get(ctx.user.id) !== ctx) continue;
        if (r.problems.some((p) => p.key === 'scheduler') && !ctx.bot.running) {
          this.log.warn(`Planner van ${ctx.user.username} liep niet meer; opnieuw gestart`);
          ctx.bot.health.recovered('planner opnieuw gestart (er draaiden geen checks meer)');
          this.#run(ctx);
          this.#watch(ctx);
        }
      } catch (err) {
        this.log.error(`Gezondheidscontrole mislukt (${ctx.user.username}):`, err);
      }
    }
  }

  // Een onverwachte fout in het proces (niet opgevangen promise of exception): bij elke bot vastleggen
  // en melden (hooguit eens per 10 minuten), zodat het niet alleen in de console staat.
  reportProcessError(kind, err) {
    const text = `${kind}: ${err?.message ?? err}`.slice(0, 500);
    this.log.error(`Onverwachte fout (${kind}):`, err);
    const now = Date.now();
    const notify = now - (this.lastProcessAlert ?? 0) > 10 * 60000;
    if (notify) this.lastProcessAlert = now;
    for (const ctx of this.contexts.values()) {
      ctx.bot.health.error('proces', text);
      if (notify) {
        ctx.notifier.send('health', {
          title: '🔴 Kritiek: onverwachte fout in vetobot',
          message: `${text}\n\nDe bot draait nog (of wordt door Docker opnieuw gestart). Open posities: ${Object.keys(ctx.bot.store.state.positions).length}. Kijk op het dashboard of de checks weer lopen.`,
          level: 'error',
        }).catch(() => {});
      }
    }
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
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => { this.checkHealth().catch(() => {}); }, 30 * 1000);
    // "Leert hij echt?": meldingen en het weekoverzicht, elke 5 minuten (los van de handel).
    clearInterval(this.learnTimer);
    this.learnTimer = setInterval(() => { this.checkLearning().catch(() => {}); }, LEARN_CHECK.cacheMinutes * 60 * 1000);
    // Eigen model: bij de start en daarna elk half uur kijken of er een nieuwe is.
    clearInterval(this.modelTimer);
    clearInterval(this.microTimer);
    clearInterval(this.armsTimer);
    this.refreshModel();
    this.modelTimer = setInterval(() => { this.refreshModel(); this.flushFeedback(); }, 30 * 60 * 1000);
    // Orderboek-kenmerken van de trainer, elke minuut, maar alleen als het model ze gebruikt.
    this.microTimer = setInterval(() => this.refreshMicro(), 60 * 1000);
    this.armsTimer = setInterval(() => { this.refreshArms().catch(() => {}); this.refreshAgent().catch(() => {}); }, 5 * 60 * 1000);
    this.refreshAgent().catch(() => {});
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
    for (const rt of Object.values(ctx.venues ?? { bitvavo: { stores: ctx.stores } })) {
      rt.stores.paper.save();
      rt.stores.live.save();
    }
    // Het leerdagboek (SQLite) netjes dicht, zodat de map veilig verplaatst kan worden.
    try { ctx.bot._journal?.close?.(); } catch { /* niets aan te doen */ }
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
    clearInterval(this.healthTimer);
    clearInterval(this.learnTimer);
    clearInterval(this.modelTimer);
    clearInterval(this.microTimer);
    clearInterval(this.armsTimer);
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
        exchange: ctx?.settings.exchange ?? null,
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
