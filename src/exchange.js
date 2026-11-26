import { fillBuy, fillSell } from './orderbook.js';
import ccxt from 'ccxt';

// Wrapper rond ccxt voor Bitvavo. Marktdata is publiek en werkt zonder keys.
// De keys komen uit de versleutelde SecretStore en worden bijgewerkt zodra je ze
// in het dashboard wijzigt.

// Bitvavo (en ccxt) eist bij elke order en elke annulering een operatorId: een nummer dat je zelf
// kiest om te zien welke bot of persoon de order plaatste. Zonder weigert ccxt ÉLKE order, ook
// verkopen. Te wijzigen met BITVAVO_OPERATOR_ID.
export const OPERATOR_ID = Number(process.env.BITVAVO_OPERATOR_ID) > 0 ? Math.floor(Number(process.env.BITVAVO_OPERATOR_ID)) : 1;

export function createExchange(secrets) {
  const ex = new ccxt.bitvavo({ enableRateLimit: true, options: { operatorId: OPERATOR_ID } });
  const apply = () => {
    ex.apiKey = secrets.get('bitvavoApiKey') || undefined;
    ex.secret = secrets.get('bitvavoApiSecret') || undefined;
  };
  apply();
  secrets.onChange(apply);
  return ex;
}

export const hasTradingKeys = (ex) => Boolean(ex.apiKey && ex.secret);

// Is dit een verbindingsfout (time-out, Bitvavo niet bereikbaar, onderhoud), en geen fout in de order zelf?
export function isNetworkError(err) {
  if (!err) return false;
  if (err instanceof ccxt.NetworkError) return true; // RequestTimeout, ExchangeNotAvailable, DDoSProtection, ...
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|timed? ?out/i.test(String(err.message ?? err));
}

// Weigerde Bitvavo de order duidelijk (dan is er zeker niets gebeurd)? Ongeldige order, te weinig saldo,
// keys of rechten. Bij al het andere (time-out, verbinding weg, order niet gevuld) is de uitkomst onzeker.
export const isOrderRefusal = (err) => err instanceof ccxt.InvalidOrder || err instanceof ccxt.InsufficientFunds || err instanceof ccxt.BadSymbol || err instanceof ccxt.AuthenticationError
  || err instanceof ccxt.PermissionDenied || err instanceof ccxt.AccountSuspended || /^Bitvavo-keys ontbreken/.test(String(err?.message ?? ''));

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
    // since hoort in de sleutel: anders krijgt een ander verzoek met dezelfde limit oude candles uit de cache.
    return this.#cached(`ohlcv:${pair}:${tf}:${since ?? ''}:${limit}`, 15000, () => this.ex.fetchOHLCV(pair, tf, since, limit));
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

// Laatste koers. Geeft Bitvavo geen bruikbare koers (kleine coins hebben soms geen 'last'), dan het
// midden van bied en laat; lukt ook dat niet, dan een fout in plaats van een leeg getal (NaN), zodat
// er nooit met een onbekende koers wordt gerekend of verkocht.
export async function fetchPrice(ex, pair) {
  const t = await ex.fetchTicker(pair);
  const ok = (v) => Number.isFinite(v) && v > 0;
  if (ok(t?.last)) return t.last;
  if (ok(t?.close)) return t.close;
  if (ok(t?.bid) && ok(t?.ask)) return (t.bid + t.ask) / 2;
  throw new Error(`Geen bruikbare koers voor ${pair} van Bitvavo`);
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

  async #settle(order, pair, side) {
    // Market orders zijn meestal direct gevuld; zo niet, haal de order opnieuw op.
    let o = order;
    for (let i = 0; i < 5 && o.status !== 'closed'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      o = await this.ex.fetchOrder(o.id, pair);
    }
    if (!o.filled) throw new Error(`Order ${o.id} is niet gevuld (status ${o.status})`);
    return this.#fillOf(o, side, pair);
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

  // Wachten op een limietorder mislukte (bijv. verbinding weg) terwijl hij al bij Bitvavo staat: annuleren
  // en de echte stand ophalen, zodat hij niet ongemerkt open blijft (en later alsnog gevuld wordt). Is de stand
  // niet op te halen, dan een fout: dan is onbekend wat er gevuld is.
  async #abandon(order, pair, err) {
    try {
      await this.ex.cancelOrder(order.id, pair);
    } catch {
      // Al gevuld of al geannuleerd; de stand hieronder is leidend.
    }
    try {
      return await this.ex.fetchOrder(order.id, pair);
    } catch {
      throw new Error(`Limietorder ${order.id} bij Bitvavo: stand onbekend (${err?.message ?? err})`);
    }
  }

  // Zelfde betekenis als in paper: bij kopen is costEur wat je in totaal betaalde (inclusief fee),
  // bij verkopen wat je netto ontving (na fee). Zonder dit telden de fees live niet mee in de winst.
  // Een fee in de coin zelf (bij kopen) gaat van de ontvangen hoeveelheid af.
  #fillOf(o, side, pair) {
    const fees = o.fees?.length ? o.fees : o.fee ? [o.fee] : [];
    const base = String(pair ?? '').split('/')[0];
    const sum = (cur) => fees.filter((f) => f?.currency === cur).reduce((a, f) => a + (Number(f.cost) || 0), 0);
    const feeEur = sum('EUR');
    const feeBase = side === 'buy' && base ? sum(base) : 0;
    const price = o.average ?? o.price;
    const cost = Number.isFinite(o.cost) ? o.cost : o.filled * price;
    return { amount: o.filled - feeBase, price, costEur: side === 'buy' ? cost + feeEur : cost - feeEur, feeEur: feeEur + feeBase * price };
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
      } catch (err) {
        // Alleen een geweigerde order (bijv. de koers sprong net omhoog) is "niet gevuld"; een echte
        // fout (keys, saldo, ontbrekende instelling) moet zichtbaar worden, niet stil verdwijnen.
        if (err instanceof ccxt.InvalidOrder && !(err instanceof ccxt.InsufficientFunds)) return null;
        throw err;
      }
      let o;
      try {
        o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      } catch (err) {
        o = await this.#abandon(order, pair, err);
      }
      if (!o.filled) return null;
      return { ...this.#fillOf(o, 'buy', pair), limit: true, partial: o.filled < amount };
    }
    let order;
    if (this.ex.has.createMarketBuyOrderWithCost) {
      order = await this.ex.createMarketBuyOrderWithCost(pair, stakeEur);
    } else {
      const price = await fetchPrice(this.ex, pair);
      const amount = Number(this.ex.amountToPrecision(pair, stakeEur / price));
      order = await this.ex.createMarketOrder(pair, 'buy', amount);
    }
    return this.#settle(order, pair, 'buy');
  }

  async sell(pair, amount, opts = {}) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    const amt = Number(this.ex.amountToPrecision(pair, amount));
    if (opts.limit) {
      const t = await this.ex.fetchTicker(pair);
      const price = Number(this.ex.priceToPrecision(pair, t.ask ?? t.last));
      let o = null;
      let order = null;
      try {
        order = await this.ex.createOrder(pair, 'limit', 'sell', amt, price, { postOnly: true });
        o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      } catch (err) {
        // Stond de order al bij Bitvavo, dan eerst annuleren en de echte stand: anders verkoopt de market-order
        // hieronder alles nog eens terwijl de limietorder (deels) gevuld is of nog openstaat.
        o = order?.id ? await this.#abandon(order, pair, err) : null;
      }
      const filled = o?.filled ?? 0;
      if (filled >= amt) return { ...this.#fillOf(o, 'sell', pair), limit: true };
      // Rest alsnog met een market order, zodat de positie echt dicht gaat.
      const rest = Number(this.ex.amountToPrecision(pair, amt - filled));
      const restFill = rest > 0 ? await this.#settle(await this.ex.createMarketOrder(pair, 'sell', rest), pair, 'sell') : null;
      if (!filled) return { ...restFill, limitFallback: true };
      const a = this.#fillOf(o, 'sell', pair);
      const b = restFill ?? { amount: 0, price: 0, costEur: 0, feeEur: 0 };
      const total = a.amount + b.amount;
      return { amount: total, price: (a.amount * a.price + b.amount * b.price) / total, costEur: a.costEur + b.costEur, feeEur: a.feeEur + b.feeEur, limit: true, limitFallback: true };
    }
    const order = await this.ex.createMarketOrder(pair, 'sell', amt);
    return this.#settle(order, pair, 'sell');
  }

  // ---------- Stop-loss bij Bitvavo zelf ----------
  // Een stop-loss market-order die Bitvavo zelf uitvoert als de laatste koers (lastTrade) op of
  // onder de stopprijs komt, ook als de bot offline is. Let op: Bitvavo reserveert de hoeveelheid
  // zolang de order openstaat; vóór elke eigen verkoop moet hij dus eerst geannuleerd worden.
  // Geeft { orderId, stopPrice, amount }, of { skipped: reden } als de hoeveelheid onder het
  // minimum van Bitvavo valt (dan wordt er niets geplaatst).
  async placeStop(pair, amount, stopPrice) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    let amt;
    try {
      amt = Number(this.ex.amountToPrecision(pair, amount));
    } catch (err) {
      return { skipped: `hoeveelheid ${amount} is te klein voor Bitvavo (${err.message})` };
    }
    const min = Number(this.ex.markets?.[pair]?.limits?.amount?.min);
    if (!(amt > 0) || (min > 0 && amt < min)) return { skipped: `hoeveelheid ${amt} ligt onder het minimum van Bitvavo${min > 0 ? ` (${min})` : ''}` };
    const trigger = Number(this.ex.priceToPrecision(pair, stopPrice));
    if (!(trigger > 0)) throw new Error(`Ongeldige stopprijs ${stopPrice}`);
    // Bitvavo weigert orders onder een minimale orderwaarde (meestal € 5). Een stop van een kleine positie
    // (bijv. € 5 met 10% noodstop = € 4,50) zou dan steeds mislukken: niet plaatsen, de bot bewaakt zelf.
    const minCost = Number(this.ex.markets?.[pair]?.limits?.cost?.min) > 0 ? Number(this.ex.markets[pair].limits.cost.min) : 5;
    if (amt * trigger < minCost) return { skipped: `de stop is € ${(amt * trigger).toFixed(2)} waard, onder het minimum van Bitvavo (€ ${minCost.toFixed(2)}); de bot bewaakt de noodstop zelf` };
    const o = await this.ex.createOrder(pair, 'stopLoss', 'sell', amt, undefined,
      { triggerPrice: trigger, triggerType: 'price', triggerReference: 'lastTrade', operatorId: OPERATOR_ID });
    if (!o?.id) throw new Error('Bitvavo gaf geen order-id terug voor de stop-order');
    return { orderId: String(o.id), stopPrice: trigger, amount: amt };
  }

  // Stand van een stop-order: { state: 'open' | 'filled' | 'canceled', filled, fill }.
  // fill (zoals bij een verkoop) alleen als er iets is uitgevoerd.
  #stopState(o, pair) {
    const filled = Number(o?.filled) || 0;
    const state = o?.status === 'closed' ? 'filled' : o?.status === 'canceled' || o?.status === 'expired' || o?.status === 'rejected' ? 'canceled' : 'open';
    const fill = filled > 0 ? this.#fillOf({ ...o, average: o.average ?? (Number.isFinite(o.cost) && filled ? o.cost / filled : o.price) }, 'sell', pair) : null;
    return { state, filled, fill };
  }

  // Zoekt een openstaande stop-order (verkoop) voor deze hoeveelheid en stopprijs bij Bitvavo. Voor als
  // een eerdere poging een fout gaf terwijl de order misschien wél is aangemaakt (time-out, antwoord
  // verloren): dan die overnemen in plaats van een tweede te zetten. Geeft { orderId, stopPrice, amount } of null.
  async findStop(pair, amount, stopPrice) {
    this.#requireKeys();
    if (typeof this.ex.fetchOpenOrders !== 'function') return null;
    await this.ex.loadMarkets();
    let amt;
    try { amt = Number(this.ex.amountToPrecision(pair, amount)); } catch { return null; }
    const trigger = Number(this.ex.priceToPrecision(pair, stopPrice));
    const near = (a, b, rel) => a > 0 && b > 0 && Math.abs(a - b) <= b * rel;
    const open = await this.ex.fetchOpenOrders(pair);
    const o = (open ?? []).find((x) => x?.side === 'sell' && /^stoploss$/i.test(String(x.type ?? x.info?.orderType ?? ''))
      && near(Number(x.amount), amt, 1e-6) && near(Number(x.triggerPrice ?? x.info?.triggerAmount ?? x.info?.triggerPrice), trigger, 1e-6));
    return o?.id ? { orderId: String(o.id), stopPrice: trigger, amount: amt } : null;
  }

  async fetchStop(pair, orderId) {
    this.#requireKeys();
    return this.#stopState(await this.ex.fetchOrder(orderId, pair), pair);
  }

  // Annuleert de stop-order en controleert daarna bij Bitvavo dat hij echt geannuleerd is (of
  // inmiddels uitgevoerd). Geeft de stand zoals fetchStop. Is het niet zeker (order staat nog
  // open, of niets op te halen), dan een fout: dan mag de bot NIET verkopen.
  async cancelStop(pair, orderId) {
    this.#requireKeys();
    let cancelErr = null;
    try {
      await this.ex.cancelOrder(orderId, pair, { operatorId: OPERATOR_ID });
    } catch (err) {
      cancelErr = err; // bijv. al uitgevoerd; fetchOrder hieronder is leidend
    }
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        last = this.#stopState(await this.ex.fetchOrder(orderId, pair), pair);
        if (last.state !== 'open') return last;
      } catch (err) {
        // Annuleren lukte en de order is niet meer te vinden: dan is hij weg.
        if (!cancelErr && err instanceof ccxt.OrderNotFound) return { state: 'canceled', filled: 0, fill: null };
        if (i === 2) throw new Error(`Stop-order ${orderId} bij Bitvavo: stand onbekend na annuleren (${(cancelErr ?? err).message})`);
      }
      await orderTiming.sleep(1000);
    }
    throw new Error(`Stop-order ${orderId} bij Bitvavo staat nog open na annuleren${cancelErr ? ` (${cancelErr.message})` : ''}`);
  }
}
