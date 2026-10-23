# agent_dashboard

A local web dashboard (AgentsHub) for watching and directing all of the user's
Claude Code agents.
**Read PLAN.md first.** It has the goals, design decisions, the verified data formats
and Claude Code behavior, and which phase is in progress.

- The server runs as a macOS LaunchAgent and starts at login (`npm run
  service:install | service:uninstall | service:restart | service:status`). After
  changing server code, run `npm run service:restart`. It's used as an installed
  Chrome app called **AgentsHub** at http://127.0.0.1:7420. Page files are read
  fresh on every request, so UI-only changes need just a reload.
- Develop alongside it on another port: `PORT=7421 npm run dev`.
- Test: `npm test`

## Layout

- `server.js`: HTTP server, JSON API, static files and the terminal WebSocket
  upgrade. Binds 127.0.0.1 only.
- `lib/agents.js`: wraps `claude agents --json --all`. `claudeEnv()` is the clean
  environment every child `claude` process must use.
- `lib/terminals.js`: WebSocket ↔ `claude attach <id>` in a node-pty, one client per
  socket.
- `lib/transcripts.js`: the only code that reads Claude Code's undocumented
  transcript format. It parses incrementally by byte offset.
- `lib/jobs.js`: reads `needs` (what a blocked background session is asking) from
  its job record.
- `lib/board.js`: the dashboard's own state (project groups keyed by session id,
  dismissals, last-seen pid and name), stored in `data/board.json` (gitignored).
- `public/`: vanilla JS/CSS UI with no build step. `terminals.js` manages the xterm
  tiles; `manifest.webmanifest` and the icons make it installable as an app
  (regenerate the PNGs from `icon.svg` if the icon changes).
- `scripts/service.sh`: installs and controls the LaunchAgent.

## Rules

- **Never disturb the user's running sessions.** Don't attach to, stop, respawn or type
  into them while testing. Use throwaway `claude --bg -n dash-test-N --model haiku`
  sessions and remove them afterwards (`claude stop` then `claude rm`, after checking
  the name).
- The dashboard never stops, kills or messages an agent unless the user explicitly
  acts.
- The repo is meant to be shareable. Keep personal or machine-specific details
  (names, hostnames, real session names, home paths) out of tracked files, code
  comments, test fixtures and commit messages.
- Keep the localhost protections in `server.js` (Host check, JSON-only writes,
  Origin check on WebSockets).
- At each milestone, add a line to PLAN.md's status log and commit.
