#!/bin/bash
# Swaps the public link from the Cloudflare quick tunnel to ngrok's reserved
# hostname, and installs it as a launchd agent so it survives reboots.
#
# The two cannot both own briefs/tunnel-url.txt, so the Cloudflare agent is
# unloaded rather than left running — a stale writer would keep overwriting the
# stable URL with an expiring one.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bai-tracker.ngrok"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/briefs"

echo "Stopping the Cloudflare quick tunnel (it would fight over tunnel-url.txt)…"
launchctl bootout "gui/$(id -u)/com.bai-tracker.tunnel" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/ngrok.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO/briefs/ngrok.log</string>
  <key>StandardErrorPath</key><string>$REPO/briefs/ngrok.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  URL:   $(cat "$REPO/briefs/tunnel-url.txt" 2>/dev/null || echo 'starting…')"
echo "  logs:  $REPO/briefs/ngrok.log"
echo "  stop:  launchctl bootout gui/$(id -u)/$LABEL"
