# 双终端执行发现

## 2026-11-10 初始审查

- 当前分支：`main`，与 `origin/main` 对齐；工作区只有未跟踪的设计/计划文档、根目录 zip 和 JPG。
- 两份实现计划已读取；生产代码、测试和依赖尚未修改。
- 阶段 B 依赖阶段 A 的 lease/hooks/watcher/service，不能并行成两套会话系统。
- 阶段 A Task 1 首先修改 `shared/protocol.ts` 与 `bridge/tests/protocol.test.ts`，并生成 `bridge/src/protocol.ts`、`extension/src/lib/protocol.ts`。
- 后续还会修改 App、AliasBar、InputBox、server、生产入口、依赖锁文件、构建和 CI；这些已有文件需要明确授权。
- 阶段 B Task 3 的 File Map 写成 `extension/src/protocol.ts`，但实际同步目标及 Task 1 均为 `extension/src/lib/protocol.ts`；执行到该任务时以唯一真实路径为准并修正文档。
- 阶段 A Task 6 的 `TerminalServiceDeps` 示例未列出 `privateDir`，但 `ServerDeps.terminal` 已包含它；实现时需把 `privateDir: string` 明确加入 service 依赖，避免 open 时缺少私有目录来源。
- 当前没有生产故障或测试失败证据；不能把计划审查修正描述成软件问题已修复。
- 真实 CLI 2.1.316 探针推翻了计划中的 HTTP 版本假设：HTTP Hook 10 秒未到达，本机假上游收到 3 次请求；同环境 command Hook 成功收到 `SessionStart(startup)`。因此 `selectHookTransport()` 当前固定 command，HTTP settings/handler 仅保留协议能力，后续只有在真实探针成功后才能按版本启用。
- command helper 两个生产入口均只走显式 `--terminal-hook`；`process.env` 的键必须允许缺失，不能使用把键标成必存在的 `Pick<ProcessEnv, …>`。
- server 通过 `TerminalHookHttpDeps` 窄接口接 lease；公开协议和 HTTP 响应都不包含私有 token。
- Task 5 的私有 request/可见 launcher 均不含 hook token；command helper 所需 URL/token 只由包装进程从私有文件放进 CLI 子进程环境。
- 系统终端句柄跟踪包装进程写出的 `status.json` 与真实 CLI 的 `exit.json`，不能把 wt/osascript 启动器返回当成 Claude 退出；停止通过私有 stop 文件发起。
- 重启存活核对使用 PID、规范化可执行路径和 OS 启动时间三项，不接受仅 PID 相同。
- Task 5 聚焦 15/15、桥接完整 333/333 和 typecheck 已通过；这些都是假 spawn/假 CLI 证据，不等于真实窗口或生产装配验收。
- 曾误写项目外 `D:\SVN_Cursor\bridge\tests\terminal-child.test.ts`，正确文件已在项目内；误写文件仍待用户确认后才能删除。
- 重启恢复必须先建立只读 lease，再恢复文件夹绑定和 watcher：若先 `bindFolder/openSession`，会在仍存活的终端之外创建 SDK Query，形成双写。恢复绑定路径通过 `terminal.isActive()` 禁止打开 Query。
- 系统 lease 私有记录只在 system 非 idle 状态保存，idle 按上一次 leaseId 原子清除；已存在合法 exit.json 时优先走真实退出，不再查询进程身份。身份匹配只接管退出监控，不重开窗口；unknown 保持只读且只有人工确认后清 lease，不写 stop 文件或杀进程。
- CLI 与托盘生产入口现在共用 `SystemTerminalAdapter.start/recover`，私有目录固定为 `<configDir>/terminal`。Task 6 最终证据为聚焦 92/92、bridge 完整 27 文件 342/342、typecheck 通过；仍不是实际窗口或 Chrome 验收。
- App 的历史、实时消息与终端镜像共用 `upsertUiMessage`/`toUiMessage`，不再维护第二份工具行更新逻辑；镜像先核对当前 sessionId 再比较 revision，同会话 upsert 保留已加载旧分页，只有切换会话才清空旧视图。
- 长寿命 WebSocket 回调通过 `sessionIdRef` 与 `terminalControlledRef` 读取最新会话和接管状态；React 首轮闭包不能作为镜像归属或写操作防线的依据，服务端 READ_ONLY guard 仍是权威防线。
- 接管只禁写而不伪造 busy：草稿保留，输入、设置、换绑、别名/会话写操作和四类交互作答禁用；复制续聊、打开文件夹、历史展开/分页保持可用。degraded、后端回退和错误均位于折叠详情之外。
- Task 7 完整证据为扩展 20 文件 158/158、typecheck 和 production build 通过；这仍是 App DOM/单元集成证据，不等于真实 Chrome、系统终端窗口或桥接重启验收。
- `green-8` 的真实证据只覆盖初始窗口/resume/SessionStart、双视图只读和服务端 READ_ONLY；`/clear` 未到达，后续场景均未执行。`green-9` 的 ConsoleShim 没有改变结果，实际假 CLI 出现 `stdin-eof`，截图空白。
- Windows 构建对托盘 exe 使用 `--windows-hide-console`，而 `terminal-child` 又通过 `stdio: "inherit"` 启动交互 CLI。GUI 子系统与可见终端控制台输入/输出不匹配是当前待验证根因；在 PE Console 对照探针完成前，不声称已修复生产链路。
- Windows 控制台探针必须只向隔离包装 PID 写入输入；`AttachConsole(pid)` 不会重定向既有 std handles，需显式打开 `CONIN$` 后调用 `WriteConsoleInputW`。这使 `green-15` 起的命令发送不再依赖前台焦点，也不会落入用户已有窗口。
- C# shim 中 `Console.In.ReadLineAsync()` 在该真实控制台路径仍同步阻塞调用线程，导致退出任务无法参与 `WaitAny`；改为 `Task.Run(() => Console.In.ReadLine())` 后，`green-22` 观察到 `child-exited → closing-input → child-exit`，真实 lease 退出恢复通过。这是验收 shim 修复，不是生产终端包装代码改动。
- 验收 `ControlClient.wait` 默认扫描全 inbox，close 前已有 idle 时必须记录起始索引，否则会把旧 idle 当关闭完成并提前强杀桥接。`green-24` 的残留 degraded lease 正是这一测试时序问题，不能据此修改生产持久化。
- 回退测试不能只把 PATH 缩为 System32：`process-identity.ts` 通过 PATH 中的 PowerShell 查询包装身份，过度收窄会在 status.json 之前失败。保留 PowerShell、仅隐藏 wt 后，`green-28` 的 `ConsoleWindowClass` 回退窗口真实可见且完整验收通过。
- `green-28` 的 required 全为 true，真实截图已查看，但它显式带有 `consoleSubsystemProbe=true`，只能证明 Console 子系统方案有效；最终仍需独立生产 Console 包装 exe、无 PE 补丁运行和最终负控。
- 最终 Windows 发行布局为同目录双 exe：`ccc-bridge.exe` 是 GUI 托盘，`ccc-terminal.exe` 是 Console 终端包装/command Hook helper。`terminalChildCommand()` 在 Windows 编译态固定选择后者，不能回退到已知会产生空白交互终端的 GUI exe；macOS 编译态仍使用原可执行文件。
- 阶段 B 原生构建实探：Node 22.23.4 configure 成功，但 1.0.0 build 首先因 Spectre 库缺失报 MSB8040；仅本次覆盖 Spectre 属性后继续暴露 ConPTY PFN 类型未声明与 winpty.cc `goto` 跳过初始化等源码/MSVC 错误。没有把这些失败记作成功，也没有修改第三方源码。
- 当前稳定版 node-pty 1.1.0 改用 N-API，npm tar 已核验发布 SHA-512，286 个条目无绝对路径或 `..`。包内直接包含 win32-x64/win32-arm64 的 conpty/conpty_console_list/pty `.node`、OpenConsole/conpty.dll、winpty-agent/winpty.dll，以及 darwin-arm64/x64 的 pty.node/spawn-helper。计划据此锁定 1.1.0；仍须通过编译 exe 的输入、tick、中文、resize、exit 7 行为探针才能选路线。

- `final-run-1` 的唯一 helper 失败发生在人工解除之后：解除已按设计删除 lease/Hook 端点，再执行假 CLI `exit` 会产生无法转发的 SessionEnd，不是 managed 会话 Hook 失效。验收改用只针对已登记隔离窗口的 `WM_CLOSE`，并把 `hook-helper-stderr`/`hook-error` 零记录列为必需条件。
- 最终有效证据为 `red-final-2` 与 `final-run-2`：负控准确失败于 clear 不跟随；正常构建无 PE 补丁，全部 required 通过，Hook 失败和页面运行错误均为空。dist 与验收隔离 exe 的 SHA-256 分别一致，证明验收运行的是最终同一批产物。
- 已人工查看最终五张关键截图，真实窗口内容与双视图状态没有空白或伪造；最终汇总位于批准目录的 `system-verification.json`。该结果仍仅覆盖 Windows 系统终端与隔离假 CLI，不调用真实 API；macOS Terminal.app 未验收，阶段 B 的 xterm.js/真实 PTY 尚未开始。
- Task 2 两条生产路线共用 `PtyBackend/PtyProcess`。Bun 直接后端只从可执行文件旁的 `pty/node_modules/node-pty/lib/index.js` 绝对入口加载；Node 回退由编译型 Bun 主端通过本地 stdin/stdout JSONL 启动随包 Node 22 helper，未开放 HTTP/WS 端口。
- helper 主端的 `started` 与首屏 data 可处于同一批 stdout；若只在 await spawn 后注册回调而不缓存，初始尺寸会丢失。已用有效 RED 固定并在两种适配器补发订阅前输出，kill 后旧块清空且 exit 仍只分发一次。
- `pty-helper-green-1` 使用真实编译产物验证 Node helper：初始 80×24、输入后的中文响应、连续五 tick、132×36、exit 7 与隔离布局均通过；`pty-auto-2` 仍选择 bun-node-pty。bridge 完整 29 文件 353/353 和 typecheck 通过，尚不等于 xterm.js 或 Chrome 内嵌终端验收。
- Task 3 的共享协议不能用 Node Buffer 计算输入大小，浏览器端统一使用 TextEncoder；先用 UTF-16 长度作廉价上界，再精确限制 UTF-8 为 65,536 字节。attachToken 只接受 43 位 base64url，afterSeq 只接受非负安全整数。
- 输出缓冲 clear 后即使暂时没有保留块，旧 afterSeq 也必须 gap=true；否则关闭/清理期间会伪造连续屏幕。单块超过 1 MiB 保留完整字符串，seq 永不因 clear 回退。bridge 360/360、extension 158/158 和两端 typecheck 已通过。
- Task 4 的 embedded 持久化与 system 分离为 `embedded-lease.json`；PTY 退出先写 `<leaseId>.exit.json`，启动即退出也由 adapter 缓存并补发给迟到的 lease 订阅。异常重启已有 exit 文件不查身份，身份三项完全匹配才允许定向 recover，unknown 保持只读且人工解除不杀进程。
- 生产原生路线只读 exe 旁 `pty-manifest.json`，不从仓库 node_modules 猜测或静默换线；manifest 缺失时构造不阻塞普通聊天/系统终端，只有 embedded spawn 报 `PTY_UNAVAILABLE`。
- 真实 `task4-smoke-1` 编译产物证明生产入口的 bun-node-pty 冒烟覆盖初始 80×24、输入后的中文、五 tick、132×36 与 exit 7；缺原生清单及无初始输出的异常 CLI 都非零失败。按隔离可执行路径复核无残留，但这仍不是 xterm.js/Chrome 真实窗口证据。
- Task 5 的 `TerminalClient` 只在认证成功后的动态 hello 闭包中 open/attach；leaseId、attachToken、lastSeq 仅保存于终端页实例内存。窗口由 background 创建成功后才加载页面并发起 WS open，聊天侧 WS 不承担 embedded open。
- background 原有监听器只认领 `ccc.*`，会使新增的 `terminal.open-window` 静默无应答；真实入口回归先复现 false，再精确放行此消息。仅测试 `openTerminalWindow()` 或模拟 runtime 无法发现该层问题。
- 独立终端页已接入真实 xterm.js、FitAddon、WebLinksAddon 与 ResizeObserver，attached 后立即同步 fit 行列；pagehide 幂等 closePage，React 清理只断开 WS。构建已生成 `terminal.html`，扩展 172/172 与 typecheck/build 通过；这些仍不代替真实 Chrome 中文 IME、输出重放和进程清理验收。
- `node-pty@1.1.0/package.json` 声明 `node-addon-api` 为 dependency；完整发行布局不能只复制 node-pty 自身。新增 manifest 精确路径断言先失败后，两种路线都携带该依赖，verify 也把它列为必需文件。
- Windows Git Bash 的 `$PWD` 是 `/d/...` 形式，不应交给 Windows Node 当发行绝对路径；CI/Release 改用 runner 提供的 `GITHUB_WORKSPACE`。本地真实构建/校验使用 `D:/...` 绝对路径并通过。
- `task6-package-smoke-1` 证明完整复制目录在项目树外可独立加载真实 ConPTY；`task6-package-missing-1` 证明缺 conpty.node 时 verify 与 smoke 均失败。冒烟原生加载错误不冒充 manifest 缺失时的 `PTY_UNAVAILABLE`，证据按实际输出记录。
- Release 汇总只下载 `bridge-*` 与 `extension` artifacts，避免 Windows/macOS 同名 `pty-route.json` 冲突或进入公开下载。macOS 当前仅有签名顺序 dry-run 和脚本语法/YAML 检查，没有真机签名或 PTY 证据。
- 真实服务器只接受 WS `/ws`，TerminalApp 曾连接 `/?token=`，组件精确 URL 测试先 RED 后修复为 `/ws?token=`。该问题说明 production build 和 mocked client 不能替代真实桥接握手。
- 现有生产契约中，非持有连接的 `terminal.input`/`terminal.resize` 返回 `ATTACH_REQUIRED`，`terminal.close` 返回 `NOT_OWNER`；真实验收按这三个实际错误码分别核对，不为匹配旧计划概括修改生产行为。
- `server.close()` 会 `await terminal?.closeEmbedded()`，但 `cmdStart()` 当前只注册 `releaseRuntimeOnExit()`，SIGINT/SIGTERM 路径未调用 `server.close()`；Windows `child.kill()` 也不能证明正常关闭。需先为生产正常关闭建立有效 RED，再接通真实退出路径，不能用强杀或单测冒充桥接关闭清理证据。
- 新验收代理只记录连接号、方向、帧类型、leaseId、seq/afterSeq、行列等脱敏元数据；attachToken、hook token、配对 token 和原始敏感帧不进入证据文件。
- `embedded-red-1` 是有效真实负控：首次 attach 已在客户端帧日志中出现但被代理精确丢弃，服务未发 attached，最终 required 在该项非零失败；认证、opened、窗口和 resume 已先成功，排除了准备阶段失败冒充 RED。隔离 Console 桥接、Chrome、PTY 的定向清理复核均为零残留。
- Windows 正常退出实探使用独立 `ccc-terminal.exe start` Console 与窗口探针的 Ctrl+C；探针在发送前枚举控制台进程，若与验收父进程共享控制台则拒绝广播。强杀仍只用于异常重启夹具和 finally 兜底，不作为正常关闭证据。
- `embedded-green-1/2` 的 ASCII 超时不是输入链断裂：失败截图显示 `hello embedded` 与第二个提示符，代理记录两次 `terminal.input`、随后 output seq 6/7 和三视图镜像更新，隔离 JSONL 同时含有该用户行与 `FAKE_ECHO` 助手行。根因是正常假 CLI 的 `appendAssistant()` 只写转录，未像真实 CLI 一样把回复写回 PTY；验收等待终端中的 `FAKE_ECHO` 因夹具缺少输出而失败。保留该真实 RED，仅给隔离假 CLI 补同样的 stdout 回复，不修改生产输入代码。
- `embedded-green-2` 的失败时页面仍处于“终端已连接”，焦点在 xterm helper；清理复核 `remaining=[]`、`errors=[]`。后续中文、IME、tick、resize 等未执行字段不能解释为各自已失败。
- 给隔离假 CLI 补 stdout 回复后，`embedded-green-3` 的真实截图已清晰显示 `FAKE_ECHO: hello embedded`，输入与 PTY 输出链因此得到实际证据；脚本仍在同一等待处超时，说明当前第二个问题是验收 DOM 读取，不是生产终端行为。`.xterm-rows.textContent` 没包含画布中新渲染的文本，后续改用脱敏代理只记录预期标记命中，并继续人工查看真实截图，不能把这个查询失败算作产品失败。
- `embedded-green-4` 的代理分别在 seq 7/9/11 命中 ASCII、中文和 IME 固定输出标记；真实截图同时显示三条回复且“组合输入”只出现一次，转录中该 IME 用户条目也只有一条。脚本随后真实失败于正常假 CLI 未实现 `/ticks on`，将其当作普通文本回复；这是下一项夹具 RED，不是生产 tick 缺陷。该轮清理仍为零残留。
- `embedded-green-5` 已命中 `TICK:3`，但尺寸轨迹暴露验收竞态：代理实际依次收到 130×36、132×36、153×36，脚本每轮却立即读取上一帧，因此过冲后以旧 130×36 报错。修复为每次 `Browser.setWindowBounds` 后等待新增 resize 帧并记录轨迹。
- 同轮截图与 JSONL 还发现夹具分支连接错误：新增 `/ticks on` 分支后，原 `/clear` 使用了新的独立 `if`，导致 tick 命令继续落入普通文本分支并写成 `FAKE_ECHO: /ticks on`。已把它接回同一 `else if` 链，并在验收中新增终端专用命令/回复不得进入 JSONL 的断言；生产镜像代码未改。
- `embedded-green-6` 首次构建因夹具 `return` 后多余大括号在编译阶段失败，未启动窗口；修正后，green-6～9 仍暴露 resize 等待竞态：实际 132×36 帧可能已到达，而脚本读取旧快照或从过晚的索引切片。最终改成一次 bounds 调整并等待目标帧，未通过放宽尺寸要求取得假绿。
- `embedded-green-10/11` 证明仅 normal 窗口尺寸和 `.xterm` 存在不足以保证页面可见；`document.visibilityState` 曾为 hidden。打开和输入前 `bringToFront`，并为验收 Chrome 禁用原生遮挡计算、后台窗口背景化与 renderer 背景节流后，`embedded-green-12` 才稳定取得 normal+visible 和真实 132×36 客户端帧。这些参数只用于隔离验收浏览器。
- 连续 tick 曾淹没 `/size` 后续证据；现已在 tick-3 后先停止 tick，再 resize，并由脱敏代理只记录数值型 `pty.size`，不保存终端正文。
- `embedded-green-13` 的同连接脱敏事件顺序为 `terminal.resize(132,36)` → `/size` 输入 → `pty.size(120,32)`，中间无 `terminal.error`；真实截图也显示 `SIZE:120x32`。该轮 `cleanup.remaining=[]`、`cleanup.errors=[]`。服务端到 `EmbeddedSession.resize()` 再到 `BunPtyProcess.raw.resize()` 的源码路径存在，但 mock 测试不能证明原生尺寸已应用。
- 已通过的真实 `--pty-smoke` 与正常假 CLI 的关键差异是：smoke 在 stdout 上注册 `resize` 监听器并随事件写尺寸；正常 `/size` 只读取 `process.stdout.columns/rows`。需以同一原生包和正常 CLI 做最小对照，区分 Bun 假 CLI 的尺寸属性未刷新与生产 resize 未应用；禁止把 `/size` 改成硬编码 132×36。
- `normal-resize-probe-1/2` 使用 Node 22 直接加载 green-13 同一原生包，正常 Bun 假 CLI 均在 resize 后报告 120×32，且 exit 0、remaining 0；空 resize 监听没有作用。probe-3 等待真实事件时超时。将正常 readline 从 `terminal:false` 改为交互模式后，probe-4 依次取得真实 `RESIZE:132x36`、`SIZE:132x36`、exit 0 和 remaining 0。根因是隔离假 CLI 的非交互 readline 没有像真实 CLI/smoke 一样接收 ConPTY 尺寸通知，不是生产桥接缺陷。
- `embedded-green-14` 的真实截图已出现 `RESIZE:132x36`，代理也收到 seq 18；但旧 `size-132x36` marker 会误匹配 RESIZE 子串，新 `\bRESIZE` 又会因 ANSI 序列尾字符与 R 相邻而失去词边界。证据同时含正确记录的首个 130×36 事件，说明是验收解析差异。现删除误导性的固定 size marker，SIZE 用 `(?<!RE)SIZE` 排除 RESIZE，RESIZE 不使用词边界，并要求先等真实 132×36 事件再 `/size`。green-14 清理为 remaining/errors 双空。
- `embedded-green-15` 已越过当前正常主流程的全部已接入断言：独立窗口 normal+visible、窗口去重、认证先于 open、opened 后同连接 attach、初始 resume、ASCII/中文/IME、连续 tick、真实子进程 `RESIZE:132x36` 与独立 `/size` 的 `SIZE:132x36`、双视图只读和草稿保留均为 true。JSONL 没有 ANSI、tick、SIZE、RESIZE 或终端专用命令泄漏，IME 未重复，`terminalCommandLeaks=[]`、`runtimeErrors=[]`，清理 remaining/errors 双空。脚本仍以“正常验收后续场景尚未接入”有意非零结束，因此不是完整验收通过。
- `embedded-green-16` 已真实通过 clear/resume/fork/compact Hooks、compact/Task/工具折叠展开、普通外部会话只进列表、11 类 READ_ONLY、非 owner 两次 ATTACH_REQUIRED 与一次 NOT_OWNER、普通聊天断线不影响 PTY、3 秒内同 lease 连续重放，以及 embedded 活跃时拒绝系统终端。结束按钮后真实页面显示 `终端已退出（exit）`，代理也收到定向 `terminal.exit`；失败仅在脚本误从非 owner 控制连接等待该定向帧。改为从 owner 代理连接取证，生产代码不变；本轮清理 remaining/errors 双空。
- `embedded-green-17` 已通过结束恢复和双向互斥，但无会话参数断言发现 `session.new` 会同步 `openSession(undefined)`，SDK 初始化先到时终端会收到 `--resume`。这不是可重复的无会话准备方式。隔离假 CLI 新增仅 stream-json 的延迟初始化开关后，`embedded-green-18` 的真实 CLI 启动记录证明无会话时使用桥接生成的 `--session-id` UUID；本批其余字段全 true，重连 1015ms，runtimeErrors 和清理均为空，仍仅失败于后续生命周期占位。
- `embedded-green-19` 的真实无会话启动参数正确，但持久化记录暴露新缺口：Hook 可在后端启动返回前把 active 写入磁盘；紧随 opened 的补存失败后，记录永久停在 backend/PID/identity 空值。不能因此放宽恢复身份门槛。`terminal-store.test.ts` 以一次 EPERM 精确复现原子替换失败并先 RED；`renameWithRetry` 仅对暂时性占用做三次有界等待重试，其他错误仍抛出并保持只读。聚焦 15/15、typecheck 与真实发行构建通过，待 green-20 原生场景复验。
- `embedded-green-20` 证明身份补存修复已越过无会话 UUID、3074ms 重连超时和刷新新 lease/旧 PTY 清理。输出缺口的脱敏事件顺序为：代理丢弃 seq 9、页面收到 seq 10、客户端定向发送 close、服务随后发送 exit；PTY 确实关闭，但 `terminal.exit` 把 error 覆盖成 exited，页面最终只显示通用退出。新增客户端回归先复现 phase 被覆盖，再让致命错误后的退出保留原错误、追加退出原因并保存退出码；正常退出仍维持 exited。聚焦 9/9、typecheck 和 production build 通过，等待 green-21 真实复验。
- `embedded-green-22` 的真实 Chrome 复验确认 `outputGapVisibleAndCloses=true` 和 `pagehideClosesOwnedPty=true`，客户端 fatal error 保留修复不是只有单测证据。首次 `stopBridge(true)` 的 `AttachConsole(interrupt)` 失败使后续场景未执行，不能把相应 false 字段解释为生产失败；本轮 runtimeErrors 和 cleanup 均为空。
- Console 最小探针必须按真实目标 PID 等待退出；启动器 ChildProcess 尚无 exit 事件不能推出目标已退出。C# 对照、Node 与 Bun 对照都需要在处理器注册完成后再写 ready 文件，避免就绪竞态。
- `GenerateConsoleCtrlEvent` 返回 true 不等于目标执行处理器。probe-15～20 中 C# 原生 `SetConsoleCtrlHandler` 同样没有记录事件，且 WriteConsoleInput 也未产生正常退出；这排除了“只是 JS 回调问题”的简单解释。`CREATE_NEW_PROCESS_GROUP` 曾被怀疑为根因，但移除后仍未通过，不能作为最终结论。
- probe-24 与 probe-25（后者非沙箱）都显示隔离 Console 可见、矩形正常，但 `GetForegroundWindow()=0`；安全前台检查阻止了 SendKeys，未向任何用户窗口发送按键，两轮 `remaining=[]`。因此应查输入桌面/窗口站并寻找精确 PID/窗口句柄的正常关闭路径，不能声称 Ctrl+C 已发送而程序未响应。
- probe-26 证明当前自动化上下文为 WinSta0/Default，但 `OpenInputDesktop` 拒绝访问（5）；这解释前台输入限制，不要求产品依赖桌面焦点。对独占 Console 的精确 WM_CLOSE 能触发原生 CTRL_CLOSE_EVENT，C# 目标 exit 0 且无残留。
- probe-27 揭示真实生产缺口：同一 WM_CLOSE 让桥接以 0xC000013A 退出，但 runtime.json 未释放，不能算正常关闭。Windows Console 关窗需要与 SIGHUP 清理路径对应；`runtime.test.ts` 参数化 SIGHUP 后先失败，再加入现有 `releaseRuntimeOnExit` 信号循环取得 GREEN。
- probe-28/29 的真实编译桥接均证明 WM_CLOSE 后 exitCode=0、runtimeReleased=true、remaining=[]。完整验收现按启动器 PID 与真实桥接 PID 分别跟踪，正常关闭与异常强杀都有身份/清理断言；不能用启动器退出或窗口消失替代 owned PTY 退出证据。
- `embedded-green-23` 区分了两个生命周期条件：owned PTY 已退出不等于 lease 已完成退出清理。`PtyProcess.kill()` 只发出请求，`EmbeddedSession.close()` 随即清内存并关闭 backend；PTY exit 回调又只同步调用一个启动异步 `completeExit()` 的函数，因此 `server.close()` 可在最终镜像、SDK 恢复和私有记录清除之前返回。重启发现无 exit 文件的旧记录后保持 degraded/unknown 是正确安全行为，修复应补正常关闭完成屏障，而不是放宽身份核验或猜杀进程。
- 关闭修复没有伪造 exit 或跳过清理：`TerminalRuntimeHandle.onExit` 的回调现在可返回 Promise，lease 的两个注册点返回同一个 `completeExit().catch(...)`；adapter 的 close 顺序为 session.kill → 真实 exited → 全部 exitCleanup → backend.close。这样 node-helper 在 exit 帧前仍存活，正常服务关闭也会等最终镜像和恢复完成。两条 RED 分别覆盖 Server 完整链路和异步回调屏障，修复后聚焦 21/21、bridge 401/401。
- `embedded-green-24` 证明正常关闭屏障已越过原失败点；新的失败位于 `stopBridge()` 强杀之后、`startBridge()` recover 之前，原 ConPTY 子进程已不存在，所以当时没有发生生产 recover 杀进程。当前恢复实现只识别 exit 文件或身份匹配，对“PID 已确认不存在且无 exit 文件”仍落 unknown；需要以回归明确计划中的进程已退出清理语义，并把仍存活身份匹配场景与 ConPTY 自动退出行为分开验收。
- `embedded-green-25` 的私有 lease 文件消失与 `terminal.state(idle)` WS 投递不是同一个同步完成点。`startBridge()` 只保证控制 WS open，因此文件等待返回后立即读 `terminalState()` 仍可能为 null。恢复验收必须从 startBridge 后的 inbox 索引等待新 idle，再断言公开状态；这与此前 close 旧 idle 竞态同类，不能用同步文件状态代替协议完成证据。
- `embedded-green-26` 的原生失败后系统终端于 `2026-11-11T00:14:53.057Z` 完成恢复，目标转录最后一条启动记录为 `00:14:53.090Z`；普通聊天的 `chat.user` 广播为 `00:14:53.921Z`。因此现有 SDK CLI 是先由 `restoreSdk()` 创建、后被聊天复用，不应要求每次 `chat.send` 新建进程。假 CLI 的 stream-json 分支只回控制请求并直接 return，没有处理 `type=user`，故当前没有 `chat.delta`/`chat.done` 或聊天转录证据。验收应登记这个恢复 PID，并要求同一 PID 收到固定聊天标记、返回流式回复和 result；这才同时证明复用与普通聊天真实可用。
- `embedded-green-27` 证明修正后的取证链完整成立：原生 PTY 不可用时插件终端明确失败，系统终端仍可运行并正常退出，随后同一个恢复 SDK PID 收到 `NATIVE_FAILURE_CHAT_ACCEPTED`，返回固定流式回复、完成 `chat.done`，用户与助手文本均进入隔离 JSONL。该轮所有必需布尔项均为 true，Hook 失败、页面运行错误、真实上游请求和最终进程/窗口清理残留均为零；这不是真实 API 或 macOS 验收证据。
- `embedded-green-28` 在相同完整链路上第二次全部通过，并补充两类此前没有定格的画面证据：真实丢弃 seq 9 后，终端页同时保留“输出序号不连续”、`exit` 和真实退出码；原生 manifest 缺失后，独立 WindowsTerminal 窗口仍真实可见并显示假 CLI 提示符。两轮最终 cleanup 都没有本轮窗口/进程残留。

## 2026-11-11 真实 Claude Code CLI 恢复补验

- 旧 `green-27/28` 的 `resumedCorrectSession=true` 只证明隔离假 CLI 收到正确参数并模拟 Hook/转录，不证明真实 Claude Code 会加载既有 CC 上下文。
- `real-cli-resume-20261111-01/02` 的假上游只接受精确 `/v1/messages`，真实 CLI 实际请求 `/v1/messages?beta=true`，两轮均为夹具准备失败；改为解析 URL pathname 后，`real-cli-resume-20261111-03` 的真实 CLI 2.1.316 九项检查全部通过。第二轮请求包含首轮用户和首轮助手的独特标记、消息数由 2 增至 4，同一 sessionId JSONL 同时包含两轮内容；仅访问 127.0.0.1 假上游，`realApiCalled=false`。
- `real-cli-dual-terminal-20261111-01～04` 依次停在真实 CLI 首次交互式主题、dummy API key 确认和目录信任页。默认 No 不能直接按 Enter 当作信任；后续加入方向键和选中行确认。各轮没有形成真实双终端续聊证据，但定向 cleanup remaining/errors 均为空。
- `real-cli-dual-terminal-20261111-05` 的最终截图显示主题页，而记录的三个 PromptSeen 全 false；根因是验收只在 attached 后立即读取一次空画面，随后没有重新识别主题页，因此方向键/选中确认代码根本没有执行。这是已定位的验收状态机竞态，不是生产 resume 缺陷。第 06 轮改为等待真实主题/API key/信任/active Hook 状态，并只在选中 Yes 后提交。
- `real-cli-dual-terminal-20261111-06` 已越过主题和 API key，但失败于目录信任选中等待。最终截图实际是 `Security notes / Press Enter to continue`，不是目录选项；通用 `/trust/` 误匹配了说明中的 `code you trust`，方向键没有对应选项可选。下一轮只精确识别 Security notes 与 `Yes, I trust this folder`，先确认说明再处理目录信任，不发送无目标方向键；本轮 cleanup remaining/errors 双空。
- `real-cli-dual-terminal-20261111-08` 已取得真实插件终端 active Hook 和续聊请求，请求含首轮用户/助手且 messageCount=5，画面也显示新旧两轮回复；但同一 JSONL 没有本轮内容。截图底部明确给出根因：`Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker`。验收从当前 Claude Code 环境继承了子会话标记，真实 CLI 按设计关闭交互转录，不是生产镜像或 resume 写入缺陷。下一轮只删除隔离 env 的该标记，不设置强制持久化；另将隔离 projects 预置键改为 CLI 实际使用的正斜杠 Windows 路径。
- `real-cli-dual-terminal-20261111-09` 的插件终端已通过真实旧上下文、同一 JSONL、双视图镜像和关闭恢复，首次向导完全跳过，系统终端也已真实 resume。第三条请求 messageCount=7 且含首轮上下文，但夹具因整段历史含 embeddedUser 把它误分类为 embedded，导致等待 system 超时。阶段分类改为只看最新用户消息，完整 serialized 仍只用于历史上下文布尔断言；本轮 cleanup remaining/errors 双空。
- 直接真实 CLI `real-cli-resume-20261111-04` 在删除继承的 `CLAUDE_CODE_CHILD_SESSION` 后再次九项全通过，与 03 相互复证；两轮均未访问真实 API。
- `real-cli-dual-terminal-20261111-10` 已证明真实系统终端 resume、旧上下文、同一 JSONL 和双视图镜像；失败仅在 WM_CLOSE 后的恢复。系统 lease 目录只有 status.json，没有 exit.json，且代理尾部没有本轮 idle。原控制等待没有记录关闭后的 inbox 起始索引，可能立即匹配插件终端关闭时的旧 idle，因此后续 UI 超时不能单独证明生产恢复缺陷。
- 系统适配器当前仅轮询 exit.json，活跃期间没有包装 PID 消失的回退通知；这与内嵌终端恢复时“ESRCH 且无 exit 文件也可完成退出”的既有处理不同。若第 11 轮证明关窗后包装进程已消失而 lease 仍 active，即构成生产 RED：需先增加系统运行时存活监测回归，再只在明确 ESRCH 时释放；权限或查询错误仍必须保持只读。若包装进程持续存活，则应改用真实 CLI 的 `/exit` 验证正常退出，不把窗口关闭等同于 CLI 退出。
- 原验收没有把系统包装 PID 放入 ownedProcesses，旧 cleanup.remaining=[] 并未覆盖这类进程。第 11 轮起按 PID+可执行路径+启动时间登记系统包装进程，避免清理证据漏项。
- `real-cli-dual-terminal-20261111-11` 的关窗采样在 0ms 即记录 `processAlive=false`、`exitFile=false`、`phase=active`，随后新 idle 等待超时；这排除了 CLI/包装进程仍存活，确认生产缺口是活跃系统 lease 只读 exit.json。Windows Terminal 可直接结束整个进程树，包装进程的 CLI exit 回调没有机会写文件。
- 修复复用 `process-identity.ts` 的 `isProcessAlive()`：只有明确 ESRCH 才返回 false，EPERM 和其他查询错误保持 true。运行时仍优先采用真实 exit.json；仅无文件且包装 PID 确认消失时补发 `process-exit`，后续仍走 lease 既有最终镜像、SDK 恢复与 idle 链。新增回归修复前退出回调 0 次，修复后同文件 6/6。
- 第 12 轮在相同关窗条件下取得真实 GREEN：采样仍为 `processAlive=false`、`exitFile=false`，但本次关窗后的新 idle 到达，`realCliSystemExitRestored=true`、双视图恢复可写、`realCliBridgeShutdownClean=true`，cleanup remaining/errors 双空。说明最小 PID 存活监测修复覆盖了原生产根因，无需改变 Hook、镜像或身份核验规则。
- 三类证据保持区分：直接真实 CLI 03/04 证明 CC 上下文恢复；真实 CLI 双终端 12 证明两个入口的 resume、旧上下文、镜像、退出和正常关闭；假 CLI `embedded-post-system-close-fix-20261111-01` 证明完整协议/生命周期没有被系统适配器改动破坏。三者均只访问本机假上游，macOS 和 GitHub Runner 仍无运行证据。

## 2026-11-11 绿色单文件生命周期发现

- 两个 Bun 运行时 exe 的内容重复无法靠普通逐文件 ZIP Deflate 消除；固定 1 MiB 块跨文件去重把唯一未压缩数据降到 140,137,781 bytes，ZIP 为 54,099,161 bytes。启动后仍按原始 manifest 逐文件复核，不发布 storage 配方或 content pack。
- .NET Framework 的长路径开关必须在进程第一次 Path/IO 之前设置；仅在 `PortableRuntime` 静态构造中启用会因为调用者已经使用 Path 而无效。启动器内部对 runtime 路径统一使用 `\\?\`（UNC 用 `\\?\UNC\`），但 `CCC_PORTABLE_RUNTIME_DIR` 与 ProcessStartInfo 保持普通绝对路径，避免破坏 Node 侧目录归属校验。
- Windows 进程启动 ticks 约 6e17，不能用 JavaScript Number 传递后再做身份相等断言；探针现以十进制字符串序列化。每次 `processes` 快照还排除执行快照的探针自身，避免把已退出的短寿命探针误记为残留。
- Node `windowsHide:true` 会让正常 WinForms 进度窗也不可见；失败 MessageBox 可见不能反驳这一点。真实进度验收必须以 `windowsHide:false` 模拟用户双击，并用随进程同步监视抓图。第 04 轮真实证据没有人为延长解压或复用阶段。
- 绿色 GUI 内层正常退出已查明真实 native 链：本地 `systray2@2.1.4` 使用的 `felixhao28/systray-portable` 源码依赖 `getlantern/systray v1.1.0`；Windows 隐藏窗口类固定为 `SystrayClass`，`WM_COMMAND` 的 `wParam` 直接映射菜单 ID。当前托盘菜单依次是状态、复制配对串、修改端口、separator、退出，对应 ID 1～5，因此退出命令 ID 为 5。验收不得只凭这个常量发送：探针还必须核对 helper 的父 PID、隔离完整路径、启动 ticks，以及同 PID 的唯一隐藏 `SystrayClass` 窗口；随后以真实 server close、runtime 释放和 owned PTY 退出作为结果证据。
- 便携真实 CLI 的 `START_FAILED` 由 Windows 原生长路径加载引起：258 字符的 conpty.node 在 Bun `require(".node")` 中报 LoadLibrary 文件名过长，而 250 字符对照成功；文件本身存在且便携 manifest 完整。规范 `\\?\` 路径配合 `process.dlopen()` 可加载 conpty 和 271 字符的 conpty_console_list。普通 JS require 加扩展前缀在 Bun 中不受支持，不能用它替代 dlopen。
- 只修父进程 conpty 不足以覆盖生命周期：node-pty 默认 kill 会 fork `conpty_console_list_agent.js`，该子进程再次通过 utils.js 加载另一原生模块。`useConptyDll=true` 也不是规避方案，因为 conpty.cc 使用 `MAX_PATH` 的 GetModuleFileNameW/PathCombineW 定位 DLL，真实探针已失败。发行打包时统一修补 utils.js 的加载回退，才能让父进程与关闭子进程共享同一解决方案，且 manifest 记录修补后哈希。
- 生命周期第 05 轮证明 `PrintWindow` 返回 true、PNG 非空仍不足以证明进度已绘制：窗口身份正确，但人工查看发现客户区全黑，因此该轮不作为进度视觉证据。第 06 轮验收只在下半客户区检测到亮色像素后保存并通过，不修改生产启动器、不人为延时；最终截图真实显示“CopilotCC 正在启动”“正在解压当前组件”和绿色进度条，15 项必需断言全 true，源/副本 SHA-256 一致，cleanup remaining/errors 双空。
- xterm `paste()` 会把 CRLF/LF 统一为 CR，但不会为没有末尾换行的剪贴板文本额外提交最后一行。在未开启 bracketed paste 的 Node readline 中，`第一行\r第二行` 只提交第一行，第二行仍是可编辑输入；真实探针在显式 Enter 后依次得到两条 line 事件。验收必须区分“文本已粘贴”和“命令已执行”，生产代码不能为通过测试而自动补 Enter。
- `interaction-fix-real-portable-01` 推翻了当前生产“可见 transcript 且含 `[` 就发送导出键”的兼容性假设：本机真实 CLI 2.1.316 的 Ctrl+O 页脚明确是 `Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in notepad · ? for shortcuts`，可见文本没有 `[`。生产逻辑因此一直等待而没有盲发 `[`，超时不是按键丢失。此前诊断记录中的 `Ctrl+O → [` 导出结论不能直接覆盖这一真实画面，需查明版本/模式差异后按实际支持的滚动链修复，不能用放宽断言或盲按键冒充 GREEN。
- 后续只读核对本机 CLI 2.1.316 实际键表与既有真实导出记录后，根因进一步明确：`[` 并未删除，仍是 detailed viewer 的 `print to scrollback`，只是提示移入 `?` 帮助；普通画面的 `[`/`]` 则是上一条/下一条用户提示导航。正确最小修复是用 `Showing detailed transcript` 与 `↑↓ scroll` 同时确认详细视图，再发送 `[`；普通画面绝不发送。第二版“详细视图滚轮映射方向键”不作为最终替代方案，避免叠加未验收交互；真实验收继续要求原生 scrollHeight 增长、向上/向下滚轮实际移动 scrollTop，且滚轮不向 PTY 发送方向键。
- 最终真实证据 `interaction-fix-real-portable-02`：真实 CLI 的 Ctrl+O 与 `[` 均实际进入 PTY，导出后 xterm scrollHeight 从 526 增至 6222；真实 CDP 向上滚轮使 scrollTop 从 5696 移至 4976，向下从 4976 回到 5696，代理未观察到滚轮方向键。该轮同时通过真实系统/内嵌 resume、旧上下文、镜像、Ctrl+C 中断后继续、退出恢复和单 exe 正常关闭，且只访问本机假上游。
- 最终完整假 CLI 证据 `interaction-fix-embedded-05` 与真实系统专项 `interaction-fix-system-05` 互补覆盖：前者验证真实剪贴板、中文/IME、多行粘贴、resize、Hooks、重连与完整生命周期，后者验证 9637ms 慢启动成功不报错、20 秒最终超时取消及迟到 child 不启动。三轮最终 JSON 均无运行错误或清理残留；real-only 报告中非适用的假 CLI 字段保持 false，不把这些字段解读为功能失败。

## 2026-11-12 CI #42 跨平台失败发现

- Ubuntu 与 macOS 的 25 项失败不是 25 个独立产品缺陷，而是两个测试准备问题：12 项 Windows 字面路径被 POSIX `path.isAbsolute()` 拒绝；13 项 WS fixture 在假运行时之前被真实 CLI 解析门槛以 `CLI_NOT_FOUND` 阻断。Windows Runner 恰好能解析 Claude，因此同一提交在 Windows 通过，形成平台相关的隐式环境依赖。
- `TerminalService.openRuntime()` 先执行 `deps.resolveCli()`，再调用 system/embedded runtime；仅 mock 终端适配器不足以隔离 CLI 发现。把可选 `resolveCli` 放在服务端 terminal deps 装配层，可让每个 fixture 注入自己的临时路径，避免全局 `CLAUDE_CODE_PATH` 与 `cachedCliPath` 在测试间形成隐式耦合；生产默认仍是 `resolveClaudeExecutable`。
- 两个新增断言不仅检查 fixture 配置，还检查 system context 和实际 PTY spawn 收到的 `cliPath` / `file`。实现前二者都拿到本机真实 Claude 路径，证明测试能捕获原缺口；实现后同命令 20/20。通用路径夹具改用宿主 `path.resolve(...)`，但相对 cwd 负测试、平台不匹配负测试及 Windows 长路径/dlopen 语义均保留。
- 日志中的开发 Origin 放行、普通 stderr 和故意 `boom-测试异常` 均有对应预期场景，不应按关键词当作失败根因。有效统计来自完整日志：Ubuntu/macOS 各 5 文件、25 失败、398 通过、4 跳过；共同测试步骤失败使后续真实 PTY、发行布局和项目树外 smoke 没有运行，旧 #42 不能作为这些后续步骤的新证据。
- 本地修复证据为原失败五文件 36/36、bridge 427/427、启动器 8/8、extension 180/180，两端 typecheck 与扩展 build 通过。该证据只支持提交修复，不支持宣称 POSIX 已转绿；必须等待新提交的 Runner。即便 macOS CI 通过，也不等于 Terminal.app、原生 PTY、签名和真实窗口产品验收。

## 2026-11-12 CI #43 与 PTY 回退发现

- 六文件修复已提交为 `1123bea` 并推送；CI #43 run `43067186158` 第一次 macOS 尝试没有获得 hosted Runner，`runner_id=0`、`runner_name=""`、`steps=[]`，约 15 分钟后因容量取消。这不是测试失败；`rerun-failed-jobs` 只重跑未成功项。
- 第二次 macOS 共同单测为 36 文件通过、2 跳过，423 项通过、4 跳过，说明 #42 的 12+13 测试准备修复已在 POSIX 生效。Ubuntu、Windows 完整通过；Windows 的真实 PTY、完整发行布局、项目树外 smoke、绿色单文件、启动器、项目树外生命周期及扩展步骤均明确为 `success`。
- macOS 的新失败发生在共同单测之后。`auto` 先试 `bun-node-pty`，其运行时报告 `PTY_PROBE_ERROR` 的 `spawn` / `posix_spawnp failed`；helper 回退本应继续，但两条路线都向同一 `pty/node_modules` 执行 `cpSync(...,{force:false,errorOnExist:true})`，因此在第二次复制 `node-pty/LICENSE` 时以 `ERR_FS_CP_EEXIST` 终止。此时不能把 Bun 的首次错误当作最终原生路线结论。
- 修复把复制准备抽成 `stagePtyDependencies()`：仅在 `node-pty` 与 `node-addon-api` 均复制成功后写完成标记，后续路线据此复用；没有标记却存在同名目录时明确报 `PTY_PROBE_DEPENDENCIES_INCOMPLETE`，避免把中断留下的半成品当完整结果。没有放宽一次性根目录、真实 PTY 行为或项目树外隔离断言。
- 新回归先因暂存模块不存在 RED，实现后 2/2。跨目标负探针仍因 Windows 无法执行 Darwin 二进制而失败，但 helper 已越过准备阶段，证明复制冲突消失而非 macOS 原生通过。Windows 真实 PTY 重新取得 `bun-node-pty` 六项行为全 true、双隔离 true；探针内运行时字符串是编译程序报告，不能误写为 child 使用的 Node 22 版本。
- 修复后完整本地证据为 bridge 39 文件 429/429、启动器 8/8、extension 24 文件 180/180，两端 typecheck 与扩展 production build 通过。macOS helper 的原生行为、发行布局、项目树外 smoke 和扩展后续步骤仍须由新 SHA 的 Runner 证明；macOS 实机 Terminal.app、真实窗口、签名及产品交互仍未验收。

## 2026-11-12 CI #44 与 Darwin 执行位发现

- `e4f1a75` 对应 CI #44 run `43146771064`。Ubuntu、Windows 成功；macOS 共同测试 425 通过、4 跳过，随后 Bun 与 helper 分别在 `spawn` / `spawn-helper` 阶段报 `posix_spawnp failed`。日志已无 `EEXIST`，所以这不是旧复制冲突的重复，而是回退真正执行后暴露的共同原生问题。
- `node-pty` 的 Darwin 原生加载分两层：`pty.node` 是原生模块，Unix spawn 还执行同预编译目录的 `spawn-helper`。模块能加载不能证明 helper 能执行；`pty.cc` 对 helper 启动失败统一抛 `posix_spawnp failed`，与两条路线日志吻合。
- 官方 `node-pty@1.1.0` tarball 直接列出 `prebuilds/darwin-arm64/spawn-helper` 和 `darwin-x64/spawn-helper` 均为 `0644`，本机 arm64 文件又是正确 Mach-O，排除架构混用。修复只把暂存/发行副本恢复为 `0755`，不修改全局缓存或第三方源文件。
- GitHub 日志同时明确 `node-version: 22`、`node: v22.23.4`。Node 24 警告指 `actions/checkout@v4` 和 `actions/setup-node@v4` 自身原目标 Node 20 被强制升级，不改变项目测试或 PTY child 的 Node 22，不能用来掩盖确定性的权限缺陷。
- 三项测试先分别证明旧实现没有暂存 chmod、没有发行 chmod、没有拒绝 `0644`，共 3 失败、8 通过。共享 `ensureDarwinSpawnHelperExecutable()` 统一目标路径和 `0755`；暂存必须先成功再写完成标记，发行打包使用同一函数，`verifyNativeLayout()` 仅在 Darwin host 校验 Darwin 布局的执行位，避免把 Windows `stat` 当 POSIX 证据。测试注入只提供确定性调用/mode，不冒充 macOS 原生执行。
- 聚焦 11/11、bridge 432/432、启动器 8/8、extension 180/180、两端 typecheck/build 和 Windows 真实 PTY 均已通过。新 macOS CI 仍需独立证明至少一条路线六项行为、发行布局及执行位、项目树外 smoke 和扩展后续步骤；即便全绿，也不等于 macOS 实机产品验收。
