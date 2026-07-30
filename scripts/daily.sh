#!/bin/bash
# Runs every weekday evening: archives the day's holdings file (builds the
# manager-activity history) and writes the daily brief to briefs/YYYY-MM-DD.md.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
npm run brief >> "$HOME/bai-tracker/briefs/run.log" 2>&1
