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

test('Learning: dagboek en modelversies; terugzetten alleen admin met wachtwoord', async () => {
  const { users, manager, client, close } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'Justin', password: PW, code: users.setupCode });
    // Zonder leerserver: de pagina werkt, met een uitleg.
    let r = await admin.get('/api/learning?days=7');
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 7);
    assert.equal(r.body.registry.available, false);
    assert.ok(r.body.journal);
    // Met een leerserver: versies ophalen en terugzetten doorgeven.
    const calls = [];
    manager.trainerAccess = () => ({ url: 'http://t', token: 'x' });
    manager.trainerRequest = async (p, opts = {}) => {
      calls.push([p, opts.method ?? 'GET', opts.body]);
      if (p === '/registry') return { data: { versions: [{ version: 3, decision: 'promoted', active: true }], active: 3, pinned: null, sessions: 5 } };
      return { data: { ok: true } };
    };
    manager.refreshAgent = async () => {};
    r = await admin.get('/api/learning');
    assert.equal(r.body.registry.active, 3);
    assert.equal(r.body.isAdmin, true);
    assert.equal((await admin.post('/api/admin/learning/rollback', { version: 3, password: 'fout-wachtwoord' })).status, 400);
    assert.equal((await admin.post('/api/admin/learning/rollback', { version: 3, password: PW })).status, 200);
    assert.deepEqual(calls.at(-1), ['/registry/rollback', 'POST', { version: 3 }]);
    // Een gewone gebruiker mag kijken, niet terugzetten.
    const inv = await admin.post('/api/admin/invites', { note: 'Piet' });
    const piet = client();
    await piet.post('/api/auth/register', { code: inv.body.code, username: 'piet', password: PW });
    assert.equal((await piet.get('/api/learning')).body.isAdmin, false);
    assert.equal((await piet.post('/api/admin/learning/rollback', { version: 3, password: PW })).status, 403);
    assert.equal((await piet.post('/api/admin/learning/unpin')).status, 403);
  } finally {
    close();
  }
});

test('Live-veiligheid: status in /api/state, saldocontrole alleen live', async () => {
  const { users, manager, client, close } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'Justin', password: PW, code: users.setupCode });
    const bot = manager.get(users.list()[0].id).bot;
    let checked = 0;
    bot.safetyStatus = () => ({ mode: bot.mode, exchangeStop: { enabled: true, positions: [] }, reconcile: checked ? { at: 'x', ok: true, issues: [] } : null, nextReconcileAt: null });
    bot.reconcile = async () => { checked++; };
    assert.equal((await admin.get('/api/state')).body.safety.exchangeStop.enabled, true);
    // In paper: weigeren, niets doen.
    assert.equal((await admin.post('/api/safety/reconcile')).status, 400);
    assert.equal(checked, 0);
    bot.settings.data.mode = 'live';
    const r = await admin.post('/api/safety/reconcile');
    assert.equal(r.status, 200);
    assert.equal(checked, 1);
    assert.equal(r.body.safety.reconcile.ok, true);
  } finally {
    close();
  }
});

test('Live op eigen risico in bulk: meerdere tegelijk, per recept een verliesgrens, alles intrekken', async () => {
  const { users, manager, client, close } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'Justin', password: PW, code: users.setupCode });
    const bot = manager.get(users.list()[0].id).bot;
    const part = (k, stage) => ({ recipeKey: k, stage, liveCheck: { allMet: false, checks: [] } });
    bot.getAgent = () => ({ ...part('A', 'getest'), regimes: {}, extras: [part('B', 'bewezen'), part('C', 'oefenen')], extrasAll: [part('B', 'bewezen'), part('C', 'oefenen')] });
    // Zonder bevestiging of wachtwoord: niets.
    assert.equal((await admin.post('/api/agent/live/bulk', { recipes: ['A', 'B'], maxLossEur: 25, confirmText: 'ja', password: PW })).status, 400);
    assert.equal((await admin.post('/api/agent/live/bulk', { recipes: ['A', 'B'], maxLossEur: 25, confirmText: 'EIGEN RISICO', password: 'fout-wachtwoord' })).status, 400);
    assert.deepEqual(bot.settings.agentLive.risky, {});
    const r = await admin.post('/api/agent/live/bulk', { recipes: ['A', 'B', 'C', 'X'], maxLossEur: 25, confirmText: 'eigen risico', password: PW });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.done, ['A', 'B']);
    assert.deepEqual(r.body.skipped.map((x) => x.recipe), ['C', 'X'], 'oefenen en onbekend overgeslagen');
    assert.equal(bot.settings.agentLive.risky.A.maxLossEur, 25);
    assert.equal(bot.settings.agentLive.risky.B.maxLossEur, 25);
    bot.settings.setAgentLive('B', true);
    const rv = await admin.post('/api/agent/live/bulk', { revokeAll: true, password: PW });
    assert.equal(rv.status, 200);
    assert.deepEqual(bot.settings.agentLive.risky, {});
    assert.deepEqual(bot.settings.agentLive.approved, []);
  } finally {
    close();
  }
});

test('healthz: 200 als het goed gaat, 503 als een handelsronde hangt; /api/state geeft de gezondheid', async () => {
  const { users, manager, client, close, base } = await setup();
  try {
    const admin = client();
    await admin.post('/api/auth/setup', { username: 'Justin', password: PW, code: users.setupCode });
    let res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(['healthy', 'degraded', 'paused'].includes(body.status));
    const st = await admin.get('/api/state');
    assert.ok(st.body.health?.label, 'gezondheid in /api/state');
    assert.ok('lastTickOkAt' in st.body.health && 'positionsWatched' in st.body.health);
    // Handelsronde hangt al lang.
    const bot = manager.get(users.list()[0].id).bot;
    await bot.tickPromise;
    bot.running = true;
    bot.health.s.tickStartedAt = Date.now() - 60 * 60000;
    res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).status, 'critical');
    assert.equal(JSON.stringify(await (await fetch(`${base}/healthz`)).json()).includes('loop-hang'), false, 'geen details naar buiten');
    bot.running = false;
  } finally {
    close();
  }
});
