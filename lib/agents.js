import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Environment for child `claude` processes, minus the markers a parent Claude Code
// session sets. If the dashboard was started from inside a session, children would
// otherwise treat themselves as its subprocesses (no transcript, borrowed session id).
export function claudeEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k)),
  );
}

// Every live Claude Code session on this machine, interactive and background.
// --all keeps background sessions that finished or were stopped after idling
// (they restart on the next attach), which the plain listing drops.
export async function listAgents() {
  const { stdout } = await run('claude', ['agents', '--json', '--all'], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    env: claudeEnv(),
  });
  return JSON.parse(stdout);
}

// 'light' or 'dark', following Claude Code's own theme so embedded terminals match it.
export function claudeTheme() {
  try {
    const { theme } = JSON.parse(readFileSync(path.join(homedir(), '.claude.json'), 'utf8'));
    return String(theme ?? 'dark').startsWith('light') ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
