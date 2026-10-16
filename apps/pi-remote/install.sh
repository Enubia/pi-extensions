#!/bin/sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
bin="$HOME/.local/bin"

chmod +x "$here/pi-remote.ts"
mkdir -p "$bin"
ln -sf "$here/pi-remote.ts" "$bin/pi-remote"
echo "Linked $bin/pi-remote -> $here/pi-remote.ts"
