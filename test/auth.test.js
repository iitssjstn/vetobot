import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth } from '../src/auth.js';
import { SecretStore, remapAiKeys } from '../src/secrets.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));

test('first-run setup vereist de setup-code en kan maar één keer', () => {
  const dir = tmp();
  const auth = new Auth(dir);
  assert.equal(auth.isSetUp(), false);
  assert.match(auth.setupCode, /^[0-9A-F]{8}$/);

  assert.throws(() => auth.setup({ username: 'admin', password: 'lang-genoeg-123', code: 'FOUT' }, '1.1.1.1'), /setup-code/);
  assert.throws(() => auth.setup({ username: 'admin', password: 'kort', code: auth.setupCode }, '1.1.1.1'), /10 tekens/);

  const token = auth.setup({ username: 'admin', password: 'lang-genoeg-123', code: auth.setupCode.toLowerCase() }, '1.1.1.1');
  assert.equal(auth.verify(token), 'admin');
  assert.equal(auth.setupCode, null);
  assert.throws(() => auth.setup({ username: 'x', password: 'lang-genoeg-123', code: 'X' }, '1.1.1.1'), /al een account/);

  // Na herstart bestaat het account nog en is er geen setup-code meer.
  const again = new Auth(dir);
  assert.equal(again.isSetUp(), true);
  assert.equal(again.setupCode, null);
  assert.ok(!fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes('lang-genoeg-123'));
});

test('login controleert gebruikersnaam en wachtwoord en blokkeert na 5 fouten', () => {
  const auth = new Auth(tmp());
  auth.setup({ username: 'admin', password: 'lang-genoeg-123', code: auth.setupCode }, 'x');
  assert.equal(auth.verify(auth.login({ username: 'admin', password: 'lang-genoeg-123' }, 'a')), 'admin');
  assert.throws(() => auth.login({ username: 'iemand', password: 'lang-genoeg-123' }, 'a'), /Onjuiste/);
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login({ username: 'admin', password: 'fout' }, 'b'));
  assert.throws(() => auth.login({ username: 'admin', password: 'lang-genoeg-123' }, 'b'), /Te veel/);
});

test('wachtwoord wijzigen logt alle sessies uit', () => {
  const auth = new Auth(tmp());
  const t = auth.setup({ username: 'admin', password: 'lang-genoeg-123', code: auth.setupCode }, 'x');
  auth.changePassword({ current: 'lang-genoeg-123', next: 'nog-langer-456' }, 'x');
  assert.equal(auth.verify(t), null);
  assert.ok(auth.login({ username: 'admin', password: 'nog-langer-456' }, 'x'));
});

test('secrets worden versleuteld opgeslagen en overleven een herstart', () => {
  const dir = tmp();
  const s = new SecretStore(dir);
  s.update({ bitvavoApiKey: 'GEHEIM-KEY-1234', aiApiKey: 'AI-KEY-9999' });
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8').includes('GEHEIM'));
  assert.deepEqual(s.status().bitvavoApiKey, { set: true, hint: '…1234' });
  assert.equal(s.status().bitvavoApiSecret.set, false);

  const again = new SecretStore(dir);
  assert.equal(again.get('bitvavoApiKey'), 'GEHEIM-KEY-1234');
  again.update({ aiApiKey: null });
  assert.equal(again.get('aiApiKey'), '');
  assert.throws(() => again.update({ onbekend: 'x' }));
});

test('AI-keys verhuizen mee bij verschuiven, verwijderen en nieuwe keys', () => {
  const s = new SecretStore(tmp());
  s.update({ aiApiKey: 'A', aiApiKey2: 'B', aiApiKey3: 'C' });
  // Nieuwe volgorde: oud 3, oud 1, een nieuw model met een nieuwe key. Oud 2 is verwijderd.
  remapAiKeys(s, [3, 1, null], { 3: 'NIEUW' }, 3);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => s.get(i === 1 ? 'aiApiKey' : `aiApiKey${i}`)), ['C', 'A', 'NIEUW', '', '']);
  // Alles op één model na weg
  remapAiKeys(s, [2], {}, 1);
  assert.equal(s.get('aiApiKey'), 'A');
  assert.equal(s.get('aiApiKey2'), '');
});
