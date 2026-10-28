#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/npm.sh run dev -- --port 5173 &
SERVER_PID=$!

sleep 2
open "http://localhost:5173/"

wait "$SERVER_PID"
