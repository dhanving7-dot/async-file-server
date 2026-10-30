#!/usr/bin/env bash
# Starts everything from a Linux shell (native Linux, or WSL with Node.js
# installed inside it). Ctrl+C stops all three processes.
#
#   ./scripts/start-all.sh                 # production dashboard on :7070
#   IO_DELAY_MS=300 ./scripts/start-all.sh # visible queueing for demos
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IO_DELAY_MS="${IO_DELAY_MS:-0}"

make -C "$ROOT/backend"

[ -d "$ROOT/bridge/node_modules" ] || (cd "$ROOT/bridge" && npm install --no-fund --no-audit)
[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm install --no-fund --no-audit)
[ -f "$ROOT/frontend/dist/index.html" ] || (cd "$ROOT/frontend" && npm run build)

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -INT "$pid" 2>/dev/null || true; done
  wait
}
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && exec ./server --io-delay-ms "$IO_DELAY_MS") &
pids+=($!)
(cd "$ROOT/bridge" && exec node src/index.js) &
pids+=($!)

echo
echo "Dashboard: http://127.0.0.1:7070   (Ctrl+C to stop)"
wait
