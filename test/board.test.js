import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followAgents, validGroups } from '../lib/board.js';

const boardWith = (sessions, seen = {}) => ({ groups: [{ name: 'Pipeline', sessions }], dismissed: {}, seen });

test('validGroups accepts session-id groups and rejects bad input', () => {
  assert.ok(validGroups([{ name: 'A', sessions: ['s1'] }, { name: 'B', sessions: [] }]));
  assert.ok(!validGroups([{ name: '', sessions: [] }]));
  assert.ok(!validGroups([{ name: 'A', agents: ['old-format'] }]));
  assert.ok(!validGroups([{ name: 'A', sessions: [] }, { name: 'A', sessions: [] }]));
});

test('/clear or /resume in a window: the new session inherits the group via the pid', () => {
  const board = boardWith(['old'], { old: { pid: 4242, name: 'pipeline' } });
  const changed = followAgents(board, [{ sessionId: 'new', pid: 4242, name: 'pipeline-followup' }]);
  assert.ok(changed);
  assert.deepEqual(board.groups[0].sessions, ['new']);
  assert.deepEqual(Object.keys(board.seen), ['new']);
});

test('/bg: the background session inherits the group via the name', () => {
  const board = boardWith(['interactive'], { interactive: { pid: 100, name: 'dash-test-3' } });
  followAgents(board, [{ sessionId: 'background', pid: 200, name: 'dash-test-3' }]);
  assert.deepEqual(board.groups[0].sessions, ['background']);
});

test('a session that is still live keeps its group entry', () => {
  const board = boardWith(['a'], { a: { pid: 1, name: 'x' } });
  followAgents(board, [
    { sessionId: 'a', pid: 1, name: 'x' },
    { sessionId: 'b', pid: 1, name: 'x' },
  ]);
  assert.deepEqual(board.groups[0].sessions, ['a']);
});

test('nothing changes on a quiet poll, so the board is not rewritten', () => {
  const board = boardWith(['a']);
  const agents = [{ sessionId: 'a', pid: 1, name: 'x' }, { sessionId: 'z', name: 'bg', pid: undefined }];
  assert.ok(followAgents(board, agents));
  assert.ok(!followAgents(board, agents));
});

test('ungrouped sessions that end are forgotten', () => {
  const board = boardWith([], { gone: { pid: 5, name: 'old' } });
  followAgents(board, []);
  assert.deepEqual(board.seen, {});
});
