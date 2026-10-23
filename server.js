import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { claudeTheme, listAgents } from './lib/agents.js';
import { followAgents, loadBoard, saveBoard, validGroups } from './lib/board.js';
import { jobNeeds } from './lib/jobs.js';
import { serveTerminals } from './lib/terminals.js';
import { forget, summarize } from './lib/transcripts.js';

const PORT = Number(process.env.PORT ?? 7420);
const HOST = '127.0.0.1';
// Answering only requests addressed to this machine blocks DNS-rebinding pages.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', JS],
  '/terminals.js': ['public/terminals.js', JS],
  '/style.css': ['public/style.css', CSS],
  '/vendor/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', JS],
  '/vendor/addon-fit.mjs': ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', JS],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', CSS],
  // installable as a Chrome app window
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['public/icon-192.png', 'image/png'],
  '/icon-512.png': ['public/icon-512.png', 'image/png'],
};

const board = loadBoard();
const terminalTheme = claudeTheme();
let inflight = null; // concurrent /api/state requests share one refresh

async function buildState() {
  const agents = await listAgents();
  forget(new Set(agents.map((a) => a.sessionId)));
  if (followAgents(board, agents)) saveBoard(board);
  const rows = await Promise.all(
    agents.map(async (a) => ({
      ...a,
      needs: a.kind === 'background' && a.id ? await jobNeeds(a.id) : null,
      transcript: await summarize(a.sessionId, a.cwd),
    })),
  );
  return { generatedAt: new Date().toISOString(), agents: rows, board, terminalTheme };
}

function reply(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body === undefined || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJSON(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return reply(res, 403, { error: 'forbidden host' });
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return reply(res, 200, await readFile(new URL(`./${file}`, import.meta.url)), type);
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      inflight ??= buildState().finally(() => {
        inflight = null;
      });
      return reply(res, 200, await inflight);
    }
    // Requiring JSON forces a CORS preflight, so other sites can't post here.
    if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) {
      return reply(res, 415, { error: 'expected application/json' });
    }
    if (req.method === 'PUT' && pathname === '/api/groups') {
      const { groups } = await readJSON(req);
      if (!validGroups(groups)) return reply(res, 400, { error: 'invalid groups' });
      board.groups = groups;
      saveBoard(board);
      return reply(res, 204);
    }
    if (req.method === 'POST' && pathname === '/api/dismiss') {
      const { sessionId, until } = await readJSON(req);
      if (typeof sessionId !== 'string') return reply(res, 400, { error: 'sessionId required' });
      if (until) board.dismissed[sessionId] = String(until);
      else delete board.dismissed[sessionId];
      saveBoard(board);
      return reply(res, 204);
    }
    reply(res, 404, { error: 'not found' });
  } catch (e) {
    reply(res, 500, { error: e.message });
  }
});

// WebSockets skip CORS entirely, so terminals also require this page's Origin.
serveTerminals(server, (req) => ALLOWED_HOSTS.has(req.headers.host) && ALLOWED_ORIGINS.has(req.headers.origin));

server.listen(PORT, HOST, () => console.log(`Agent dashboard: http://${HOST}:${PORT}`));
