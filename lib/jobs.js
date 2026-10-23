// Background-session job records (~/.claude/jobs/<id>/state.json). The format is
// undocumented, like transcripts; only `needs`, a one-line summary of what a
// blocked session is asking, is used.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const JOBS_DIR = path.join(homedir(), '.claude', 'jobs');

export async function jobNeeds(id) {
  try {
    const job = JSON.parse(await readFile(path.join(JOBS_DIR, id, 'state.json'), 'utf8'));
    return job.needs ?? null;
  } catch (e) {
    // missing, or caught mid-write by Claude Code: the next poll will retry
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
    throw e;
  }
}
