#!/bin/sh
set -eu

label="dev.enubia.pi-attention-bar"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"
rm -rf "$HOME/Applications/Pi Attention.app"
echo "Removed $label"
