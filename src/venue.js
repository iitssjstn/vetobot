// Beurzen (venues) waarop de bot kan handelen, en alles wat per beurs verschilt.
//
// - Bitvavo: paren in euro (BTC/EUR). Paper en live. Dit is het standaardgedrag en blijft precies gelijk.
// - Bybit: paren in USDT (BTC/USDT). Fase 1: alleen paper. Inzet, winst, limieten en het dashboard blijven
//   in euro; de bot rekent om met de actuele USDT/EUR-koers van Bybit (QuoteRate hieronder).
//
// De leerserver levert coins als X/EUR (Bitvavo-namen). toVenuePair/toBasePair vertalen tussen de
// naam van de leerserver en de naam op de beurs; posities en trades van Bitvavo veranderen niet.

export const VENUES = {
  bitvavo: { id: 'bitvavo', label: 'Bitvavo', quote: 'EUR', ccxt: 'bitvavo', fees: { feePct: 0.25, makerFeePct: 0.15 } },
  // Bybit spot: 0,1% taker en 0,1% maker (standaardtarief, zonder VIP-korting).
  bybit: { id: 'bybit', label: 'Bybit', quote: 'USDT', ccxt: 'bybit', fees: { feePct: 0.1, makerFeePct: 0.1 } },
};
export const DEFAULT_VENUE = 'bitvavo';
export const VENUE_IDS = Object.keys(VENUES);

// Onbekend of leeg (oude settings.json): Bitvavo.
export const venueOf = (v) => (Object.hasOwn(VENUES, v) ? v : DEFAULT_VENUE);
export const venueLabel = (v) => VENUES[venueOf(v)].label;
export const quoteOf = (v) => VENUES[venueOf(v)].quote;

// Quotes die we tussen de beurzen vertalen. Een paar met een andere quote (bijv. BTC/USDC) blijft zoals het is.
const TRANSLATED = new Set(VENUE_IDS.map((v) => VENUES[v].quote));

// "SOL/EUR" → "SOL/USDT" op Bybit, "SOL/USDT" → "SOL/EUR" op Bitvavo.
export function toVenuePair(pair, venue) {
  const s = String(pair ?? '');
  const i = s.indexOf('/');
  if (i < 0) return s;
  const quote = s.slice(i + 1);
  if (!TRANSLATED.has(quote)) return s;
  return `${s.slice(0, i)}/${quoteOf(venue)}`;
}

// Naam zoals de leerserver hem kent (X/EUR).
export const toBasePair = (pair) => toVenuePair(pair, DEFAULT_VENUE);

// ---------- Live per beurs ----------
// Eén centrale plek die bepaalt of live op een beurs mag. Fase 1: alleen Bitvavo. Fase 2 vervangt de
// Bybit-tak door een eigen-risico-akkoord (zoals bij de AI-trader: EIGEN RISICO + verliesgrens + wachtwoord),
// bijv. door hier settings.venueLive?.bybit te controleren. Bot, server en dashboard gebruiken allemaal deze check.
export const LIVE_BLOCKED_TEXT = {
  bybit: 'Live op Bybit (op eigen risico) komt in de volgende stap; Bybit werkt nu alleen in paper.',
};

export function liveAllowedOnVenue(venue /* , settings */) {
  const v = venueOf(venue);
  if (v === 'bitvavo') return { ok: true, reason: null };
  return { ok: false, reason: LIVE_BLOCKED_TEXT[v] ?? `Live op ${venueLabel(v)} is nog niet mogelijk` };
}

// ---------- AI-trader: coins van de leerserver naar de beurs ----------
// De leerserver stuurt coins als X/EUR. Op Bybit worden dat X/USDT. Zelfde object → zelfde kopie, zodat
// vergelijkingen op identiteit (hoofdrecept = recept van een marktfase) blijven werken.
export function venueAgent(agent, venue) {
  if (!agent || venueOf(venue) === DEFAULT_VENUE) return agent;
  const seen = new Map();
  const part = (p) => {
    if (!p || typeof p !== 'object') return p;
    if (seen.has(p)) return seen.get(p);
    const copy = { ...p };
    seen.set(p, copy);
    if (Array.isArray(p.coins)) copy.coins = p.coins.map((c) => toVenuePair(c, venue));
    return copy;
  };
  const main = part(agent);
  if (agent.regimes && typeof agent.regimes === 'object') {
    main.regimes = Object.fromEntries(Object.entries(agent.regimes).map(([k, r]) => {
      if (!r || typeof r !== 'object') return [k, r];
      const copy = { ...r };
      if (r.agent) copy.agent = part(r.agent);
      if (Array.isArray(r.coins)) copy.coins = r.coins.map((c) => toVenuePair(c, venue));
      return [k, copy];
    }));
  }
  if (Array.isArray(agent.extras)) main.extras = agent.extras.map(part);
  if (Array.isArray(agent.extrasAll)) main.extrasAll = agent.extrasAll.map(part);
  return main;
}

// ---------- Omrekenkoers: euro per quote-munt ----------
// Bitvavo handelt al in euro: altijd 1.
export const EUR_RATE = Object.freeze({ quote: 'EUR', async eurPerQuote() { return 1; }, last() { return 1; }, info() { return { quote: 'EUR', rate: 1 }; } });

// Bybit: hoeveel euro is 1 USDT? Uit de ticker USDT/EUR (of omgekeerd EUR/USDT), via de gedeelde marktdata
// (één verzoek voor alle gebruikers), één minuut bewaard. Kopen vraagt een verse koers (hooguit ttl oud;
// lukt ophalen niet, dan nog maxStaleMs de laatste bekende); verkopen mag altijd met de laatst bekende koers,
// zodat een positie nooit vastzit op een ontbrekende koers. Geen koers bekend: een duidelijke fout.
export class QuoteRate {
  constructor(market, venue, { ttlMs = 60000, maxStaleMs = 10 * 60000, now = () => Date.now() } = {}) {
    this.market = market;
    this.venue = venueOf(venue);
    this.quote = quoteOf(venue);
    this.ttlMs = ttlMs;
    this.maxStaleMs = maxStaleMs;
    this.now = now;
    this.value = null;
    this.at = 0;
    this.source = null;
    this.error = null;
    this.inflight = null;
  }

  async #fetch() {
    const ok = (v) => Number.isFinite(v) && v > 0;
    const px = (t) => (ok(t?.last) ? t.last : ok(t?.close) ? t.close : ok(t?.bid) && ok(t?.ask) ? (t.bid + t.ask) / 2 : null);
    const errors = [];
    for (const [symbol, invert] of [[`${this.quote}/EUR`, false], [`EUR/${this.quote}`, true]]) {
      try {
        const p = px(await this.market.fetchTicker(symbol));
        if (p) return { rate: invert ? 1 / p : p, source: symbol };
        errors.push(`${symbol}: geen koers`);
      } catch (err) {
        errors.push(`${symbol}: ${err.message}`);
      }
    }
    throw new Error(errors.join('; '));
  }

  async eurPerQuote({ allowStale = false } = {}) {
    const age = this.now() - this.at;
    if (this.value && age < this.ttlMs) return this.value;
    try {
      this.inflight ??= this.#fetch().finally(() => { this.inflight = null; });
      const r = await this.inflight;
      this.value = r.rate;
      this.source = r.source;
      this.at = this.now();
      this.error = null;
      return this.value;
    } catch (err) {
      this.error = err.message;
      if (this.value && (allowStale || this.now() - this.at < this.maxStaleMs)) return this.value;
      throw new Error(`Geen ${this.quote}/EUR-koers van ${venueLabel(this.venue)}, dus niet in euro om te rekenen (${err.message})`);
    }
  }

  // Laatst bekende koers (synchroon, voor het dashboard), of null.
  last() {
    return this.value;
  }

  info() {
    return { quote: this.quote, rate: this.value, at: this.at ? new Date(this.at).toISOString() : null, source: this.source, error: this.error };
  }
}
