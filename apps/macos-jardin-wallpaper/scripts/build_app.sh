#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V3_PUBLIC="$(cd "$ROOT/../v3-jardin-oil/public" && pwd)"
APP_DIR="$ROOT/build/JardinWallpaper.app"

echo "==> Assembling pure native $APP_DIR..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/assets"

cp "$ROOT/macos/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$V3_PUBLIC/bg-foliage.webp" "$APP_DIR/Contents/Resources/assets/"
cp "$V3_PUBLIC/species.json" "$APP_DIR/Contents/Resources/assets/"
cp -R "$V3_PUBLIC/sprites" "$APP_DIR/Contents/Resources/assets/"

echo "==> Compiling pure native Swift + CoreAnimation wallpaper..."
swiftc -O \
  -framework AppKit \
  -framework QuartzCore \
  -framework CoreGraphics \
  -framework ImageIO \
  "$ROOT/macos/JardinWallpaper.swift" \
  -o "$APP_DIR/Contents/MacOS/JardinWallpaper"

echo "==> Ad-hoc signing..."
codesign --force --deep --sign - "$APP_DIR"

echo "==> Built successfully:"
du -sh "$APP_DIR"
