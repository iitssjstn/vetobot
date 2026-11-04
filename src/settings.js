import fs from 'node:fs';
import path from 'node:path';

// Instellingen die je in het dashboard wijzigt: handelsmodus en AI-provider.
// Opgeslagen in data/settings.json. Bij de eerste start komen de waarden uit
// de environment variables (LIVE_TRADING, AI_PROVIDER, ...), daarna uit dit bestand.

export const AI_PROVIDERS = ['none', 'gemini', 'openai'];
export const MAX_PAIRS = 30;

export class Settings {
  constructor(dataDir, defaults) {
    this.file = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.data = {
      mode: saved.mode ?? (defaults.liveTrading ? 'live' : 'paper'),
      ai: {
        provider: saved.ai?.provider ?? defaults.ai.provider,
        model: saved.ai?.model ?? defaults.ai.model,
        baseUrl: saved.ai?.baseUrl ?? defaults.ai.baseUrl,
      },
      pairs: saved.pairs ?? defaults.pairs,
      modeChangedAt: saved.modeChangedAt ?? null,
    };
  }

  get mode() {
    return this.data.mode;
  }

  get ai() {
    return this.data.ai;
  }

  get pairs() {
    return this.data.pairs;
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  setMode(mode) {
    if (!['paper', 'live'].includes(mode)) throw new Error(`Ongeldige modus "${mode}"`);
    this.data.mode = mode;
    this.data.modeChangedAt = new Date().toISOString();
    this.#save();
  }

  // validPairs: de markten die Bitvavo echt aanbiedt, zodat er geen typfouten in komen.
  setPairs(pairs, validPairs) {
    if (!Array.isArray(pairs)) throw new Error('pairs moet een lijst zijn');
    const unique = [...new Set(pairs.map((p) => String(p).trim().toUpperCase()))].filter(Boolean);
    if (!unique.length) throw new Error('Kies minimaal één coin');
    if (unique.length > MAX_PAIRS) throw new Error(`Maximaal ${MAX_PAIRS} coins tegelijk`);
    const unknown = unique.filter((p) => !validPairs.has(p));
    if (unknown.length) throw new Error(`Onbekend op Bitvavo: ${unknown.join(', ')}`);
    this.data.pairs = unique;
    this.#save();
  }

  setAi({ provider, model, baseUrl }) {
    if (!AI_PROVIDERS.includes(provider)) throw new Error(`Onbekende AI-provider "${provider}"`);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Base-URL moet met http:// of https:// beginnen');
    this.data.ai = {
      provider,
      model: String(model ?? '').trim().slice(0, 100),
      baseUrl: String(baseUrl ?? '').trim() || 'https://api.groq.com/openai/v1',
    };
    this.#save();
  }
}
