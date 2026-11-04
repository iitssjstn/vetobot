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

  async #cached(key, ttlMs, fn) {
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
  const viaShared = new Set(['fetchOHLCV', 'fetchTicker', 'fetchTickers', 'parseTimeframe']);
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

export class PaperBroker {
  // feePct mag een getal of een functie zijn, zodat de fee uit het dashboard direct geldt.
  // slippagePct (getal of functie): koop zoveel procent duurder en verkoop zoveel goedkoper
  // dan de laatste koers, zodat paper niet rooskleuriger is dan live.
  constructor(ex, feePct, slippagePct = 0) {
    this.ex = ex;
    this.fee = typeof feePct === 'function' ? feePct : () => feePct;
    this.slip = typeof slippagePct === 'function' ? slippagePct : () => slippagePct;
    this.mode = 'paper';
  }

  get feePct() {
    return this.fee();
  }

  get slippagePct() {
    return this.slip() ?? 0;
  }

  async buy(pair, stakeEur) {
    const price = (await fetchPrice(this.ex, pair)) * (1 + this.slippagePct / 100);
    const feeEur = (stakeEur * this.feePct) / 100;
    const amount = (stakeEur - feeEur) / price;
    return { amount, price, costEur: stakeEur, feeEur };
  }

  async sell(pair, amount) {
    const price = (await fetchPrice(this.ex, pair)) * (1 - this.slippagePct / 100);
    const gross = amount * price;
    const feeEur = (gross * this.feePct) / 100;
    return { amount, price, costEur: gross - feeEur, feeEur };
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

  async buy(pair, stakeEur) {
    this.#requireKeys();
    await this.ex.loadMarkets();
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

  async sell(pair, amount) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    const amt = Number(this.ex.amountToPrecision(pair, amount));
    const order = await this.ex.createMarketOrder(pair, 'sell', amt);
    return this.#settle(order, pair);
  }
}
