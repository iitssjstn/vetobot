import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { createApp } from '../src/server.js';

const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };

// Draait het echte dashboard op een willekeurige poort, met nep-marktdata.
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-srv-'));
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 },
    ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const ex = {
    markets: Object.fromEntries(['BTC/EUR', 'ETH/EUR', 'SOL/EUR', 'ADA/EUR'].map((p) => [p, { symbol: p, base: p.split('/')[0], quote: 'EUR', spot: true }])),
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV() { return []; },
    async fetchTicker() { return { last: 100 }; },
    async fetchTickers(ps) { return Object.fromEntries(ps.map((p) => [p, { last: 100 }])); },
  };
  const users = new Users(dir);
  const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket(ex), makePrivateExchange: () => ({}) });
  const server = createApp({ users, manager, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Kleine client met eigen cookie per "browser".
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b) };
  };
  const close = () => { manager.stopAll(); server.close(); };
  return { users, manager, client, close, base };
}

test('setup, uitnodigen, registreren en elk zijn eigen bot', async () => {
  const { users, manager, client, close } = await setup();
  try {
    const admin = client();
    assert.equal((await admin.post('/api/auth/setup', { username: 'Justin', password: PW, code: users.setupCode })).status, 200);
    const inv = await admin.post('/api/admin/invites', { note: 'Piet' });
    assert.equal(inv.status, 200);
    assert.ok(inv.body.code);

    const piet = client();
    assert.equal((await piet.post('/api/auth/invite/check', { code: inv.body.code })).body.valid, true);
    assert.equal((await piet.post('/api/auth/register', { code: inv.body.code, username: 'piet', password: PW })).status, 200);
    // Code werkt maar één keer
    assert.equal((await client().post('/api/auth/register', { code: inv.body.code, username: 'klaas', password: PW })).status, 400);

    const sp = await piet.get('/api/state');
    assert.equal(sp.body.user.username, 'piet');
    assert.equal(sp.body.user.role, 'user');
    assert.equal(sp.body.follow.available, true);
    assert.equal(sp.body.follow.leader, 'Justin');
    assert.equal(sp.body.heartbeatSet, false);

    // Keys zijn per gebruiker
    await piet.post('/api/settings/keys', { bitvavoApiKey: 'PIET-KEY' });
    const ids = users.list().map((u) => u.id);
    assert.equal(manager.get(ids[1]).secrets.get('bitvavoApiKey'), 'PIET-KEY');
    assert.equal(manager.get(ids[0]).secrets.get('bitvavoApiKey'), '');
    // Heartbeat en gebruikersbeheer alleen voor de admin
    assert.equal((await piet.post('/api/settings/keys', { heartbeatUrl: 'https://hc-ping.com/x' })).status, 403);
    assert.equal((await piet.get('/api/admin/users')).status, 403);
    assert.equal((await piet.post('/api/admin/invites')).status, 403);

    const list = await admin.get('/api/admin/users');
    assert.deepEqual(list.body.users.map((u) => u.username), ['Justin', 'piet']);
    assert.equal(list.body.invites[0].usedBy, 'piet');
  } finally {
    close();
  }
});

test('volgen: aan te zetten door gebruikers, niet door de admin; eigen coins dan geblokkeerd', async () => {
  const { users, client, close } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'justin', password: PW, code: users.setupCode });
    const { body } = await admin.post('/api/admin/invites');
    const piet = client();
    await piet.post('/api/auth/register', { code: body.code, username: 'piet', password: PW });

    assert.equal((await admin.post('/api/settings/follow', { enabled: true })).status, 400);
    const f = await piet.post('/api/settings/follow', { enabled: true });
    assert.equal(f.status, 200);
    assert.equal(f.body.following, true);
    const blocked = await piet.post('/api/settings/pairs', { pairs: ['ETH/EUR'] });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /volgt de strategie van justin/);
    // Wel eigen inzet en limieten
    assert.equal((await piet.post('/api/settings/risk', { risk: { stakeEur: 10 } })).status, 200);
    // Coins wijzigen van de admin komt bij de volger terecht
    assert.equal((await admin.post('/api/settings/pairs', { pairs: ['ETH/EUR', 'SOL/EUR'] })).status, 200);
    assert.deepEqual((await piet.get('/api/state')).body.pairs, ['ETH/EUR', 'SOL/EUR']);
    await piet.post('/api/settings/follow', { enabled: false });
    assert.equal((await piet.post('/api/settings/pairs', { pairs: ['ADA/EUR'] })).status, 200);
  } finally {
    close();
  }
});

test('gebruikersnaam wijzigen, uitschakelen en verwijderen', async () => {
  const { users, manager, client, close } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'justin', password: PW, code: users.setupCode });
    const { body } = await admin.post('/api/admin/invites');
    const piet = client();
    await piet.post('/api/auth/register', { code: body.code, username: 'piet', password: PW });
    const pietId = users.list()[1].id;

    // Naam wijzigen vraagt je wachtwoord; je blijft ingelogd
    assert.equal((await piet.post('/api/auth/username', { username: 'pietje', password: 'fout-wachtwoord' })).status, 400);
    assert.equal((await piet.post('/api/auth/username', { username: 'Justin', password: PW })).status, 400);
    const r = await piet.post('/api/auth/username', { username: 'pietje', password: PW });
    assert.equal(r.status, 200);
    assert.equal((await piet.get('/api/state')).body.user.username, 'pietje');
    assert.equal(manager.get(pietId).bot.username, 'pietje');
    // Inloggen met de nieuwe naam, hoofdletters maken niet uit
    assert.equal((await client().post('/api/auth/login', { username: 'Pietje', password: PW })).status, 200);

    // Uitschakelen: sessie weg, bot gestopt, inloggen geblokkeerd
    await admin.post('/api/admin/users/disable', { id: pietId, disabled: true });
    assert.equal((await piet.get('/api/state')).status, 401);
    assert.equal(manager.get(pietId), null);
    assert.equal((await client().post('/api/auth/login', { username: 'pietje', password: PW })).status, 401);
    await admin.post('/api/admin/users/disable', { id: pietId, disabled: false });
    assert.ok(manager.get(pietId));

    // Verwijderen vraagt het wachtwoord van de admin; de map gaat naar _verwijderd
    assert.equal((await admin.post('/api/admin/users/remove', { id: pietId, password: 'fout' })).status, 400);
    assert.equal((await admin.post('/api/admin/users/remove', { id: pietId, password: PW })).status, 200);
    assert.equal(users.get(pietId), null);
    assert.equal(manager.get(pietId), null);
    // De admin kan zichzelf niet verwijderen
    assert.equal((await admin.post('/api/admin/users/remove', { id: users.admin.id, password: PW })).status, 400);
  } finally {
    close();
  }
});

test('dashboard en API gecomprimeerd; pagina met ETag zodat hij niet steeds opnieuw wordt gedownload', async () => {
  const { users, client, close, base } = await setup();
  try {
    const raw = (url, headers = {}) => new Promise((resolve, reject) => {
      http.get(base + url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    const page = await raw('/', { 'Accept-Encoding': 'gzip' });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.ok(page.headers.etag);
    assert.match(zlib.gunzipSync(page.body).toString(), /<title>/);
    const again = await raw('/', { 'Accept-Encoding': 'gzip', 'If-None-Match': page.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    const plain = await raw('/');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.body.toString(), /<title>/);

    // /api/state is groot genoeg om gecomprimeerd te worden; fetch pakt het zelf uit.
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'justin', password: PW, code: users.setupCode });
    const st = await admin.get('/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.body.user.username, 'justin');
  } finally {
    close();
  }
});

test('api/state wacht niet op de live-prijsopvraag', async () => {
  const { users, manager, client, close } = await setup();
  let finishRefresh;
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'justin', password: PW, code: users.setupCode });
    const bot = manager.ensure(users.admin).bot;
    bot.store.state.positions['BTC/EUR'] = { pair: 'BTC/EUR', entryPrice: 100, amount: 0.25, costEur: 25 };

    let markStarted;
    const refreshStarted = new Promise((resolve) => { markStarted = resolve; });
    manager.shared.ex.fetchTickers = () => {
      markStarted();
      return new Promise((resolve) => { finishRefresh = resolve; });
    };

    const response = admin.get('/api/state');
    await refreshStarted;
    const result = await Promise.race([
      response.then(() => 'response'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    assert.equal(result, 'response');
    finishRefresh({ 'BTC/EUR': { last: 100 } });
    assert.equal((await response).status, 200);
  } finally {
    finishRefresh?.({ 'BTC/EUR': { last: 100 } });
    close();
  }
});
