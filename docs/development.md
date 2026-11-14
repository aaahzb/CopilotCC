# CopilotCC 开发文档

[返回项目首页](../README.md) · [用户指南](guide.md) · [完整验证记录](../TODO.md)

## 架构

```
Chrome 侧边栏(React) ┐
                     ├─(镜像视图)⇄ ws://127.0.0.1:19280 ⇄ ccc-bridge(Node) ⇄ Agent SDK ⇄ claude CLI ⇄ 你的中转 API
独立弹窗(同一 React) ┘              (token 认证/Origin 白名单)      (stream-json 常驻会话)
        │                                  └─ 唯一工作区：文件夹/会话/busy/流式/草稿/审批，状态广播给全部视图
        └─ chrome.scripting 按需提取页面（弹窗钉住原 tab）→ Defuddle 转 Markdown → 随消息附带
```

- 侧边栏/弹窗页面直连 WebSocket（规避 MV3 service worker 30 秒回收；SW 只做弹窗窗口与页面徽标的短命协调，被回收后扫描弹窗 URL 自愈）。
- **镜像架构**：桥接进程内只有一份工作区状态，侧边栏与弹窗都是它的视图——消息回显（chat.user）、流式增量（chat.delta）、草稿（chat.draft）、工具活动（chat.tool）、提问结果（chat.ask.resolved）和其他交互决定（chat.interaction.resolved）全由桥接广播，视图不做本地乐观上屏，双端天然一致；新视图或断线重连发 client.ready 换一份按序快照（folder.bound → history → lists → settings.state → chat.sync），中途接入也能补齐在途流式、工具、挂起交互、已解决记录与草稿。关掉任何一个视图都不杀会话；停止、切换/重建会话或桥接退出才会终结在途轮次；工作区绑定（文件夹+别名）与权威执行设置（权限/模型/effort/fast 请求值）持久化在 `~/.ccc-bridge/workspace.json`，桥接重启/升级后首个视图接入即自动恢复（连别名带会话续聊），扩展侧 lastFolder 回绑只是兜底。认证后的自动完整设置只给尚未初始化的桥接播种；已有执行设置时以桥接为准，旧视图的自动回放缓存不会撤销用户刚修改或失败回滚后的值。手动设置另带 fields 变更掩码，快照里未改的旧字段不会覆盖桥接；未初始化桥先收到 fastOnly 也会完整播种。旧版无 hello 的启动序列按首个 ready 前的帧序兼容，离线显式设置先应用，最后的自动完整帧只作 hello。主动绑定、新建、切换或删除会话才重置对话视图，恢复快照与自动回绑不会误清聊天和运行时真值。
- 不装常驻 content script；发消息时才按需注入脚本提取 `outerHTML` + 选中文字，正文解析（Defuddle→Markdown）在视图页面内完成；弹窗模式钉住原 tab 提取（弹窗聚焦时"活动 tab"是弹窗自己）。
- 桥接维护 `文件夹 → sessionId` 映射（`~/.ccc-bridge/sessions.json`），重新绑定即 resume 会话；历史消息从 `~/.claude/projects/<slug>/<sessionId>.jsonl` 转录回放。

### 系统终端续聊架构

- `TerminalLeaseManager` 独占当前工作区写入权：`idle → starting → active/degraded → stopping → idle`。接管期间扩展只读，SessionEnd 不直接释放 lease，只有真实包装进程退出才执行最终镜像、SDK 恢复和 idle。
- 每次 lease 使用独立随机 Hook token。当前生产固定使用 command helper：本机 CLI 2.1.316 的 HTTP Hook 实探超时，不能仅凭版本号或最新文档重新启用 HTTP。SessionStart 只接受 `startup/resume/clear/compact/fork`，10 秒无有效事件进入 degraded，绝不按最新 mtime 猜 sessionId。
- 常驻 `TranscriptWatcher` 以 250ms 防抖和 2 秒对账发现转录增删改；只有 lease 当前 sessionId 才生成带单调 revision 的 `session.mirror.data`，普通外部新会话只刷新列表。
- Windows 系统终端由私有包装进程记录身份和退出文件。GUI 启动器退出不等于 Claude 退出；重启恢复必须核对 PID + executable + startedAt，unknown 只允许人工解除。启动状态等待上限为 20 秒；包装进程先写 status，只有桥接接管 lease 并写入 `.start` 后才允许启动真实 CLI，最终失败写 `.cancel`，避免迟到窗口失去 lease 后仍启动交互进程。
- Windows 发行目录必须同时包含 `ccc-bridge.exe`（GUI subsystem=2，托盘主程序）和 `ccc-terminal.exe`（Console subsystem=3，`--terminal-child` / `--terminal-hook`）。不要把 Console 包装改回 GUI exe，也不要通过修改发行 PE 头规避子系统问题。
- macOS 使用 Terminal.app。2026-11-14 的 arm64 实机已复现原始“私有终端包装进程失败”：中文 Locale 下 `/bin/ps` 的 `lstart` 被本地化，严格身份解析返回 `null`，最终报 `TERMINAL_CHILD_IDENTITY`。最小修复只对 `ps` 子进程固定 `LC_ALL=C`，不放宽 PID + executable + startedAt 身份校验。最终 v4 已通过真实窗口、身份、Hook 会话跟随、ASCII/中文、退出与定向清理；真实 Claude Code CLI 2.1.325 只访问本机假上游。原始插件窗口创建故障仍未复现，交接总状态与范围见 [RETURN-REPORT](../RETURN-REPORT.md)。
- 私有文件位于 `<CCC_BRIDGE_HOME>/terminal/`：`system-lease.json` 保存当前系统 lease，`<leaseId>.request.json` / `.settings.json` / `.hook-token` / `.status.json` / `.start` / `.cancel` / `.exit.json` / `.stop` 分别用于启动请求、Hook 配置、私有 token、包装身份、启动准许、启动取消、真实退出和停止请求。公开 WS 状态不得包含 token、环境或凭据，验收日志不得打印这些文件的秘密内容。

### 插件独立终端架构

- 插件终端复用同一个 `TerminalLeaseManager`、Hooks 和 watcher，不另建会话状态机。独立 `terminal.html` 只负责 xterm.js 显示、中文/IME 输入和 FitAddon 行列调整；实际 shell/Claude 进程由 `node-pty@1.1.0` 的真实 ConPTY/POSIX PTY 运行，ANSI 不进入聊天 JSONL 镜像。工具栏提供复制、粘贴与「可滚历史」；有选区时 Ctrl+C 复制，无选区时仍向 CLI 发送中断，Ctrl+Shift+C/V 用于复制/粘贴，粘贴不额外补 Enter。
- 真实 CLI 普通画面通常没有足够的 xterm 线性 scrollback。「可滚历史」先发送 Ctrl+O，并且只有可见区域同时出现 `Showing detailed transcript` 与 `↑↓ scroll` 才发送 `[`，把 detailed transcript 导出到 xterm 原生 scrollback；普通画面的 `[` 是提示导航，绝不能盲发。真实验收必须同时证明导出键进入 PTY、scrollHeight 增长、滚轮实际移动 scrollTop，且滚轮没有被转换成方向键输入。
- 输出按 `leaseId + seq` 进入 1 MiB/256 块有界缓冲；attach 顺序固定为 `terminal.attached` 后重放 `terminal.output`。attachToken 只保存在原终端页面内存，不能写入 chrome.storage、sessionStorage 或 localStorage；同一页面断线有 3 秒重连宽限，普通聊天 WS 断开不影响 PTY。刷新后的新文档没有原 token，旧 PTY 被清理并使用新 lease；序号缺口必须持续显示错误并关闭 owned PTY。
- `EmbeddedSession` 与系统终端分别持久化 `embedded-lease.json` / `system-lease.json`。异常重启先核对 PID + executable + startedAt；只有明确 ESRCH 才按已退出清理，权限或瞬时查询错误保持只读，unknown 人工解除不杀进程。
- 正常 `server.close()` 等待 kill 请求、真实 PTY exit、全部异步退出清理（最终镜像、SDK 恢复、idle 和私有 lease 清除）完成后才关闭 backend；不能把 `PtyProcess.kill()` 的 Promise 当作进程已经退出。
- `EmbeddedTerminalAdapter` 持有可连续启动多个 lease 的共享 backend。普通 lease 的 `handle.close()` 只等待当前 session 退出与清理，**不得关闭共享 backend**；`TerminalService` 进入 idle 时也只关闭当前 handle。桥接整体退出才沿 `server.close()` → `TerminalService.closeEmbedded()` → `embeddedClose` → `adapter.close()` 最终关闭共享 backend，即使没有活动 handle 也要执行最终关闭。否则第一次关窗后第二次 `spawn()` 会以 `PTY_BACKEND_CLOSED` 失败。
- 原生路线只能由真实编译产物探针选为 `bun-node-pty` 或 `node-helper`。便携模式由生产入口把 `CCC_PORTABLE_RUNTIME_DIR` 指向已校验的私有负载；传统目录模式才读取 exe 旁 `pty-manifest.json`。清单缺失/非法时仅 embedded 返回 `PTY_UNAVAILABLE`，系统终端和普通聊天仍须可用。macOS 本轮 Bun 直路线仍为 `initial-size_TIMEOUT`，最终使用 `node-helper`；公开 WS 的 `TerminalBackend` 值仍为 `"pty"`，内部 manifest 才记录 `"node-helper"`。
- Windows 内部完整发行布局如下；`runtime/` 仅 node-helper 路线需要。传统目录和本地源码验收必须保留整棵目录；绿色发布则把同一布局压缩、跨文件固定块去重后内嵌进 `CopilotCC.exe`，用户不再接触这些附属文件。

  ```text
  ccc-bridge-win-x64/
    ccc-bridge.exe       # GUI subsystem=2，托盘主程序
    ccc-terminal.exe     # Console subsystem=3，CLI、终端包装与 Hook helper
    pty/
      package.json
      node_modules/{node-pty,node-addon-api}/
    pty-manifest.json
    runtime/             # node-helper 路线携带 Node 22
  ```

- **绿色单文件发布**：`build-portable-exe.mjs` 用 7-Zip 压缩上述负载，以 1 MiB 固定块跨文件去重，把 `payload-manifest.json`、去重配方和内容包作为 `CopilotCC.Payload.zip` 嵌入 WinForms GUI 启动器。启动器只依赖 Windows 10 自带的 .NET Framework，输出唯一 `dist/portable-win-x64/CopilotCC.exe`。
- 私有运行目录为 `<CCC_BRIDGE_HOME>/runtime/<payloadSha256>/`。每次启动先在命名 Mutex 内按专有 product 标记清理旧版本与 `.extracting-*`，再全量校验当前版本；缺失或损坏时在 staging 解压、逐文件 SHA-256 复核并原子发布，完整当前版本直接复用。活跃、未知、foreign product、junction 和权限异常目录保留，正式运行目录不留下去重配方或 pack。
- Bun 的 Win32 `LoadLibrary` 对深层原生 `.node` 路径仍受 `MAX_PATH` 限制。`package-pty.mjs` 只在发行副本的 `node-pty/lib/utils.js` 追加规范 `\\?\` 路径 + `process.dlopen()` 回退，同时覆盖主进程 ConPTY 和关闭时 fork 的 console-list agent；补丁后的文件及哈希进入原生与便携 manifest，仓库 `node_modules` 不被改写。
- macOS 2026-11-14 实机证据包括：原始系统终端故障 RED→GREEN、最终 v4 的真实 Terminal.app、真实 Chrome 侧边栏/独立终端、WS + node-helper PTY + xterm 交互、严格签名、DMG CRC 与原生 smoke。原始插件窗口创建故障仍未复现，不能用最终功能全绿替代其 RED/根因；完整边界见 [RETURN-REPORT](../RETURN-REPORT.md)。

## 开发者

### 从源码运行

```bash
# 桥接（Node 22+）
cd bridge && npm i && npm start        # 开发态托盘：npm run tray
# arm64 Mac 跑托盘前须先编一次自研托盘助手：bash scripts/build-tray-mac.sh
# （systray2 自带的 darwin 托盘是 x86_64 单架构，无 Rosetta 起不来；发布态由 CI 现场编译，无需手动）

# 扩展（另一个终端）
cd extension && npm i && npm run build
# chrome://extensions → 开发者模式 → 加载已解压扩展 → 选 extension/.output/chrome-mv3
```

### 测试与自检

```bash
# 协议单一来源是 shared/protocol.ts，两端复制件由脚本同步（改协议只改它）
node scripts/sync-protocol.mjs

cd bridge && npm test                  # macOS：38 文件/440 项通过、2 文件/4 项跳过；Windows：40 文件通过、443 项通过/1 项跳过
cd bridge && npm run typecheck         # 桥接严格类型检查
cd bridge && npm run selftest          # 离线：握手 + 绑定流程，不调 API
cd bridge && npm run selftest:live     # 端到端：向真实 claude 发一条消息（走本机中转配置）

cd extension && npm test               # 扩展 24 个测试文件，180 个单测
cd extension && npm run typecheck      # 严格类型检查（需先 npx wxt prepare 或构建过一次）

# 预编译件架构审计（CI 门禁同款）：读文件头断言 CPU 架构，防"第三方二进制架构发错进包"
node bridge/scripts/check-arch.mjs bridge/node_modules/systray2/traybin/tray_windows_release.exe x64
```

### 系统终端隔离验收

以下命令只适用于 Windows，且验收根目录必须事先获得用户批准。脚本固定要求根目录位于 `D:/ccc-fast-final-verify-20261026/tool-history-20261027/dual-terminal-20261110` 内；每次运行都换成一个全新的空目录，绝不覆盖或删除旧证据。

```bash
# 先构建真实扩展，并用真实编译产物探针选择原生 PTY 路线
npm --prefix extension run build
APPROVED="D:/ccc-fast-final-verify-20261026/tool-history-20261027/dual-terminal-20261110"
node bridge/scripts/run-pty-probe.mjs --route auto --target win --root "$APPROVED/fresh-pty-probe-win"
node bridge/scripts/build-exe.mjs win --pty-route "$APPROVED/fresh-pty-probe-win/pty-route.json"

# 编译只访问本机、不写真实 API 的隔离假 CLI
mkdir -p "$APPROVED/bin"
bun build bridge/scripts/fake-terminal-claude.ts --compile --target=bun-windows-x64 --outfile "$APPROVED/bin/fake-claude.exe"

# 有效负控：必须非零退出，并准确指出 Hook 会话跟随证据缺失
node bridge/scripts/verify-system-terminal.mjs --root "$APPROVED/fresh-hook-negative-run" --negative-control hooks

# 正常验收：另用新空目录；全部必需证据满足后退出码为 0
node bridge/scripts/verify-system-terminal.mjs --root "$APPROVED/fresh-normal-run"
```

脚本从项目树外 CWD 启动双 exe 的隔离副本，使用独立 `CCC_BRIDGE_HOME` / `CLAUDE_CONFIG_DIR`、本机假上游、真实 Chrome 与真实 Windows 窗口，不停止或替换用户正在使用的桥接。正常验收不得添加诊断用 `--console-subsystem-probe`，也不得启用假 CLI 的 Hook 补救；最终结果必须包含 `commandHooksWithoutFailure=true`、`runtimeErrors=[]` 和 `realApiCalled=false`。准备阶段异常、连接失败或普通超时不能记作有效负控。

### 插件终端与双终端隔离验收

沿用上面同一批准根目录、新构建的扩展/完整 Windows 发行目录和隔离假 CLI，每次仍换全新空目录：

```bash
# 有效负控：精确丢弃第一次 attach；必须在 attachedAfterOpenedOnSameConnection=false 非零失败
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-embedded-negative-run" --negative-control attach

# 正常完整验收：真实 Chrome + xterm.js + ConPTY，同时覆盖系统终端回退场景
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-embedded-normal-run"
```

正常脚本逐项要求窗口可见/去重、认证与 opened/attach 顺序、resume/生成 UUID、ASCII/中文/IME、连续输出、真实 132×36、Hooks、双视图只读、11 类写拒绝、非 owner 错误、连续重放、3 秒内重连与超时清理、刷新新 lease、缺帧错误保留、结束/pagehide/桥接关闭清理、三类异常恢复、原生失败隔离及系统终端/普通聊天可用。最终还必须满足 `commandHooksWithoutFailure=true`、`upstreamRequests=0`、`realApiCalled=false`、`runtimeErrors=[]` 和 cleanup remaining/errors 双空；任一缺证据都会非零退出。脚本只登记并定向清理本轮隔离窗口与进程，不按标题批量关闭用户窗口。

2026-11-14 已用 Mac 返回源码的新 Windows 绿色单 exe 独立执行上述完整流程：首次及后续多次打开均通过，43 项功能断言为真，错误、上游请求与清理残留均为空，四张关键截图已人工核对。结果与静态复验范围见 [TODO](../TODO.md) 顶部“Windows 独立复验”；该 Windows 证据不替代原始 macOS 插件窗口故障的有效 RED 和根因。

### 真实 Claude Code CLI 会话恢复补验

下面两类补验使用本机真实 Claude Code CLI，但只访问脚本启动的 `127.0.0.1` 假上游，不调用真实中转或真实 API。每次都使用新的隔离 `CCC_BRIDGE_HOME` / `CLAUDE_CONFIG_DIR` 和空工作目录，不读取或修改用户配置；证据只保留请求阶段、消息数量及固定标记布尔值，不保存请求正文或请求头。

```bash
# 真实 CLI 单独 resume：要求第二轮请求实际包含首轮用户和助手，并写入同一 JSONL
node bridge/scripts/verify-real-cli-resume.mjs \
  --root "$APPROVED/fresh-real-cli-resume"

# 真实 CLI 双终端：插件终端与系统终端都验证旧上下文、镜像、退出恢复和桥接正常关闭
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-real-cli-dual-terminal" --real-cli-resume-only
```

双终端脚本会在全新隔离 `.claude.json` 中预置首次初始化结果，仅用于跳过主题、dummy key、Security notes 和目录信任向导；不会放宽 `--resume`、有效 Session Hooks、旧用户/旧助手上下文、同一转录、双视图镜像、退出恢复或清理断言。系统终端关窗后必须等待本次关窗之后的新 `idle`，不能误用插件终端此前留下的旧 `idle`。Windows Terminal 直接关窗可能结束包装进程而来不及写 `exit.json`：桥接仍优先采用真实退出文件，仅在没有文件且包装 PID 明确不存在（ESRCH）时恢复；进程仍存活、权限不足或查询状态未知时继续保持只读。

生产入口装配回归同时覆盖普通 CLI 与托盘 exe，确保两者都注入同一份 `workspace.json` 持久化；Windows 产物另经项目树外隔离探针验证执行设置与文件夹绑定真实落盘。最终交互验收使用新 dist exe、独立 `CCC_BRIDGE_HOME` / `CLAUDE_CONFIG_DIR`、真实 CLI、`127.0.0.1` 假上游和真实 Chrome：Ask 多题/多选/Other/自定义答案、计划退回/批准、Write 拒绝/允许、工具状态/完整输出/Edit diff/错误、历史分页、双视图和重载恢复均通过；refusal UserDialog 还覆盖了同端口桥接重启恢复。compact/Task 最终回归另从真实扩展 UI 验证：网页附带与选中文字存在时 `/compact` 仍原文执行，普通消息附带不受影响，实时及重载后的压缩记录均有默认折叠的完整摘要，旧侧车长 Task 报告读取后也成为短状态与折叠详情。验收同时检查了页面截图和运行时错误，具体结果目录及未验证边界见 TODO。上述验证未调用真实 API。

### 绿色单文件构建与验收

沿用上述完整 Windows 发行目录和 `$APPROVED`。每次验收仍使用新的空目录；构建只输出 `bridge/dist/portable-win-x64/CopilotCC.exe`，公开交付时不复制完整目录或 `pty/`。

```bash
# C# 启动器八组行为回归，再构建压缩内嵌单 exe
node bridge/scripts/run-portable-launcher-tests.mjs
node bridge/scripts/build-portable-exe.mjs

# 项目树外生命周期：先清理后解压、占用保护、篡改重建、重复启动与真实进度窗口
node bridge/scripts/verify-portable-exe.mjs \
  --root "$APPROVED/fresh-portable-lifecycle"

# 单 exe 完整假 CLI 双终端回归
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-portable-embedded" --portable

# 单 exe 真实 Claude Code CLI 双终端 resume；仍只访问本机假上游
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-portable-real-cli" --portable --real-cli-resume-only
```

生命周期脚本要求源 exe 与隔离副本 SHA-256 一致、公开目录只有单文件、15 项必需证据全部成立且 cleanup remaining/errors 双空。进度截图不仅检查窗口存在和 `PrintWindow` 返回值，还检查客户区确有已绘制亮色像素，避免把首次绘制前的黑帧记为通过；生产启动器不为截图人为延时。便携双终端证据另要求内层真实路径位于本轮 `runtime/<payloadSha256>/`、托盘正常退出和桥接清理完成。以上验收均不调用真实 API。

本轮交互修复的最终证据目录为 `interaction-fix-system-05`、`interaction-fix-real-portable-02` 和 `interaction-fix-embedded-05`：分别覆盖系统终端慢启动/迟到取消、真实 CLI 双终端 resume/中断/原生历史滚轮，以及完整假 CLI 的剪贴板、中文/IME、resize、Hooks、重连和异常生命周期。三者均退出码 0、关键截图已人工核对，运行错误与最终清理残留为空；真实 CLI 与完整假 CLI 的 real-only/全量字段按各自适用范围解读，不能混为同一份覆盖矩阵。

`bridge/probe-sdk.mjs` / `probe2-sdk.mjs` / `bridge/scripts/probe-frames.mjs` 是 Agent SDK 直连探针（排障用，不经桥接直接验证 CLI 时序、权限模式与流式帧字段——"SDK 流不下发 effort" 就是用 probe-frames 实锤的）。

### 目录结构

```
shared/protocol.ts      # WS 协议单一来源
scripts/                # sync-protocol / gen-extension-key
bridge/                 # 本地桥接（Node + ws + Agent SDK）
  src/{config,session-manager,transcript,claude-session,interaction-store,server,resume-script,folder-picker,index}.ts
  src/{terminal-lease,terminal-service,terminal-store,system-terminal,embedded-terminal}.ts
  src/{bun-pty-backend,node-pty-backend,node-pty-helper,terminal-output-buffer,process-identity}.ts
  scripts/              # 原生/便携构建、PTY 探针、布局校验、双终端与生命周期验收、macOS 构建签名
  launcher/             # WinForms 绿色启动器与 C# 行为 harness
  tray/main.swift       # 自研 macOS 菜单栏托盘助手（systray2 协议，arm64 原生，CI 现场 swiftc 编译）
extension/              # Chrome MV3 扩展（WXT + React）
  src/lib/{protocol,storage,attach-policy,ws-client,page-extract,popup-mode,popup-registry}.ts
  src/components/       # MessageList / InputBox / PermissionCard / AskCard / ElicitationCard / UserDialogCard / InteractionRecordView 等
  src/entrypoints/{background.ts, sidepanel/, terminal/}
.github/workflows/      # ci.yml（三平台测试）/ release.yml（tag 触发构建发布）
```

### CI / 发版

> 本节保留 2026-11-12 及更早的历史 CI/CD 记录。最新 macOS 实机状态见下文“2026-11-14 macOS arm64 实机交接”和 [RETURN-REPORT](../RETURN-REPORT.md)。

- **CI**：push / PR 触发（`.github/workflows/ci.yml`），在 ubuntu / windows / macOS 三平台跑两端类型检查 + 单测 + 扩展构建。Windows 另跑真实 PTY 路线、完整原生布局/项目树外冒烟、启动器八组回归、绿色单 exe 构建和 `$RUNNER_TEMP` 严格子目录中的生命周期验收。
- **发版**：打 tag 即自动构建并发布 Release（`.github/workflows/release.yml`）：

  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```

  流程：测试门禁 → Windows runner 先运行真实 PTY 路线探针，再按报告编双 exe、校验完整原生布局，并把完整发行目录复制到项目树外运行真实 PTY smoke；随后执行启动器八组回归、压缩去重构建和 `$RUNNER_TEMP` 中的单 exe 生命周期验收，全部通过后只上传 `dist/portable-win-x64/CopilotCC.exe` 作为公开 Windows 资产。完整目录和 PTY route 仅作中间产物/内部证据，不再公开上传 `ccc-bridge-win-x64.zip`。macOS runner 编 `ccc-bridge-darwin-arm64.dmg`（本机原生编译 → 组装标准 .app（悬索桥 icns、菜单栏驻留）→ swiftc 现场编译 arm64 托盘助手并跑协议冒烟 → 主程序 `--smoke` 运行自检 → ad-hoc 预签并校验 → dmg 附 Applications 快捷方式与一键解除隔离脚本，hdiutil 打包）、ubuntu runner 出扩展 zip（`wxt zip`，manifest 版本号自动取 tag）→ 汇总创建 GitHub Release。发布步骤读取完整 Git 历史，自动写入固定下载说明、上一 tag 到当前 tag 的非合并提交列表和 compare 链接，直接提交到 `main`、没有 PR 时也有实际更新条目。CI 门禁另对第三方预编译托盘组件做字节级架构审计（`check-arch.mjs`）——“构建成功 ≠ 能跑”，教训见 [TODO](../TODO.md)。GitHub Actions #42（run `43058589061`，提交 `d4ce58f`）已真实运行：Windows 通过，Ubuntu/macOS 均为 5 个测试文件失败、25 项失败、398 项通过、4 项跳过，失败发生在共同测试步骤，后续平台步骤没有执行。

2026-11-12 的跨平台测试修复保持生产行为不变：通用绝对路径夹具使用 `path.resolve(...)`，Windows 专用语义继续显式使用 `path.win32` / `platform: "win32"`，不放宽生产 `path.isAbsolute()` 校验；服务端测试通过可选 `ServerDeps.terminal.resolveCli` 注入确定性假 CLI，生产缺省仍调用真实 `resolveClaudeExecutable()`。两项注入值断言先 RED 后 GREEN，原失败五文件 36/36、bridge 427/427、启动器 8/8、extension 180/180、两端 typecheck 和扩展 production build 均已在本机通过。修复后的三平台结果必须由新提交对应的真实 Runner 证明；本地 Windows 全绿不能替代 POSIX CI，macOS CI 也不能替代 Terminal.app、原生 PTY、签名、Hook 跟随及退出/恢复实机验收。Release 仍未触发或发布。

上述修复由 `1123bea` 推送后触发 CI #43（run `43067186158`）。第一次 macOS 尝试因托管容量未获 Runner，`steps=[]`，不是测试失败；仅重跑失败项后，Ubuntu、Windows 完整通过，macOS 共同单测 423 通过、4 跳过。macOS 随后暴露独立的 PTY 探针准备缺陷：`auto` 的 Bun 与 helper 回退共享 `pty/node_modules`，却各自拒绝覆盖复制，helper 在 `node-pty/LICENSE` 处被 `EEXIST` 阻断。现由 `stagePtyDependencies()` 在两个依赖包全部复制后写完成标记，后续路线复用完整结果；无标记的同名目录明确报 `PTY_PROBE_DEPENDENCIES_INCOMPLETE`。新回归先 RED 后 2/2，跨目标负探针只证明复制冲突消失；Windows 真实 PTY 六项行为和双隔离通过，完整 bridge 429/429、启动器 8/8、extension 180/180 及两端 typecheck/build 通过。

`e4f1a75` 对应 CI #44（run `43146771064`）：Ubuntu、Windows 成功，macOS 共同测试 425 通过、4 跳过，且 `EEXIST` 已消失。Bun 与 helper 随后分别在 `spawn` / `spawn-helper` 阶段报 `posix_spawnp failed`。官方 `node-pty@1.1.0` tarball 的 Darwin arm64/x64 `spawn-helper` 都是 `0644`，因此暂存和发行复制都必须显式把目标副本恢复为 `0755`；`pty-native-permissions.mjs` 统一该操作，完成标记只在修复成功后写入，`verify-native-layout.mjs` 在 Darwin 主机额外拒绝无执行位的发行副本。测试的 `chmod` / `stat` 注入只验证逻辑，不冒充 macOS 原生执行。

三项权限回归先以 3 失败、8 通过取得 RED，实现后聚焦 11/11；完整 bridge 432/432、启动器 8/8、extension 180/180、两端 typecheck/build 和项目树外 Windows 真实 PTY 均通过。CI 中的 Node 24 警告只属于 checkout/setup-node Action 自身，项目与 PTY child 仍使用 Node 22.23.4。新 SHA 的 macOS Runner 必须另行证明真实 PTY、发行布局、项目树外 smoke 和扩展步骤；CI 通过也不替代 macOS 实机 Terminal.app、真实窗口、签名及产品交互验收。仍未打 tag 或发布 Release。

`34aab032cc4eb97a59605d7786e750ae84117832` 对应 CI #45（run `43152101342`）：Ubuntu、Windows 成功，macOS 共同测试 1 个文件失败、36 个通过、2 个跳过，1 项失败、427 项通过、4 项跳过。失败发生在“auto 回退复用完整暂存”用例，旧夹具只有最小依赖包，缺少生产 Darwin 分支按真实包结构要求存在的 `prebuilds/darwin-arm64/spawn-helper`，因此 chmod 报 `ENOENT`；真实 PTY、发行布局、项目树外 smoke、artifact 与扩展后续步骤均未执行。这不是原生 `posix_spawnp` 的复现，也不能作为执行位修复已通过 macOS 原生验证的证据。

该夹具修复先只注入 Darwin arm64，在 Windows 复现同一 `ENOENT` RED，再仅补最小 helper 文件，不放宽生产缺失文件校验。聚焦两文件 11/11；最新完整 bridge 432/432、启动器 8/8、extension 180/180、两端 typecheck 和扩展 production build 均通过，仅有既有大 chunk 警告。新提交的 macOS Runner 必须重新证明共同测试、至少一条 PTY 路线六项行为、发行执行位与项目树外 smoke；即使 CI 全绿，macOS 实机 Terminal.app、真实窗口、签名及产品交互仍未验收，仍未打 tag 或发布 Release。

`1ee42d0d1f54db49ad7f22ef7b005b86c02af36b` 对应 CI #46（run `43153732333`）已 `completed / success`，Ubuntu、macOS、Windows 全部成功。macOS 共同测试 428 通过、4 跳过；`auto` 在 Bun 路线 `initial-size_TIMEOUT` 后回退并选择 `node-helper`，初始尺寸、输入、连续 tick、中文、resize、exit 7 与 CWD/原生依赖双隔离全 true，因此不能宣称 Bun 与 helper 两路线都通过。随后 Darwin 发行构建、arm64 布局校验、项目树外真实 smoke 和扩展步骤均成功，外部 smoke 六项行为也全 true、`backend=node-helper`。这构成 macOS Runner 原生与发行证据，不替代 macOS 实机 Terminal.app、真实窗口、签名、GUI 产品交互或真实 API 中转验收；未打 tag、未发布 Release。

Release #37（run `43164913706`）随后暴露了平面 PTY 测试未覆盖的 `.app` 整包签名问题：`Contents/MacOS/pty/node_modules` 中的 `node_addon_api.gyp` 被 codesign 当作未签名子组件。修复不是追加 `--deep` 或跳过校验，而是由 `stage-mac-pty.mjs` 统一生成代码/资源分离布局：Mach-O 位于 `Contents/MacOS`，JS、JSON、`.gyp` 与 manifest 位于 `Contents/Resources`。签名前校验白名单、manifest、原始哈希和 Darwin 执行位，依次签内层、主程序、整包；签名后的完整副本使用 `codesign --verify --deep --strict` 与真实 PTY smoke，不再重复比较会随签名变化的 Mach-O 原始哈希。

运行时同步区分 Resources 与 MacOS：manifest/helper 脚本从 Resources 读取，helper Node 和 `spawn-helper` 从 MacOS 获取；Darwin 发行加载器保留平面优先逻辑，仅在确认的 `.app` Resources 中回退加载 MacOS 的 `pty.node`，并保持 `native.dir` 与 helper 同目录。普通 macOS CI 已新增真实 `.app` 签名、签名后项目树外 PTY 与 DMG 门禁，避免到 tag Release 才发现同类问题。

本地修复先后取得 4 项路径/布局 RED 和 1 项 staging 模块缺失 RED；最终聚焦 45/45、bridge 437/437、启动器 8/8、extension 180/180，两端 typecheck、扩展 build、脚本语法、YAML 和 diff 检查通过。Windows 使用 Node 22.23.4 的项目树外真实 PTY 仍选择 `bun-node-pty`，六项行为、双隔离、完整布局及发行 smoke 全通过。

`88f805d14b6d568b2d5a557b7cda46da6df924a9` 对应 CI #48（run `43173448220`）已三平台全绿。macOS job `131031961213` 的真实 PTY/平面发行 smoke、真实 `.app` 签名、签名后项目树外 PTY、DMG、artifact 与扩展步骤均为 `success`；Ubuntu job `131031961412` 和 Windows job `131031961431` 也成功，Windows 绿色单文件及生命周期门禁通过。原始日志在当前未登录环境返回 403/404，因此这里记录的是 GitHub API 的 run/job/step 结论及脚本非零即失败语义，不声称已读取日志正文。未打 tag、未重发 Release，macOS 实机 GUI、真实 API 中转和 Bun 直路线仍未验收。

随后用户提供的 Release run `43177539200`（tag `v2026.11.12.2`，SHA `c59c36d`）原始日志证明上述签名修复在 CD 中确实成功：整包 codesign 深校验通过，签名后完整复制包的 PTY 六项行为全 true，DMG 和三类公开资产上传也成功。真正失败发生在 publish 汇总：`actions/download-artifact@v4` 的多行 `pattern: "bridge-*\nextension"` 被该 Action 固定 SHA 的源码交给单个 `Minimatch`，不会按换行拆分，因此找到 5 个 artifact 却下载 0 个，随后 `ls assets/` 退出 2，Release 创建步骤未执行。

publish 现改为分别按 `bridge-win`、`bridge-mac`、`extension` 三个固定名称下载到同一 `assets/`，任一缺失会直接失败，两个 PTY route 报告仍仅保留为内部证据。新增工作流回归先 RED 后 GREEN；完整 bridge 40 文件 438/438（含启动器 8/8）、extension 24 文件 180/180，两端 typecheck、扩展 production build 和 release YAML 解析通过。修复提交 `1fb226bafc7ac8ee33b94a65f8579cbeb8958304` 对应 CI #50（run `43181108593`）三平台成功，macOS job `131057021655` 的真实签名、签名后 PTY 与 DMG 步骤也成功。本次未创建 tag 或重发 Release，因此新 publish 配置仍需后续真实 tag 运行才能记为 CD 端到端通过，普通 CI 成功不能代替该证据。

### 2026-11-14 macOS arm64 实机交接

- 环境为 macOS 27.2.1 / Darwin 27.2.0 arm64、中文 `zh_CN.UTF-8`、Chrome 157.0.8103.39、应用内 Node 22.23.4；真实 Claude Code CLI 为 2.1.325。
- 系统终端原始链已完成真实 Release RED、底层固定错误定位、最小 Locale 修复和最终真实 Terminal.app GREEN。生产诊断只保留固定错误码或 Node 系统 `code`，不输出私有请求路径、正文或完整环境。
- 原始“插件终端窗口创建失败，未启动 Claude”在 Release/本地构建、冷/热 Worker、全屏和真实 sidePanel 中均未复现，仍无有效原始 RED 与根因。`extension/src/lib/terminal-window.ts`、后台与侧边栏未做无证据修改。
- 另行修复首次关窗后第二次打开失败：单 lease 清理曾误关共享 backend，导致第二次 `spawn()` 抛 `PTY_BACKEND_CLOSED`。此故障发生时窗口和 WS 已创建，不能当成原始窗口创建故障的修复。
- 最终真实 Chrome 综合验收覆盖 WS open/attach、PTY、xterm、ASCII/中文、复制粘贴、resize、连续输出、滚动、二次打开、刷新与退出清理，使用隔离假 CLI；真实 CLI + 本机假上游是在系统 Terminal.app 链验证。两轮均 `realApiCalled=false`，本轮 Chrome 已定向关闭并验证退出。
- 最终回归为 bridge 40 文件 / 444 项（38 文件 / 440 项通过，2 文件 / 4 项跳过）、extension 24 文件 / 180 项，两端 typecheck 和扩展 production build 通过。最终 DMG 为 87,163,702 字节，SHA-256 `cd1c1e73163cbda7698a6c09d2fe954dbb6f92b0391e4189dabe2d9e1d805666`，CRC、严格 ad-hoc 签名、arm64 和 node-helper PTY smoke 通过。Bun 直路线仍未通过。
- **交接总状态：未完成。** 精确阻塞是原始插件窗口创建故障没有可复现的产品 RED，因而无法做根因修复及该原始链的 RED→GREEN。证据分类和命令见 [RETURN-REPORT](../RETURN-REPORT.md) 与 [handoff-results/README](../handoff-results/README.md)。

## 许可证

[MIT](../LICENSE)
