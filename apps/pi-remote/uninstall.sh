#!/bin/sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
link="$HOME/.local/bin/pi-remote"

if [ -L "$link" ] && [ "$(readlink "$link")" = "$here/pi-remote.ts" ]; then
	rm -f "$link"
	echo "Removed $link"
else
	echo "Nothing to remove: $link is not a link to $here/pi-remote.ts"
fi
