// Plain login shells for terminal tiles. Unlike a `claude attach` client, the shell
// is the terminal itself, so it outlives a dropped socket: a page reload reconnects
// and replays recent output. It ends when its tile is closed, when it exits, or
// after a day with no window attached.
import { randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import pty from 'node-pty';
import { claudeEnv } from './agents.js';

const MAX_SHELLS = 8;
const REPLAY_CHARS = 200_000; // recent output sent to a reconnecting window
const IDLE_MS = 24 * 60 * 60 * 1000;
const shells = new Map(); // id -> { pty, buffer, client, idle }

export const shellIds = () => [...shells.keys()];
export const hasShell = (id) => shells.has(id);

export function createShell(cols = 100, rows = 30) {
  if (shells.size >= MAX_SHELLS) return null;
  const id = randomUUID();
  const p = pty.spawn(userInfo().shell || '/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...claudeEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const s = { pty: p, buffer: '', client: null, idle: null };
  p.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > REPLAY_CHARS) {
      // cut at a line break so the replay doesn't start mid escape sequence
      const cut = s.buffer.indexOf('\n', s.buffer.length - REPLAY_CHARS);
      s.buffer = cut === -1 ? s.buffer.slice(-REPLAY_CHARS) : s.buffer.slice(cut + 1);
    }
    if (s.client && s.client.readyState === s.client.OPEN) s.client.send(d);
  });
  p.onExit(() => {
    shells.delete(id);
    clearTimeout(s.idle);
    s.client?.close(4000, 'exited');
  });
  shells.set(id, s);
  s.idle = setTimeout(() => p.kill(), IDLE_MS); // until a window attaches
  return id;
}

// Make `ws` the shell's window (replacing any other) and replay recent output.
// Returns the pty to write to, or null if the shell is gone.
export function attachShell(id, ws) {
  const s = shells.get(id);
  if (!s) return null;
  if (s.client && s.client !== ws) s.client.close(4001, 'replaced');
  s.client = ws;
  clearTimeout(s.idle);
  if (s.buffer) ws.send(s.buffer);
  ws.on('close', () => {
    if (s.client !== ws) return;
    s.client = null;
    s.idle = setTimeout(() => s.pty.kill(), IDLE_MS);
  });
  return s.pty;
}

export function closeShell(id) {
  shells.get(id)?.pty.kill(); // onExit does the cleanup
}
