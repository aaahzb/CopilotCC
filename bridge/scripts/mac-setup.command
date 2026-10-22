#!/bin/bash
# CopilotCC Bridge · macOS 一键安装/修复
# 首次使用请对本文件「右键 → 打开」（浏览器下载带隔离标记，直接双击 App 会被报"已损坏"，对 App 右键打开同样绕不过，必须先解除隔离）。
# 做的事：把 App 拷入「应用程序」（已拷则跳过）→ 解除隔离标记 → 校验/补签 ad-hoc 签名 → 启动。
APP="CopilotCC Bridge.app"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$APP"
DST="/Applications/$APP"

die() {
  echo
  echo "✘ $1"
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
}

if [ -d "$DST" ]; then
  echo "==> 已安装：$DST"
elif [ -d "$SRC" ]; then
  echo "==> 安装：拷贝 $APP 到「应用程序」…"
  cp -R "$SRC" "$DST" || die "拷贝失败（权限不足？）。可手动把 App 拖进「应用程序」后重跑本脚本。"
else
  die "找不到 ${APP}。请先把 dmg 里的「CopilotCC Bridge」拖进「应用程序」，再重跑本脚本。"
fi

echo "==> 解除下载隔离标记…"
xattr -cr "$DST" || die "解除隔离失败：$DST"
chmod +x "$DST/Contents/MacOS/ccc-bridge" "$DST/Contents/MacOS/traybin/tray_darwin_release" 2>/dev/null

echo "==> 校验签名…"
if codesign --verify --deep --strict "$DST" 2>/dev/null; then
  echo "    签名有效（ad-hoc 预签）"
else
  echo "    签名缺失/失效，重新 ad-hoc 签名…"
  codesign --force --deep -s - "$DST" || die "签名失败"
fi

echo "==> 启动 CopilotCC Bridge…"
open "$DST" || die "启动失败"
echo
echo "✔ 完成！屏幕右上角菜单栏应已出现桥形图标。"
echo "  以后直接双击「应用程序」里的 CopilotCC Bridge 即可，无需再运行本脚本。"
echo "  下一步：点菜单栏桥形图标 →「复制配对串」，到 Chrome 侧栏粘贴完成配对。"
echo
read -n 1 -s -r -p "按任意键关闭窗口…"
