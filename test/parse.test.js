import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseDecision, parseExit, parseSummary } from '../src/ai.js';

test('JSON uit antwoorden van denkende modellen (Qwen e.d.)', () => {
  const qwen = '<think>\nDe RSI is 72, dat is hoog. Format: {"decision": ...}. Ik kies voor afwijzen.\n</think>\n\n{"decision": "reject", "reason": "RSI te hoog"}';
  assert.deepEqual(parseDecision(qwen), { decision: 'reject', reason: 'RSI te hoog' });
  assert.equal(parseExit('<think>momentum {neemt} af</think>{"decision":"sell","reason":"top bereikt"}').decision, 'sell');
});

test('JSON in een codeblok of met tekst eromheen', () => {
  assert.equal(parseDecision('Mijn oordeel:\n```json\n{"decision": "approve", "reason": "trend {sterk}"}\n```').decision, 'approve');
  assert.equal(parseDecision('{"decision":"approve","reason":"ok"}').reason, 'ok');
  assert.equal(extractJson('Ik denk {niet} dat... {"decision": "reject", "reason": "x"} klaar'.trim()).decision, 'reject');
});

test('geen JSON: duidelijke fout met een stukje van het antwoord', () => {
  assert.throws(() => parseDecision('Ik zou deze trade afwijzen.'), /Geen JSON in AI-antwoord: "Ik zou deze trade afwijzen\./);
  assert.throws(() => parseDecision('<think>lang nadenken zonder einde'), /Geen JSON/);
});

test('dagoverzicht: denkblok niet in de analyse', () => {
  const r = parseSummary('<think>eerst nadenken</think>{"analyse": "Rustige dag.", "voorstel": {}, "toelichting": ""}');
  assert.equal(r.analysis, 'Rustige dag.');
  assert.equal(parseSummary('<think>hmm</think>Gewoon tekst.').analysis, 'Gewoon tekst.');
});
