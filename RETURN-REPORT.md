# CopilotCC macOS 调试返回报告

日期：2026-11-14
原始目标版本：`v2026.11.12.3`
最终本地验收构建：v4（只是本轮构建序号，不是 Git tag 或 Release）

> ## 总状态：**未完成**
>
> 系统 Terminal.app 原始故障已完成复现、根因定位、最小修复和有效 RED→GREEN。另一个“首次关窗后第二次打开失败”缺陷也已独立修复并完成实机回归。
>
> 但原始“插件终端窗口创建失败，未启动 Claude”在本机没有复现，仍未取得有效原始产品 RED，也没有根因。最终 Chrome 功能验收全绿及二次打开修复都不能替代这个完成条件，因此不能把整体交接标为完成。

证据分类见 [handoff-results/README.md](handoff-results/README.md)。所有交付证据均已脱敏，不包含私有请求正文、真实配置、配对串、API key、Hook token、attachToken、完整进程环境或终端原始内容。

## 1. 两条原始链与新增缺陷的结论

| 项目 | 原始故障阶段 | 复现 / 根因 | 修复与最终验证 | 结论 |
|---|---|---|---|---|
| Terminal.app 只显示“私有终端包装进程失败” | terminal-child 身份校验，尚未启动 CLI | 已复现；中文 Locale 使 `ps lstart` 输出本地化，身份解析返回 `null`，得到 `TERMINAL_CHILD_IDENTITY` | 只对 `ps` 子进程固定 `LC_ALL=C`；入口保留脱敏固定错误码；真实 Terminal.app + 真实 CLI / 本机假上游通过 | **已完成该原始链 RED→GREEN** |
| 点击“在插件终端打开”只显示“插件终端窗口创建失败，未启动 Claude” | 扩展窗口扫描 / 聚焦 / 创建阶段；此阶段失败时不会发送 WS `terminal.open` | Release/本地、冷/热 Worker、全屏、真实 sidePanel 均未复现；无有效原始 RED、无根因 | 未对扩展窗口生产代码做无证据修改 | **未完成，精确阻塞见第 4 节** |
| 新增发现：首次关窗后第二次打开启动失败 | 窗口和 WS 已成功创建，后端第二次 `spawn()` 失败 | 单 lease 清理误关共享 backend，第二次抛出 `PTY_BACKEND_CLOSED` | 分离普通 lease 清理与 adapter 最终关闭；真实 Chrome 二次打开、第三次打开及退出清理通过 | **独立缺陷已修复，不等同于原始窗口故障** |

## 2. 环境与隔离边界

- macOS 27.2.1，Build 26B131；Darwin 27.2.0，arm64；Locale `zh_CN.UTF-8`。
- Chrome 157.0.8103.39；Bun 1.4.4；最终应用内 Node v22.23.4。
- 本轮 shell Node v24.15.0、npm 11.12.1。
- 真实 Claude Code CLI：`2.1.325 (Claude Code)`。
- 每轮使用独立 `CCC_BRIDGE_HOME`、`CLAUDE_CONFIG_DIR`、端口、工作目录、Chrome `user-data-dir` 和隔离假 CLI / 假上游。
- 真实 CLI 的 `ANTHROPIC_BASE_URL` 只指向本轮 `127.0.0.1` 假上游；localhost/CDP 不走代理。未调用真实付费 API，未向真实服务发送真实聊天消息。
- 只登记并操作本轮创建的 Terminal/Chrome 窗口和进程；没有向用户原有窗口发送测试按键，没有替换正在使用的桥接。
- 每轮测试 Chrome 均在结束或失败后定向关闭并验证退出；最终证据为 `cleanup.chromeClosed=true`。
- 插件剪贴板测试先写入固定测试值，再读取本轮写入内容，没有读取用户原剪贴板。

## 3. 原始系统 Terminal.app 故障：已修复

### 3.1 原始 RED 与底层证据

1. 原始 Release 在真实 Terminal.app 中只显示通用失败：
   - `realTerminal=true`
   - `genericMessage=true`
   - `statusExists=false`
   - `startExists=false`
   - `exitExists=false`
   - `cliSpawned=false`
   - 证据：[red/system-terminal-release-real-terminal.json](handoff-results/red/system-terminal-release-real-terminal.json)
2. 直接执行隔离的私有 terminal-child 请求，保留到底层固定错误 `TERMINAL_CHILD_IDENTITY`；status/start/exit 均不存在。证据：[red/system-terminal-direct.json](handoff-results/red/system-terminal-direct.json)。
3. 真实 Darwin 回归显式设置 `LC_ALL=zh_CN.UTF-8`、`LC_TIME=zh_CN.UTF-8`、`LANG=zh_CN.UTF-8`，调用真实 `readProcessIdentity(process.pid, "darwin")`。修复前返回 `null`，1 failed / 3 passed：[red/system-identity-locale-test.txt](handoff-results/red/system-identity-locale-test.txt)。

### 3.2 根因与最小修复

`/bin/ps -p <pid> -o comm= -o lstart=` 的 `lstart` 会跟随系统区域设置本地化，而解析器只接受稳定的英文日期格式，导致进程身份为 `null`。修复仅固定该子进程 Locale：

```ts
const { stdout } = await execFileAsync("/bin/ps", [
  "-p", String(pid), "-o", "comm=", "-o", "lstart=",
], {
  timeout: 3000,
  maxBuffer: 8192,
  windowsHide: true,
  env: { ...process.env, LC_ALL: "C" },
});
```

位置：`bridge/src/process-identity.ts:88`。PID、executable、startedAt 的严格身份比较没有放宽，私有路径、UUID、启动准许和取消/停止检查也没有放宽。

同时新增 `terminalChildErrorCode()`（`bridge/src/terminal-child.ts:29`）：只允许固定 `TERMINAL_CHILD_*` 错误码或有限格式的 Node 系统 `code`，其他异常统一为 `TERMINAL_CHILD_UNKNOWN`。`src/index.ts` 与 `src/tray.ts` 的终端子进程入口现在显示固定错误码，不显示私有请求路径、正文或原始异常。

### 3.3 RED→GREEN 命令与结果

| 命令（从仓库根目录执行） | RED | GREEN | 证据 |
|---|---:|---:|---|
| `npm --prefix bridge test -- --run tests/process-identity.test.ts` | 1 failed / 3 passed | 4/4 | `red/system-identity-locale-test.txt`、`green/system-identity-locale-test.txt` |
| `npm --prefix bridge test -- --run tests/terminal-child.test.ts` | 2 failed / 5 passed | 与下行合并通过 | `red/system-terminal-entry-diagnostics.txt` |
| `npm --prefix bridge test -- --run tests/terminal-child.test.ts tests/process-identity.test.ts` | — | 2 文件、12/12 | `green/system-terminal-focused.txt` |

入口诊断 RED 精确证明旧 stderr 只有通用“私有终端包装进程失败”，新增断言要求包含 `TERMINAL_CHILD_REQUEST` 且不包含请求路径和私有 JSON 正文；修复后两个真实入口均通过。

### 3.4 最终真实 Terminal.app 验收

证据：[green/macos-system-terminal-e2e-v4.json](handoff-results/green/macos-system-terminal-e2e-v4.json)。

- 最终 v4 `.app` 位于项目树外的隔离验收位置。
- 隔离假 CLI：真实 Terminal 标签页、0600 身份文件、实时 `ps` 身份匹配、Hook、会话跟随、ASCII/中文输入输出、退出码 0、lease 释放、wrapper/CLI/桥接停止均为 true。
- 真实 Claude Code CLI 2.1.325：真实 Terminal 启动、Hook、提示输入、固定本机回复可见、lease 释放和清理均通过。
- 本机假上游只记录一条脱敏摘要：`kind="messages"`、`stream=true`、`hasMarker=true`；没有保存请求正文或请求头。
- `realApiCalled=false`、`fatalCode=null`、`ok=true`、`privateRootRemoved=true`。

## 4. 原始插件窗口创建故障：未完成

### 4.1 已做的复现尝试

`handoff-results/diagnostics/window-creation-not-reproduced/` 保存 11 份脱敏诊断，覆盖：

- 原始 Release 与本地扩展构建；
- 冷 / 热 MV3 Service Worker；
- 全屏窗口状态；
- 真实 `chrome.sidePanel.open`、真实侧边栏按钮与独立 `terminal.html`；
- 多种 CDP 加载和诊断阶段。

这些结果只有窗口 API 成功或探针自身准备/执行失败，**没有出现目标“插件终端窗口创建失败，未启动 Claude”产品错误**。因此它们不能标成有效产品 RED，也不能用于推断根因。

### 4.2 代码边界与未修改项

`extension/src/entrypoints/sidepanel/App.tsx` 在 `openTerminalWindow()` 失败时显示该错误；窗口创建失败时不会发送 WS `terminal.open`。`extension/src/lib/terminal-window.ts` 负责扫描已有 popup、聚焦或创建新窗口，`extension/src/entrypoints/background.ts` 已放行 `terminal.open-window`。

本轮没有对上述扩展生产文件做无证据修改。

### 4.3 精确阻塞点

缺少在故障实际发生环境中可重复的原始失败，以及 `openTerminalWindow()` 内“扫描已有窗口 → 聚焦 → 创建”具体失败阶段的固定错误证据。下一步必须在隔离环境中重现同一点击链，并捕获对应 Chrome API 的 `runtime.lastError` / 固定异常码，同时保持 token、设置和页面正文不出证据。取得该 RED 后才能做根因修复及原始第二链的有效 RED→GREEN。

最终真实 Chrome 全链路通过只说明本轮环境下功能可运行，**不能证明用户原始故障已修复**。

## 5. 独立缺陷：首次关窗后第二次打开失败

### 5.1 实机与单元 RED

- 实机诊断：[diagnostics/embedded-probe/macos-embedded-run-06.json](handoff-results/diagnostics/embedded-probe/macos-embedded-run-06.json)。首次完整链路通过并关窗后，第二次打开出现 `terminal-phase error`；WS 已见 `auth.ok`、`terminal.open`、`terminal.state`、`folder.bound`、`terminal.error`，状态由 `starting/embedded` 回到 `idle`。这证明失败不在窗口创建阶段。
- 单元 RED：[red/embedded-shared-backend-reopen.txt](handoff-results/red/embedded-shared-backend-reopen.txt)。同一 adapter 第二次 `start()` 精确抛 `PTY_BACKEND_CLOSED`，1 failed / 9 passed。

### 5.2 根因与修复

旧 `EmbeddedTerminalAdapter` 的单次 `handle.close()` 在真实退出和异步清理后调用共享 `backend.close()`。lease 进入 idle 时，`TerminalService` 异步关闭该 handle，于是共享 backend 被永久标记 closed，后续 `spawn()` 失败。

最终边界：

- 普通 `handle.close()` 只等待当前 session close、真实 exit 帧和异步退出清理，不关闭共享 backend。
- `TerminalService` 的 idle 清理只关闭当前 handle。
- 新增 adapter 级 `close()`，并由 `server` / `index` / `tray` 接入桥接最终退出。
- `TerminalService.closeEmbedded()` 先关闭活动 handle，再调用共享 `embeddedClose`；即使没有活动 handle，也必须执行最终关闭。

聚焦 GREEN：

```bash
npm --prefix bridge test -- tests/embedded-terminal.test.ts tests/terminal-service.test.ts
# 2 个文件，12/12 通过
```

证据：[green/embedded-shared-backend-reopen.txt](handoff-results/green/embedded-shared-backend-reopen.txt)。

最终真实 Chrome 探针在首次关窗后再次执行 `openEmbedded()`，随后完成刷新；第三次打开后停止桥接。最终 `fatalCode=null`，旧进程、新进程和所有 owned CLI 均停止。证据：[green/macos-embedded-terminal-e2e-final-build.json](handoff-results/green/macos-embedded-terminal-e2e-final-build.json)。

## 6. 最终真实 Chrome 插件验收

证据：[green/macos-embedded-terminal-e2e-final-build.json](handoff-results/green/macos-embedded-terminal-e2e-final-build.json)。

本轮使用最终 production 扩展、最终 v4 `.app`、真实 Chrome 侧边栏/独立窗口和**隔离假 CLI**：

- `actualSidepanelOpened=true`，独立 popup 可见，xterm 存在。
- 公开 WS `backend="pty"`；最终应用内部原生路线 `nativePtyBackend="node-helper"`。
- 实际观察到 `auth.ok`、`terminal.open`、`terminal.opened`、`terminal.attach`、`terminal.attached`、`terminal.input`、`terminal.output`、`terminal.resize`、`terminal.state`。
- open/attach 顺序、attached 状态和真实输入输出互相印证；ASCII、中文、真实选区复制、多行中文粘贴均通过。
- PTY resize 从 `129x34` 到 `150x41`，`resizeSignalSeen=true`。
- 连续输出、向上/向下真实滚轮、Hook、关窗进程停止与 lease 释放均通过。
- 关窗后再次打开、刷新旧进程停止、新会话启动、桥接退出清理均通过。
- `fatalCode=null`、`failedStage=null`、`ok=true`、`realApiCalled=false`。
- `cleanup.chromeClosed=true`、`bridgeStopped=true`、`rootRemoved=true`、`allOwnedCliStopped=true`。

注意：真实 Claude Code CLI + 本机假上游是在系统 Terminal.app 链验收的；本轮没有完成“真实 Chrome 插件终端 + 真实 Claude CLI”的组合验收，不能混写。

## 7. 全量自动验证

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm --prefix bridge test` | 40 文件：38 passed、2 skipped；444 项：440 passed、4 skipped | `green/final-bridge-tests.txt` |
| `npm --prefix bridge run typecheck` | 通过 | `green/final-bridge-typecheck.txt` |
| `npm --prefix extension test` | 24/24 文件、180/180 项通过 | `green/final-extension-tests.txt` |
| `npm --prefix extension run typecheck` | 通过 | `green/final-extension-typecheck.txt` |
| `npm --prefix extension run build` | WXT 0.21.4 production build 通过，总大小 3.03 MB；仅既有大 chunk 警告 | `green/final-extension-build.txt` |

最终生产代码之后未再改动；后续仅整理脱敏证据和文档。

## 8. 最终 DMG 与原生验证

文件：`ccc-bridge-darwin-arm64.dmg`（单独交付，不放进源码 ZIP）

- 大小：`87,163,702` 字节。
- SHA-256：`cd1c1e73163cbda7698a6c09d2fe954dbb6f92b0391e4189dabe2d9e1d805666`。
- DMG CRC 通过；`.app`、Applications 链接和首次使用脚本存在。
- `codesign --verify --deep --strict --verbose=2` 通过；`Signature=adhoc`、`TeamIdentifier=not set`。
- 主程序、Node、`pty.node`、`spawn-helper`、Swift tray 均为 arm64。
- `--smoke darwin arm64` 通过。
- `--pty-smoke` 的 initialSize、inputEcho、continuousTicks、chinese、resize、exitCode7 均为 true，`backend="node-helper"`。

证据：`green/final-native-build-v4.txt`、`green/final-dmg-build-v4.txt`、`green/final-dmg-validation-v4.txt`。

这是 ad-hoc 签名，不宣称 Apple 公证。macOS Bun 直路线仍失败于 `initial-size_TIMEOUT`，最终路线是 node-helper，不能宣称 Bun 直路线通过。

## 9. 本轮修改文件

### 生产代码

- `bridge/src/process-identity.ts`：只为 `ps` 子进程固定 `LC_ALL=C`。
- `bridge/src/terminal-child.ts`：新增脱敏固定错误码映射。
- `bridge/src/index.ts`、`bridge/src/tray.ts`：terminal-child 入口保留固定错误码；接入共享 embedded backend 最终关闭。
- `bridge/src/embedded-terminal.ts`：分离普通 lease 关闭与 adapter 最终关闭。
- `bridge/src/terminal-service.ts`：新增共享 `embeddedClose`，最终关闭即使无活动 handle 也执行。
- `bridge/src/server.ts`：转接并在服务最终退出时调用共享关闭。

### 回归测试

- `bridge/tests/process-identity.test.ts`
- `bridge/tests/terminal-child.test.ts`
- `bridge/tests/embedded-terminal.test.ts`
- `bridge/tests/terminal-service.test.ts`

### 文档与交付

- `README.md`
- `docs/development.md`
- `docs/guide.md`
- `TODO.md`
- `RETURN-REPORT.md`
- `handoff-results/README.md` 及分类、脱敏后的证据文件

没有修改扩展生产代码。`bridge/src/terminal-hooks.ts` 的临时 Hook stdin 假设及其临时测试已完整撤回；对应材料仅在 `diagnostics/withdrawn-hook-stdin-hypothesis/`，不属于最终修复。

## 10. 未验证项、限制与交付物

1. **原始插件窗口创建故障未复现、未定位、未完成原始 RED→GREEN，这是总状态“未完成”的直接原因。**
2. macOS Bun 直路线未通过；只验收最终 node-helper 路线。
3. 最终 Chrome 插件全链路使用隔离假 CLI；真实 CLI + 本机假上游仅在系统 Terminal.app 链完成。
4. DMG 为 ad-hoc 签名，未做 Apple 公证。
5. 未创建 Git tag、Release 或推送；未调用真实 API。
6. 交付源码 ZIP 包含完整源码、lockfile、本报告与脱敏证据，排除 `.git/`、`node_modules/`、`dist/`、`.output/`、`.wxt/`、`.app`、`.node`、DMG/exe、`.DS_Store` 和大型构建产物。ZIP 不自包含；其 SHA-256 见同目录 `CopilotCC-macos-debug-handoff-20261114-source.zip.sha256`。

---

**最终结论：未完成。** 已完成系统终端原始链修复、独立二次打开缺陷修复及最终实机/自动验证；原始“插件终端窗口创建失败，未启动 Claude”仍缺有效复现和根因，不能宣布两条原始故障链均完成。
