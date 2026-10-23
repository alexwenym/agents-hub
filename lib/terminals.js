// Live terminals: each browser WebSocket gets its own `claude attach <id>` client
// in a pty. Closing the socket kills only that client; the session keeps running.
// (Verified 2026-10-20 on a throwaway session: SIGHUP, SIGKILL, and two clients
// attached at once all leave the session untouched.)
import { homedir } from 'node:os';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { claudeEnv, listAgents } from './agents.js';

const MAX_CLIENTS = 8;
const size = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return n >= 2 && n <= 500 ? n : fallback;
};

// `isAllowed(req)` must reject requests from other origins: browsers let any page
// open a WebSocket to localhost, and this one can type into an agent.
export function serveTerminals(server, isAllowed) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.match(/^\/term\/([0-9a-f]{8})$/)?.[1];
    let ok = false;
    try {
      ok = Boolean(id) && isAllowed(req) && wss.clients.size < MAX_CLIENTS
        && (await listAgents()).some((a) => a.kind === 'background' && a.id === id);
    } catch (e) {
      console.error('terminal upgrade failed:', e.message);
    }
    if (!ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const cols = size(url.searchParams.get('cols'), 100);
    const rows = size(url.searchParams.get('rows'), 30);
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, id, cols, rows));
  });
}

function connect(ws, id, cols, rows) {
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
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (exited) return;
    if (m.t === 'i' && typeof m.d === 'string') p.write(m.d);
    else if (m.t === 'r') p.resize(size(m.c, cols), size(m.r, rows));
  });
  ws.on('close', () => {
    if (!exited) p.kill(); // ends this attach client only
  });
}
