import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Dashboard-login met één admin-account.
//
// First-run setup: zolang er nog geen account is, maakt de server een eenmalige
// setup-code aan en print die in de containerlogs. Alleen wie die code heeft
// (dus toegang tot de server) kan het admin-account aanmaken. Daarna verdwijnt
// de setup en is alleen inloggen nog mogelijk.
//
// Het wachtwoord wordt alleen als scrypt-hash opgeslagen in data/auth.json.

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
export const COOKIE = 'vetobot_session';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'auth.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
    this.sessions = new Map();
    this.fails = new Map();
    this.setupCode = this.isSetUp() ? null : crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  isSetUp() {
    return Boolean(this.data?.hash && this.data?.username);
  }

  #hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('base64');
  }

  #checkLock(ip) {
    const f = this.fails.get(ip);
    if (f && f.count >= MAX_FAILS && Date.now() - f.at < LOCK_MS) {
      throw new Error('Te veel mislukte pogingen, probeer het over een paar minuten opnieuw');
    }
  }

  #fail(ip, message) {
    const f = this.fails.get(ip);
    this.fails.set(ip, { count: (f?.count ?? 0) + 1, at: Date.now() });
    throw new Error(message);
  }

  #newSession(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { username, exp: Date.now() + SESSION_TTL_MS });
    return token;
  }

  // Maakt het admin-account aan. Alleen mogelijk als er nog geen account is.
  setup({ username, password, code }, ip) {
    if (this.isSetUp()) throw new Error('Er bestaat al een account');
    this.#checkLock(ip);
    if (!code || !safeEqual(String(code).trim().toUpperCase(), this.setupCode)) {
      this.#fail(ip, 'Onjuiste setup-code. Je vindt hem in de logs: docker compose logs vetobot');
    }
    username = String(username ?? '').trim();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new Error('Gebruikersnaam: 3 tot 32 tekens, alleen letters, cijfers, punt, streepje of underscore');
    }
    if (typeof password !== 'string' || password.length < 10) {
      throw new Error('Wachtwoord moet minimaal 10 tekens zijn');
    }
    const salt = crypto.randomBytes(16).toString('base64');
    this.data = { username, salt, hash: this.#hash(password, salt), createdAt: new Date().toISOString() };
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    this.setupCode = null;
    this.fails.delete(ip);
    return this.#newSession(username);
  }

  login({ username, password }, ip) {
    this.#checkLock(ip);
    if (!this.isSetUp() || typeof password !== 'string') this.#fail(ip, 'Onjuiste gebruikersnaam of wachtwoord');
    const okUser = safeEqual(String(username ?? '').trim(), this.data.username);
    const okPass = safeEqual(this.#hash(password, this.data.salt), this.data.hash);
    if (!okUser || !okPass) this.#fail(ip, 'Onjuiste gebruikersnaam of wachtwoord');
    this.fails.delete(ip);
    return this.#newSession(this.data.username);
  }

  // Extra bevestiging voor gevoelige acties, zoals overschakelen naar live trading.
  confirmPassword(password, ip) {
    this.#checkLock(ip);
    if (!this.isSetUp() || !safeEqual(this.#hash(String(password ?? ''), this.data.salt), this.data.hash)) {
      this.#fail(ip, 'Wachtwoord klopt niet');
    }
    this.fails.delete(ip);
  }

  changePassword({ current, next }, ip) {
    this.#checkLock(ip);
    if (!safeEqual(this.#hash(String(current ?? ''), this.data.salt), this.data.hash)) {
      this.#fail(ip, 'Huidig wachtwoord klopt niet');
    }
    if (typeof next !== 'string' || next.length < 10) throw new Error('Nieuw wachtwoord moet minimaal 10 tekens zijn');
    const salt = crypto.randomBytes(16).toString('base64');
    this.data = { ...this.data, salt, hash: this.#hash(next, salt) };
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    this.sessions.clear();
  }

  // Geeft de gebruikersnaam terug bij een geldige sessie, anders null.
  verify(token) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s.username;
  }

  logout(token) {
    this.sessions.delete(token);
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
