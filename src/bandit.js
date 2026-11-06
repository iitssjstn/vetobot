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

function gauss(rnd = Math.random) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export class Bandit {
  constructor(file) {
    this.file = file;
    this.state = { arms: {}, recent: [] };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && typeof s.arms === 'object') this.state = { arms: s.arms, recent: Array.isArray(s.recent) ? s.recent : [] };
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

  // Beloning na een gesloten trade (winst/verlies in %, na kosten).
  reward(key, pct) {
    if (!key || !Number.isFinite(pct)) return;
    const s = this.stats(key);
    this.state.arms[key] = {
      n: s.n * DECAY + 1,
      sum: s.sum * DECAY + pct,
      sumSq: s.sumSq * DECAY + pct * pct,
      trades: (s.trades ?? 0) + 1,
      total: (s.total ?? 0) + pct,
      lastPct: pct,
      lastAt: new Date().toISOString(),
    };
    this.#save();
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
        chosenShare: recent.length ? recent.filter((k) => k === key).length / recent.length * 100 : 0,
        lastPct: s.lastPct ?? null, lastAt: s.lastAt ?? null,
      };
    }).sort((a, b) => b.estimatePct - a.estimatePct);
  }
}
