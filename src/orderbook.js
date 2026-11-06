// Orderboek: wie wil kopen en verkopen, tegen welke prijs en hoeveel.
// Gebruikt voor (1) een veiligheidscheck bij het kopen (niet duur instappen bij een dunne coin)
// en (2) eerlijkere paper-trades (vullen tegen de echte prijzen in het boek).
//
// book: { bids: [[prijs, hoeveelheid], ...] hoog -> laag, asks: [[prijs, hoeveelheid], ...] laag -> hoog }

// Een order van `eur` euro (kopen) door de asks laten lopen. Geeft de gemiddelde vulprijs, of
// null als het boek niet diep genoeg is.
export function fillBuy(book, eur) {
  let left = eur;
  let amount = 0;
  for (const [price, qty] of book?.asks ?? []) {
    const cost = price * qty;
    if (cost >= left) {
      amount += left / price;
      left = 0;
      break;
    }
    amount += qty;
    left -= cost;
  }
  return left > 1e-9 || amount <= 0 ? null : eur / amount;
}

// `amount` munten verkopen door de bids. Geeft de gemiddelde vulprijs, of null.
export function fillSell(book, amount) {
  let left = amount;
  let eur = 0;
  for (const [price, qty] of book?.bids ?? []) {
    const q = Math.min(qty, left);
    eur += q * price;
    left -= q;
    if (left <= 1e-12) break;
  }
  return left > 1e-12 || eur <= 0 ? null : eur / amount;
}

// Samenvatting van het boek voor een aankoop van `stakeEur`.
export function analyzeBook(book, stakeEur) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (!bid || !ask || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const within = (side, pct) => (book[side] ?? [])
    .filter(([p]) => Math.abs(p - mid) / mid * 100 <= pct)
    .reduce((s, [p, q]) => s + p * q, 0);
  const bid1 = within('bids', 1);
  const ask1 = within('asks', 1);
  const fill = fillBuy(book, stakeEur);
  return {
    bid, ask, mid,
    spreadPct: (ask - bid) / mid * 100,
    // Wat jouw aankoop kost boven het midden van het boek (halve spread + doorlopen in het boek).
    buyCostPct: fill ? (fill / mid - 1) * 100 : null,
    fillPrice: fill,
    depthBidEur: bid1, depthAskEur: ask1,
    // Aandeel kopers in het boek binnen 1% van de prijs (0,5 = evenwicht).
    buyersShare: bid1 + ask1 > 0 ? bid1 / (bid1 + ask1) : null,
  };
}

// Mag de aankoop door? Geeft null (ok) of een reden.
export function bookProblem(info, { maxSpreadPct = 0, maxBookCostPct = 0 } = {}) {
  if (!info) return null; // geen boek: niet blokkeren
  if (maxSpreadPct > 0 && info.spreadPct > maxSpreadPct) {
    return `Orderboek: verschil tussen bied en laat is ${info.spreadPct.toFixed(2)}% (max ${maxSpreadPct}%), te duur om in te stappen`;
  }
  if (maxBookCostPct > 0) {
    if (info.buyCostPct == null) return 'Orderboek: niet genoeg aanbod in het boek voor je inzet';
    if (info.buyCostPct > maxBookCostPct) {
      return `Orderboek: je aankoop zou ${info.buyCostPct.toFixed(2)}% boven de middenprijs gevuld worden (max ${maxBookCostPct}%)`;
    }
  }
  return null;
}
