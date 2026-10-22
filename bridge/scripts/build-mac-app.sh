#!/bin/bash
# CopilotCC Bridge · macOS .app 组装 + ad-hoc 预签 + dmg 打包（仅 macOS；release CI 的 macos runner 调用，本地 Mac 也可跑）
# 输入：bridge/dist/ccc-bridge-darwin-arm64/{ccc-bridge, traybin/tray_darwin_release}（先跑 node scripts/build-exe.mjs darwin）
# 产物：仓库根 ccc-bridge-darwin-arm64.dmg（CopilotCC Bridge.app + Applications 快捷方式 + 首次使用脚本）
# 说明：免费分发没有 Apple Developer ID，只能 ad-hoc 签名（codesign -s -）；浏览器下载的隔离标记下
#       macOS 仍报"已损坏"，用户侧须随 dmg 的「首次使用」脚本跑一次解除隔离（一次性）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # bridge/ 目录
REPO="$(cd "$ROOT/.." && pwd)"            # 仓库根
SRC="$ROOT/dist/ccc-bridge-darwin-arm64"
APP="CopilotCC Bridge.app"
BUNDLE="$ROOT/dist/$APP"
STAGE="$ROOT/dist/dmg-stage"
VER="$(node -p "require('$ROOT/package.json').version")"

# 1. 组装 .app 骨架：主程序与托盘组件都放在 Contents/MacOS（tray.ts 按 exe 旁 traybin/ 解析，零改动兼容）
rm -rf "$BUNDLE" "$STAGE"
mkdir -p "$BUNDLE/Contents/MacOS/traybin" "$BUNDLE/Contents/Resources"
cp "$SRC/ccc-bridge" "$BUNDLE/Contents/MacOS/ccc-bridge"
cp "$SRC/traybin/tray_darwin_release" "$BUNDLE/Contents/MacOS/traybin/tray_darwin_release"
chmod +x "$BUNDLE/Contents/MacOS/ccc-bridge" "$BUNDLE/Contents/MacOS/traybin/tray_darwin_release"

# 2. Info.plist（LSUIElement：菜单栏常驻程序，不占 Dock）
cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>CopilotCC Bridge</string>
	<key>CFBundleDisplayName</key><string>CopilotCC Bridge</string>
	<key>CFBundleIdentifier</key><string>com.copilotcc.bridge</string>
	<key>CFBundleExecutable</key><string>ccc-bridge</string>
	<key>CFBundleIconFile</key><string>icon.icns</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>$VER</string>
	<key>CFBundleShortVersionString</key><string>$VER</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# 3. 图标：形状库出 iconset → iconutil 转 icns（iconutil 仅 macOS 有）
node "$ROOT/scripts/gen-iconset.mjs" "$ROOT/dist/ccc.iconset"
iconutil -c icns "$ROOT/dist/ccc.iconset" -o "$BUNDLE/Contents/Resources/icon.icns"

# 4. ad-hoc 预签：先内层二进制后整包；签完立即校验——失败让 CI 红，不出坏包
codesign --force -s - "$BUNDLE/Contents/MacOS/traybin/tray_darwin_release"
codesign --force -s - "$BUNDLE/Contents/MacOS/ccc-bridge"
codesign --force -s - "$BUNDLE"
codesign --verify --deep --strict --verbose=1 "$BUNDLE"

# 5. dmg 舞台：app + Applications 快捷方式 + 首次使用脚本（解除隔离/修复/启动一体化）
mkdir -p "$STAGE"
mv "$BUNDLE" "$STAGE/$APP"
cp "$ROOT/scripts/mac-setup.command" "$STAGE/首次使用-右键打开我.command"
chmod +x "$STAGE/首次使用-右键打开我.command"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "CopilotCC Bridge" -srcfolder "$STAGE" -ov -format UDZO "$REPO/ccc-bridge-darwin-arm64.dmg"
rm -rf "$STAGE" "$ROOT/dist/ccc.iconset"
# 教训：变量后紧跟全角标点（，。（等）时，mac runner 的 bash 会把标点首字节吞进变量名 → 一律 ${} 花括号
echo "✔ $REPO/ccc-bridge-darwin-arm64.dmg（${APP}，ad-hoc 预签，版本 ${VER}）"
