import { fillBuy, fillSell } from './orderbook.js';
import ccxt from 'ccxt';

// Wrapper rond ccxt voor Bitvavo. Marktdata is publiek en werkt zonder keys.
// De keys komen uit de versleutelde SecretStore en worden bijgewerkt zodra je ze
// in het dashboard wijzigt.

export function createExchange(secrets) {
  const ex = new ccxt.bitvavo({ enableRateLimit: true });
  const apply = () => {
    ex.apiKey = secrets.get('bitvavoApiKey') || undefined;
    ex.secret = secrets.get('bitvavoApiSecret') || undefined;
  };
  apply();
  secrets.onChange(apply);
  return ex;
}

export const hasTradingKeys = (ex) => Boolean(ex.apiKey && ex.secret);

// ---------- Gedeelde marktdata voor meerdere gebruikers ----------
// Bitvavo telt de rate limit per IP-adres, en alle gebruikers draaien op dezelfde server.
// Daarom halen alle bots koersen en candles via één publieke verbinding met een korte cache.
// Orders en saldo gaan via de eigen verbinding van elke gebruiker, met zijn eigen keys.
export class SharedMarket {
  constructor(ex = new ccxt.bitvavo({ enableRateLimit: true })) {
    this.ex = ex;
    this.cache = new Map();
    this.inflight = new Map();
  }

  // Ruimt af en toe items op die al lang niet meer gebruikt zijn (bijv. coins die uit de lijst
  // zijn gehaald), zodat het geheugen niet blijft groeien. Candles kunnen groot zijn.
  #sweep() {
    const now = Date.now();
    if (now - (this.lastSweep ?? 0) < 60000) return;
    this.lastSweep = now;
    for (const [k, v] of this.cache) if (k !== 'markets' && now - v.at > 10 * 60000) this.cache.delete(k);
  }

  async #cached(key, ttlMs, fn) {
    this.#sweep();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  parseTimeframe(tf) {
    return this.ex.parseTimeframe(tf);
  }

  get markets() {
    return this.ex.markets;
  }

  loadMarkets() {
    return this.#cached('markets', 3600000, () => this.ex.loadMarkets());
  }

  fetchOHLCV(pair, tf, since, limit) {
    return this.#cached(`ohlcv:${pair}:${tf}:${limit}`, 5000, () => this.ex.fetchOHLCV(pair, tf, since, limit));
  }

  fetchTicker(pair) {
    return this.#cached(`ticker:${pair}`, 3000, () => this.ex.fetchTicker(pair));
  }

  fetchOrderBook(pair, limit = 50) {
    return this.#cached(`book:${pair}:${limit}`, 3000, () => this.ex.fetchOrderBook(pair, limit));
  }

  async fetchTickers(pairs) {
    const out = {};
    const missing = [];
    for (const p of pairs) {
      const hit = this.cache.get(`ticker:${p}`);
      if (hit && Date.now() - hit.at < 3000) out[p] = hit.value;
      else missing.push(p);
    }
    if (missing.length) {
      const fresh = await this.ex.fetchTickers(missing);
      for (const [p, t] of Object.entries(fresh)) {
        this.cache.set(`ticker:${p}`, { at: Date.now(), value: t });
        out[p] = t;
      }
    }
    return out;
  }
}

// Verbinding voor één gebruiker: marktdata uit de gedeelde cache, al het andere (orders,
// saldo, keys) via de eigen ccxt-instantie van de gebruiker.
export function userExchange(shared, privateEx) {
  const viaShared = new Set(['fetchOHLCV', 'fetchTicker', 'fetchTickers', 'fetchOrderBook', 'parseTimeframe']);
  return new Proxy(privateEx, {
    get(target, prop) {
      if (viaShared.has(prop)) return shared[prop].bind(shared);
      if (prop === 'markets') return shared.markets ?? target.markets;
      // Beide laden: de gedeelde voor marktlijsten, de eigen voor orders (afronding per markt).
      if (prop === 'loadMarkets') return async () => {
        await shared.loadMarkets();
        if (target.apiKey) await target.loadMarkets();
        return shared.markets;
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

// Haalt candles op en laat de laatste (nog niet gesloten) candle weg.
// includeOpen: de lopende candle juist wel meenemen (de close is dan de actuele koers).
export async function fetchClosedCandles(ex, pair, timeframe, limit = 200, { includeOpen = false } = {}) {
  const candles = await ex.fetchOHLCV(pair, timeframe, undefined, limit + 1);
  if (includeOpen) return candles.slice(-limit);
  const tfMs = ex.parseTimeframe(timeframe) * 1000;
  const now = Date.now();
  return candles.filter((c) => c[0] + tfMs <= now);
}

export async function fetchPrice(ex, pair) {
  const t = await ex.fetchTicker(pair);
  return t.last ?? t.close;
}

// --- Brokers -----------------------------------------------------------------
// Beide brokers geven { amount, price, costEur, feeEur } terug.
//
// Limietorders (opts.limit): goedkoper, want Bitvavo rekent dan de maker-fee (0,15%) in plaats
// van de taker-fee (0,25%). Een limietorder wordt alleen gevuld als de koers naar je toe komt:
// - kopen: tegen de biedprijs; niet (volledig) gevuld binnen de wachttijd → rest annuleren.
//   Niets gevuld → null (de aankoop gaat niet door).
// - verkopen: tegen de laatprijs; niet gevuld → de rest alsnog met een market order, want
//   een positie moet altijd dicht kunnen.
// Stop-losses gebruiken nooit een limietorder; dat bepaalt de bot.

// Wachten en pollen, instelbaar voor tests.
export const orderTiming = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pollMs: 2000 };

// Echte vulprijs uit het orderboek (paper), of null als dat niet lukt.
async function bookPrice(ex, pair, side, size) {
  try {
    const book = await ex.fetchOrderBook?.(pair, 50);
    return side === 'buy' ? fillBuy(book, size) : fillSell(book, size);
  } catch {
    return null;
  }
}

export class PaperBroker {
  // feePct mag een getal of een functie zijn, zodat de fee uit het dashboard direct geldt.
  // slippagePct (getal of functie): koop zoveel procent duurder en verkoop zoveel goedkoper
  // dan de laatste koers, zodat paper niet rooskleuriger is dan live.
  constructor(ex, feePct, slippagePct = 0, makerFeePct = null) {
    this.ex = ex;
    this.fee = typeof feePct === 'function' ? feePct : () => feePct;
    this.slip = typeof slippagePct === 'function' ? slippagePct : () => slippagePct;
    const maker = makerFeePct ?? feePct;
    this.maker = typeof maker === 'function' ? maker : () => maker;
    this.mode = 'paper';
  }

  get makerFeePct() {
    return this.maker() ?? this.feePct;
  }

  get feePct() {
    return this.fee();
  }

  get slippagePct() {
    return this.slip() ?? 0;
  }

  async buy(pair, stakeEur, opts = {}) {
    if (opts.limit) {
      // Nagebootst: limiet op de huidige koers. Na de wachttijd gevuld als de koers er niet
      // boven is weggelopen (binnen een halve spread); anders gaat de aankoop niet door.
      const limit = await fetchPrice(this.ex, pair);
      await orderTiming.sleep((opts.waitSec ?? 20) * 1000);
      const now = await fetchPrice(this.ex, pair);
      if (now > limit * (1 + this.slippagePct / 200)) return null;
      const feeEur = (stakeEur * this.makerFeePct) / 100;
      return { amount: (stakeEur - feeEur) / limit, price: limit, costEur: stakeEur, feeEur, limit: true };
    }
    const feeEur = (stakeEur * this.feePct) / 100;
    // Vullen tegen de echte prijzen in het orderboek (zoals live); lukt dat niet, dan de
    // laatste koers plus de ingestelde slippage.
    const fromBook = await bookPrice(this.ex, pair, 'buy', stakeEur - feeEur);
    const price = fromBook ?? (await fetchPrice(this.ex, pair)) * (1 + this.slippagePct / 100);
    const amount = (stakeEur - feeEur) / price;
    return { amount, price, costEur: stakeEur, feeEur, ...(fromBook ? { book: true } : {}) };
  }

  async sell(pair, amount, opts = {}) {
    if (opts.limit) {
      const limit = await fetchPrice(this.ex, pair);
      await orderTiming.sleep((opts.waitSec ?? 20) * 1000);
      const now = await fetchPrice(this.ex, pair);
      if (now >= limit * (1 - this.slippagePct / 200)) {
        const gross = amount * limit;
        const feeEur = (gross * this.makerFeePct) / 100;
        return { amount, price: limit, costEur: gross - feeEur, feeEur, limit: true };
      }
      // Niet gevuld: alsnog market.
    }
    const fromBook = await bookPrice(this.ex, pair, 'sell', amount);
    const price = fromBook ?? (await fetchPrice(this.ex, pair)) * (1 - this.slippagePct / 100);
    const gross = amount * price;
    const feeEur = (gross * this.feePct) / 100;
    return { amount, price, costEur: gross - feeEur, feeEur, ...(opts.limit ? { limitFallback: true } : {}) };
  }
}

export class LiveBroker {
  constructor(ex) {
    this.ex = ex;
    this.mode = 'live';
  }

  #requireKeys() {
    if (!hasTradingKeys(this.ex)) throw new Error('Bitvavo-keys ontbreken, vul ze in via het dashboard');
  }

  async #settle(order, pair) {
    // Market orders zijn meestal direct gevuld; zo niet, haal de order opnieuw op.
    let o = order;
    for (let i = 0; i < 5 && o.status !== 'closed'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      o = await this.ex.fetchOrder(o.id, pair);
    }
    if (!o.filled) throw new Error(`Order ${o.id} is niet gevuld (status ${o.status})`);
    const feeEur = o.fee?.currency === 'EUR' ? o.fee.cost : 0;
    return { amount: o.filled, price: o.average ?? o.price, costEur: o.cost, feeEur };
  }

  // Wacht tot een order gevuld is, maximaal waitSec. Daarna de rest annuleren en de
  // eindstand ophalen (de order kan tussen annuleren en ophalen alsnog gevuld zijn).
  async #waitFill(order, pair, waitSec) {
    let o = order;
    const end = Date.now() + waitSec * 1000;
    while (o.status !== 'closed' && o.status !== 'canceled' && Date.now() < end) {
      await orderTiming.sleep(orderTiming.pollMs);
      o = await this.ex.fetchOrder(o.id, pair);
    }
    if (o.status !== 'closed') {
      try {
        await this.ex.cancelOrder(o.id, pair);
      } catch {
        // Al gevuld of al geannuleerd; de status hieronder is leidend.
      }
      o = await this.ex.fetchOrder(o.id, pair);
    }
    return o;
  }

  #fillOf(o) {
    const feeEur = o.fee?.currency === 'EUR' ? o.fee.cost : 0;
    return { amount: o.filled, price: o.average ?? o.price, costEur: o.cost, feeEur };
  }

  async buy(pair, stakeEur, opts = {}) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    if (opts.limit) {
      const t = await this.ex.fetchTicker(pair);
      const price = Number(this.ex.priceToPrecision(pair, t.bid ?? t.last));
      const amount = Number(this.ex.amountToPrecision(pair, stakeEur / price));
      let order;
      try {
        // postOnly: wordt nooit direct tegen de laatprijs uitgevoerd, dus altijd maker-fee.
        order = await this.ex.createOrder(pair, 'limit', 'buy', amount, price, { postOnly: true });
      } catch {
        return null; // Bijv. geweigerd omdat de koers net omhoog sprong: aankoop gaat niet door.
      }
      const o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      if (!o.filled) return null;
      return { ...this.#fillOf(o), limit: true, partial: o.filled < amount };
    }
    let order;
    if (this.ex.has.createMarketBuyOrderWithCost) {
      order = await this.ex.createMarketBuyOrderWithCost(pair, stakeEur);
    } else {
      const price = await fetchPrice(this.ex, pair);
      const amount = Number(this.ex.amountToPrecision(pair, stakeEur / price));
      order = await this.ex.createMarketOrder(pair, 'buy', amount);
    }
    return this.#settle(order, pair);
  }

  async sell(pair, amount, opts = {}) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    const amt = Number(this.ex.amountToPrecision(pair, amount));
    if (opts.limit) {
      const t = await this.ex.fetchTicker(pair);
      const price = Number(this.ex.priceToPrecision(pair, t.ask ?? t.last));
      let o = null;
      try {
        const order = await this.ex.createOrder(pair, 'limit', 'sell', amt, price, { postOnly: true });
        o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      } catch {
        o = null;
      }
      const filled = o?.filled ?? 0;
      if (filled >= amt) return { ...this.#fillOf(o), limit: true };
      // Rest alsnog met een market order, zodat de positie echt dicht gaat.
      const rest = Number(this.ex.amountToPrecision(pair, amt - filled));
      const restFill = rest > 0 ? await this.#settle(await this.ex.createMarketOrder(pair, 'sell', rest), pair) : null;
      if (!filled) return { ...restFill, limitFallback: true };
      const a = this.#fillOf(o);
      const b = restFill ?? { amount: 0, costEur: 0, feeEur: 0 };
      const total = a.amount + b.amount;
      return { amount: total, price: (a.costEur + b.costEur) / total, costEur: a.costEur + b.costEur, feeEur: a.feeEur + b.feeEur, limit: true, limitFallback: true };
    }
    const order = await this.ex.createMarketOrder(pair, 'sell', amt);
    return this.#settle(order, pair);
  }
}
