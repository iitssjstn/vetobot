import fs from 'node:fs';
import path from 'node:path';

// Eenvoudige opslag in één JSON-bestand. Wordt atomair weggeschreven,
// zodat een crash halverwege het bestand niet corrupt maakt.

const MAX_DECISIONS = 500;
const MAX_TRADES = 1000;

export class Store {
  constructor(dataDir, mode, startBalanceEur) {
    this.file = path.join(dataDir, `state-${mode}.json`);
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.#load() ?? {
      mode,
      createdAt: new Date().toISOString(),
      balanceEur: mode === 'paper' ? startBalanceEur : null,
      startBalanceEur: mode === 'paper' ? startBalanceEur : null,
      positions: {},
      trades: [],
      decisions: [],
      halted: null,
    };
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Kan ${this.file} niet lezen: ${err.message}`);
    }
  }

  // Begint opnieuw met een leeg paper-account. Alleen voor paper.
  reset(startBalanceEur) {
    this.state = {
      mode: this.state.mode,
      createdAt: new Date().toISOString(),
      balanceEur: startBalanceEur,
      startBalanceEur,
      positions: {},
      trades: [],
      decisions: [],
      halted: null,
    };
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  addDecision(entry) {
    this.state.decisions.unshift({ at: new Date().toISOString(), ...entry });
    this.state.decisions.length = Math.min(this.state.decisions.length, MAX_DECISIONS);
  }

  addTrade(trade) {
    this.state.trades.unshift(trade);
    this.state.trades.length = Math.min(this.state.trades.length, MAX_TRADES);
  }

  // Gerealiseerde winst/verlies van vandaag (lokale tijd van de container, zet TZ).
  realizedTodayEur() {
    const today = new Date().toDateString();
    return this.state.trades
      .filter((t) => t.closedAt && new Date(t.closedAt).toDateString() === today)
      .reduce((sum, t) => sum + t.pnlEur, 0);
  }
}
