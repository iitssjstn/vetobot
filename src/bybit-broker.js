import ccxt from 'ccxt';
import { orderTiming, hasTradingKeys } from './exchange.js';

// ---------- Live handelen op Bybit (spot, paren in USDT), alleen op eigen risico ----------
// Zelfde interface als LiveBroker (Bitvavo): buy/sell (market en limiet), placeStop/cancelStop/fetchStop/findStop.
// Alle bedragen die de bot ziet zijn in euro (costEur, feeEur); daarnaast bewaren we de bedragen in USDT
// (costQuote, feeQuote) en de koers waarmee is omgerekend (eurRate), net als PaperBroker met fx.
//
// Hoe ccxt 4.5 (js/src/bybit.js) Bybit spot afhandelt, en wat we daarom doen:
// - Market-koop op kosten: createMarketBuyOrderWithCost(symbol, cost) → createOrder(symbol, 'market', 'buy', -1,
//   undefined, { cost }). Bij spot gaat qty dan in de quote-munt (USDT): je geeft precies `cost` USDT uit. Bybit
//   rekent de fee bij een koop in de coin zelf (je krijgt iets minder coins), bij een verkoop in USDT.
// - Orders opvragen: bybit.fetchOrder werkt op een Unified Trading Account alleen met params.acknowledged = true
//   (anders ArgumentsRequired) en alleen voor de laatste 500 orders; op een klassiek account bestaat het niet voor
//   spot (NotSupported). Daarom #getOrder: eerst fetchOrder met acknowledged, anders fetchOpenOrders en
//   fetchCanceledAndClosedOrders met { orderId }.
// - parseOrder: status uit orderStatus ('New'/'PartiallyFilled' → open, 'Filled' → closed, 'Cancelled' → canceled,
//   'PartiallyFilledCanceled' → closed, 'Rejected' → rejected, en voor conditional orders 'Untriggered' → open,
//   'Triggered' → open, 'Active' → open, 'Deactivated' → canceled). De fee komt uit cumFeeDetail (alleen de
//   eerste munt in ccxt; wij lezen info.cumFeeDetail zelf, zodat een fee in de coin én in USDT beide tellen).
//
// Stop-loss bij Bybit (keuze, zie placeStop): een spot TP/SL-order, d.w.z. createOrder(symbol, 'market', 'sell',
// amount, undefined, { triggerPrice, orderFilter: 'tpslOrder' }). ccxt zet bij triggerPrice orderFilter
// 'StopOrder' maar params gaan er daarna overheen (createOrderRequest eindigt met extend(request, query)), dus
// Bybit krijgt orderFilter 'tpslOrder'. Waarom tpslOrder en niet StopOrder (of ccxt's stopLossPrice)?
// - tpslOrder reserveert de coins al vóór de trigger (zoals de stop bij Bitvavo). De bot annuleert de stop
//   vóór elke eigen verkoop, dus een getriggerde stop en een eigen verkoop kunnen nooit allebei dezelfde coins
//   verkopen. Een StopOrder reserveert pas bij de trigger: dan kan de stop later nóg eens verkopen.
// - ccxt's stopLossPrice zet ook reduceOnly (bedoeld voor derivaten); dat laten we liever weg op spot.
// Opvragen/annuleren gaat met dezelfde orderFilter ('tpslOrder'; cancelOrderRequest en fetchOpenOrders nemen
// params over). Bij uitvoering: op een Unified account houdt de order zijn orderId en gaat hij van 'Untriggered'
// via 'Triggered' naar 'New'/'Filled'. Bybit documenteert daarnaast 'Active' ("getriggerd, de nieuwe order is
// geplaatst") als eindstand; dan staat de echte verkoop in een andere order met een nieuw id. Dat vangen we op:
// bij 'Triggered'/'Active' zonder uitvoering zoeken we de verkoop die daaruit kwam (#findTriggered). Vinden we
// hem niet, dan heet de stop 'open' (getriggerd): de bot verkoopt dan zelf NIET (annuleren lukt niet, dus geen
// eigen verkoop), zodat er nooit dubbel verkocht wordt; de saldocontrole meldt het.

const BYBIT_MIN_COST = 5; // USDT: gangbaar minimum per spot-order als de markt geen limits.cost.min geeft
const STOP_FILTER = { orderFilter: 'tpslOrder' };
// Bybit-fouten waarbij de order misschien tóch is aangemaakt of geannuleerd (time-out aan de kant van Bybit,
// "create/cancel failed"). ccxt maakt er InvalidOrder/ExchangeError van, maar het is géén duidelijke weigering.
const UNCERTAIN = /"retCode"\s*:\s*(170146|170147|170149|170150|10016)\b/;

const near = (a, b, rel) => a > 0 && b > 0 && Math.abs(a - b) <= b * rel;
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

// Duidelijke weigering vóór er iets naar Bybit gaat (onder het minimum). isOrderRefusal → true, belowMinimum → true.
function minimumError(text) {
  const err = new ccxt.InvalidOrder(text);
  err.belowMinimum = true;
  return err;
}

export class BybitLiveBroker {
  // fx: { quote: 'USDT', eurPerQuote({ allowStale }) } (QuoteRate van de manager).
  // allowed: () => liveAllowedOnVenue('bybit', settings). Extra vangnet: zonder geldig eigen-risico-akkoord
  // koopt deze broker niets, wat de bot ook vraagt. Verkopen en stops gaan altijd door (een positie moet dicht kunnen).
  constructor(ex, fx, { allowed = null } = {}) {
    this.ex = ex;
    this.fx = fx;
    this.allowed = allowed;
    this.mode = 'live';
    this.venue = 'bybit';
    this.quote = 'USDT';
  }

  #requireKeys() {
    if (!hasTradingKeys(this.ex)) throw new Error('Bybit-keys ontbreken, vul ze in via het dashboard');
  }

  #market(pair) {
    return this.ex.markets?.[pair] ?? null;
  }

  // Minimum van deze markt: { amount (coin), cost (USDT) }. cost valt terug op 5 USDT als Bybit niets geeft.
  minimums(pair) {
    const l = this.#market(pair)?.limits ?? {};
    const amount = num(l.amount?.min) > 0 ? num(l.amount.min) : 0;
    const cost = num(l.cost?.min) > 0 ? num(l.cost.min) : BYBIT_MIN_COST;
    return { amount, cost };
  }

  // Order aanmaken. Een Bybit-time-out (of "create failed") wordt een gewone fout: dan is de uitkomst onzeker
  // (de bot koopt dan niets nieuws tot de saldocontrole), geen weigering.
  async #create(fn, ...args) {
    try {
      return await this.ex[fn](...args);
    } catch (err) {
      if (UNCERTAIN.test(String(err?.message ?? ''))) throw new Error(`Bybit: uitkomst van de order onzeker (${err.message})`);
      throw err;
    }
  }

  // Order ophalen: fetchOrder (Unified, met acknowledged), anders open/gesloten orders met dit id.
  async #getOrder(id, pair, params = {}) {
    let first = null;
    if (typeof this.ex.fetchOrder === 'function') {
      try {
        return await this.ex.fetchOrder(id, pair, { acknowledged: true, ...params });
      } catch (err) {
        if (!(err instanceof ccxt.OrderNotFound || err instanceof ccxt.NotSupported || err instanceof ccxt.ArgumentsRequired)) throw err;
        first = err;
      }
    }
    for (const fn of ['fetchOpenOrders', 'fetchCanceledAndClosedOrders']) {
      if (typeof this.ex[fn] !== 'function') continue;
      const list = await this.ex[fn](pair, undefined, undefined, { orderId: id, ...params });
      const o = (list ?? []).find((x) => String(x?.id) === String(id));
      if (o) return o;
    }
    throw new ccxt.OrderNotFound(`Order ${id} niet gevonden bij Bybit${first ? ` (${first.message})` : ''}`);
  }

  // Alle fees van een order: [{ currency, cost }]. info.cumFeeDetail (Unified) bevat elke munt; anders de
  // ccxt-fee; anders info.cumExecFee zonder munt (klassiek account): bij kopen in de coin, bij verkopen in USDT.
  #fees(o, side, pair) {
    const detail = o?.info?.cumFeeDetail;
    if (detail && typeof detail === 'object' && Object.keys(detail).length) {
      return Object.entries(detail).map(([currency, cost]) => ({ currency, cost: Number(cost) || 0 }));
    }
    const list = o?.fees?.length ? o.fees : o?.fee ? [o.fee] : [];
    if (list.length) return list.map((f) => ({ currency: f?.currency, cost: Number(f?.cost) || 0 }));
    const raw = num(o?.info?.cumExecFee);
    if (Number.isFinite(raw)) {
      const [base, quote] = String(pair).split('/');
      return [{ currency: side === 'buy' ? base : quote, cost: raw }];
    }
    return null; // onbekend
  }

  // Zelfde betekenis als LiveBroker/PaperBroker: bij kopen is costEur wat je in totaal betaalde (inclusief fee),
  // bij verkopen wat je netto ontving (na fee). Fee in de coin (kopen): van de hoeveelheid af, gewaardeerd tegen
  // de vulprijs. Geeft Bybit geen fee, dan schatten we hem met de fee van de markt (feeEstimated) en houden we bij
  // kopen iets minder coins aan dan we kregen: liever een restje dan later een verkoop die Bybit weigert.
  #fillOf(o, side, pair, rate, { maker = false } = {}) {
    const [base, quote] = String(pair).split('/');
    const filled = num(o.filled) || 0;
    const rawCost = num(o.cost);
    const price = num(o.average) > 0 ? num(o.average) : rawCost > 0 && filled > 0 ? rawCost / filled : num(o.price);
    const cost = rawCost > 0 ? rawCost : filled * price;
    let fees = this.#fees(o, side, pair);
    let estimated = false;
    if (!fees) {
      const m = this.#market(pair);
      const r = num(maker ? m?.maker : m?.taker) > 0 ? num(maker ? m.maker : m.taker) : 0.001;
      fees = side === 'buy' ? [{ currency: base, cost: filled * r }] : [{ currency: quote, cost: cost * r }];
      estimated = true;
    }
    const sum = (cur) => fees.filter((f) => f.currency === cur).reduce((a, f) => a + f.cost, 0);
    const feeQ = sum(quote);
    const feeB = sum(base);
    const other = fees.filter((f) => f.currency !== quote && f.currency !== base && f.cost > 0);
    const feeQuote = feeQ + feeB * price;
    const amount = side === 'buy' ? filled - feeB : filled;
    const costQuote = side === 'buy' ? cost + feeQ : cost - feeQ - feeB * price;
    return { amount, price, costEur: costQuote * rate, feeEur: feeQuote * rate, quote: this.quote, eurRate: rate, costQuote, feeQuote,
      ...(estimated ? { feeEstimated: true } : {}), ...(other.length ? { feeOther: other } : {}) };
  }

  async #settle(order, pair, side, rate) {
    let o = order;
    // Bybit geeft bij het aanmaken alleen een orderId terug (geen status): ophalen tot hij klaar is.
    for (let i = 0; i < 6 && o.status !== 'closed' && o.status !== 'canceled' && o.status !== 'rejected'; i++) {
      if (i > 0) await orderTiming.sleep(1000);
      o = await this.#getOrder(order.id, pair);
    }
    if (!(num(o.filled) > 0)) throw new Error(`Order ${order.id} bij Bybit is niet gevuld (status ${o.status ?? 'onbekend'})`);
    return this.#fillOf(o, side, pair, rate);
  }

  async #waitFill(order, pair, waitSec) {
    let o = order;
    const end = Date.now() + waitSec * 1000;
    while (o.status !== 'closed' && o.status !== 'canceled' && o.status !== 'rejected' && Date.now() < end) {
      await orderTiming.sleep(orderTiming.pollMs);
      o = await this.#getOrder(order.id, pair);
    }
    if (o.status !== 'closed') {
      try {
        await this.ex.cancelOrder(order.id, pair);
      } catch {
        // Al gevuld of al geannuleerd; de status hieronder is leidend.
      }
      o = await this.#getOrder(order.id, pair);
    }
    return o;
  }

  // Wachten op een limietorder mislukte terwijl hij al bij Bybit staat: annuleren en de echte stand ophalen.
  async #abandon(order, pair, err) {
    try {
      await this.ex.cancelOrder(order.id, pair);
    } catch {
      // Al gevuld of al geannuleerd; de stand hieronder is leidend.
    }
    try {
      return await this.#getOrder(order.id, pair);
    } catch {
      throw new Error(`Limietorder ${order.id} bij Bybit: stand onbekend (${err?.message ?? err})`);
    }
  }

  async buy(pair, stakeEur, opts = {}) {
    const ok = this.allowed?.();
    if (ok && !ok.ok) throw new Error(ok.reason);
    this.#requireKeys();
    await this.ex.loadMarkets();
    // Kopen: een verse USDT/EUR-koers (anders geen aankoop); de inzet in euro wordt USDT.
    const rate = await this.fx.eurPerQuote();
    const stake = stakeEur / rate;
    const min = this.minimums(pair);
    if (stake < min.cost) throw minimumError(`Bybit: inzet ${stake.toFixed(2)} USDT (€ ${stakeEur.toFixed(2)}) ligt onder het minimum van ${pair} (${min.cost} USDT)`);
    if (opts.limit) {
      const t = await this.ex.fetchTicker(pair);
      const price = Number(this.ex.priceToPrecision(pair, t.bid ?? t.last));
      const amount = Number(this.ex.amountToPrecision(pair, stake / price));
      let order;
      try {
        order = await this.#create('createOrder', pair, 'limit', 'buy', amount, price, { postOnly: true });
      } catch (err) {
        if (err instanceof ccxt.InvalidOrder && !(err instanceof ccxt.InsufficientFunds)) return null;
        throw err;
      }
      let o;
      try {
        o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      } catch (err) {
        o = await this.#abandon(order, pair, err);
      }
      if (!(num(o.filled) > 0)) return null;
      return { ...this.#fillOf(o, 'buy', pair, rate, { maker: true }), limit: true, partial: num(o.filled) < amount };
    }
    const cost = Number(this.ex.costToPrecision ? this.ex.costToPrecision(pair, stake) : stake.toFixed(2));
    const order = await this.#create('createMarketBuyOrderWithCost', pair, cost);
    return this.#settle(order, pair, 'buy', rate);
  }

  async sell(pair, amount, opts = {}) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    // Verkopen mag met de laatst bekende koers: een positie mag nooit vastzitten op een ontbrekende koers.
    const rate = await this.fx.eurPerQuote({ allowStale: true });
    const amt = Number(this.ex.amountToPrecision(pair, amount));
    const min = this.minimums(pair);
    // Koers voor de minimumcheck (en de limietprijs). Lukt dat niet, dan zonder die check: Bybit weigert zelf.
    const t = await this.ex.fetchTicker(pair).catch(() => null);
    const px = num(t?.last) > 0 ? num(t.last) : num(t?.bid);
    if (!(amt > 0) || (min.amount > 0 && amt < min.amount) || (px > 0 && amt * px < min.cost)) {
      throw minimumError(`Bybit: verkoop van ${amt} ${pair.split('/')[0]}${px > 0 ? ` (± ${(amt * px).toFixed(2)} USDT)` : ''} ligt onder het minimum van ${pair} (${min.cost} USDT${min.amount ? `, ${min.amount} ${pair.split('/')[0]}` : ''})`);
    }
    if (opts.limit && (t?.ask ?? t?.last)) {
      const price = Number(this.ex.priceToPrecision(pair, t.ask ?? t.last));
      let o = null;
      let order = null;
      try {
        order = await this.#create('createOrder', pair, 'limit', 'sell', amt, price, { postOnly: true });
        o = await this.#waitFill(order, pair, opts.waitSec ?? 20);
      } catch (err) {
        // Stond de order al bij Bybit, dan eerst annuleren en de echte stand: anders verkoopt de market-order
        // hieronder alles nog eens terwijl de limietorder (deels) gevuld is of nog openstaat.
        o = order?.id ? await this.#abandon(order, pair, err) : null;
        // Aanmaken zelf mislukte zonder duidelijke weigering (time-out, verbinding weg): de limietorder kan tóch
        // bij Bybit staan. Dan NIET alles met een market order verkopen (dubbel); de fout gaat naar de bot, die de
        // positie houdt en opnieuw probeert (de saldocontrole ziet het als de limietorder toch gevuld werd).
        if (!order?.id && !(err instanceof ccxt.InvalidOrder && !UNCERTAIN.test(String(err?.message ?? '')))) throw err;
      }
      const filled = num(o?.filled) || 0;
      if (filled >= amt) return { ...this.#fillOf(o, 'sell', pair, rate, { maker: true }), limit: true };
      // Rest alsnog met een market order, zodat de positie echt dicht gaat; onder het minimum van Bybit kan dat
      // niet (dan blijft een restje staan, de bot sluit de positie met wat er verkocht is).
      const rest = Number(this.ex.amountToPrecision(pair, amt - filled));
      const restOk = rest > 0 && !(min.amount > 0 && rest < min.amount) && !(px > 0 && rest * px < min.cost);
      const restFill = restOk ? await this.#settle(await this.#create('createOrder', pair, 'market', 'sell', rest), pair, 'sell', rate) : null;
      if (!filled) {
        if (!restFill) throw minimumError(`Bybit: verkoop van ${rest} ligt onder het minimum van ${pair}`);
        return { ...restFill, limitFallback: true };
      }
      const a = this.#fillOf(o, 'sell', pair, rate, { maker: true });
      const b = restFill ?? { amount: 0, price: 0, costEur: 0, feeEur: 0, costQuote: 0, feeQuote: 0 };
      const total = a.amount + b.amount;
      return { amount: total, price: (a.amount * a.price + b.amount * b.price) / total, costEur: a.costEur + b.costEur, feeEur: a.feeEur + b.feeEur,
        quote: this.quote, eurRate: rate, costQuote: a.costQuote + b.costQuote, feeQuote: a.feeQuote + b.feeQuote, limit: true, limitFallback: true,
        ...(restOk ? {} : { restBelowMinimum: rest }) };
    }
    const order = await this.#create('createOrder', pair, 'market', 'sell', amt);
    return this.#settle(order, pair, 'sell', rate);
  }

  // ---------- Stop-loss bij Bybit zelf ----------
  // Spot TP/SL-order (orderFilter 'tpslOrder', zie boven): Bybit verkoopt met een market order zodra de laatste
  // koers de triggerprijs raakt, ook als de bot offline is. Geeft { orderId, stopPrice, amount } of { skipped }.
  async placeStop(pair, amount, stopPrice) {
    this.#requireKeys();
    await this.ex.loadMarkets();
    let amt;
    try {
      amt = Number(this.ex.amountToPrecision(pair, amount));
    } catch (err) {
      return { skipped: `hoeveelheid ${amount} is te klein voor Bybit (${err.message})` };
    }
    const min = this.minimums(pair);
    if (!(amt > 0) || (min.amount > 0 && amt < min.amount)) return { skipped: `hoeveelheid ${amt} ligt onder het minimum van Bybit${min.amount > 0 ? ` (${min.amount})` : ''}` };
    const trigger = Number(this.ex.priceToPrecision(pair, stopPrice));
    if (!(trigger > 0)) throw new Error(`Ongeldige stopprijs ${stopPrice}`);
    if (amt * trigger < min.cost) {
      const rate = this.fx?.last?.() ?? null;
      return { skipped: `de stop is ${(amt * trigger).toFixed(2)} USDT${rate ? ` (± € ${(amt * trigger * rate).toFixed(2)})` : ''} waard, onder het minimum van Bybit (${min.cost} USDT); de bot bewaakt de noodstop zelf` };
    }
    const clientOrderId = `vbs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const o = await this.#create('createOrder', pair, 'market', 'sell', amt, undefined, { triggerPrice: trigger, ...STOP_FILTER, clientOrderId });
    if (!o?.id) throw new Error('Bybit gaf geen order-id terug voor de stop-order');
    return { orderId: String(o.id), stopPrice: trigger, amount: amt, clientOrderId };
  }

  // De verkoop die uit een getriggerde stop kwam, als Bybit die als nieuwe order (nieuw id) aanmaakte.
  // Herkennen: zelfde orderLinkId, of een market-verkoop van (vrijwel) dezelfde hoeveelheid ná de stop.
  async #findTriggered(stop, pair) {
    const since = num(stop.timestamp) > 0 ? num(stop.timestamp) : undefined;
    const amt = num(stop.amount) > 0 ? num(stop.amount) : num(stop.info?.qty);
    const link = stop.clientOrderId ?? stop.info?.orderLinkId ?? null;
    const lists = [];
    for (const fn of ['fetchCanceledAndClosedOrders', 'fetchOpenOrders']) {
      if (typeof this.ex[fn] !== 'function') continue;
      lists.push(...((await this.ex[fn](pair, since, 50, fn === 'fetchOpenOrders' ? {} : { orderFilter: 'Order' })) ?? []));
    }
    const match = lists.filter((x) => x && String(x.id) !== String(stop.id) && x.side === 'sell'
      && ((link && (x.clientOrderId ?? x.info?.orderLinkId) === link)
        || (String(x.type).toLowerCase() === 'market' && (since == null || num(x.timestamp) >= since) && (near(num(x.amount), amt, 1e-6) || near(num(x.filled), amt, 1e-6)))));
    match.sort((a, b) => (num(a.timestamp) || 0) - (num(b.timestamp) || 0));
    return match[0] ?? null;
  }

  // Stand van een stop-order: { state: 'open' | 'filled' | 'canceled', filled, fill, triggered?, fillOrderId? }.
  async #stopState(o, pair, rate) {
    const raw = String(o?.info?.orderStatus ?? '');
    const filled = num(o?.filled) || 0;
    const fillOf = (x, n) => (n > 0 ? this.#fillOf(x, 'sell', pair, rate) : null);
    if (o?.status === 'closed') return { state: 'filled', filled, fill: fillOf(o, filled) };
    if (o?.status === 'canceled' || o?.status === 'expired' || o?.status === 'rejected') return { state: 'canceled', filled, fill: fillOf(o, filled) };
    // Getriggerd, maar op deze order (nog) niets uitgevoerd: misschien staat de verkoop in een nieuwe order.
    if ((raw === 'Active' || raw === 'Triggered') && !(filled > 0)) {
      const child = await this.#findTriggered(o, pair).catch(() => null);
      const cf = num(child?.filled) || 0;
      if (child?.status === 'closed' && cf > 0) return { state: 'filled', filled: cf, fill: fillOf(child, cf), triggered: true, fillOrderId: String(child.id) };
      if ((child?.status === 'canceled' || child?.status === 'rejected') && !(cf > 0)) return { state: 'canceled', filled: 0, fill: null, triggered: true, fillOrderId: String(child.id) };
      if (child && cf > 0 && child.status !== 'open') return { state: 'canceled', filled: cf, fill: fillOf(child, cf), triggered: true, fillOrderId: String(child.id) };
      return { state: 'open', filled: 0, fill: null, triggered: true };
    }
    // Untriggered, of getriggerd en bezig ('New'/'PartiallyFilled' op dezelfde order): nog open.
    return { state: 'open', filled, fill: null, ...(raw && raw !== 'Untriggered' ? { triggered: true } : {}) };
  }

  async findStop(pair, amount, stopPrice) {
    this.#requireKeys();
    if (typeof this.ex.fetchOpenOrders !== 'function') return null;
    await this.ex.loadMarkets();
    let amt;
    try { amt = Number(this.ex.amountToPrecision(pair, amount)); } catch { return null; }
    const trigger = Number(this.ex.priceToPrecision(pair, stopPrice));
    const open = await this.ex.fetchOpenOrders(pair, undefined, undefined, STOP_FILTER);
    const o = (open ?? []).find((x) => x?.side === 'sell' && near(num(x.amount), amt, 1e-6) && near(num(x.triggerPrice ?? x.info?.triggerPrice), trigger, 1e-6));
    return o?.id ? { orderId: String(o.id), stopPrice: trigger, amount: amt } : null;
  }

  async fetchStop(pair, orderId) {
    this.#requireKeys();
    const rate = await this.fx.eurPerQuote({ allowStale: true });
    return this.#stopState(await this.#getOrder(orderId, pair, STOP_FILTER), pair, rate);
  }

  // Annuleert de stop en controleert daarna dat hij echt weg is (of inmiddels uitgevoerd). Is het niet zeker
  // (staat nog open, of getriggerd zonder bekende uitvoering), dan een fout: dan mag de bot NIET verkopen.
  async cancelStop(pair, orderId) {
    this.#requireKeys();
    const rate = await this.fx.eurPerQuote({ allowStale: true });
    let cancelErr = null;
    try {
      await this.ex.cancelOrder(orderId, pair, STOP_FILTER);
    } catch (err) {
      cancelErr = err;
    }
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        last = await this.#stopState(await this.#getOrder(orderId, pair, STOP_FILTER), pair, rate);
        if (last.state !== 'open') return last;
      } catch (err) {
        if (!cancelErr && err instanceof ccxt.OrderNotFound) return { state: 'canceled', filled: 0, fill: null };
        if (i === 2) throw new Error(`Stop-order ${orderId} bij Bybit: stand onbekend na annuleren (${(cancelErr ?? err).message})`);
      }
      await orderTiming.sleep(1000);
    }
    throw new Error(`Stop-order ${orderId} bij Bybit staat nog open${last?.triggered ? ' (getriggerd, uitvoering nog niet bekend)' : ''} na annuleren${cancelErr ? ` (${cancelErr.message})` : ''}`);
  }

  // Id's van alle open orders, inclusief de TP/SL-orders (die staan niet in de gewone lijst). Voor de saldocontrole.
  async openOrderIds() {
    const ids = new Set();
    for (const params of [{}, STOP_FILTER]) {
      for (const o of (await this.ex.fetchOpenOrders(undefined, undefined, undefined, params)) ?? []) ids.add(String(o.id));
    }
    return ids;
  }
}
