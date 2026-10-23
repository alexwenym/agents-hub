import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyEntry, encodeCwd, newSummary, readNew, toView } from '../lib/transcripts.js';

const T0 = '2026-10-19T10:00:00.000Z';
const T1 = '2026-10-19T10:05:00.000Z';

const assistant = (id, content, usage, extra = {}) => ({
  type: 'assistant',
  timestamp: T0,
  message: { id, model: 'claude-opus-5-5', content, usage },
  ...extra,
});
const user = (content, extra = {}) => ({ type: 'user', timestamp: T0, message: { role: 'user', content }, ...extra });
const fold = (entries) => {
  const s = newSummary();
  for (const e of entries) applyEntry(s, e);
  return toView(s);
};

test('cwd encoding matches the project folder names Claude Code uses', () => {
  assert.equal(encodeCwd('/Users/me/my_projects/Paper-Draft'), '-Users-me-my-projects-Paper-Draft');
});

test('output tokens count each API message once even when split across entries', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 50 };
  const v = fold([
    assistant('m1', [{ type: 'text', text: 'a' }], usage),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage),
    assistant('m2', [{ type: 'text', text: 'b' }], { ...usage, output_tokens: 7 }),
  ]);
  assert.equal(v.outputTokens, 57);
  assert.equal(v.contextTokens, 1100);
});

test('last message joins the text blocks of one message and resets on the next', () => {
  const v1 = fold([
    assistant('m1', [{ type: 'text', text: 'first' }], {}),
    assistant('m1', [{ type: 'text', text: 'second' }], {}),
  ]);
  assert.equal(v1.lastAssistant.text, 'first\n\nsecond');
  const v2 = fold([
    assistant('m1', [{ type: 'text', text: 'first' }], {}),
    assistant('m2', [{ type: 'text', text: 'later' }], {}),
  ]);
  assert.equal(v2.lastAssistant.text, 'later');
});

test('tool requests stay pending until their result arrives', () => {
  const ask = assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ssh cluster squeue' } }], {});
  assert.deepEqual(fold([ask]).pendingTools.map((t) => t.detail), ['ssh cluster squeue']);
  assert.equal(fold([ask, user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])]).pendingTools.length, 0);
});

test('only real prompts count as the last prompt, and a new prompt clears stale requests', () => {
  const v = fold([
    user('look at the handoff document'),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }], {}),
    user('<command-name>/clear</command-name>'),
    user('skill text', { isMeta: true }),
    user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    user('summary', { isCompactSummary: true }),
  ]);
  assert.equal(v.lastPrompt.text, 'look at the handoff document');
  assert.equal(v.pendingTools.length, 1);
  assert.equal(fold([user('a'), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], {}), user('b')]).pendingTools.length, 0);
});

test('sidechain entries and synthetic messages do not change usage', () => {
  const usage = { input_tokens: 5, output_tokens: 5 };
  const synthetic = {
    type: 'assistant',
    timestamp: T1,
    message: { id: 'm3', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } },
  };
  const v = fold([
    assistant('m1', [{ type: 'text', text: 'main' }], usage),
    assistant('m2', [{ type: 'text', text: 'sub' }], { input_tokens: 999, output_tokens: 999 }, { isSidechain: true }),
    synthetic,
  ]);
  assert.equal(v.outputTokens, 5);
  assert.equal(v.contextTokens, 5);
  assert.equal(v.model, 'claude-opus-5-5');
  assert.equal(v.lastAssistant.text, 'API Error');
  assert.equal(v.lastActivityTs, T1);
});

test('permission mode and effort come from the latest entries', () => {
  const v = fold([
    { type: 'permission-mode', permissionMode: 'plan' },
    assistant('m1', [{ type: 'text', text: 'a' }], { output_tokens: 1 }, { effort: 'high' }),
    { type: 'permission-mode', permissionMode: 'auto' },
    assistant('m2', [{ type: 'text', text: 'b' }], { output_tokens: 1 }, { effort: 'xhigh' }),
  ]);
  assert.equal(v.permissionMode, 'auto');
  assert.equal(v.effort, 'xhigh');
});

test('readNew consumes only complete lines and picks up appended ones', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'transcript-')), 's.jsonl');
  const line = (e) => `${JSON.stringify(e)}\n`;
  const second = line(user('second prompt'));
  writeFileSync(file, line(user('first prompt')) + second.slice(0, 10)); // second line half-written
  const c = { path: file, offset: 0, summary: newSummary() };
  await readNew(c);
  assert.equal(c.summary.lastPrompt.text, 'first prompt');
  appendFileSync(file, second.slice(10));
  await readNew(c);
  assert.equal(c.summary.lastPrompt.text, 'second prompt');
  await readNew(c); // nothing new: no change, no error
  assert.equal(c.offset, Buffer.byteLength(line(user('first prompt')) + second));
});
