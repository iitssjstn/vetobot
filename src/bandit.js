import fs from 'node:fs';

// Zelflerend kiezen tussen strategieën ("multi-armed bandit" met Thompson sampling).
//
// Elke bevestigde strategie van de trainer is een "arm". Na elke gesloten trade krijgt de
// gebruikte strategie een beloning: de echte winst of het verlies in % (na kosten). De bot kiest
// daarna vaker de strategieën die het meest opleverden, maar probeert de andere af en toe
// opnieuw, want het kan geluk geweest zijn of de markt kan veranderd zijn.
//
// Hoe: per strategie een schatting van de gemiddelde beloning met een onzekerheid. Bij elke keuze
// trekken we per strategie een getal uit die schatting en nemen de hoogste. Met weinig trades is
// de onzekerheid groot, dus wordt er veel geprobeerd; met veel trades kiest hij vooral de beste.
// Oudere trades tellen steeds minder mee (DECAY), zodat hij zich aanpast aan de markt.

const DECAY = 0.97;        // per nieuwe trade van dezelfde strategie: ±33 trades geheugen
const PRIOR_TRADES = 2;    // denkbeeldige trades met beloning 0: voorzichtig beginnen
const MIN_SD = 0.5;        // minimale spreiding van de beloning (in %)
const MAX_RECENT = 100;
export const SHADOW_WEIGHT = 0.5; // een schaduwtrade telt half zo zwaar als een echte

function gauss(rnd = Math.random) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export class Bandit {
  constructor(file) {
    this.file = file;
    this.state = { arms: {}, recent: [], shadows: [] };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && typeof s.arms === 'object') this.state = { arms: s.arms, recent: Array.isArray(s.recent) ? s.recent : [], shadows: Array.isArray(s.shadows) ? s.shadows : [] };
    } catch {
      // nog niets geleerd
    }
  }

  #save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {
      // niet erg; dan alleen in het geheugen
    }
  }

  stats(key) {
    return this.state.arms[key] ?? { n: 0, sum: 0, sumSq: 0, trades: 0, total: 0 };
  }

  // Geschatte gemiddelde beloning en onzekerheid.
  estimate(key) {
    const s = this.stats(key);
    const nEff = s.n + PRIOR_TRADES;
    const mean = s.sum / nEff;
    const m = s.n > 0 ? s.sum / s.n : 0;
    const variance = Math.max(MIN_SD ** 2, s.n > 1 ? s.sumSq / s.n - m * m : 1);
    return { mean, sd: Math.sqrt(variance / nEff) };
  }

  // Kies een strategie uit keys. Geeft { key, sample, mean, sd }.
  pick(keys, rnd = Math.random) {
    let best = null;
    for (const key of keys) {
      const { mean, sd } = this.estimate(key);
      const sample = mean + sd * gauss(rnd);
      if (!best || sample > best.sample) best = { key, sample, mean, sd };
    }
    if (best) {
      this.state.recent = [...this.state.recent, best.key].slice(-MAX_RECENT);
      this.#save();
    }
    return best;
  }

  // Beloning na een gesloten trade (winst/verlies in %, na kosten). weight < 1 voor een
  // schaduwtrade (niet echt gedaan, wel uitgerekend): telt mee, maar minder zwaar.
  reward(key, pct, weight = 1) {
    if (!key || !Number.isFinite(pct)) return;
    const s = this.stats(key);
    const d = DECAY ** weight;
    const shadow = weight < 1;
    this.state.arms[key] = {
      n: s.n * d + weight,
      sum: s.sum * d + pct * weight,
      sumSq: s.sumSq * d + pct * pct * weight,
      trades: (s.trades ?? 0) + (shadow ? 0 : 1),
      total: (s.total ?? 0) + (shadow ? 0 : pct),
      shadowTrades: (s.shadowTrades ?? 0) + (shadow ? 1 : 0),
      shadowTotal: (s.shadowTotal ?? 0) + (shadow ? pct : 0),
      lastPct: pct,
      lastAt: new Date().toISOString(),
    };
    this.#save();
  }

  // ---------- Schaduwtrades ----------
  // Elke keer dat een strategie wil kopen, volgt de bandit "in gedachten" een trade met haar
  // regels (doel, stop, maximale duur), ook als de bot hem niet echt doet: omdat een andere
  // strategie gekozen werd, de AI nee zei, er al een positie open stond, of er geen geld was.
  // Zo leert hij veel sneller welke strategie werkt dan alleen van echte trades.
  addShadow(sh) {
    const list = this.state.shadows;
    if (list.some((x) => x.key === sh.key && x.pair === sh.pair)) return false; // al eentje open
    list.push(sh);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.#save();
    return true;
  }

  // Schaduwtrades afrekenen met de huidige prijzen. prices: { pair: prijs }. costPct: kosten
  // per ronde. Geeft de afgeronde schaduwtrades terug.
  settleShadows(prices, costPct, now = Date.now(), weight = SHADOW_WEIGHT) {
    const done = [];
    this.state.shadows = this.state.shadows.filter((sh) => {
      const p = prices[sh.pair];
      if (!p) return now - sh.at < 7 * 86400000; // geen prijs: bewaren (maar niet eeuwig)
      const chg = (p / sh.entry - 1) * 100;
      let pct = null;
      let why = '';
      if (chg >= sh.targetPct) { pct = sh.targetPct - costPct; why = 'doel gehaald'; }
      else if (chg <= -sh.stopPct) { pct = -sh.stopPct - costPct; why = 'stop geraakt'; }
      else if (now - sh.at >= sh.holdMinutes * 60000) { pct = chg - costPct; why = 'maximale duur'; }
      if (pct == null) return true;
      this.reward(sh.key, pct, weight);
      done.push({ ...sh, pct, why });
      return false;
    });
    if (done.length) this.#save();
    return done;
  }

  openShadows() {
    return this.state.shadows.length;
  }

  // Overzicht voor het dashboard.
  summary(keys) {
    const all = [...new Set([...(keys ?? []), ...Object.keys(this.state.arms)])];
    const recent = this.state.recent;
    return all.map((key) => {
      const s = this.stats(key);
      const { mean, sd } = this.estimate(key);
      return {
        key, active: keys ? keys.includes(key) : true, trades: s.trades ?? 0, totalPct: s.total ?? 0,
        avgPct: s.trades ? s.total / s.trades : null, estimatePct: mean, uncertaintyPct: sd,
        shadowTrades: s.shadowTrades ?? 0, shadowAvgPct: s.shadowTrades ? s.shadowTotal / s.shadowTrades : null,
        openShadows: this.state.shadows.filter((x) => x.key === key).length,
        chosenShare: recent.length ? recent.filter((k) => k === key).length / recent.length * 100 : 0,
        lastPct: s.lastPct ?? null, lastAt: s.lastAt ?? null,
      };
    }).sort((a, b) => b.estimatePct - a.estimatePct);
  }
}
