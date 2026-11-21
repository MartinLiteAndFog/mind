#!/bin/zsh
# Restart the Mind server (after code changes): rebuilds if needed and starts the standalone server.
# Does not wait for running bot runs – use deploy-live.sh for that.
[ -z "$MIND_HOME" ] && [ -f "$HOME/.config/mind/home" ] && MIND_HOME="$(head -1 "$HOME/.config/mind/home")"
MIND_HOME="${MIND_HOME:-$HOME/Mind}"
PORT="${MIND_PORT:-5180}"
HERE="${0:A:h}"
pids=$( { lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null; pgrep -f "standalone.ts --port $PORT" 2>/dev/null; pgrep -f "vite --port $PORT" 2>/dev/null; } | sort -u | tr '\n' ' ')
# Remember tunnel processes started by the old server and stop them too (otherwise they are left orphaned)
kids=""; for p in ${=pids}; do kids="$kids $(pgrep -P $p -f cloudflared 2>/dev/null)"; done
[ -n "$pids" ] && kill ${=pids} 2>/dev/null
for i in {1..20}; do lsof -nP -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
[ -n "${kids// /}" ] && kill ${=kids} 2>/dev/null
if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  echo "Old Mind server is still running (PIDs: ${pids:-none found}) – restart aborted, new code is NOT active"; exit 1
fi
"$HERE/mind-launch.sh" --server
curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && echo "Mind is running again on port $PORT" || { echo "Mind did not start – see $MIND_HOME/mind.log"; exit 1; }
