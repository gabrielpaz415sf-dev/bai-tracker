#!/bin/bash
# Installs the Cloudflare quick tunnel as a launchd user agent so the public
# link comes back after a reboot without being re-run by hand.
#
# The hostname is NOT stable across restarts — quick tunnels are assigned a new
# random name each time. `scripts/tunnel.sh` writes whatever the current one is
# to briefs/tunnel-url.txt; check there after a reboot.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bai-tracker.tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/briefs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/tunnel.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO/briefs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$REPO/briefs/tunnel.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  current URL: cat $REPO/briefs/tunnel-url.txt"
echo "  logs:        $REPO/briefs/tunnel.log"
echo "  stop:        launchctl bootout gui/$(id -u)/$LABEL"
