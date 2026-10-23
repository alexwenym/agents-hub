// Terminal tiles: each one is an xterm.js view of a background session, connected
// to the server's `claude attach` bridge over a WebSocket. Closing a tile ends only
// that attach client; the session keeps running.
import { FitAddon } from '/vendor/addon-fit.mjs';
import { Terminal } from '/vendor/xterm.mjs';

const MAX_TILES = 4;
const STORE_KEY = 'agent-dashboard:terminals';
// Match Claude Code's own light/dark theme so its colors stay readable.
const THEMES = {
  light: { background: '#ffffff', foreground: '#1f1e1c', cursor: '#1f1e1c', cursorAccent: '#ffffff', selectionBackground: 'rgba(42, 120, 214, 0.25)' },
  dark: { background: '#1a1a19', foreground: '#f0efec', cursor: '#f0efec', cursorAccent: '#1a1a19', selectionBackground: 'rgba(57, 135, 229, 0.35)' },
};

const container = document.querySelector('#tiles');
const tiles = new Map(); // background session short id -> tile
const headers = new WeakMap(); // header element -> last markup
let theme = 'dark';
let onChange = () => {};

export function configure(terminalTheme, changed) {
  theme = THEMES[terminalTheme] ? terminalTheme : 'dark';
  onChange = changed;
}

export const openIds = () => [...tiles.keys()];
export const has = (id) => tiles.has(id);

// Ids open when the page was last closed, so a reload brings the terminals back.
export function saved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? [];
  } catch {
    return [];
  }
}

export function open(id) {
  if (!tiles.has(id)) {
    if (tiles.size >= MAX_TILES) close([...tiles.values()].sort((a, b) => a.usedAt - b.usedAt)[0].id);
    tiles.set(id, create(id));
    changed();
  }
}

export function focus(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  refit(tile);
  tile.term.focus();
}

export function close(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  const ws = tile.ws;
  tile.ws = null;
  ws?.close();
  tile.term.dispose();
  tile.el.remove();
  tiles.delete(id);
  changed();
}

export function reconnect(id) {
  const tile = tiles.get(id);
  if (tile) connect(tile);
}

// Update each tile's header; `render(id)` returns its markup.
export function renderHeaders(render) {
  for (const tile of tiles.values()) {
    const el = tile.el.querySelector('.tile-head');
    const html = render(tile.id);
    if (headers.get(el) !== html) {
      headers.set(el, html);
      el.innerHTML = html;
    }
  }
}

function changed() {
  container.dataset.count = tiles.size;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(openIds()));
  } catch {
    // storage unavailable (private window): tiles just won't be restored on reload
  }
  onChange();
}

function create(id) {
  const el = document.createElement('section');
  el.className = `tile ${theme}`;
  el.innerHTML = '<header class="tile-head"></header><div class="term"></div><div class="tile-overlay" hidden></div>';
  container.append(el);
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEMES[theme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.term'));
  const tile = { id, el, term, fit, ws: null, usedAt: Date.now() };
  term.onData((d) => send(tile, { t: 'i', d }));
  term.onResize(({ cols, rows }) => send(tile, { t: 'r', c: cols, r: rows }));
  el.addEventListener('focusin', () => {
    tile.usedAt = Date.now();
    for (const t of tiles.values()) t.el.classList.toggle('focused', t === tile);
  });
  new ResizeObserver(() => refit(tile)).observe(el.querySelector('.term'));
  connect(tile);
  return tile;
}

function refit(tile) {
  if (tile.el.offsetParent !== null) tile.fit.fit(); // skip while the workspace is hidden
}

function send(tile, msg) {
  if (tile.ws?.readyState === WebSocket.OPEN) tile.ws.send(JSON.stringify(msg));
}

function connect(tile) {
  refit(tile);
  tile.term.reset();
  overlay(tile, null);
  const { cols, rows } = tile.term;
  const ws = new WebSocket(`ws://${location.host}/term/${tile.id}?cols=${cols}&rows=${rows}`);
  tile.ws = ws;
  // the tile may have been resized while connecting
  ws.onopen = () => send(tile, { t: 'r', c: tile.term.cols, r: tile.term.rows });
  ws.onmessage = (e) => tile.term.write(e.data);
  ws.onclose = (e) => {
    if (tile.ws !== ws) return; // closed on purpose or replaced by a reconnect
    tile.ws = null;
    overlay(tile, e.code === 4000 ? 'Detached from this session.' : "Couldn't connect to this session.");
  };
}

function overlay(tile, message) {
  const el = tile.el.querySelector('.tile-overlay');
  el.hidden = !message;
  if (message) {
    el.innerHTML = `<p>${message} The agent itself keeps running.</p>`
      + `<div><button type="button" data-reconnect="${tile.id}">Reconnect</button> `
      + `<button type="button" data-close-tile="${tile.id}">Close</button></div>`;
  }
}
