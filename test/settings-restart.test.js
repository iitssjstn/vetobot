import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Settings } from '../src/settings.js';

const defaults = { liveTrading: false, pairs: ['BTC/EUR'], timeframe: '5m', checkIntervalMinutes: 1,
  ai: { provider: 'openai', model: 'm', baseUrl: '', failMode: 'reject' }, risk: { stakeEur: 5, maxOpenTrades: 3 }, strategy: {} };

test('alle instellingen blijven na een herstart behouden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetobot-set-'));
  const a = new Settings(dir, defaults);
  a.setAi({ provider: 'openai', model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1', failMode: 'approve',
    fallbacks: [{ provider: 'openai', model: 'qwen/qwen3.8-27b' }] });
  a.setStrategy({ agentMode: 1, agentVeto: 0, mlBandit: 1, agentExplore: 1 });
  a.setRisk({ limitOrders: 2, maxHoldMinutes: 60, reinvestPct: 50, watchSeconds: 10 });
  a.setFollow(true);
  // "Herstart": nieuwe instantie die van schijf leest
  const b = new Settings(dir, defaults);
  assert.equal(b.ai.failMode, 'approve');
  assert.equal(b.ai.model, 'openai/gpt-oss-120b');
  assert.equal(b.ai.fallbacks[0].model, 'qwen/qwen3.8-27b');
  assert.equal(b.strategy.agentMode, 1);
  assert.equal(b.strategy.agentVeto, 0);
  assert.equal(b.strategy.mlBandit, 1);
  assert.equal(b.risk.limitOrders, 2);
  assert.equal(b.risk.maxHoldMinutes, 60);
  assert.equal(b.follow.enabled, true);
  // Alles wat opgeslagen is, wordt ook weer ingelezen
  assert.deepEqual(b.data.ai, a.data.ai);
  assert.deepEqual(b.data.strategy, a.data.strategy);
  assert.deepEqual(b.data.risk, a.data.risk);
});
