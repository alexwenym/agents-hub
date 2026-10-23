#!/bin/sh
# Run the dashboard server as a macOS LaunchAgent: it starts at login and restarts
# if it crashes. Usage: scripts/service.sh install|uninstall|restart|status
#
# `install` records the PATH of the shell it runs in, so `claude` and anything it
# starts see the same tools as in your terminal. Re-run it after moving node or
# claude. The SSH agent socket comes from launchd itself.
set -eu

LABEL=local.agent-dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agent-dashboard.log"
DIR=$(cd "$(dirname "$0")/.." && pwd)
DOMAIN="gui/$(id -u)"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "${1:-}" in
install)
  NODE=$(command -v node)
  command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }
  # drop the node_modules/.bin entries npm adds when this runs as an npm script
  SERVICE_PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'node_modules/.bin' | paste -sd: -)
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$DIR/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$SERVICE_PATH")</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed. Dashboard: http://127.0.0.1:7420  Log: $LOG"
  ;;
uninstall)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled. The dashboard no longer starts at login."
  ;;
restart)
  launchctl kickstart -k "$DOMAIN/$LABEL"
  ;;
status)
  launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) =' || echo "not installed"
  ;;
*)
  echo "usage: $0 install|uninstall|restart|status" >&2
  exit 2
  ;;
esac
