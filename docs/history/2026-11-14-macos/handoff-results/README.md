# macOS 调试证据索引

本目录对应 `../RETURN-REPORT.md`。所有 JSON/TXT 均已做交付前脱敏：本机用户目录替换为 `<HOME>`，隔离临时目录替换为 `<TMP>` / `<ISOLATED_HOME>`，临时 target、扩展 ID、CDP URL 和原始诊断正文移除或替换；固定错误码、协议消息类型、版本、计数和布尔验收结果保留。证据不包含私有请求正文、配置正文、配对串、API key、Hook token、attachToken、完整环境或终端原始内容。

## 总结论

**交接总状态：未完成。** 系统 Terminal.app 原始故障已完成有效 RED→GREEN 和实机验收；原始“插件终端窗口创建失败，未启动 Claude”没有取得有效产品 RED，也没有根因。`red/embedded-shared-backend-reopen.txt` 是另一个发生在窗口创建之后的二次打开缺陷，不得当作原始窗口创建故障的证据。

## `red/`：真实产品缺陷或生产诊断 RED

- `system-terminal-release-real-terminal.json`：原始 Release 在真实 Terminal.app 中仅显示通用失败信息；status/start/exit 均不存在，CLI 未启动。
- `system-terminal-direct.json`：直接执行私有 terminal-child 请求得到固定底层错误 `TERMINAL_CHILD_IDENTITY`；未保留请求正文或私有路径。
- `system-identity-locale-test.txt`：真实 macOS `ps` 中文 Locale 回归，修复前 1 failed / 3 passed，身份结果为 `null`。
- `system-terminal-entry-diagnostics.txt`：`src/index.ts` 与 `src/tray.ts` 原入口丢弃固定错误码，2 failed / 5 passed；同时证明测试要求不泄露请求路径和正文。
- `embedded-shared-backend-reopen.txt`：独立发现的“首次关窗后第二次打开失败”回归，第二次 `spawn()` 抛 `PTY_BACKEND_CLOSED`，1 failed / 9 passed。这不是窗口创建失败。

## `green/`：最终通过结果

- `system-identity-locale-test.txt`：中文 Locale 的真实 Darwin 身份回归 4/4。
- `system-terminal-focused.txt`：terminal-child 与 process-identity 聚焦回归 12/12。
- `embedded-shared-backend-reopen.txt`：普通 lease 与共享 backend 生命周期聚焦回归 12/12。
- `macos-system-terminal-e2e-v4.json`：最终 v4 `.app` + 真实 Terminal.app；隔离假 CLI 和真实 Claude Code CLI 2.1.325 + 本机假上游均通过，`realApiCalled=false`，隔离根目录与登记进程/窗口清理完成。
- `macos-embedded-terminal-e2e-final-build.json`：最终 production 扩展 + 真实 Chrome 侧边栏/独立窗口；WS、node-helper PTY、xterm、ASCII/中文、复制粘贴、resize、连续输出、滚动、关窗后再次打开、刷新及桥接退出清理通过。该轮插件验收使用隔离假 CLI，不冒充真实 CLI 插件验收。
- `final-bridge-tests.txt`：40 个测试文件中 38 passed、2 skipped；444 项中 440 passed、4 skipped。
- `final-bridge-typecheck.txt`：通过。
- `final-extension-tests.txt`：24/24 文件、180/180 项通过。
- `final-extension-typecheck.txt`：通过。
- `final-extension-build.txt`：WXT production build 通过；仅有既有大 chunk 警告。
- `final-native-build-v4.txt` / `final-dmg-build-v4.txt`：最终 v4 原生应用与 DMG 构建日志。
- `final-dmg-validation-v4.txt`：DMG CRC、严格 ad-hoc 签名验证、arm64 架构、主程序 smoke 和 node-helper PTY 六项行为通过。

## `diagnostics/`：不能作为有效产品 RED 的材料

### `window-creation-not-reproduced/`

11 份原始插件窗口故障探针记录，覆盖 Release/本地构建、冷/热 Worker、全屏、真实 sidePanel 和不同 CDP 阶段。结果只证明窗口 API 成功或探针自身准备/执行失败，**没有复现目标产品错误**。临时 target/URL 与原始诊断正文已脱敏。

### `embedded-probe/`

8 份插件综合探针迭代记录，包括设置上下文竞态、探针断言和连续输出视口问题。`macos-embedded-final-build-run-02.json` 等不是最终全绿结果；最终通过文件已移至 `green/macos-embedded-terminal-e2e-final-build.json`。`macos-embedded-run-06.json` 是二次打开缺陷的实机 RED 诊断：首次关窗后第二次打开已创建窗口和 WS，但出现 `terminal-phase error` / `terminal.error` 并回到 idle；其顶层 `XTERM_ATTACH_TIMEOUT` 是探针等待症状，精确后端根因由 `red/embedded-shared-backend-reopen.txt` 的 `PTY_BACKEND_CLOSED` 回归证明。连续输出超时的后续诊断表明 WS 已持续收到输出，问题是探针把历史视口 DOM 当成实时底部，未因此修改生产代码。

### `system-terminal-probe/`

4 份系统终端探针准备与隔离诊断。`baseline-focused-tests.txt` 实际是 8/8 通过的基线，不是 RED；`macos-system-isolation-baseline.json` 实际 `ok=false`。这些文件只用于解释探针修正，不能替代最终实机结果。

### `withdrawn-hook-stdin-hypothesis/`

临时 Hook stdin EventEmitter 假设的单元日志、构建日志和本地诊断。真实旧/新应用 A/B 均为 3/3 成功，原超时未复现，因此生产修改与临时测试均已撤回；此目录不是最终修复证据。

归档时 RED/GREEN 同名日志发生覆盖，现存 GREEN 已改名保留；`hook-stdin-events-red.txt` 根据本轮原始工具记录恢复，并在文件头明确标注“恢复、未重跑、假设已撤回”。`packaged-hook-helper-local.json` 实际 `ok=false`，不得误读为通过。

### `earlier-runs/`

较早构建与实机运行，仅保留过程对照。最终报告只引用 `green/` 中的 v4 / final-build 结果，不使用本目录旧 DMG 或旧运行替代最终验收。

## 解读约束

- `backend: "pty"` 是公开 WS 协议枚举；最终 `.app` 内部 `pty-manifest.json` 的实际路线是 `node-helper`。
- macOS Bun 直路线仍为 `initial-size_TIMEOUT`，不能宣称 Bun 直路线通过。
- 真实 Claude Code CLI + 本机假上游验收在系统 Terminal.app 链完成；最终 Chrome 插件全链路使用隔离假 CLI。
- 所有实机测试均使用隔离配置、端口、CLI/上游和浏览器 profile；未向真实付费 API 或真实服务发送聊天消息。
- 每轮隔离 Chrome 均在探针结束或失败后定向关闭并验证退出；最终证据的 `cleanup.chromeClosed=true`。
