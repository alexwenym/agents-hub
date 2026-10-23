# AgentsHub

One window for all your Claude Code sessions. It shows which agents need you, lets you group them by project, and lets you type into background agents in live terminals.

**Requires:** macOS, Node 20+ (tested on 26), Claude Code 2.1.304+, Chrome.

## Install

```sh
git clone <repo-url> agentshub && cd agentshub
npm install
npm run service:install   # starts the server now and at every login
```

Run the last line from your usual terminal, because the service keeps that shell's PATH.

Then open http://127.0.0.1:7420 in Chrome and choose ⋮ → **Cast, save, and share → Install page as app**.

## Use

- Every running Claude Code session appears, with its status, last message, wait time and context use.
- To type into a session from AgentsHub, run `/bg` in its terminal (it keeps working), then click it here.
- Closing a terminal tile only detaches it. AgentsHub never stops or messages an agent on its own.

## Manage

```sh
npm run service:status    # or service:restart, service:uninstall
```

- Log: `~/Library/Logs/agent-dashboard.log`
- Groups: `data/board.json`
- The server listens on 127.0.0.1 only.
