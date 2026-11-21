#!/bin/zsh
# Mind – start without a terminal. Code: $MIND_HOME/app · Data: $MIND_HOME/data · Log: $MIND_HOME/mind.log
# (also copied into Mind.app, so it cannot rely on its own location)
[ -z "$MIND_HOME" ] && [ -f "$HOME/.config/mind/home" ] && MIND_HOME="$(head -1 "$HOME/.config/mind/home")"
MIND_HOME="${MIND_HOME:-$HOME/Mind}"
APP="$MIND_HOME/app"
[ -d "$APP/apps/decision-graph" ] && DIR="$APP/apps/decision-graph" || DIR="$APP"
PORT="${MIND_PORT:-5180}"
URL="http://127.0.0.1:$PORT/"
LOG="$MIND_HOME/mind.log"
export PATH="$MIND_HOME/runtime/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! curl -s -o /dev/null "${URL}api/health"; then
  # No inherited credentials: bots only use subscription logins.
  for v in ${(k)parameters[(I)ANTHROPIC_*]} ${(k)parameters[(I)CLAUDE*]} OPENAI_API_KEY; do unset $v; done
  cd "$DIR" || { osascript -e "display alert \"Mind\" message \"App folder missing: $APP\""; exit 1; }
  # Developer checkout (git): pull updates and install packages. Release package: already installed and prebuilt.
  if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only -q >>"$LOG" 2>&1 || true; npm install --silent >>"$LOG" 2>&1; fi
  # Built app instead of the dev server: only rebuild if the code has changed since the last build (needs the build tools).
  if [ -x node_modules/.bin/vite ] && { [ ! -f dist/.built ] || [ -n "$(find src public index.html 3d.html vite.config.ts package.json -newer dist/.built -print -quit 2>/dev/null)" ]; }; then
    if npm run build >>"$LOG" 2>&1; then touch dist/.built
    elif [ -f dist/index.html ]; then echo "[mind] Build failed – starting with the last working state" >>"$LOG"
    else osascript -e 'display alert "Mind" message "The app could not be built. Details: mind.log"'; exit 1; fi
  fi
  DECISION_GRAPH_DATA="$MIND_HOME/data" nohup npx tsx src/server/standalone.ts --port $PORT >>"$LOG" 2>&1 &
  for i in {1..40}; do curl -s -o /dev/null "${URL}api/health" && break; sleep 0.5; done
fi

# Autostart (--server): server only, no window
[ "$1" = "--server" ] && exit 0

# Prefer the installed Mind app (installed as an app by Chrome: own Dock icon)
PWA="$(ls -d "$HOME/Applications/Chrome Apps.localized/Mind.app" "$HOME/Applications/Chrome Apps/Mind.app" 2>/dev/null | head -1)"
if [ -n "$PWA" ]; then
  open "$PWA"
# otherwise its own app window (Chrome app mode: no tabs, microphone allowed); otherwise Safari.
elif [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --class=Mind
else
  open -a Safari "$URL"
fi
