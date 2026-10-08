#!/bin/sh
set -eu

cd "$(dirname "$0")"
swift build -c release

label="dev.enubia.pi-attention-bar"
app="$HOME/Applications/Pi Attention.app"
agent="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

launchctl bootout "$domain/$label" 2>/dev/null || true

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$(dirname "$agent")"
cp .build/release/PiAttentionBar "$app/Contents/MacOS/PiAttentionBar"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$label</string>
  <key>CFBundleName</key><string>Pi Attention</string>
  <key>CFBundleExecutable</key><string>PiAttentionBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
codesign --force --sign - "$app"

cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$app/Contents/MacOS/PiAttentionBar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
EOF
launchctl bootstrap "$domain" "$agent"
echo "Installed $app and started $label"
