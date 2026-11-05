// Live terminals over WebSockets.
// - /term/<id>: each socket gets its own `claude attach <id>` client in a pty.
//   Closing the socket kills only that client; the session keeps running.
//   (Verified 2026-10-20 on a throwaway session: SIGHUP, SIGKILL, and two clients
//   attached at once all leave the session untouched.)
// - /shell/<id>: a plain login shell from lib/shells.js, which outlives the socket.
import { homedir } from 'node:os';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { claudeEnv, listAgents } from './agents.js';
import { attachShell, hasShell } from './shells.js';

const MAX_CLIENTS = 8;
const size = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return n >= 2 && n <= 500 ? n : fallback;
};

// `isAllowed(req)` must reject requests from other origins: browsers let any page
// open a WebSocket to localhost, and these sockets can type into an agent or a shell.
export function serveTerminals(server, isAllowed) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.pathname.match(/^\/term\/([0-9a-f]{8})$/)?.[1];
    const shellId = url.pathname.match(/^\/shell\/([0-9a-f-]{36})$/)?.[1];
    let ok = false;
    try {
      if (isAllowed(req) && wss.clients.size < MAX_CLIENTS) {
        if (shellId) ok = hasShell(shellId);
        else if (agentId) ok = (await listAgents()).some((a) => a.kind === 'background' && a.id === agentId);
      }
    } catch (e) {
      console.error('terminal upgrade failed:', e.message);
    }
    if (!ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const cols = size(url.searchParams.get('cols'), 100);
    const rows = size(url.searchParams.get('rows'), 30);
    wss.handleUpgrade(req, socket, head, (ws) =>
      shellId ? connectShell(ws, shellId, cols, rows) : connectAgent(ws, agentId, cols, rows),
    );
  });
}

// Keystrokes and resizes from the page go to the pty until `done()`.
function relayInput(ws, p, cols, rows, done) {
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (done()) return;
    if (m.t === 'i' && typeof m.d === 'string') p.write(m.d);
    else if (m.t === 'r') p.resize(size(m.c, cols), size(m.r, rows));
  });
}

function connectAgent(ws, id, cols, rows) {
  const p = pty.spawn('claude', ['attach', id], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...claudeEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  let exited = false;
  p.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  p.onExit(() => {
    exited = true;
    ws.close(4000, 'detached');
  });
  relayInput(ws, p, cols, rows, () => exited);
  ws.on('close', () => {
    if (!exited) p.kill(); // ends this attach client only
  });
}

function connectShell(ws, id, cols, rows) {
  const p = attachShell(id, ws);
  if (!p) return ws.close(4000, 'exited');
  p.resize(cols, rows);
  relayInput(ws, p, cols, rows, () => !hasShell(id));
}
