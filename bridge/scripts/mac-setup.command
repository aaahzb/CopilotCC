#!/bin/bash
# Claude Code 侧边栏 · macOS 桥接一键初始化
# 首次使用请对 本文件「右键 → 打开」（浏览器下载的文件带隔离标记，直接双击会被 Gatekeeper 拦截）。
cd "$(dirname "$0")" || exit 1
set -e
echo "==> 赋予可执行权限…"
chmod +x ccc-bridge traybin/tray_darwin_release
echo "==> 解除下载隔离标记…"
xattr -dr com.apple.quarantine . 2>/dev/null || true
echo "==> ad-hoc 签名（让 macOS 允许运行未公证二进制）…"
codesign --force -s - ccc-bridge
codesign --force -s - traybin/tray_darwin_release
echo
echo "✔ 初始化完成！以后直接双击 ccc-bridge 即可常驻菜单栏。"
echo "  下一步：托盘菜单选「复制配对串」，到 Chrome 侧栏粘贴完成配对。"
read -n 1 -s -r -p "按任意键关闭窗口…"
