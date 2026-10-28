#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-v24.15.0}"
NODE_BIN="$ROOT_DIR/.tools/node/node-$NODE_VERSION-darwin-arm64/bin"

if [[ ! -x "$NODE_BIN/npm" ]]; then
  "$ROOT_DIR/scripts/setup-node.sh"
fi

PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" "$@"
