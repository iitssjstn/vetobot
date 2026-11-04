import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Gebruikers, uitnodigingen en sessies.
//
// - data/users.json bevat alle accounts (alleen scrypt-hashes van wachtwoorden) en
//   de uitnodigingen (alleen een hash van de code, nooit de code zelf).
// - Het eerste account wordt via de first-run setup aangemaakt en is admin.
// - Andere gebruikers kunnen alleen een account maken met een uitnodigingscode van de admin.
// - Een bestaand data/auth.json (van vóór meerdere gebruikers) wordt automatisch omgezet
//   naar het admin-account.

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const COOKIE = 'vetobot_session';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (password, salt) => crypto.scryptSync(password, salt, 64).toString('base64');
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Wachtwoord moet minimaal 10 tekens zijn');
}

export class Users {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'users.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    this.sessions = new Map(); // token -> { userId, exp }
    this.fails = new Map();
    this.setupCode = this.isSetUp() ? null : crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  #load() {
    if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const data = { users: [], invites: [] };
    // Omzetten van het oude single-user auth.json
    const old = path.join(this.dataDir, 'auth.json');
    if (fs.existsSync(old)) {
      const a = JSON.parse(fs.readFileSync(old, 'utf8'));
      if (a?.username && a?.hash) {
        data.users.push({
          id: `u_${crypto.randomBytes(6).toString('hex')}`,
          username: a.username,
          salt: a.salt,
          hash: a.hash,
          role: 'admin',
          createdAt: a.createdAt ?? new Date().toISOString(),
          disabled: false,
          migrated: true,
        });
        this.#write(data);
        fs.renameSync(old, `${old}.migrated`);
      }
    }
    return data;
  }

  #write(data = this.data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isSetUp() {
    return this.data.users.some((u) => u.role === 'admin');
  }

  get admin() {
    return this.data.users.find((u) => u.role === 'admin') ?? null;
  }

  get(id) {
    return this.data.users.find((u) => u.id === id) ?? null;
  }

  // Publieke gegevens, zonder hash of salt.
  publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, disabled: Boolean(u.disabled), lastLoginAt: u.lastLoginAt ?? null };
  }

  list() {
    return this.data.users.map((u) => this.publicUser(u));
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

  #newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { userId, exp: Date.now() + SESSION_TTL_MS });
    return token;
  }

  #checkUsername(username, exceptId = null) {
    username = String(username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      throw new Error('Gebruikersnaam: 3 tot 32 tekens, alleen letters, cijfers, punt, streepje of underscore');
    }
    if (this.data.users.some((u) => u.id !== exceptId && u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Deze gebruikersnaam is al in gebruik');
    }
    return username;
  }

  #addUser({ username, password, role }) {
    username = this.#checkUsername(username);
    checkPassword(password);
    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: `u_${crypto.randomBytes(6).toString('hex')}`,
      username,
      salt,
      hash: hashPw(password, salt),
      role,
      createdAt: new Date().toISOString(),
      disabled: false,
    };
    this.data.users.push(user);
    this.#write();
    return user;
  }

  // First-run: het admin-account, met de setup-code uit de logs.
  setup({ username, password, code }, ip) {
    if (this.isSetUp()) throw new Error('Er bestaat al een account');
    this.#checkLock(ip);
    if (!code || !safeEqual(String(code).trim().toUpperCase(), this.setupCode)) {
      this.#fail(ip, 'Onjuiste setup-code. Je vindt hem in de logs: docker compose logs vetobot');
    }
    const user = this.#addUser({ username, password, role: 'admin' });
    this.setupCode = null;
    this.fails.delete(ip);
    return { token: this.#newSession(user.id), user };
  }

  // ---------- Uitnodigingen ----------
  createInvite(createdBy, note = '') {
    const code = crypto.randomBytes(9).toString('base64url');
    const invite = {
      id: `i_${crypto.randomBytes(4).toString('hex')}`,
      codeHash: sha(code),
      note: String(note).slice(0, 60),
      createdBy,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      usedBy: null,
      usedAt: null,
    };
    this.data.invites.push(invite);
    this.#write();
    return { code, invite: this.#publicInvite(invite) };
  }

  #publicInvite(i) {
    const { codeHash, ...rest } = i;
    void codeHash;
    const usedBy = i.usedBy ? this.get(i.usedBy)?.username ?? 'verwijderd' : null;
    return { ...rest, usedBy, expired: !i.usedBy && new Date(i.expiresAt).getTime() < Date.now() };
  }

  listInvites() {
    return this.data.invites.map((i) => this.#publicInvite(i)).reverse();
  }

  revokeInvite(id) {
    this.data.invites = this.data.invites.filter((i) => i.id !== id || i.usedBy);
    this.#write();
  }

  #findInvite(code) {
    const h = sha(String(code ?? '').trim());
    const inv = this.data.invites.find((i) => safeEqual(i.codeHash, h));
    if (!inv || inv.usedBy || new Date(inv.expiresAt).getTime() < Date.now()) return null;
    return inv;
  }

  checkInvite(code) {
    return Boolean(this.#findInvite(code));
  }

  register({ code, username, password }, ip) {
    this.#checkLock(ip);
    const inv = this.#findInvite(code);
    if (!inv) this.#fail(ip, 'Deze uitnodiging is ongeldig, al gebruikt of verlopen');
    const user = this.#addUser({ username, password, role: 'user' });
    inv.usedBy = user.id;
    inv.usedAt = new Date().toISOString();
    this.#write();
    this.fails.delete(ip);
    return { token: this.#newSession(user.id), user };
  }

  // ---------- Inloggen ----------
  login({ username, password }, ip) {
    this.#checkLock(ip);
    const name = String(username ?? '').trim().toLowerCase();
    const user = this.data.users.find((u) => u.username.toLowerCase() === name);
    // Altijd hashen, ook als de gebruiker niet bestaat, zodat de tijd niets verraadt.
    const ok = user
      ? typeof password === 'string' && safeEqual(hashPw(password, user.salt), user.hash)
      : (hashPw(String(password ?? ''), 'x'), false);
    if (!ok) this.#fail(ip, 'Onjuiste gebruikersnaam of wachtwoord');
    if (user.disabled) throw new Error('Dit account is uitgeschakeld');
    this.fails.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    this.#write();
    return { token: this.#newSession(user.id), user };
  }

  // Geeft de gebruiker terug bij een geldige sessie, anders null.
  verify(token) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.get(s.userId);
    if (!user || user.disabled) {
      this.sessions.delete(token);
      return null;
    }
    return user;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  #endSessionsOf(userId) {
    for (const [t, s] of this.sessions) if (s.userId === userId) this.sessions.delete(t);
  }

  confirmPassword(userId, password, ip) {
    this.#checkLock(ip);
    const u = this.get(userId);
    if (!u || !safeEqual(hashPw(String(password ?? ''), u.salt), u.hash)) this.#fail(ip, 'Wachtwoord klopt niet');
    this.fails.delete(ip);
  }

  changePassword(userId, { current, next }, ip) {
    this.confirmPassword(userId, current, ip);
    checkPassword(next);
    const u = this.get(userId);
    u.salt = crypto.randomBytes(16).toString('base64');
    u.hash = hashPw(next, u.salt);
    this.#write();
    this.#endSessionsOf(userId);
  }

  // Nieuwe gebruikersnaam, met je wachtwoord ter bevestiging. Je blijft ingelogd.
  changeUsername(userId, { password, username }, ip) {
    this.confirmPassword(userId, password, ip);
    const name = this.#checkUsername(username, userId);
    const u = this.get(userId);
    u.username = name;
    this.#write();
    return u;
  }

  // ---------- Beheer door de admin ----------
  setDisabled(userId, disabled) {
    const u = this.get(userId);
    if (!u) throw new Error('Gebruiker niet gevonden');
    if (u.role === 'admin') throw new Error('Het admin-account kan niet worden uitgeschakeld');
    u.disabled = Boolean(disabled);
    this.#write();
    if (u.disabled) this.#endSessionsOf(userId);
  }

  remove(userId) {
    const u = this.get(userId);
    if (!u) throw new Error('Gebruiker niet gevonden');
    if (u.role === 'admin') throw new Error('Het admin-account kan niet worden verwijderd');
    this.data.users = this.data.users.filter((x) => x.id !== userId);
    this.#write();
    this.#endSessionsOf(userId);
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
