# CopilotCC

**把 Claude Code 放进 Chrome 侧边栏：一边看网页，一边让 Claude 阅读、提问并处理本地文件。**

[![CI](https://github.com/aaahzb/CopilotCC/actions/workflows/ci.yml/badge.svg)](https://github.com/aaahzb/CopilotCC/actions/workflows/ci.yml)
[![Download](https://img.shields.io/github/v/release/aaahzb/CopilotCC?label=download&color=blue)](https://github.com/aaahzb/CopilotCC/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20macOS%20arm64-lightgrey)

![CopilotCC 侧边栏读取当前网页并回答“这个网页说了什么”](docs/img/main.png)

CopilotCC 是免费开源的 Chrome 扩展 + 本地桥接工具。它使用你已经配置好的本机 Claude Code CLI，不额外要求 Anthropic 官方登录；网页不必复制粘贴，Claude 的回复、工具执行和审批过程都直接显示在浏览器里。

## 下载

| 平台 | 下载 | 运行要求 |
|---|---|---|
| **Chrome / Edge** | [扩展安装包](https://github.com/aaahzb/CopilotCC/releases/latest) | 解压后通过「加载已解压的扩展程序」安装 |
| **Windows 10+ x64** | [绿色单文件 `CopilotCC.exe`](https://github.com/aaahzb/CopilotCC/releases/latest) | 下载后直接运行，无需安装或解压，常驻系统托盘；exe 旁不需要其他文件 |
| **macOS Apple Silicon** | [本地桥接 DMG](https://github.com/aaahzb/CopilotCC/releases/latest) | 仅 arm64；首次打开方式见[用户指南](docs/guide.md) |

使用前需要已安装并能正常运行的 Claude Code CLI。macOS Intel 和 Linux 可从源码运行。

## 核心亮点

- **网页就是上下文**：自动附带页面正文或选中文字，支持文章提取、丰富度设置和强制重新读取。
- **不只是聊天**：上传文件、读取网页，并让 Claude 在你绑定的文件夹中写笔记、改代码。
- **过程完整可见**：正文、工具状态、输出、错误、提问和审批按真实顺序显示；长报告、diff 和压缩摘要默认折叠，不静默丢失。
- **无需记住命令行**：新建/切换会话、选择模型与权限、停止任务、批准计划都可在界面完成；`/compact` 等命令也会原样交给 CLI。
- **系统终端或插件终端**：别名行的 `>_` 菜单可在当前文件夹打开 Windows Terminal（不可用时回退系统控制台）或 macOS Terminal.app，也可打开独立 Chrome 窗口中的 xterm.js + 真实 PTY 终端；两者都继续当前会话。macOS arm64 的实机验收范围见 [macOS 调试返回报告](RETURN-REPORT.md)，Windows 复验与真实 CLI 历史证据见 [验证记录](TODO.md)。插件终端提供复制/粘贴按钮、快捷键和一键「可滚历史」。接管期间插件只读同步会话与工具记录，终端退出后自动恢复输入。

> **macOS 调试交接状态（2026-11-14）：未完成。** 系统 Terminal.app 原始故障已修复并实机验收；原始“插件终端窗口创建失败，未启动 Claude”仍未复现、未定位。另已修复首次关窗后第二次打开失败，但该缺陷发生在窗口创建之后，不能等同于原始窗口故障。
- **本地配对与按需读取**：桥接只监听 `127.0.0.1`，页面仅在发送消息时按需提取，没有常驻网页内容脚本。

## 侧边栏与独立窗口

侧边栏适合边看网页边问；点「🗖 弹出」可换成独立窗口，一边全屏浏览，一边持续对话。两个视图的草稿、流式回答、工具进度和审批实时同步，独立窗口仍可指向原来的网页。

![CopilotCC 独立窗口与侧边栏共享会话，并可指向当前网页](docs/img/popup.jpg)

## 上手 1 分钟

1. 安装扩展并启动对应平台的本地桥接。
2. 在托盘/菜单栏中选择「复制配对串」，粘贴到扩展完成配对。
3. 点「＋新建」，选择或输入一个文件夹作为工作目录，然后打开网页直接提问。

完整安装、macOS 首次打开、网页附带规则和故障排查请查看用户指南。

## 文档

- [用户指南](docs/guide.md)：安装、全部功能、交互支持矩阵、安全说明和 FAQ。
- [开发文档](docs/development.md)：架构、构建、测试、发布流程和项目结构。
- [macOS 调试返回报告](RETURN-REPORT.md)：两条原始故障链、RED→GREEN、实机证据、未完成阻塞与交付校验。
- [验证记录](TODO.md)：真实 CLI / Chrome 验收范围与尚未覆盖的边界。
- [问题反馈](https://github.com/aaahzb/CopilotCC/issues)：报告问题或提出需求。

## 开发

Chrome MV3 + React 19 + WXT，本地桥接使用 Node.js 22、Agent SDK 与本机 Claude CLI。构建和完整验证命令见[开发文档](docs/development.md)。

## 许可证

[MIT](LICENSE) © aaahzb
