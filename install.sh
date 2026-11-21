#!/bin/bash
# Mind installer for macOS. Safe to run again: it updates the code and keeps your data.
#   curl -fsSL https://raw.githubusercontent.com/MartinLiteAndFog/mind/main/install.sh | bash
# Options (env): MIND_HOME (default ~/Mind) · MIND_PORT (default 5180) · MIND_NO_AUTOSTART=1 · MIND_NO_OPEN=1
# Testing: MIND_TARBALL=<local .tar.gz> · MIND_FORCE_NODE=1 (always use the private Node copy)
set -euo pipefail

REPO="${MIND_REPO:-MartinLiteAndFog/mind}"
MIND_HOME="${MIND_HOME:-$HOME/Mind}"
PORT="${MIND_PORT:-5180}"
APP="$MIND_HOME/app"
DATA="$MIND_HOME/data"
NODE_VERSION="v22.23.5"
say() { printf '\033[1m[mind]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[mind] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Mind runs on macOS only."
mkdir -p "$MIND_HOME" "$DATA" "$HOME/.config/mind"
echo "$MIND_HOME" > "$HOME/.config/mind/home"

# 1) Node.js (>= 20). Use the system one if present, otherwise a private copy inside ~/Mind/runtime (no admin rights needed).
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
export PATH="$MIND_HOME/runtime/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -n "${MIND_FORCE_NODE:-}" ] || ! node_ok; then
  ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
  say "Downloading Node.js $NODE_VERSION ($ARCH) …"
  rm -rf "$MIND_HOME/runtime/node" && mkdir -p "$MIND_HOME/runtime/node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$ARCH.tar.gz" | tar -xz -C "$MIND_HOME/runtime/node" --strip-components 1
  node_ok || fail "Node.js could not be installed."
fi
say "Node $(node -v)"

# 2) Code: prebuilt release from GitHub (no build step). Data in ~/Mind/data stays untouched.
say "Downloading Mind …"
TMP=$(mktemp -d)
if [ -n "${MIND_TARBALL:-}" ]; then tar -xzf "$MIND_TARBALL" -C "$TMP" --strip-components 1   # local test package
else curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP" --strip-components 1; fi
[ -f "$TMP/dist/index.html" ] || fail "Download incomplete (no prebuilt app)."
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$TMP" "$APP"
rm -rf "$APP.old"
cd "$APP"
say "Installing runtime packages …"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

# 3) AI subscriptions: Claude Code (claude) and optionally Codex (codex). Bots only use subscription logins, never API keys.
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  say "Installing Claude Code (official installer) …"
  curl -fsSL https://claude.ai/install.sh | bash || say "Claude Code could not be installed automatically – see https://claude.com/claude-code"
fi
CLAUDE_BIN=$(command -v claude || echo "$HOME/.local/bin/claude")
if [ -x "$CLAUDE_BIN" ] && ! env -u ANTHROPIC_API_KEY "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  say "Claude Code is not logged in yet. Run once in Terminal:  claude auth login   (choose your claude.ai account)"
fi
command -v codex >/dev/null 2>&1 && say "Codex found (ChatGPT subscription can work too)." || say "Codex not found – optional: npm i -g @openai/codex && codex login"
[ -d "/Applications/Google Chrome.app" ] || say "Google Chrome not found – install it for the Mind window and PDF export: https://www.google.com/chrome/"

# Owner tool for setup and scripting: ~/Mind/bin/mind <dg command>  (acts as the owner)
mkdir -p "$MIND_HOME/bin"
printf '#!/bin/sh\nPATH="%s/runtime/node/bin:$PATH" DG_NODE=owner DG_MANDATE=owner exec "%s/data/bin/dg" "$@"\n' "$MIND_HOME" "$MIND_HOME" > "$MIND_HOME/bin/mind"
chmod +x "$MIND_HOME/bin/mind"

# 4) Mind.app on the Desktop (starts the server if needed and opens Mind in its own window)
DEST="$HOME/Desktop/Mind.app"
rm -rf "$DEST"; mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp "$APP/mac/mind.icns" "$DEST/Contents/Resources/mind.icns"
cp "$APP/mac/mind-launch.sh" "$DEST/Contents/MacOS/mind"; chmod +x "$DEST/Contents/MacOS/mind"
cat > "$DEST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Mind</string><key>CFBundleDisplayName</key><string>Mind</string>
  <key>CFBundleIdentifier</key><string>app.mind.launcher</string><key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>mind</string>
  <key>CFBundleIconFile</key><string>mind</string><key>LSUIElement</key><true/>
</dict></plist>
PLIST
touch "$DEST"

# 5) Autostart at login (server only; checks every 5 minutes)
if [ -z "${MIND_NO_AUTOSTART:-}" ]; then
  PL="$HOME/Library/LaunchAgents/app.mind.server.plist"; mkdir -p "$(dirname "$PL")"
  cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.mind.server</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$APP/mac/mind-launch.sh</string><string>--server</string></array>
  <key>EnvironmentVariables</key><dict><key>MIND_HOME</key><string>$MIND_HOME</string><key>MIND_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$MIND_HOME/autostart.log</string><key>StandardErrorPath</key><string>$MIND_HOME/autostart.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/app.mind.server" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PL" 2>/dev/null || true
fi

# 6) Start (or restart after an update) and check
pkill -f "standalone.ts --port $PORT" 2>/dev/null || true
for i in $(seq 1 20); do lsof -nP -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
MIND_HOME="$MIND_HOME" MIND_PORT="$PORT" /bin/zsh "$APP/mac/mind-launch.sh" --server
curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health" || fail "Mind did not start – see $MIND_HOME/mind.log"
[ -z "${MIND_NO_OPEN:-}" ] && open "$DEST" || true

say "Mind is running: http://127.0.0.1:$PORT  ·  data: $DATA"
say "Setup tool:  $MIND_HOME/bin/mind <command>   (e.g. $MIND_HOME/bin/mind tree)"
say "Next: continue with the setup interview described in $APP/INSTALL-AGENT.md (step 3)."
