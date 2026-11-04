import { evaluate } from './strategy.js';
import { askVetoChain, testChain, listModels, writeSummaryChain, aiLabel } from './ai.js';
import { TIMEFRAME_MINUTES } from './settings.js';
import { cleanSuggestions, currentValues, applySuggestions } from './suggest.js';
import { fetchClosedCandles, fetchPrice, hasTradingKeys } from './exchange.js';
import { checkEntry } from './risk.js';

// Bedragen en koersen in Nederlandse notatie voor meldingen (€ 81,31 / € 0,3455 / −€ 0,36).
const nl = (n, digits, min = digits) => new Intl.NumberFormat('nl-NL', { minimumFractionDigits: min, maximumFractionDigits: digits }).format(n);
const priceDigits = (n) => (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6);
export const fmtEur = (n) => `${n < 0 ? '−' : ''}€ ${nl(Math.abs(n), 2)}`;
export const fmtSigned = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}€ ${nl(Math.abs(n), 2)}`;
export const fmtPrice = (n) => `€ ${nl(n, priceDigits(n), 2)}`;
export const fmtPct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${nl(Math.abs(n), 2)}%`;
const fmtAmount = (n) => nl(n, Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 8, 0);

// Eén "tick": loopt alle pairs langs, beheert open posities en beoordeelt nieuwe signalen.
//
// Volgorde per pair:
//   1. Open positie? Dan eerst stop-loss / take-profit / verkoopsignaal. Verkopen gaat
//      NOOIT langs de AI, zodat een AI-fout een stop-loss niet kan blokkeren.
//   2. Geen positie en een koopsignaal? Dan eerst de harde risicoregels, daarna de AI-veto.

export class Bot {
  // brokers en stores: { paper, live }. De actieve modus komt uit settings en
  // kan via het dashboard gewisseld worden (zie switchMode).
  constructor({ config, exchange, brokers, stores, settings, secrets, notifier = null, log = console }) {
    this.config = config;
    this.ex = exchange;
    this.brokers = brokers;
    this.stores = stores;
    this.settings = settings;
    this.secrets = secrets;
    this.notifier = notifier;
    this.liveBalance = null;
    this.queue = Promise.resolve();
    this.log = log;
    this.lastSignalCandle = {};
    this.lastTickAt = null;
    this.lastError = null;
    this.running = false;
    // Live status voor het dashboard
    this.currentStep = null;
    this.nextTickAt = null;
    this.pairStatus = {};
    this.activity = [];
  }

  // Logt een gebeurtenis én bewaart hem voor het activiteitenlog in het dashboard.
  #event(level, pair, message) {
    const text = pair ? `[${pair}] ${message}` : message;
    (this.log[level] ?? this.log.info).call(this.log, text);
    this.activity.unshift({ at: new Date().toISOString(), level, pair, message });
    this.activity.length = Math.min(this.activity.length, 100);
  }

  // Meldingen gaan op de achtergrond en mogen een check nooit ophouden of laten mislukken.
  #notify(event, payload) {
    if (!this.notifier) return;
    this.notifier.send(event, payload).catch(() => {});
  }

  #summary(errors) {
    const t = this.tickStats;
    const parts = [`${t.pairs} coin${t.pairs === 1 ? '' : 's'} bekeken`];
    if (!t.buySignals) parts.push('geen koopsignaal, AI niet nodig');
    else {
      parts.push(`${t.buySignals} koopsignaal${t.buySignals === 1 ? '' : 'en'}`);
      if (t.blocked) parts.push(`${t.blocked} geblokkeerd door je limieten`);
      if (t.aiCalls) parts.push(`AI ${t.aiCalls}× gevraagd`);
    }
    if (t.opened) parts.push(`${t.opened} gekocht`);
    if (t.closed) parts.push(`${t.closed} verkocht`);
    if (errors) parts.push(`${errors} fout${errors === 1 ? '' : 'en'}`);
    return parts.join(', ');
  }

  #step(text) {
    this.currentStep = text;
  }

  get mode() {
    return this.settings.mode;
  }

  // Risico-instellingen uit het dashboard, aangevuld met vaste waarden (fee) uit de config.
  get risk() {
    return { ...this.config.risk, ...this.settings.risk };
  }

  get strategy() {
    return { ...this.config.strategy, ...this.settings.strategy };
  }

  get broker() {
    return this.brokers[this.mode];
  }

  get store() {
    return this.stores[this.mode];
  }

  // Zorgt dat een check, een handmatige verkoop en een modus-wissel nooit tegelijk lopen.
  #exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Alle actieve EUR-markten op Bitvavo met 24-uursvolume, gecachet voor 10 minuten.
  async listMarkets() {
    if (this.marketCache && Date.now() - this.marketCache.at < 10 * 60 * 1000) return this.marketCache.list;
    await this.ex.loadMarkets();
    const eur = Object.values(this.ex.markets).filter((m) => m.quote === 'EUR' && m.spot && m.active !== false);
    let tickers = {};
    try {
      tickers = await this.ex.fetchTickers(eur.map((m) => m.symbol));
    } catch {
      // Zonder tickers tonen we de markten nog steeds, alleen zonder volume.
    }
    const list = eur
      .map((m) => ({
        pair: m.symbol,
        base: m.base,
        price: tickers[m.symbol]?.last ?? null,
        volumeEur: tickers[m.symbol]?.quoteVolume ?? null,
        change24h: tickers[m.symbol]?.percentage ?? null,
      }))
      .sort((a, b) => (b.volumeEur ?? 0) - (a.volumeEur ?? 0));
    this.marketCache = { at: Date.now(), list };
    return list;
  }

  // Verzamelt de cijfers van de afgelopen 24 uur, laat de AI er een korte analyse bij
  // schrijven en verstuurt het naar Discord. Een AI-fout houdt het overzicht niet tegen.
  async dailySummary() {
    const since = Date.now() - 24 * 3600 * 1000;
    const s = this.store.state;
    const trades = s.trades.filter((t) => new Date(t.closedAt).getTime() >= since);
    const decisions = s.decisions.filter((d) => new Date(d.at).getTime() >= since);
    const pnl = trades.reduce((a, t) => a + t.pnlEur, 0);
    const wins = trades.filter((t) => t.pnlEur > 0).length;
    const positions = Object.values(s.positions).map((p) => {
      const price = this.pairStatus[p.pair]?.price ?? null;
      return { pair: p.pair, entryPrice: p.entryPrice, price, changePct: price ? ((price - p.entryPrice) / p.entryPrice) * 100 : null };
    });
    const count = (o) => decisions.filter((d) => d.outcome === o).length;
    const data = {
      mode: this.mode,
      periode: 'afgelopen 24 uur',
      saldo: this.mode === 'live' ? this.liveBalance : { paperEur: s.balanceEur, startEur: s.startBalanceEur },
      trades: trades.map((t) => ({ pair: t.pair, pnlEur: +t.pnlEur.toFixed(2), pnlPct: +t.pnlPct.toFixed(2), exit: t.exitReason })),
      resultaatEur: +pnl.toFixed(2),
      openPosities: positions.map((p) => ({ ...p, changePct: p.changePct == null ? null : +p.changePct.toFixed(2) })),
      signalen: { totaal: decisions.length, goedgekeurd: count('approved'), afgewezenDoorAi: count('vetoed'), geblokkeerd: count('blocked') },
      aiRedenenAfwijzing: decisions.filter((d) => d.outcome === 'vetoed').slice(0, 5).map((d) => `${d.pair}: ${d.reason}`),
      markt: this.settings.pairs.map((p) => {
        const ps = this.pairStatus[p] ?? {};
        return { pair: p, price: ps.price ?? null, trend: ps.trend ?? null, rsi: ps.rsi != null ? +ps.rsi.toFixed(1) : null,
          change24Candles: ps.change24 != null ? +ps.change24.toFixed(2) : null };
      }),
      instellingen: { ...this.risk, ...this.strategy, timeframe: this.settings.timeframe, checkIntervalMin: this.settings.checkIntervalMinutes },
    };

    let analysis = null;
    let aiError = null;
    let suggestions = [];
    let rationale = null;
    try {
      const res = await writeSummaryChain(this.aiChain(), data);
      analysis = res?.analysis ?? null;
      suggestions = cleanSuggestions(res?.suggestions, currentValues(this));
      rationale = suggestions.length ? res?.rationale ?? null : null;
    } catch (err) {
      aiError = err.message;
    }

    const eur = fmtSigned;
    const summary = {
      at: new Date().toISOString(),
      mode: this.mode,
      trades: trades.length,
      wins,
      pnlEur: pnl,
      signals: data.signalen,
      openPositions: positions,
      analysis,
      aiError,
      suggestions,
      rationale,
      appliedAt: null,
    };
    s.lastSummary = summary;
    this.store.save();

    const fields = [
      { name: 'Resultaat 24u', value: `${eur(pnl)} uit ${trades.length} trade${trades.length === 1 ? '' : 's'}` },
      { name: 'Winrate', value: trades.length ? `${Math.round((wins / trades.length) * 100)}%` : '–' },
      { name: 'Signalen', value: `${data.signalen.totaal} (✓ ${data.signalen.goedgekeurd} · ✗ ${data.signalen.afgewezenDoorAi} · ⏸ ${data.signalen.geblokkeerd})` },
      {
        name: 'Saldo',
        value: this.mode === 'live'
          ? (this.liveBalance ? `${fmtEur(this.liveBalance.eurFree)} vrij` : 'onbekend')
          : `${fmtEur(s.balanceEur)} (paper)`,
      },
    ];
    if (positions.length) {
      fields.push({
        name: 'Open posities',
        value: positions.map((p) => `${p.pair} ${p.changePct == null ? '' : fmtPct(p.changePct)}`).join('\n'),
        inline: false,
      });
    }
    if (suggestions.length) {
      fields.push({
        name: 'Voorstel van de AI',
        value: suggestions.map((x) => `${x.label}: ${x.from} → **${x.to}**`).join('\n') +
          (rationale ? `\n_${rationale}_` : '') + '\nOvernemen kan op het dashboard.',
        inline: false,
      });
    }
    const message = analysis ?? (aiError ? `Geen AI-analyse: ${aiError}` : 'Geen AI ingesteld, dus alleen de cijfers.');
    this.#event('info', null, `Dagoverzicht gemaakt${analysis ? ' met AI-analyse' : ''}`);
    await this.notifier?.send('dailySummary', { title: `Dagoverzicht · ${eur(pnl)}`, message, level: pnl >= 0 ? 'ok' : 'warn', fields });
    return summary;
  }

  // Neemt (een deel van) het voorstel uit het laatste dagoverzicht over.
  async applySummarySuggestions(keys) {
    const sum = this.store.state.lastSummary;
    if (!sum?.suggestions?.length) throw new Error('Er is geen voorstel om over te nemen');
    // Opnieuw vergelijken met nu: tussendoor kan er al iets zijn aangepast.
    const fresh = cleanSuggestions(Object.fromEntries(sum.suggestions.map((x) => [x.key, x.to])), currentValues(this));
    if (!fresh.length) throw new Error('Deze instellingen staan al zo');
    const applied = await applySuggestions(this, fresh, keys);
    sum.appliedAt = new Date().toISOString();
    sum.appliedKeys = applied.map((x) => x.key);
    this.store.save();
    this.#event('info', null, `AI-voorstel overgenomen: ${applied.map((x) => `${x.label} ${x.from} → ${x.to}`).join(', ')}`);
    return applied;
  }

  // De AI-volgorde: model 1 plus maximaal 4 back-ups, elk met zijn key. Zonder eigen key
  // gebruikt een model de key van een eerder model met dezelfde provider (en base-URL).
  // Staat model 1 op "geen AI", dan is de AI helemaal uit.
  aiChain() {
    const base = { ...this.config.ai, ...this.settings.ai };
    const entries = [{ provider: base.provider, model: base.model, baseUrl: base.baseUrl }, ...(this.settings.ai.fallbacks ?? [])];
    if (entries[0].provider === 'none') return [];
    const keyOf = (i) => this.secrets?.get(i === 0 ? 'aiApiKey' : `aiApiKey${i + 1}`) || '';
    const same = (a, b) => a.provider === b.provider && (a.provider === 'gemini' || a.baseUrl === b.baseUrl);
    return entries.map((e, i) => {
      let apiKey = keyOf(i);
      let keyFrom = apiKey ? i + 1 : null;
      for (let j = 0; !apiKey && j < i; j++) {
        if (same(entries[j], e) && keyOf(j)) {
          apiKey = keyOf(j);
          keyFrom = j + 1;
        }
      }
      return { timeoutMs: base.timeoutMs, failMode: base.failMode, ...e, apiKey, keyFrom, slot: i + 1 };
    });
  }

  // Haalt de modellen op zonder dat je eerst hoeft op te slaan. De key is de nieuw
  // ingevulde key, anders die van het opgeslagen model, anders een key van een model
  // met dezelfde provider.
  async listAiModels({ provider, baseUrl, fromSlot, newKey } = {}) {
    if (!['gemini', 'openai'].includes(provider)) throw new Error('Kies eerst een provider');
    const url = String(baseUrl || 'https://api.groq.com/openai/v1').trim();
    const chain = this.aiChain();
    const same = (c) => c.provider === provider && (provider === 'gemini' || c.baseUrl === url);
    const saved = chain.find((c) => c.slot === Number(fromSlot) && same(c));
    const apiKey = String(newKey ?? '').trim() || saved?.apiKey || chain.find((c) => same(c) && c.apiKey)?.apiKey || '';
    if (!apiKey) throw new Error('Vul eerst een API-key in voor dit model');
    return listModels({ provider, baseUrl: url, apiKey, timeoutMs: this.config.ai.timeoutMs });
  }

  // Test de AI-koppeling met actuele data van de eerste gevolgde coin.
  async testAi() {
    const pair = this.settings.pairs[0];
    const timeframe = this.settings.timeframe;
    let candles = [];
    let indicators = null;
    try {
      candles = await fetchClosedCandles(this.ex, pair, timeframe, Math.max(200, this.strategy.emaSlow * 4));
      indicators = evaluate(candles, this.strategy).indicators;
    } catch {
      // Geen marktdata: test dan met voorbeeldwaarden, het gaat om de verbinding.
    }
    if (!indicators) {
      indicators = { close: 100, emaFast: 101, emaSlow: 100, rsi: 55, change24: 1.5 };
      candles = [];
    }
    const chain = this.aiChain();
    if (!chain.length) throw new Error('Er is geen AI-provider gekozen');
    const results = await testChain(chain, { pair, timeframe, indicators, recentCandles: candles.slice(-24) });
    const ok = results.filter((r) => r.ok).length;
    this.#event(ok ? 'info' : 'warn', null, `AI-test: ${ok} van ${results.length} model(len) werken`);
    return { pair, results };
  }

  setStrategy(values) {
    return this.#exclusive(async () => {
      this.settings.setStrategy(values);
      this.lastSignalCandle = {};
      const s = this.strategy;
      this.#event('info', null, `Strategie: EMA ${s.emaFast}/${s.emaSlow}, RSI ${s.rsiPeriod}, max RSI ${s.rsiMaxEntry}`);
    });
  }

  // Begint het paper-account opnieuw met een nieuw startsaldo.
  resetPaper(startBalanceEur) {
    return this.#exclusive(async () => {
      const n = Number(startBalanceEur);
      if (!Number.isFinite(n) || n < 5 || n > 100000000) throw new Error('Startsaldo moet tussen 5 en 100.000.000 liggen');
      this.stores.paper.reset(Math.round(n * 100) / 100);
      if (this.mode === 'paper') this.lastSignalCandle = {};
      this.#event('warn', null, `Paper-account opnieuw begonnen met ${n.toFixed(2)} EUR`);
    });
  }

  setRisk(values) {
    return this.#exclusive(async () => {
      this.settings.setRisk(values);
      const r = this.risk;
      this.#event('info', null, `Risico: ${fmtEur(r.stakeEur)} per trade, max ${r.maxOpenTrades} open, ` +
        `stop-loss ${r.stopLossPct}%, take-profit ${r.takeProfitPct}%, daglimiet ${fmtEur(r.maxDailyLossEur)}`);
    });
  }

  // Past candle-tijd en check-interval aan. De timer in index.js luistert via onScheduleChange.
  setSchedule(schedule) {
    return this.#exclusive(async () => {
      const oldTf = this.settings.timeframe;
      this.settings.setSchedule(schedule);
      if (this.settings.timeframe !== oldTf) this.lastSignalCandle = {};
      this.#event('info', null, `Planning: elke ${this.settings.checkIntervalMinutes} min checken, ${this.settings.timeframe}-candles`);
      this.onScheduleChange?.();
    });
  }

  async setPairs(pairs) {
    const markets = await this.listMarkets();
    await this.#exclusive(async () => {
      const open = Object.keys(this.store.state.positions).filter((p) => !pairs.includes(p));
      if (open.length) {
        throw new Error(`Je kunt ${open.join(', ')} niet weghalen zolang daar een positie open staat`);
      }
      this.settings.setPairs(pairs, new Set(markets.map((m) => m.pair)));
      for (const p of Object.keys(this.pairStatus)) if (!this.settings.pairs.includes(p)) delete this.pairStatus[p];
      this.#event('info', null, `Coins bijgewerkt: ${this.settings.pairs.join(', ')}`);
    });
  }

  // Live koersen voor het dashboard, los van de check. Gecachet zodat meerdere
  // open tabbladen of snelle verversingen Bitvavo niet overbelasten.
  async refreshPrices(pairs, maxAgeMs = 5000) {
    this.livePrices ??= {};
    const stale = pairs.filter((p) => !this.livePrices[p] || Date.now() - this.livePrices[p].at > maxAgeMs);
    if (!stale.length) return this.livePrices;
    if (this.pricesInFlight) return this.pricesInFlight;
    this.pricesInFlight = (async () => {
      try {
        let tickers = {};
        try {
          tickers = await this.ex.fetchTickers(stale);
        } catch {
          for (const p of stale) {
            try {
              tickers[p] = await this.ex.fetchTicker(p);
            } catch {}
          }
        }
        for (const p of stale) {
          const price = tickers[p]?.last ?? tickers[p]?.close;
          if (price) this.livePrices[p] = { price, at: Date.now() };
        }
      } finally {
        this.pricesInFlight = null;
      }
      return this.livePrices;
    })();
    return this.pricesInFlight;
  }

  // Waarde en open winst/verlies van de posities, inclusief de geschatte verkoopfee.
  openPositionsValue() {
    const fee = (this.risk.feePct ?? 0) / 100;
    const list = Object.values(this.store.state.positions).map((p) => {
      const live = this.livePrices?.[p.pair];
      const price = live?.price ?? this.pairStatus[p.pair]?.price ?? null;
      const valueEur = price != null ? p.amount * price * (1 - fee) : null;
      const pnlEur = valueEur != null ? valueEur - p.costEur : null;
      return {
        ...p,
        currentPrice: price,
        priceAt: live ? new Date(live.at).toISOString() : this.pairStatus[p.pair]?.at ?? null,
        valueEur,
        pnlEur,
        pnlPct: pnlEur != null ? (pnlEur / p.costEur) * 100 : null,
        changePct: price != null ? ((price - p.entryPrice) / p.entryPrice) * 100 : null,
      };
    });
    const known = list.filter((p) => p.valueEur != null);
    return {
      positions: list,
      valueEur: known.reduce((a, p) => a + p.valueEur, 0),
      costEur: list.reduce((a, p) => a + p.costEur, 0),
      pnlEur: known.reduce((a, p) => a + p.pnlEur, 0),
      complete: known.length === list.length,
    };
  }

  // Haalt het echte EUR-saldo op bij Bitvavo. Gooit als de keys niet werken.
  async refreshLiveBalance() {
    if (!hasTradingKeys(this.ex)) {
      this.liveBalance = null;
      throw new Error('Bitvavo-keys ontbreken, vul ze in bij Instellingen');
    }
    const bal = await this.ex.fetchBalance();
    this.liveBalance = { eurFree: bal.EUR?.free ?? 0, eurTotal: bal.EUR?.total ?? 0, at: new Date().toISOString() };
    return this.liveBalance;
  }

  // Wisselt tussen paper en live. Weigert als er in de huidige modus nog posities open
  // staan, zodat een echte positie nooit onbewaakt achterblijft.
  switchMode(mode) {
    return this.#exclusive(async () => {
      if (!['paper', 'live'].includes(mode)) throw new Error(`Ongeldige modus "${mode}"`);
      if (mode === this.mode) return;
      const open = Object.keys(this.store.state.positions);
      if (open.length) {
        throw new Error(`Er staan nog ${open.length} positie(s) open in ${this.mode} (${open.join(', ')}). Sluit die eerst.`);
      }
      if (mode === 'live') {
        this.#step('Bitvavo-keys testen');
        try {
          await this.refreshLiveBalance();
        } catch (err) {
          throw new Error(`Bitvavo-keys werken niet: ${err.message}`);
        } finally {
          this.#step(null);
        }
      }
      this.settings.setMode(mode);
      this.lastSignalCandle = {};
      this.#event('warn', null, mode === 'live'
        ? 'Overgeschakeld naar LIVE trading. Er worden nu echte orders geplaatst.'
        : 'Overgeschakeld naar paper trading.');
      this.#notify('mode', mode === 'live'
        ? { title: 'vetobot staat nu op LIVE', message: 'Er worden echte orders geplaatst op Bitvavo.', level: 'live',
            fields: this.liveBalance ? [{ name: 'Beschikbaar saldo', value: fmtEur(this.liveBalance.eurFree) }] : [] }
        : { title: 'vetobot staat nu op paper', message: 'Er worden geen echte orders meer geplaatst.', level: 'info' });
    });
  }

  // Sluit een positie handmatig vanuit het dashboard.
  closeManual(pair) {
    return this.#exclusive(async () => {
      if (!this.store.state.positions[pair]) throw new Error(`Geen open positie voor ${pair}`);
      try {
        await this.#close(pair, 'Handmatig gesloten');
        if (this.pairStatus[pair]) this.pairStatus[pair].inPosition = false;
        this.store.save();
      } finally {
        this.#step(null);
      }
    });
  }

  tick() {
    if (this.running || this.tickQueued) return this.queue;
    this.tickQueued = true;
    return this.#exclusive(async () => {
      this.tickQueued = false;
      await this.#tick();
    });
  }

  async #tick() {
    this.running = true;
    const started = Date.now();
    let errors = 0;
    // Telt per check wat er gebeurde, voor de samenvatting in het activiteitenlog.
    this.tickStats = { pairs: 0, buySignals: 0, aiCalls: 0, blocked: 0, opened: 0, closed: 0 };
    try {
      this.#resetHaltIfNewDay();
      for (const pair of this.settings.pairs) {
        try {
          await this.#handlePair(pair);
        } catch (err) {
          errors++;
          this.#event('error', pair, err.message);
          this.#notify('errors', { title: `Fout bij ${pair}`, message: err.message, level: 'error' });
          this.lastError = { at: new Date().toISOString(), pair, message: err.message };
          this.pairStatus[pair] = { ...this.pairStatus[pair], at: new Date().toISOString(), error: err.message };
        }
      }
      if (this.mode === 'live') {
        this.#step('Saldo ophalen bij Bitvavo');
        await this.refreshLiveBalance().catch((err) => {
          errors++;
          this.#event('error', null, `Saldo ophalen mislukt: ${err.message}`);
          this.#notify('errors', { title: 'Saldo ophalen bij Bitvavo mislukt', message: err.message, level: 'error' });
        });
      }
      this.lastTickAt = new Date().toISOString();
      if (!errors) this.lastError = null;
      this.store.save();
      this.#event(errors ? 'warn' : 'info', null, `Check klaar in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
        this.#summary(errors));
      this.notifier?.heartbeat(errors === 0).catch(() => {});
    } finally {
      this.running = false;
      this.#step(null);
    }
  }

  #resetHaltIfNewDay() {
    const h = this.store.state.halted;
    if (h && !h.manual && new Date(h.at).toDateString() !== new Date().toDateString()) {
      this.#event('info', null, 'Nieuwe dag, dagelijkse verlieslimiet gereset.');
      this.store.state.halted = null;
    }
  }

  async #handlePair(pair) {
    this.tickStats && this.tickStats.pairs++;
    const strategy = this.strategy;
    const risk = this.risk;
    const timeframe = this.settings.timeframe;
    const position = this.store.state.positions[pair];

    // 1. Open positie beheren
    let positionChangePct = null;
    if (position) {
      this.#step(`${pair}: positie controleren`);
      const price = await fetchPrice(this.ex, pair);
      const changePct = ((price - position.entryPrice) / position.entryPrice) * 100;
      positionChangePct = changePct;
      // 0 = uit
      const exit = risk.stopLossPct > 0 && changePct <= -risk.stopLossPct ? `Stop-loss (${changePct.toFixed(2)}%)`
        : risk.takeProfitPct > 0 && changePct >= risk.takeProfitPct ? `Take-profit (${changePct.toFixed(2)}%)` : null;
      if (exit) {
        await this.#close(pair, exit);
        this.pairStatus[pair] = {
          ...this.pairStatus[pair], at: new Date().toISOString(), price, signal: 'sell',
          reason: exit, inPosition: false, positionChangePct: null, error: null,
        };
        return;
      }
    }

    this.#step(`${pair}: candles ophalen`);
    const candles = await fetchClosedCandles(this.ex, pair, timeframe, Math.max(200, strategy.emaSlow * 4));
    const lastCandleTs = candles.at(-1)?.[0];
    // Kijk terug over alle candles sinds de vorige check, plus één als marge.
    const lookback = Math.min(50, Math.ceil(this.settings.checkIntervalMinutes / (TIMEFRAME_MINUTES[timeframe] ?? 60)) + 1);
    const result = evaluate(candles, strategy, lookback);
    const ind = result.indicators;
    this.pairStatus[pair] = {
      at: new Date().toISOString(),
      price: ind?.close ?? null,
      rsi: ind?.rsi ?? null,
      trend: ind ? (ind.emaFast > ind.emaSlow ? 'up' : 'down') : null,
      change24: ind?.change24 ?? null,
      signal: result.signal,
      reason: result.reason,
      candleAt: lastCandleTs ? new Date(lastCandleTs).toISOString() : null,
      inPosition: Boolean(position),
      positionChangePct,
      error: null,
    };

    if (position) {
      if (result.signal === 'sell') {
        await this.#close(pair, result.reason);
        this.pairStatus[pair].inPosition = false;
      }
      return;
    }

    if (result.signal !== 'buy') return;
    // Zelfde candle niet twee keer beoordelen.
    // Dezelfde kruising niet twee keer beoordelen.
    const signalKey = result.crossAt ?? lastCandleTs;
    if (this.lastSignalCandle[pair] === signalKey) return;
    this.lastSignalCandle[pair] = signalKey;
    if (this.tickStats) this.tickStats.buySignals++;
    this.#event('info', pair, `Koopsignaal: ${result.reason}`);

    const blocked = checkEntry(this.store, { risk: this.risk }, this.broker.mode, this.ex, this.liveBalance);
    if (blocked) {
      if (this.tickStats) this.tickStats.blocked++;
      this.store.addDecision({ pair, signal: 'buy', outcome: 'blocked', reason: blocked, indicators: result.indicators });
      this.#event('warn', pair, `Geblokkeerd door risicoregels: ${blocked}`);
      return;
    }

    this.#step(`${pair}: AI om oordeel vragen`);
    if (this.tickStats && this.settings.ai.provider !== 'none') this.tickStats.aiCalls++;
    const veto = await askVetoChain(this.aiChain(), this.settings.ai.failMode ?? this.config.ai.failMode, {
      pair,
      timeframe,
      indicators: result.indicators,
      recentCandles: candles.slice(-24),
    });

    this.store.addDecision({
      pair,
      signal: 'buy',
      outcome: veto.decision === 'approve' ? 'approved' : 'vetoed',
      reason: veto.reason,
      provider: veto.provider,
      aiError: Boolean(veto.error),
      strategyReason: result.reason,
      indicators: result.indicators,
    });
    this.#event(veto.decision === 'approve' ? 'info' : 'warn', pair,
      `AI (${veto.provider}) ${veto.decision === 'approve' ? 'keurt goed' : 'wijst af'}: ${veto.reason}`);
    const errList = (list) => list.map((x) => `**${x.slot}. ${x.label}**: ${x.error}`).join('\n');
    if (veto.error && veto.chainErrors) {
      this.#notify('aiFailed', {
        title: 'Alle AI-modellen faalden',
        message: `${errList(veto.chainErrors)}\n\nHet koopsignaal voor ${pair} is ${veto.decision === 'approve' ? 'doorgelaten' : 'afgewezen'} volgens je fail-mode.`,
        level: 'error',
      });
    } else if (veto.fallbackErrors?.length) {
      this.#notify('aiFallback', {
        title: `Back-up nam het over: ${veto.provider}`,
        message: errList(veto.fallbackErrors),
        level: 'warn',
      });
    }
    if (veto.decision !== 'approve' && !veto.error) {
      this.#notify('aiVeto', { title: `${pair}: koopsignaal afgewezen`, message: veto.reason, level: 'warn' });
    }

    if (veto.decision === 'approve') await this.#open(pair, result.reason);
  }

  async #open(pair, reason) {
    this.#step(`${pair}: kopen`);
    if (this.tickStats) this.tickStats.opened++;
    const stake = this.risk.stakeEur;
    const fill = await this.broker.buy(pair, stake);
    if (this.broker.mode === 'paper') this.store.state.balanceEur -= fill.costEur;
    this.store.state.positions[pair] = {
      pair,
      openedAt: new Date().toISOString(),
      entryPrice: fill.price,
      amount: fill.amount,
      costEur: fill.costEur,
      entryFeeEur: fill.feeEur,
      reason,
    };
    this.#event('info', pair, `Gekocht: ${fmtAmount(fill.amount)} @ ${fmtPrice(fill.price)} (${this.broker.mode})`);
    this.#notify('trades', {
      title: `Gekocht: ${pair}`,
      message: reason,
      level: this.broker.mode === 'live' ? 'live' : 'info',
      fields: [
        { name: 'Koers', value: fmtPrice(fill.price) },
        { name: 'Inzet', value: fmtEur(fill.costEur) },
        { name: 'Hoeveelheid', value: `${fmtAmount(fill.amount)} ${pair.split('/')[0]}` },
      ],
    });
  }

  async #close(pair, reason) {
    this.#step(`${pair}: verkopen`);
    if (this.tickStats) this.tickStats.closed++;
    const pos = this.store.state.positions[pair];
    const fill = await this.broker.sell(pair, pos.amount);
    const pnlEur = fill.costEur - pos.costEur;
    if (this.broker.mode === 'paper') this.store.state.balanceEur += fill.costEur;
    delete this.store.state.positions[pair];
    this.store.addTrade({
      pair,
      mode: this.broker.mode,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice: fill.price,
      amount: pos.amount,
      pnlEur,
      pnlPct: (pnlEur / pos.costEur) * 100,
      entryReason: pos.reason,
      exitReason: reason,
    });
    this.#event(pnlEur >= 0 ? 'info' : 'warn', pair, `Verkocht @ ${fmtPrice(fill.price)}, resultaat ${fmtSigned(pnlEur)} (${reason})`);
    const isStop = reason.startsWith('Stop-loss');
    this.#notify(isStop ? 'stoploss' : 'trades', {
      title: `${isStop ? 'Stop-loss' : 'Verkocht'}: ${pair}`,
      message: reason,
      level: pnlEur >= 0 ? 'ok' : 'warn',
      fields: [
        { name: 'Resultaat', value: `${fmtSigned(pnlEur)} (${fmtPct((pnlEur / pos.costEur) * 100)})` },
        { name: 'In → uit', value: `${fmtPrice(pos.entryPrice)} → ${fmtPrice(fill.price)}` },
      ],
    });

    const today = this.store.realizedTodayEur();
    if (this.risk.maxDailyLossEur > 0 && today <= -this.risk.maxDailyLossEur && !this.store.state.halted) {
      this.store.state.halted = { at: new Date().toISOString(), reason: `Dagverlies ${today.toFixed(2)} EUR` };
      this.#event('warn', null, 'Dagelijkse verlieslimiet bereikt. Geen nieuwe trades tot morgen.');
      this.#notify('dailyLimit', {
        title: 'Dagelijkse verlieslimiet bereikt',
        message: `Verlies vandaag: ${fmtEur(today)}. Geen nieuwe trades tot morgen; open posities worden nog bewaakt.`,
        level: 'error',
      });
    }
  }
}
