// The dashboard's own state: user-defined project groups
// ({ name, sessions: [sessionId] }), inbox dismissals (sessionId -> timestamp of
// the last activity that was dismissed) and the pid and name each session was last
// seen with (sessionId -> { pid, name }).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../data/board.json', import.meta.url));

export function loadBoard() {
  try {
    return { seen: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return { groups: [], dismissed: {}, seen: {} };
    throw e;
  }
}

export function saveBoard(board) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(board, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

export function validGroups(groups) {
  if (!Array.isArray(groups)) return false;
  const names = groups.map((g) => g?.name);
  return (
    groups.every(
      (g) =>
        typeof g.name === 'string' &&
        g.name.trim() !== '' &&
        Array.isArray(g.sessions) &&
        g.sessions.every((id) => typeof id === 'string'),
    ) && new Set(names).size === names.length
  );
}

// Keep an agent in its group when its session id changes under it. /clear and
// /resume in a window keep the process but not the id; /bg keeps the name but not
// the id or the process. An ungrouped live session takes over a grouped session
// that is no longer live and was last seen in the same process or, failing that,
// under the same name. Returns whether the board changed.
export function followAgents(board, agents) {
  const live = new Set(agents.map((a) => a.sessionId));
  const groupOf = new Map(board.groups.flatMap((g) => g.sessions.map((id) => [id, g])));
  const orphans = Object.keys(board.seen).filter((id) => !live.has(id) && groupOf.has(id));
  let changed = false;
  for (const a of agents) {
    if (groupOf.has(a.sessionId)) continue;
    const prev =
      orphans.find((id) => a.pid && board.seen[id].pid === a.pid) ??
      orphans.find((id) => a.name && board.seen[id].name === a.name);
    if (!prev) continue;
    const g = groupOf.get(prev);
    g.sessions[g.sessions.indexOf(prev)] = a.sessionId;
    groupOf.delete(prev);
    groupOf.set(a.sessionId, g);
    orphans.splice(orphans.indexOf(prev), 1);
    delete board.seen[prev];
    changed = true;
  }
  for (const a of agents) {
    const pid = a.pid ?? null;
    const name = a.name ?? null;
    const seen = board.seen[a.sessionId];
    if (seen?.pid !== pid || seen?.name !== name) {
      board.seen[a.sessionId] = { pid, name };
      changed = true;
    }
  }
  for (const id of Object.keys(board.seen)) {
    if (!live.has(id) && !groupOf.has(id)) {
      delete board.seen[id];
      changed = true;
    }
  }
  return changed;
}
