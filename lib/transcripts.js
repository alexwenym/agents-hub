// Summaries of Claude Code conversation transcripts. The transcript format is
// undocumented, so every assumption about it lives in this file (see PLAN.md).
import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');
const MAX_TEXT = 20_000;

// Claude Code names each project folder after the cwd with every
// non-alphanumeric character replaced by '-'.
export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

async function findTranscript(sessionId, cwd) {
  const direct = path.join(PROJECTS_DIR, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  for (const dir of await readdir(PROJECTS_DIR)) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function newSummary() {
  return {
    lastAssistant: null, // { id, text, ts }
    lastPrompt: null, // { text, ts }
    lastActivityTs: null,
    pendingTools: new Map(), // tool_use id -> { name, detail, ts }
    contextTokens: 0,
    outputTokens: 0,
    outputByMessage: new Map(), // message id -> output tokens counted so far
    model: null,
    effort: null,
    permissionMode: null,
  };
}

// The text of a real prompt typed by the user, or null for tool results,
// slash-command plumbing, task notifications and interruptions.
function promptText(content) {
  if (typeof content === 'string') return content.startsWith('<') ? null : content;
  if (content.some((b) => b.type === 'tool_result')) return null;
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return null;
  return text;
}

function describeTool(name, input = {}) {
  const detail =
    input.command ?? input.file_path ?? input.url ?? input.questions?.[0]?.question ?? JSON.stringify(input);
  return String(detail).slice(0, 300);
}

// Fold one transcript entry into the running summary.
export function applyEntry(s, e) {
  if (e.isSidechain) return;
  if (e.type === 'permission-mode' && e.permissionMode) s.permissionMode = e.permissionMode;
  if (['assistant', 'user', 'system'].includes(e.type) && e.timestamp) {
    if (!s.lastActivityTs || e.timestamp > s.lastActivityTs) s.lastActivityTs = e.timestamp;
  }

  if (e.type === 'assistant') {
    const m = e.message ?? {};
    if (m.model !== '<synthetic>' && m.usage) {
      // Entries of one API response repeat its usage; count each message once.
      const counted = s.outputByMessage.get(m.id) ?? 0;
      const output = m.usage.output_tokens ?? 0;
      if (output > counted) {
        s.outputTokens += output - counted;
        s.outputByMessage.set(m.id, output);
      }
      const u = m.usage;
      s.contextTokens =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      s.model = m.model;
      if (e.effort) s.effort = e.effort;
    }
    for (const block of m.content ?? []) {
      if (block.type === 'text' && block.text) {
        const sameMessage = s.lastAssistant?.id === m.id;
        const text = sameMessage ? `${s.lastAssistant.text}\n\n${block.text}` : block.text;
        s.lastAssistant = { id: m.id, text: text.slice(0, MAX_TEXT), ts: e.timestamp };
      } else if (block.type === 'tool_use') {
        s.pendingTools.set(block.id, { name: block.name, detail: describeTool(block.name, block.input), ts: e.timestamp });
      }
    }
    return;
  }

  if (e.type === 'user') {
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) if (block.type === 'tool_result') s.pendingTools.delete(block.tool_use_id);
    }
    if (e.isMeta || e.isCompactSummary || content == null) return;
    const text = promptText(content);
    if (text) {
      s.lastPrompt = { text: text.slice(0, MAX_TEXT), ts: e.timestamp };
      s.pendingTools.clear(); // a new prompt supersedes any unanswered request
    }
  }
}

export function toView(s) {
  return {
    lastAssistant: s.lastAssistant && { text: s.lastAssistant.text, ts: s.lastAssistant.ts },
    lastPrompt: s.lastPrompt,
    lastActivityTs: s.lastActivityTs,
    pendingTools: [...s.pendingTools.values()],
    contextTokens: s.contextTokens,
    outputTokens: s.outputTokens,
    model: s.model,
    effort: s.effort,
    permissionMode: s.permissionMode,
  };
}

// Apply whatever complete lines were appended to the transcript since the last read.
export async function readNew(c) {
  const { size } = await stat(c.path);
  if (size < c.offset) Object.assign(c, { offset: 0, summary: newSummary() }); // file was rewritten
  if (size === c.offset) return;
  const fh = await open(c.path);
  try {
    const buf = Buffer.alloc(size - c.offset);
    await fh.read(buf, 0, buf.length, c.offset);
    const end = buf.lastIndexOf(0x0a); // stop at the last newline; a partial line waits for next time
    if (end === -1) return;
    c.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // one corrupt line shouldn't hide the rest of the conversation
      }
      applyEntry(c.summary, entry);
    }
  } finally {
    await fh.close();
  }
}

const cache = new Map(); // sessionId -> { path, offset, summary }

// Summary of a live session's transcript, or null if it has none yet.
export async function summarize(sessionId, cwd) {
  let c = cache.get(sessionId);
  if (!c) {
    const p = await findTranscript(sessionId, cwd);
    if (!p) return null;
    c = { path: p, offset: 0, summary: newSummary() };
    cache.set(sessionId, c);
  }
  await readNew(c);
  return toView(c.summary);
}

// Drop cached state for sessions that are no longer live.
export function forget(liveIds) {
  for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
}
