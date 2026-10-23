# Agent dashboard — plan

## Goal

One place to see and direct many Claude Code agents (~10 at once, across several
projects) instead of switching between terminal windows.

## Context

- All agents run on one Mac (they may SSH to other machines from there). No phone
  access is needed.
- A local web app, usable as a Chrome app window.
- Wanted: user-defined grouping by project, a "needs you" triage view, and
  diagnostics (wait time, the agent's last message/question, context fill, usage).
- Agents often share a working directory, so groups can't come from the cwd.
  Groups are explicit (see "Group identity").
- **Don't disturb running sessions.** Agents run for a long time. Experiments use
  throwaway sessions (`dash-test-*`, Haiku) that are removed afterwards.

## Architecture principles

- **The dashboard displays and connects; it never owns the agents.** Agents are
  ordinary Claude Code sessions. If the dashboard dies they keep running and
  `claude agents` still works. Don't rebuild this on the Agent SDK.
- **Local only.** Bind 127.0.0.1, reject foreign `Host` headers (DNS rebinding),
  require `Content-Type: application/json` on writes (blocks cross-site form posts),
  and require this page's `Origin` on terminal WebSockets. WebSockets skip CORS, and
  a terminal can type into an agent.
- **Undocumented formats stay contained.** Only `lib/transcripts.js` (transcripts)
  and `lib/jobs.js` (background job records) read Claude Code's internal files.
  Prefer `claude agents --json` wherever it has the answer; the docs call it the
  supported interface.
- **Clean environment for child `claude` processes** (`claudeEnv()` in
  `lib/agents.js`). If the dashboard was started from inside a Claude session,
  inherited `CLAUDE_CODE_*` markers make children turn off transcript saving and skip
  registering.
- No build step. Runtime dependencies: `ws`, `node-pty`, `@xterm/xterm`,
  `@xterm/addon-fit`, all served locally.

## Group identity

Groups store session ids: `data/board.json` → `groups: [{ name, sessions }]`. A
session id isn't stable for "the agent in that window":
- renaming keeps the id;
- `/clear` or `/resume` in a window keep the process (pid) but change the id;
- `/bg` keeps the name but changes both the id and the process.

`followAgents()` in `lib/board.js` records each session's last pid and name
(`board.seen`). An ungrouped live session takes over a grouped session that is no
longer live, matched by pid first, then by name.

## Data sources (verified on Claude Code 2.1.304)

- `claude agents --json --all` (~0.4 s): live sessions plus background sessions that
  finished or were stopped. Documented fields: `cwd`, `kind`
  (interactive|background), `startedAt` (ms), `sessionId`, `name`; background only:
  `id` (short id), `state` (working|blocked|done|failed|stopped); while the process
  is alive: `pid`, `status` (busy|waiting|idle); when waiting: `waitingFor`
  (permission prompt|input needed|sandbox request|worker request|dialog open). The
  UI maps `state` onto `status` when `status` is missing.
- Transcript: `~/.claude/projects/<cwd, non-alphanumerics → '-'>/<sessionId>.jsonl`.
  Up to ~30 MB, so it is read incrementally by byte offset.
  - `assistant` entries: `message.{id, model, content[], usage}` plus `effort`. One
    API response is split over several entries that share `message.id`, so count
    usage once per id. `model: '<synthetic>'` is not a real API call.
  - Context in use ≈ `input_tokens + cache_read_input_tokens +
    cache_creation_input_tokens` of the latest main-chain assistant entry. Sessions
    reach ~975k tokens, so the windows are 1M.
  - `user` entries: a real prompt is string content that is not `isMeta` and doesn't
    start with `<`. Tool results are list content with `tool_result` blocks.
  - `permission-mode` entries: `permissionMode` (e.g. auto).
  - `cost-state` entries carry `totalCostUSD` but are written rarely, so they can't
    give a live cost.
- Background jobs: `~/.claude/jobs/<id>/state.json` → `needs` (a one-line summary
  of what a blocked session asks), shown on blocked cards. The docs say this file "is
  not a stable interface"; it degrades to null.
- `~/.claude.json` → `theme`, used to pick light or dark terminal colors.

## Verified behavior (2026-10-20, throwaway sessions only)

- `claude attach <id>` works in a pty (node-pty), and typed input reaches the agent.
  Killing the client (SIGHUP or SIGKILL) leaves the session running. Two clients can
  attach at once and both mirror it.
- Inside attach, `←` on an empty prompt or `/exit` switches the client to agent view;
  double Ctrl+C there exits the client (documented).
- `/bg` (or `/background`) in an interactive window backgrounds it at once.
  Mid-response work continues. Name, conversation and permission mode are kept; the
  session id and process change.
- Exit, then `claude --bg --resume <id>`: keeps the id and name, but the permission
  mode falls back to the settings `defaultMode` (e.g. plan). `/bg` is the better
  route.
- Background sessions left unattached and idle for ~1 h are stopped and restart on
  the next attach (documented). An open terminal tile keeps its session attached.
- node-pty 1.1.0's prebuilt `spawn-helper` loses its execute bit on install;
  `postinstall` restores it.

## Phases

1. **Read-only board** ✓ done 2026-10-19
   - "Needs you" inbox: blocked first, then idle ("your turn"), longest wait first.
     Dismiss hides an agent until it has new activity.
   - Project groups: user-defined; drag agents between groups; create, rename and
     delete groups.
   - Per agent: status and how long, the agent's last message, a pending tool
     request, your last prompt, context fill, output tokens, model and effort, kind,
     pid and cwd.
2. **Live terminals** ✓ done 2026-10-20
   - Clicking a background agent opens it as a terminal tile (xterm.js ↔ WebSocket ↔
     `claude attach` in a pty). Up to 4 tiles; opening a 5th replaces the least
     recently used one. The board becomes a sidebar ("workspace"); the top bar
     toggles between Overview and Terminals.
   - Closing a tile, a reload or a server restart only ends the attach client.
     Open tiles come back after a reload (localStorage).
   - Interactive agents open their details, which explain `/bg`.
2b. **Standalone window** ✓ done 2026-10-23 (option 1 of the "standalone app"
   discussion; Electron is the upgrade path for native notifications or a global
   hotkey).
   - The server runs as a LaunchAgent (`scripts/service.sh`, label
     `local.agent-dashboard`): it starts at login and restarts if it crashes. It
     carries the PATH of the shell that ran `install`. Log:
     `~/Library/Logs/agent-dashboard.log`.
   - A web manifest and icons make it installable as a Chrome app (its own window,
     Dock icon and Cmd+Tab entry). Chrome reported no installability errors.
   - Dock badge = number of agents that need you (`navigator.setAppBadge`).
3. **Launch and stop** ← next. Start a new background agent into a project
   (`claude --bg -n <name>` in a chosen cwd); stop and remove; desktop notification
   naming the agent that needs you.

## Open questions / later

- Dollar cost needs a price table or a live source; the board shows tokens.
- The drawer shows messages as plain text (raw markdown). Snippets strip `**` and
  backticks.
- The context bar assumes a 1M window for every session (`CONTEXT_WINDOW` in
  `public/app.js`).
- In a tile, `←` on an empty prompt turns the tile into Claude's agent view; the
  header still names the original agent.

## Status log

- 2026-10-19: discussion done, repo created, phase 1 started.
- 2026-10-19: phase 1 done. Board with a "needs you" inbox, project groups, a detail
  drawer and dismiss. Verified with `npm test` and a one-off headless-Chrome CDP
  script (15 checks). Fixed a drag bug: the dragged row is replaced on drop, so
  `dragend` never fires and polling would stall.
- 2026-10-20: phase 2 done. Terminal tiles over `claude attach`; groups keyed by
  session id and following /clear, /resume and /bg; child env cleaned; `--all`
  listing. Verified with 14 unit tests, WebSocket access checks (foreign or missing
  Origin, unknown and malformed ids → 403) and a CDP browser script (15 checks:
  open, type, second tile, Escape stays in the terminal, close, reload restore, /bg
  help, no leftover attach clients), all on throwaway sessions that were then removed.
- 2026-10-23: standalone window. LaunchAgent service, web manifest, icon and Dock
  badge. Verified that the service serves everything, that attaching works under
  the service's environment (throwaway session, removed), and that Chrome's
  installability check is clean. Noted: Claude's background supervisor isn't always
  running; `claude --bg` starts it ("Starting background service…").
