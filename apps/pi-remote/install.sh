#!/bin/sh
set -eu

here="$(cd "$(dirname "$0")" && pwd -P)"
bin="$HOME/.local/bin"

chmod +x "$here/pi-remote.ts"
mkdir -p "$bin"
ln -sfn "$here/pi-remote.ts" "$bin/pi-remote"
echo "Linked $bin/pi-remote -> $here/pi-remote.ts"
