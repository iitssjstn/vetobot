import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Notifier } from '../src/notify.js';
import { SecretStore } from '../src/secrets.js';
import { Settings } from '../src/settings.js';

const quiet = { info() {}, warn() {}, error() {} };
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-123';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  const secrets = new SecretStore(dir);
  const settings = new Settings(dir, { liveTrading: false, pairs: ['BTC/EUR'], timeframe: '1h', checkIntervalMinutes: 15,
    risk: {}, strategy: {}, ai: { provider: 'none' } });
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 204, text: async () => '' };
  };
  return { secrets, settings, calls, n: new Notifier({ secrets, settings, log: quiet, fetchImpl }) };
}

test('zonder webhook wordt er niets verstuurd', async () => {
  const { n, calls } = setup();
  assert.equal(await n.send('trades', { title: 'x', message: 'y' }), false);
  assert.equal(calls.length, 0);
  await assert.rejects(n.test(), /geen Discord-webhook/);
});

test('webhook- en heartbeat-URL worden gevalideerd', () => {
  const { secrets } = setup();
  assert.throws(() => secrets.update({ discordWebhook: 'https://example.com/hook' }), /Discord-webhook/);
  assert.throws(() => secrets.update({ heartbeatUrl: 'http://hc-ping.com/abc' }), /https/);
  secrets.update({ discordWebhook: WEBHOOK, heartbeatUrl: 'https://hc-ping.com/abc' });
  assert.equal(secrets.status().discordWebhook.set, true);
});

test('tag alleen bij gekozen events en alleen jouw user ID', async () => {
  const { n, calls, secrets, settings } = setup();
  secrets.update({ discordWebhook: WEBHOOK });
  assert.throws(() => settings.setNotify({ discordUserId: 'abc' }), /15 tot 22 cijfers/);
  settings.setNotify({
    discordUserId: '111122223333444455',
    events: { trades: true, errors: true, stoploss: true },
    mentions: { stoploss: true },
  });
  await n.send('trades', { title: 'Gekocht', message: 'x' });
  await n.send('stoploss', { title: 'Stop-loss', message: 'x' });
  await n.send('mode', { title: 'uit', message: 'x' });
  assert.equal(calls.length, 2, 'mode staat uit');
  assert.equal(calls[0].body.content, '');
  assert.deepEqual(calls[0].body.allowed_mentions.users, []);
  assert.equal(calls[1].body.content, '<@111122223333444455>');
  assert.deepEqual(calls[1].body.allowed_mentions.users, ['111122223333444455']);
  assert.equal(calls[1].url, WEBHOOK);
});

test('dezelfde fout wordt maar één keer per 30 minuten gemeld', async () => {
  const { n, calls, secrets } = setup();
  secrets.update({ discordWebhook: WEBHOOK });
  await n.send('errors', { title: 'Fout', message: 'Bitvavo niet bereikbaar' });
  await n.send('errors', { title: 'Fout', message: 'Bitvavo niet bereikbaar' });
  await n.send('errors', { title: 'Fout', message: 'Iets anders' });
  assert.equal(calls.length, 2);
});

test('heartbeat pingt de URL, en /fail bij fouten', async () => {
  const { n, calls, secrets } = setup();
  assert.equal(await n.heartbeat(true), null);
  secrets.update({ heartbeatUrl: 'https://hc-ping.com/abc-123' });
  await n.heartbeat(true);
  await n.heartbeat(false);
  assert.deepEqual(calls.map((c) => c.url), ['https://hc-ping.com/abc-123', 'https://hc-ping.com/abc-123/fail']);
  assert.equal(n.lastHeartbeat.ok, false);
});

test('een kapotte webhook laat de bot niet crashen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
  const secrets = new SecretStore(dir);
  secrets.update({ discordWebhook: WEBHOOK });
  const settings = new Settings(dir, { pairs: [], risk: {}, strategy: {}, ai: {} });
  const n = new Notifier({ secrets, settings, log: quiet, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await n.send('trades', { title: 'x', message: 'y' }), false);
  await assert.rejects(n.test(), /offline/);
});

test('heartbeat bij snelle checks hooguit eens per minuut, fouten altijd', async () => {
  const { n, calls, secrets } = setup();
  secrets.update({ heartbeatUrl: 'https://hc-ping.com/x' });
  await n.heartbeat(true); await n.heartbeat(true); await n.heartbeat(true);
  assert.equal(calls.length, 1);
  await n.heartbeat(false);
  assert.equal(calls.length, 2, 'fout gaat direct');
  await n.heartbeat(true, { force: true });
  assert.equal(calls.length, 3, 'testknop gaat altijd');
});
