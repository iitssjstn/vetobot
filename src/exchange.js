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

// Haalt candles op en laat de laatste (nog niet gesloten) candle weg.
export async function fetchClosedCandles(ex, pair, timeframe, limit = 200) {
  const candles = await ex.fetchOHLCV(pair, timeframe, undefined, limit + 1);
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
  constructor(ex, feePct) {
    this.ex = ex;
    this.feePct = feePct;
    this.mode = 'paper';
  }

  async buy(pair, stakeEur) {
    const price = await fetchPrice(this.ex, pair);
    const feeEur = (stakeEur * this.feePct) / 100;
    const amount = (stakeEur - feeEur) / price;
    return { amount, price, costEur: stakeEur, feeEur };
  }

  async sell(pair, amount) {
    const price = await fetchPrice(this.ex, pair);
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
