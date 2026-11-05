import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker, LiveBroker, orderTiming } from '../src/exchange.js';

// Geen echte wachttijden in tests; tijdens het "wachten" kan de koers veranderen.
let onWait = null;
orderTiming.sleep = async () => { onWait?.(); };
orderTiming.pollMs = 0;

test('paper: limiet-koop tegen maker-fee als de koers niet wegloopt', async () => {
  const ex = { price: 100, async fetchTicker() { return { last: this.price }; } };
  const b = new PaperBroker(ex, 0.25, 0.1, 0.15);
  onWait = () => { ex.price = 100.02; };
  const f = await b.buy('X/EUR', 50, { limit: true, waitSec: 20 });
  assert.equal(f.price, 100);
  assert.equal(f.feeEur, 50 * 0.0015);
  assert.equal(f.limit, true);
});

test('paper: limiet-koop gaat niet door als de koers omhoog wegloopt', async () => {
  const ex = { price: 100, async fetchTicker() { return { last: this.price }; } };
  const b = new PaperBroker(ex, 0.25, 0.1, 0.15);
  onWait = () => { ex.price = 100.5; };
  assert.equal(await b.buy('X/EUR', 50, { limit: true }), null);
});

test('paper: limiet-verkoop niet gevuld → alsnog market met taker-fee', async () => {
  const ex = { price: 100, async fetchTicker() { return { last: this.price }; } };
  const b = new PaperBroker(ex, 0.25, 0, 0.15);
  onWait = () => { ex.price = 99; };
  const f = await b.sell('X/EUR', 1, { limit: true });
  assert.equal(f.price, 99);
  assert.equal(f.limitFallback, true);
  assert.ok(Math.abs(f.feeEur - 99 * 0.0025) < 1e-9);
});

// Nep-Bitvavo voor orders: script bepaalt wat er met een limietorder gebeurt.
function fakeLive({ fillLimit = 'none' } = {}) {
  const calls = [];
  const orders = {};
  let n = 0;
  return {
    calls,
    apiKey: 'k', secret: 's', has: {},
    async loadMarkets() {},
    priceToPrecision: (_p, v) => v,
    amountToPrecision: (_p, v) => Math.round(v * 1e6) / 1e6,
    async fetchTicker() { return { bid: 99.9, ask: 100.1, last: 100 }; },
    async createOrder(pair, type, side, amount, price, params) {
      calls.push(['create', type, side, amount, price, params?.postOnly ?? false]);
      const id = `o${++n}`;
      orders[id] = { id, status: 'open', amount, price, filled: 0, cost: 0 };
      // Half gevuld direct bij het plaatsen (de rest blijft open staan).
      if (fillLimit === 'half') Object.assign(orders[id], { filled: amount / 2, average: price, cost: (amount / 2) * price, fee: { currency: 'EUR', cost: 0.01 } });
      return orders[id];
    },
    async fetchOrder(id) {
      const o = orders[id];
      if (o.status === 'open') {
        if (fillLimit === 'full') Object.assign(o, { status: 'closed', filled: o.amount, average: o.price, cost: o.amount * o.price, fee: { currency: 'EUR', cost: o.amount * o.price * 0.0015 } });
      }
      return o;
    },
    async cancelOrder(id) { calls.push(['cancel', id]); if (orders[id].status === 'open') orders[id].status = 'canceled'; },
    async createMarketOrder(pair, side, amount) {
      calls.push(['market', side, amount]);
      return { id: 'm', status: 'closed', filled: amount, average: 99.5, cost: amount * 99.5, fee: { currency: 'EUR', cost: amount * 99.5 * 0.0025 } };
    },
  };
}

test('live: limiet-koop post-only op de biedprijs, gevuld tegen maker-fee', async () => {
  const ex = fakeLive({ fillLimit: 'full' });
  const f = await new LiveBroker(ex).buy('X/EUR', 50, { limit: true, waitSec: 5 });
  assert.deepEqual(ex.calls[0].slice(0, 3), ['create', 'limit', 'buy']);
  assert.equal(ex.calls[0][4], 99.9, 'op de biedprijs');
  assert.equal(ex.calls[0][5], true, 'post-only');
  assert.equal(f.limit, true);
  assert.ok(Math.abs(f.costEur - 50) < 0.01);
});

test('live: limiet-koop niet gevuld → geannuleerd, geen aankoop', async () => {
  const ex = fakeLive({ fillLimit: 'none' });
  assert.equal(await new LiveBroker(ex).buy('X/EUR', 50, { limit: true, waitSec: 0 }), null);
  assert.ok(ex.calls.some((c) => c[0] === 'cancel'));
  assert.ok(!ex.calls.some((c) => c[0] === 'market'), 'geen market-aankoop');
});

test('live: limiet-verkoop half gevuld → rest met market, samen één resultaat', async () => {
  const ex = fakeLive({ fillLimit: 'half' });
  const f = await new LiveBroker(ex).sell('X/EUR', 2, { limit: true, waitSec: 0 });
  assert.ok(ex.calls.some((c) => c[0] === 'cancel'));
  assert.deepEqual(ex.calls.find((c) => c[0] === 'market'), ['market', 'sell', 1]);
  assert.equal(f.amount, 2);
  assert.ok(Math.abs(f.costEur - (100.1 + 99.5)) < 1e-9);
  assert.equal(f.limitFallback, true);
});

test('live: stop-loss en gewone orders blijven market', async () => {
  const ex = fakeLive();
  ex.has = { createMarketBuyOrderWithCost: false };
  await new LiveBroker(ex).sell('X/EUR', 1);
  assert.deepEqual(ex.calls.map((c) => c[0]), ['market']);
});
