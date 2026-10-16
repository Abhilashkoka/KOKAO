#!/usr/bin/env bash
# One command to update and (re)start the KOKAO preview on Replit.
#
#   bash scripts/kokao-update.sh            pull feat/quick-create-v2, rebuild, restart
#   bash scripts/kokao-update.sh <branch>   same, from another branch
#   bash scripts/kokao-update.sh --no-pull  just rebuild and restart (e.g. after Replit slept)
#
# It never touches the database. The API runs in the background (log in
# /tmp/api.log), so closing the Shell tab does not stop it.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

WEB_PORT=18493
API_PORT=8080
BRANCH="feat/quick-create-v2"
PULL=1
case "${1:-}" in
  --no-pull) PULL=0 ;;
  "") ;;
  *) BRANCH="$1" ;;
esac

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$1"; exit 1; }
up() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" != "000" ]; }

if [ "$PULL" = 1 ]; then
  step "Pulling $BRANCH"
  git pull --no-rebase --no-edit origin "$BRANCH" || fail "Pull failed. Paste the message above to Claude."
fi

step "Installing packages"
pnpm install >/tmp/kokao-install.log 2>&1 || { tail -20 /tmp/kokao-install.log; fail "pnpm install failed."; }

step "Building the web app"
if up "http://localhost:$WEB_PORT/"; then
  # The preview is already serving: rebuild only (the running preview picks
  # up the new files). The script's "port in use" exit after the build is expected.
  (cd artifacts/socialforge && PORT=$WEB_PORT BASE_PATH=/ pnpm run dev >/tmp/kokao-web.log 2>&1)
  grep -q "built in" /tmp/kokao-web.log || { tail -30 /tmp/kokao-web.log; fail "Web build failed."; }
else
  (cd artifacts/socialforge && PORT=$WEB_PORT BASE_PATH=/ nohup pnpm run dev >/tmp/kokao-web.log 2>&1 &)
  for _ in $(seq 1 90); do up "http://localhost:$WEB_PORT/" && break; sleep 2; done
  up "http://localhost:$WEB_PORT/" || { tail -30 /tmp/kokao-web.log; fail "Web app did not start."; }
fi
echo "  web app ready"

step "Restarting the API server"
pkill -f "api-server/dist/index.mjs" 2>/dev/null
pkill -f "node --enable-source-maps ./dist/index.mjs" 2>/dev/null
for _ in $(seq 1 15); do up "http://localhost:$API_PORT/api/healthz" || break; sleep 1; done
nohup env PORT=$API_PORT pnpm --filter @workspace/api-server run dev >/tmp/api.log 2>&1 &
for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/api/healthz")" = "200" ] && break
  sleep 2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/api/healthz")" = "200" ] \
  || { tail -30 /tmp/api.log; fail "API server did not start."; }
echo "  API ready"

printf '\n\033[1;32m✔ KOKAO is updated and running.\033[0m Hard-refresh the app (Ctrl+Shift+R).\n'
printf '  API log: tail -f /tmp/api.log\n'
