#!/bin/sh
set -eu
cd "$(dirname "$0")"
cargo build --locked -j 4
bundle="dist/SheetSage Studio.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp target/debug/sheetsage-studio "$bundle/Contents/MacOS/sheetsage-studio"
cp app-bundle/Info.plist "$bundle/Contents/Info.plist"
cp icons/icon.png "$bundle/Contents/Resources/AppIcon.png"
codesign --force --sign - "$bundle"
printf 'Built: %s/%s\n' "$PWD" "$bundle"
