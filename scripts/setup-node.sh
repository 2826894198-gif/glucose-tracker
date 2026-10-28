#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.15.0}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT_DIR/.tools"
NODE_DIR="$TOOLS_DIR/node/node-$NODE_VERSION-darwin-arm64"
ARCHIVE="node-$NODE_VERSION-darwin-arm64.tar.xz"
URL="https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This helper currently supports Apple Silicon macOS only."
  exit 1
fi

if [[ -x "$NODE_DIR/bin/npm" ]]; then
  "$NODE_DIR/bin/node" --version
  "$NODE_DIR/bin/npm" --version
  exit 0
fi

mkdir -p "$TOOLS_DIR/downloads" "$TOOLS_DIR/node"
curl -fL "$URL" -o "$TOOLS_DIR/downloads/$ARCHIVE"
tar -xJf "$TOOLS_DIR/downloads/$ARCHIVE" -C "$TOOLS_DIR/node"

"$NODE_DIR/bin/node" --version
"$NODE_DIR/bin/npm" --version
