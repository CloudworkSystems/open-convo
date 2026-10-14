#!/bin/bash
# Load alarm: an alert-only tripwire for when the Mac is overloaded (for example
# by local models or several agent sessions at once).
#
# When the 1-minute load average reaches the threshold, it shows a macOS
# notification and logs the top CPU users. It writes nothing unless the alarm
# trips, so it never adds to the load it watches.
#
# Threshold: LOAD_ALARM_THRESHOLD if set, otherwise 1.5 x the number of CPU
# cores. Nothing installs or schedules this script; running it on a timer
# (launchd) is the owner's choice.

set -u

cores=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
threshold=${LOAD_ALARM_THRESHOLD:-$(( cores * 3 / 2 ))}
case "$threshold" in ''|*[!0-9]*) threshold=$(( cores * 3 / 2 )) ;; esac

log="$HOME/Library/Logs/True Convo/load-alarm.log"
load=$(sysctl -n vm.loadavg | awk '{print $2}')

if [ "${load%.*}" -ge "$threshold" ]; then
  mkdir -p "$(dirname "$log")"
  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') load=${load} (threshold ${threshold}, ${cores} cores)"
    ps aux | sort -rk3 | head -6 | awk '{printf "  %s%% pid=%s %s\n", $3, $2, $11}'
  } >> "$log"
  osascript -e "display notification \"1-minute load is ${load} on ${cores} cores. Check heavy sessions or local models before it snowballs.\" with title \"True Convo load alarm\" sound name \"Sosumi\"" 2>/dev/null
fi
