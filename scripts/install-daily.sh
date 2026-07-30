#!/bin/bash
# Installs the weekday daily-brief job as a launchd user agent.
#
# 17:45 local is after the 16:00 ET close plus enough slack for the issuer to
# publish and for late prints to settle. A *user* agent (not a system daemon)
# is required: the job posts a macOS notification, which needs a GUI session.
#
# Idempotent: safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bai-tracker.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/briefs"

{
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/daily.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <array>
PLIST_EOF
  for wd in 1 2 3 4 5; do
    echo "    <dict><key>Weekday</key><integer>$wd</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>45</integer></dict>"
  done
  cat <<PLIST_EOF
  </array>
  <key>StandardOutPath</key><string>$REPO/briefs/launchd.log</string>
  <key>StandardErrorPath</key><string>$REPO/briefs/launchd.log</string>
</dict>
</plist>
PLIST_EOF
} > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL — weekdays 17:45 local"
echo "  briefs: $REPO/briefs/YYYY-MM-DD.md"
echo "  run now: launchctl kickstart -k gui/$(id -u)/$LABEL"
