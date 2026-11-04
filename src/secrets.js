import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Versleutelde opslag voor API-keys, ingevuld via het dashboard.
//
// - De keys staan versleuteld (AES-256-GCM) in data/secrets.enc.
// - De sleutel daarvoor wordt bij de eerste start willekeurig gemaakt en staat in
//   data/master.key (alleen leesbaar voor de eigenaar).
// - Keys komen nooit in env-variabelen, .env-bestanden, logs of API-antwoorden.
//
// Dit beschermt tegen uitlekken via git, backups van losse bestanden of het dashboard.
// Wie root is op de server kan bij beide bestanden; dat is bij elke opslag op disk zo.

export const SECRET_NAMES = ['bitvavoApiKey', 'bitvavoApiSecret', 'aiApiKey'];

export class SecretStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.keyFile = path.join(dataDir, 'master.key');
    this.file = path.join(dataDir, 'secrets.enc');
    this.masterKey = this.#loadOrCreateMasterKey();
    this.values = this.#load();
    this.listeners = [];
  }

  #loadOrCreateMasterKey() {
    if (fs.existsSync(this.keyFile)) {
      const key = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (key.length !== 32) throw new Error(`${this.keyFile} is ongeldig`);
      return key;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  #load() {
    if (!fs.existsSync(this.file)) return {};
    const blob = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  #save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.values), 'utf8'), cipher.final()]);
    const blob = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(name) {
    return this.values[name] || '';
  }

  // updates: { naam: 'nieuwe waarde' } om te zetten, { naam: null } om te verwijderen.
  // Namen die ontbreken blijven ongewijzigd.
  update(updates) {
    for (const [name, value] of Object.entries(updates)) {
      if (!SECRET_NAMES.includes(name)) throw new Error(`Onbekende key "${name}"`);
      if (value === null || value === '') delete this.values[name];
      else if (typeof value === 'string') this.values[name] = value.trim();
      else throw new Error(`Ongeldige waarde voor "${name}"`);
    }
    this.#save();
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  // Alleen of een key is ingesteld, met de laatste 4 tekens. Nooit de volledige waarde.
  status() {
    return Object.fromEntries(
      SECRET_NAMES.map((n) => {
        const v = this.values[n];
        return [n, v ? { set: true, hint: `…${v.slice(-4)}` } : { set: false }];
      }),
    );
  }
}
