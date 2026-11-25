// Regressietests voor het dashboard/API: belangrijkste endpoints, admin-only, geen geheimen naar buiten.
// Draait het echte dashboard op een willekeurige poort met nep-marktdata (patroon uit test/server.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';
import { BotManager } from '../src/manager.js';
import { SharedMarket } from '../src/exchange.js';
import { createApp } from '../src/server.js';

const PW = 'lang-genoeg-123';
const quiet = { info() {}, warn() {}, error() {} };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-reg-srv-'));
  const config = {
    dataDir: dir, liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    paper: { startBalanceEur: 500 },
    risk: { stakeEur: 25, maxOpenTrades: 2, stopLossPct: 0, takeProfitPct: 0, maxDailyLossEur: 0, feePct: 0, cooldownMinutes: 0, slippagePct: 0 },
    strategy: { emaFast: 3, emaSlow: 8, rsiPeriod: 5, rsiMaxEntry: 100 },
    ai: { provider: 'none', model: '', baseUrl: '', failMode: 'reject', timeoutMs: 1000 },
  };
  const ex = {
    markets: Object.fromEntries(['BTC/EUR', 'ETH/EUR'].map((p) => [p, { symbol: p, base: p.split('/')[0], quote: 'EUR', spot: true, active: true }])),
    parseTimeframe: () => 3600,
    async loadMarkets() { return this.markets; },
    async fetchOHLCV() { return []; },
    async fetchTicker() { return { last: 100 }; },
    async fetchTickers(ps) { return Object.fromEntries(ps.map((p) => [p, { last: 100, quoteVolume: 1 }])); },
  };
  const users = new Users(dir);
  // De eigen verbinding per gebruiker: een saldo-opvraag die werkt (zonder netwerk).
  const manager = new BotManager({ config, users, log: quiet, shared: new SharedMarket(ex),
    makePrivateExchange: () => ({ async fetchBalance() { return { EUR: { free: 100, total: 100 } }; }, async loadMarkets() { return ex.markets; } }) });
  const server = createApp({ users, manager, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
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
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json, text };
    };
    return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b) };
  };
  const admin = client();
  await admin.post('/api/auth/setup', { username: 'baas', password: PW, code: users.setupCode });
  const inv = await admin.post('/api/admin/invites', { note: 'Piet' });
  const user = client();
  await user.post('/api/auth/register', { code: inv.body.code, username: 'piet', password: PW });
  const close = () => { manager.stopAll(); server.close(); };
  return { users, manager, client, admin, user, close, base };
}

test('API: belangrijkste endpoints geven 200 met de verwachte sleutels', async () => {
  const { admin, user, close } = await setup();
  try {
    assert.equal((await admin.get('/healthz')).status, 200);
    for (const c of [admin, user]) {
      const st = await c.get('/api/state');
      assert.equal(st.status, 200);
      for (const k of ['user', 'mode', 'pairs', 'timeframe', 'risk', 'riskLimits', 'strategy', 'strategyLimits', 'balanceEur', 'startBalanceEur',
        'positions', 'open', 'trades', 'decisions', 'stats', 'pairStatus', 'activity', 'notify', 'halted', 'liveBalance', 'stake', 'safety',
        'bitvavoKeysSet', 'aiKeySet', 'checkIntervalMinutes', 'serverTime']) {
        assert.ok(k in st.body, `state.${k}`);
      }
      assert.equal(st.body.mode, 'paper', 'nieuwe gebruikers in paper');
      assert.equal(st.body.balanceEur, 500);
      for (const k of ['totalTrades', 'winRate', 'realizedEur', 'realizedTodayEur', 'vetoed', 'approved', 'blocked']) assert.ok(k in st.body.stats, `stats.${k}`);
      const keys = await c.get('/api/settings/keys');
      assert.equal(keys.status, 200);
      assert.equal(keys.body.bitvavoApiKey.set, false);
      assert.equal((await c.get('/api/markets')).status, 200);
      assert.equal((await c.get('/api/aichat')).status, 200);
      assert.equal((await c.get('/api/learning')).status, 200);
      assert.equal((await c.get('/api/model')).status, 200);
    }
    assert.equal((await user.post('/api/pause')).status, 200);
    assert.equal((await user.get('/api/state')).body.halted.manual, true);
    assert.equal((await user.post('/api/resume')).status, 200);
    assert.equal((await user.get('/api/state')).body.halted, null);
    // Instellingen via de API: gevalideerd, met de nieuwe waarde terug.
    const r = await user.post('/api/settings/risk', { risk: { stakeEur: 12 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.risk.stakeEur, 12);
    assert.equal((await user.post('/api/settings/risk', { risk: { stakeEur: -1 } })).status, 400);
    assert.equal((await user.post('/api/positions/close', { pair: 'BTC/EUR' })).status, 400, 'geen positie');
  } finally {
    close();
  }
});

test('API: zonder sessie 401, zonder JSON 415', async () => {
  const { client, base, close, user } = await setup();
  try {
    const ok = await user.get('/api/state');
    assert.equal(ok.status, 200);
    const anon = client();
    for (const u of ['/api/state', '/api/settings/keys', '/api/admin/users', '/api/learning']) assert.equal((await anon.get(u)).status, 401, u);
    assert.equal((await anon.post('/api/pause')).status, 401);
    const res = await fetch(`${base}/api/pause`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 401);
    // Ingelogd, maar geen JSON (CSRF-bescherming): 415 en niets gedaan.
    const cookie = await (async () => {
      const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'piet', password: PW }) });
      return r.headers.get('set-cookie').split(';')[0];
    })();
    const form = await fetch(`${base}/api/pause`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: 'a=1' });
    assert.equal(form.status, 415);
    assert.equal((await user.get('/api/state')).body.halted, null);
  } finally {
    close();
  }
});

test('API: admin-only endpoints weigeren een gewone gebruiker (403), de admin niet', async () => {
  const { admin, user, close } = await setup();
  try {
    const gets = ['/api/admin/users', '/api/admin/trainer/status'];
    const posts = ['/api/admin/invites', '/api/admin/invites/revoke', '/api/admin/users/disable', '/api/admin/users/remove', '/api/admin/trainer/train',
      '/api/admin/trainer/agent', '/api/admin/trainer/search', '/api/admin/trainer/apply', '/api/admin/trainer/schedule', '/api/admin/trainer/fetch',
      '/api/admin/learning/rollback', '/api/admin/learning/unpin', '/api/settings/heartbeat/test', '/api/admin/trainer/helper-pair', '/api/admin/trainer/micro'];
    for (const u of gets) assert.equal((await user.get(u)).status, 403, u);
    for (const u of posts) assert.equal((await user.post(u, {})).status, 403, u);
    assert.equal((await admin.get('/api/admin/users')).status, 200);
    // Admin-secrets kan een gewone gebruiker niet zetten en niet zien.
    assert.equal((await user.post('/api/settings/keys', { trainerToken: 'abc' })).status, 403);
    const keys = (await user.get('/api/settings/keys')).body;
    for (const n of ['heartbeatUrl', 'trainerUrl', 'trainerToken']) assert.equal(n in keys, false, n);
  } finally {
    close();
  }
});

test('API: nooit keys of geheimen in /api/state (ook niet in /api/settings/keys)', async () => {
  const { admin, close } = await setup();
  try {
    const secrets = {
      bitvavoApiKey: 'BVKEY-zeer-geheim-1234567890abcdef',
      bitvavoApiSecret: 'BVSECRET-zeer-geheim-0987654321fedcba',
      aiApiKey: 'AIKEY-zeer-geheim-abcdefabcdef',
      trainerToken: 'TRAINTOKEN-zeer-geheim-xyzxyzxyz',
      discordWebhook: 'https://discord.com/api/webhooks/123456789012345678/WEBHOOKGEHEIM-abcdefghij',
    };
    const set = await admin.post('/api/settings/keys', secrets);
    assert.equal(set.status, 200, set.text);
    const st = await admin.get('/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.body.bitvavoKeysSet, true);
    const keysRes = await admin.get('/api/settings/keys');
    for (const [name, v] of Object.entries(secrets)) {
      for (const part of [v, v.slice(0, 20), 'WEBHOOKGEHEIM']) {
        if (name !== 'discordWebhook' && part === 'WEBHOOKGEHEIM') continue;
        assert.equal(st.text.includes(part), false, `${name} in /api/state`);
        assert.equal(keysRes.text.includes(part), false, `${name} in /api/settings/keys`);
        assert.equal(set.text.includes(part), false, `${name} in het antwoord op opslaan`);
      }
    }
    assert.equal(keysRes.body.bitvavoApiKey.set, true);
    assert.equal(keysRes.body.bitvavoApiKey.hint, '…cdef', 'alleen de laatste 4 tekens');
    assert.equal(/password|passwordHash|salt/i.test(st.text.replace(/"[^"]*Password[^"]*"/g, '')), false, 'geen wachtwoordgegevens');
  } finally {
    close();
  }
});

test('API: naar live alleen met wachtwoord én het woord LIVE; zonder keys geweigerd', async () => {
  const { user, close } = await setup();
  try {
    assert.equal((await user.post('/api/settings/mode', { mode: 'live', password: 'fout-wachtwoord', confirm: 'LIVE' })).status, 400);
    assert.equal((await user.post('/api/settings/mode', { mode: 'live', password: PW, confirm: 'live' })).status, 400);
    const r = await user.post('/api/settings/mode', { mode: 'live', password: PW, confirm: 'LIVE' });
    assert.equal(r.status, 400, 'geen Bitvavo-keys');
    assert.match(r.body.error, /keys/);
    assert.equal((await user.get('/api/state')).body.mode, 'paper');
  } finally {
    close();
  }
});
