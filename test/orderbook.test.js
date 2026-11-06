import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBook, bookProblem, fillBuy, fillSell } from '../src/orderbook.js';
import { PaperBroker } from '../src/exchange.js';

const book = {
  bids: [[99.9, 1], [99.5, 2], [98, 10]],
  asks: [[100.1, 1], [100.5, 2], [102, 10]],
};

test('orderboek: vulprijs door het boek heen lopen', () => {
  assert.equal(fillBuy(book, 50), 100.1); // past in de eerste laag
  const p = fillBuy(book, 300.1); // 100,1 (1 stuk) + 200 euro tegen 100,5
  assert.ok(Math.abs(p - 300.1 / (1 + 200 / 100.5)) < 1e-9);
  assert.equal(fillBuy(book, 1e9), null, 'niet diep genoeg');
  assert.equal(fillSell(book, 0.5), 99.9);
  assert.ok(Math.abs(fillSell(book, 2) - (99.9 + 99.5) / 2) < 1e-9);
});

test('orderboek: check bij het kopen', () => {
  const info = analyzeBook(book, 25);
  assert.ok(Math.abs(info.spreadPct - 0.2) < 1e-9);
  assert.ok(Math.abs(info.buyCostPct - 0.1) < 1e-9);
  assert.ok(info.buyersShare > 0.4 && info.buyersShare < 0.6);
  assert.equal(bookProblem(info, { maxSpreadPct: 0.5, maxBookCostPct: 0.3 }), null);
  assert.match(bookProblem(info, { maxSpreadPct: 0.1 }), /verschil tussen bied en laat is 0.20%/);
  assert.match(bookProblem(info, { maxBookCostPct: 0.05 }), /0.10% boven de middenprijs/);
  assert.match(bookProblem(analyzeBook(book, 1e9), { maxBookCostPct: 1 }), /niet genoeg aanbod/);
  assert.equal(bookProblem(null, { maxSpreadPct: 0.1 }), null, 'geen boek: niet blokkeren');
});

test('paper: vullen tegen de echte prijzen in het orderboek', async () => {
  const ex = { fetchTicker: async () => ({ last: 100 }), fetchOrderBook: async () => book };
  const br = new PaperBroker(ex, 0.25, 0.1);
  const buy = await br.buy('X/EUR', 25);
  assert.equal(buy.book, true);
  assert.equal(buy.price, 100.1);
  const sell = await br.sell('X/EUR', 0.2);
  assert.ok(Math.abs(sell.price - 99.9) < 1e-9);
  // Zonder orderboek: laatste koers + slippage
  const br2 = new PaperBroker({ fetchTicker: async () => ({ last: 100 }) }, 0.25, 0.1);
  assert.equal((await br2.buy('X/EUR', 25)).price, 100 * 1.001);
});
