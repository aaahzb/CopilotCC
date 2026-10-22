#!/bin/bash
# 开发态 mac（Apple Silicon）托盘助手编译：bridge/tray/main.swift → bridge/tray/bin/tray_darwin_release
# （systray2 自带的 darwin 托盘是 x86_64 单架构，arm64 Mac 上 npm run tray 前须先跑本脚本一次；
#   tray.ts 的候选顺序会优先认本地产物。发布态不走这里——CI 的 build-mac-app.sh 现场编译进 .app）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tray/bin"
swiftc -O -target arm64-apple-macos12.0 -o "$ROOT/tray/bin/tray_darwin_release" "$ROOT/tray/main.swift"
echo "✔ $ROOT/tray/bin/tray_darwin_release"
