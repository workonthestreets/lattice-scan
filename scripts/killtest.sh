#!/bin/sh
# Crash test: kill -9 the running scanner mid-tail, restart, prove it resumed from the cursor
# (re-read 0 contracts) and that a self-check finds 0 differences.
set -e
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
PID=$(cat scanner.pid 2>/dev/null || pgrep -f "src/index.mjs --run" | head -1)
echo "before: $(curl -s localhost:$PORT/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log("cursor",h.cursor_offset,"contracts",h.contracts_total,"events",h.events_indexed)})')"
echo "kill -9 $PID"
kill -9 "$PID"
sleep 1
nohup node --no-warnings=ExperimentalWarning src/index.mjs --run > scanner.log 2>&1 &
echo $! > scanner.pid
sleep 4
grep -m1 "resume:" scanner.log
echo "after:  $(curl -s localhost:$PORT/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log("cursor",h.cursor_offset,"contracts",h.contracts_total,"events",h.events_indexed,"tail",h.tail.connected)})')"
echo "self-check:"
curl -s -X POST localhost:$PORT/verify/run | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`offset ${r.at_offset}: ledger ${r.ledger_count} vs mirror ${r.mirror_count}, missing ${r.only_in_ledger}, phantom ${r.only_in_mirror}, ${r.duration_ms} ms`)})'
