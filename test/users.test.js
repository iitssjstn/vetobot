import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Users } from '../src/users.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-'));
const PW = 'lang-genoeg-123';

test('admin via setup, gebruikers alleen met een geldige uitnodiging', () => {
  const u = new Users(tmp());
  const { user: admin } = u.setup({ username: 'justin', password: PW, code: u.setupCode }, 'x');
  assert.equal(admin.role, 'admin');
  assert.throws(() => u.register({ code: 'verzonnen', username: 'piet', password: PW }, 'y'), /ongeldig/);

  const { code, invite } = u.createInvite(admin.id, 'voor Piet');
  assert.ok(!JSON.stringify(u.data).includes(code), 'de code zelf wordt niet opgeslagen');
  assert.equal(u.checkInvite(code), true);
  const { user: piet, token } = u.register({ code, username: 'piet', password: PW }, 'y');
  assert.equal(piet.role, 'user');
  assert.equal(u.verify(token).id, piet.id);
  assert.throws(() => u.register({ code, username: 'klaas', password: PW }, 'z'), /al gebruikt/, 'eenmalig');
  assert.throws(() => u.register({ code: u.createInvite(admin.id).code, username: 'PIET', password: PW }, 'z'), /al in gebruik/);
  assert.equal(u.listInvites().find((i) => i.id === invite.id).usedBy, 'piet');
});

test('verlopen uitnodiging, uitschakelen en verwijderen', () => {
  const dir = tmp();
  const u = new Users(dir);
  const { user: admin } = u.setup({ username: 'justin', password: PW, code: u.setupCode }, 'x');
  const { code } = u.createInvite(admin.id);
  u.data.invites[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => u.register({ code, username: 'piet', password: PW }, 'y'), /verlopen/);

  const { user: piet, token } = u.register({ code: u.createInvite(admin.id).code, username: 'piet', password: PW }, 'y');
  u.setDisabled(piet.id, true);
  assert.equal(u.verify(token), null, 'sessie stopt direct');
  assert.throws(() => u.login({ username: 'piet', password: PW }, 'y'), /uitgeschakeld/);
  assert.throws(() => u.setDisabled(admin.id, true), /admin/);
  u.remove(piet.id);
  assert.equal(new Users(dir).list().length, 1);
});

test('oud single-user account wordt het admin-account', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ username: 'justin', salt: 's', hash: 'h', createdAt: '2026-01-01' }));
  const u = new Users(dir);
  assert.equal(u.admin.username, 'justin');
  assert.equal(u.admin.hash, 'h');
  assert.equal(u.setupCode, null);
  assert.ok(fs.existsSync(path.join(dir, 'auth.json.migrated')));
});
