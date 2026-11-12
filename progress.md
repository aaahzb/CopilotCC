# 双终端执行日志

## 2026-11-10

- 用户选择 Inline Execution。
- 已加载并审查两份实施计划及当前 Git 状态。
- 已建立持久化执行记录：`task_plan.md`、`findings.md`、`progress.md`。
- 尚未创建分支、修改生产/测试文件、安装依赖或运行新功能测试。
- 用户已明确授权创建 `feature/dual-terminal` 并修改计划涉及的已有文件；分支已创建，未创建工作树。
- 阶段 A Task 1 RED：`npm --prefix bridge test -- tests/protocol.test.ts`，30 项中新增 2 项按预期失败（新终端帧返回 null），其余 28 项通过。
- 阶段 A Task 1 GREEN：同步协议后同一测试 30/30 通过，`npm --prefix bridge run typecheck` 退出码 0。
- 当前进入 Task 2；下一步先写 lease/store 失败测试。
- 阶段 A Task 2 RED：`terminal-lease`、`terminal-store` 模块不存在；最小实现后 lease/store 6/6 通过，bridge typecheck 退出码 0。
- 阶段 A Task 3 Hook/helper/degraded RED：相关模块不存在且 10 秒仍停留 starting；实现后四组测试 21/21 通过，bridge typecheck 退出码 0。
- 阶段 A Task 3 生产入口 RED：`entrypoints.test.ts` 新增 index/tray 显式 `--terminal-hook` 契约，2 项按预期失败。
- 入口 GREEN：index/tray 均只在显式分支运行 helper；`entrypoints.test.ts` 4/4、终端相关五组测试 25/25 通过。
- 类型修正：`Pick<ProcessEnv, …>` 把可选环境键误标为必存在，导致两个生产入口 typecheck 失败；改为显式可选键后，25/25 复测及 bridge typecheck 均通过，缺失 token 的运行时拒绝测试仍通过。
- 当前 Task 3 尚未完成：真实 CLI Hook 探针与 server HTTP 路由尚未验证/接线。
- Task 3 真实探针：本机 CLI 2.1.316 的 HTTP Hook 10 秒超时；同环境 command Hook 收到 `SessionStart(startup)`，`realApiCalled=false`。HTTP 不能按版本号启用，传输选择测试先 RED 后改为始终 command 并 GREEN。
- Task 3 HTTP 接收路由：handler 安全测试与 server 集成测试分别取得预期 RED；实现 405/401/404/409/413/422 固定响应、64 KiB 限制及 lease/cwd/transcript 校验后通过。
- Task 3 最终证据：`npm --prefix bridge test` 21 个文件、319/319 通过；`npm --prefix bridge run typecheck` 退出码 0。进入 Task 4。
- Task 4 RED：watcher/service/reducer 三个模块不存在，桥接两个 suite 与扩展一个 suite 按预期失败。
- Task 4 GREEN：250ms 防抖、2 秒对账、目录补挂、增删改快照、lease 当前会话镜像和 revision 防旧包实现后，bridge 3/3、extension 2/2 通过，两端 typecheck 退出码 0。
- 断言修正：Hook 切会话会自动推一包镜像，测试初稿漏算该既定行为；未删除或弱化生产校验。进入 Task 5。
- Task 5 RED：`system-terminal`、`terminal-child`、`process-identity` 与入口四组测试因新模块不存在而失败（4 个 suite，无测试可执行）。
- 操作失误：`terminal-child.test.ts` 首次误写到 `D:\SVN_Cursor\bridge\tests\`，随后在正确项目内重建；项目外误写文件未删除，清理需用户明确确认。
- Task 5 GREEN：实现 PID+可执行路径+启动时间身份解析、严格私有请求、环境继承、token 私有文件注入、退出/停止文件、wt/可见控制台/Terminal.app 启动和两个生产入口分发；聚焦四组 15/15 通过。
- 类型修正：`TerminalBackend` 改从 `protocol` 导入后，`npm --prefix bridge run typecheck` 退出码 0；`npm --prefix bridge test` 26 个文件、333/333 通过。
- 计划/spec 已按真实探针修正：CLI 2.1.316 不再被描述为已验证 HTTP Hook，生产 transport 固定 command；未经新实探不得按 semver 启用 HTTP。
- 进入 Task 6；尚未做生产 Server/TerminalService 装配、真实终端窗口、Chrome、原生 PTY 或 macOS 验收，未提交、推送或发布。
- Task 6 首轮 RED：`server-terminal.test.ts` 三项均等待 `terminal.opened` 超时。完成唯一 TerminalService、SDK suspend/restore、watcher 绑定、生产 Hook 路由、终端消息分支、owner、快照和统一 READ_ONLY guard 后，同一文件 3/3 通过。
- 聚焦回归初次发现测试夹具问题：缺 `runtimeInfo()`、TerminalService 新 onSession 需要 sessions.get/set，以及 ES2022 不支持 `findLastIndex`；只修正测试夹具和兼容写法。复测 `server-terminal/server-mirror/terminal-service/entrypoints` 共 4 文件 78/78 通过，bridge typecheck 退出码 0。
- Task 6 尚未完成：系统 lease 持久化/重启身份恢复、生产入口 system 适配器注入仍待 RED→GREEN；真实窗口与 Chrome 验收仍未开始。
- Task 6 恢复矩阵 RED：`server-terminal.test.ts` 共 7 项，新增 4 项分别因 lease 文件未保存、未核对身份、未接管退出文件、unknown 未进入人工解除状态而失败；实现原子保存/按 leaseId 清除、先 lease 后 bind、PID+路径+启动时间核对、exit.json 优先处理和无窗口 recover 后，终端相关四文件 16/16 通过，bridge typecheck 退出码 0。
- Task 6 入口 RED：`entrypoints.test.ts` 共 9 项，index/tray 两项因缺 `SystemTerminalAdapter` 按预期失败；CLI 与托盘注入同一 `start/recover` 适配器及 `terminal/` 私有目录后，入口、Server、镜像、service、系统终端、lease 六文件 92/92 通过，typecheck 退出码 0。
- Task 6 完整 GREEN：`npm --prefix bridge test` 27 个文件、342/342 通过。进入 Task 7；真实 Windows 窗口、Chrome 双视图、原生 PTY 和 macOS 仍未验收，未提交、推送或发布。
- Task 7 RED：首轮 `app-tool-flow`/`input-box` 共 5 项按预期失败、46 项通过，分别缺系统终端按钮、只读 banner/禁写、镜像分支、degraded/error 和 InputBox readOnly；补齐别名/文件夹/交互卡/人工解除断言后 App 为 6 项失败、33 项通过。
- Task 7 GREEN：App 接入 terminal 状态、sessionId 同步 ref 和共用镜像 reducer；AliasBar/FolderBar/InputBox/四类交互卡禁写并保留草稿、复制续聊与历史展开。聚焦两文件 53/53 通过，extension typecheck 退出码 0。
- Task 7 完整验证：`npm --prefix extension test` 20 个文件、158/158 通过；`npm --prefix extension run build` 退出码 0，既有工具详情、compact、Task 回放、Ask、MCP、UserDialog 和分页测试无回归。构建仅有大 chunk 提示。进入 Task 8；真实 Chrome/系统窗口和桥接重启恢复仍未验收，阶段 B 与 macOS 仍未完成。
- Task 8 构建基线：bridge 27 文件 342/342、extension 20 文件 158/158，两端 typecheck、扩展 production build 和 Windows exe 编译退出码均为 0；隔离假 CLI 已编译。
- 首次 Hook 负控在准备阶段失败，不属于有效 RED：`folder.bind` 不自动挑选最新转录，且 SDK 的 `--settings` 为内联 JSON。验收脚本改为显式 `session.switch`，假 CLI 同时支持内联 JSON/设置文件；生产代码与 required 断言未改，换全新隔离目录重跑。
- 有效 Hook 负控 `red-8`/`red-9` 均非零退出并明确失败于 `clearFollowedNewSession=false`；正常 `green-8` 已证明新 Windows Terminal 窗口可见、初始 resume 参数和 command SessionStart 到达、双视图只读及 11 项 READ_ONLY，但 `/clear` 新会话 Hook 超时，不能记作通过。
- 截图 `CopyFromScreen` 连续失败后改用 `PrintWindow(PW_RENDERFULLCONTENT)`；`green-8`/`green-9` 虽能截图，终端区域却完全空白，窗口可见不等于 CLI 可交互。
- `green-9` 加入 C# ConsoleShim 后仍在同一步失败；事件显示实际假 CLI 收到 `stdin-eof`，且没有 `/clear` 或第二个 SessionStart。构建审查发现包装进程复用了带 `--windows-hide-console` 的托盘 GUI exe；下一步仅修改验收副本 PE 子系统做最小假设检验，不先把 shim 或猜测性修改当作生产修复。
- `green-10` 的单变量 PE Console 对照使终端首次显示真实假 CLI 提示符和会话标题，证明 GUI 子系统确实解释空白输出，但 `/clear` 仍未通过，不能据此宣称修复完整。
- `green-11` 边界日志证明目标 shim 的 `Console.IsInputRedirected/IsOutputRedirected` 均为 false；新增前台安全检查发现 `SetForegroundWindow` 后 `GetForegroundWindow()=0`，因此 `/clear` 在发送前被阻止。此前 EOF 发生在清理阶段，不是启动输入故障证据。后续验收改用仅附加到隔离包装 PID 的原生控制台输入记录，不再依赖前台焦点。
- `green-12`～`green-14` 原生 `WriteConsoleInputW` 仍失败；错误 6 最终定位为 `AttachConsole` 后继续使用旧 std handle。`green-15` 改为显式打开 `CONIN$` 后，`/clear` 真实显示并触发 Hook，验收推进到工具折叠。
- `green-16` 证明工具 DOM 查询在尚未就绪时返回空数组，且 `/fork` 等待误接受上一轮 clear 状态；修正 DOM 必需条件和排除 clearSid 后，`green-17` 的 clear/resume/fork、普通外部会话不抢镜像、compact/Task/Read/Edit/diff/Ask 双视图折叠均取得真实证据。
- `green-18` 重启后 banner、disabled 和 terminalDisabled 均正确，只有内存草稿因桥接强杀被清空；按既定范围不新增崩溃持久化，重启后重新注入测试草稿。`green-19` 通过系统 lease 重启恢复，随后暴露真实 `exit` 不释放 lease。
- `green-19`～`green-21` 确认假 CLI 收到 `exit` 并发送 SessionEnd，但 shim 停在下一行读取；`Task.WaitAny(ReadLineAsync(), exitTask)` 无效。`green-22` 将控制台阻塞读取显式放进 `Task.Run` 后，真实退出、最终镜像→恢复会话→idle 顺序及 degraded 只读均通过。
- `green-23`～`green-24` 的 unknown 场景没有第三套 lease，公开协议显示旧 degraded lease 被重启恢复并拒绝新 open。继续核对发现验收的 close 等待误命中连接内已有初始 idle，导致提前强杀；不是生产清理失败。限定只接受 close 后的新 idle 后，`green-25` 通过 unknown 身份核对与人工解除。
- `green-25`～`green-27` 回退控制台没有 status.json；定向启动错误只发给点击连接，控制连接需观察启动后的 idle。根因是测试将 PATH 缩为 System32，同时隐藏了包装身份查询所需 PowerShell。只隐藏 wt、保留标准 PowerShell 目录后，`green-28` 在 Console 子系统对照下完整通过全部 required 项，runtimeErrors=[]，loopbackRequests=0，realApiCalled=false。
- 已人工查看 `green-28` 的 Windows Terminal、回退 Console 和 `/clear` 截图：窗口均可见，假 CLI 提示符和命令回显清晰。该结果仍是隔离副本 PE 对照，不是最终生产构建证据；下一步先 RED 后实现独立 Console 包装 exe，再关闭默认 HTTP 诊断并重跑最终负控/正常验收。
- Console 入口契约 RED：`entrypoints.test.ts` 1 项按预期失败，Windows 编译态仍返回 GUI `ccc-bridge.exe`；最小实现改为同目录 `ccc-terminal.exe` 后 9/9 通过，bridge typecheck 退出码 0。macOS 编译入口保持原 `ccc-bridge`。
- 生产构建新增 `ccc-terminal.exe`（Console subsystem=3），主托盘 `ccc-bridge.exe` 保持 GUI subsystem=2；不再通过修改发行 exe PE 头实施修复。假 CLI 的直接 HTTP 补救分支已删除并重新编译，正常验收不启用任何 Hook 补救。
- `final-run-1` 虽全部 required 通过，但复核发现人工解除 lease 后脚本仍发送 `exit`，产生一条预期端点已移除的 `SessionEnd` 转发失败。只修验收夹具：该隔离窗口改用定向 `WM_CLOSE` 清理，并新增 `commandHooksWithoutFailure` 必需证据，防止 OK 掩盖意外 Hook 失败。
- 最终完整回归：bridge 27 文件 342/342、extension 20 文件 158/158，两端 typecheck、扩展 production build 和 Windows 双 exe 构建均退出码 0；仅有既存大 chunk 与 Git LF→CRLF 提示。
- 最终负控 `red-final-2` 非零退出，准确失败于 `clearFollowedNewSession=false`，且已先取得真实窗口、初始 resume、degraded 和双视图只读证据。正常 `final-run-2` 退出码 0，全部 required=true，`commandHooksWithoutFailure=true`、`hookFailures=[]`、`runtimeErrors=[]`、`consoleSubsystemProbe=false`、`loopbackRequests=0`、`realApiCalled=false`。
- 已人工查看 `final-run-2` 的 Windows Terminal、`/clear`、回退 Console、side panel 和 popup 截图：终端提示符与命令回显清晰，双视图只读 banner、禁用输入、保留草稿及 compact/Task/工具/diff/Ask 内容可见。最终 JSON 已复制到批准根目录 `system-verification.json`。
- 最终 PE/哈希核对：`ccc-bridge.exe` subsystem=2、102557696 bytes；`ccc-terminal.exe` subsystem=3、97870336 bytes。两份验收隔离副本均与最终 dist 逐字节一致。
- 四份用户文档已分别取得明确修改批准并完成：README 增加系统终端入口；guide 写清双 exe、只读/degraded/恢复与真实 CLI/隔离假 CLI 的验收边界；development 增加架构、隔离正常/负控命令及双 exe 发版布局；TODO 记录最终证据和未完成边界。阶段 A Task 8 收尾，阶段 B 尚未开始，macOS Terminal.app 仍未真实验收。
- 用户明确指出目标是完整双终端做完并真实验收，且多批测试窗口未清理。已恢复完整 Inline 执行；进程清单仅按批准隔离目录识别到多批早期 `fake-claude`、隔离桥接/终端包装和测试 `cmd`，不按标题批量关闭、不碰正式桥接。首次清理命令因 Bash 提前展开 PowerShell `$` 变量而解析失败，未终止任何进程；改用 UTF-16LE EncodedCommand 避免 shell 插值，最终按隔离路径复核剩余进程为 0。
- 阶段 B Task 1 环境准备：Node 22.23.4 zip 来自 npmmirror，已核对 SHA-256 与压缩包路径安全；项目 Conda venv 已修复为 Python 3.12.16。首次 npm 安装的 node-gyp 子进程误用系统 Node 25，已停止并改为显式 Node 22。
- `node-gyp configure` 已正常退出：Node 22.23.4 头文件和 win-x64/node.lib 哈希匹配，检测到 VS2022 17.14、v143 与 Windows SDK 10.0.26100.0。独立 `build` 随后真实失败于 MSB8040：node-pty 强制 Spectre 而本机没有缓解库；winpty-agent.exe 与 winpty.dll 已编译，但 conpty/conpty_console_list/pty 三个目标未成功，不能记作构建通过。
- 当前 `bridge/package.json` 与 lock 均未登记 node-pty；虽然 npm 中断后留下包目录，也不能把它当作已安装依赖。下一步用一次性 MSBuild 属性覆盖验证构建，再完成清单锁定、postinstall、模块加载和真实行为探针。
- Task 1 依赖修正：1.0.0 在 Spectre 覆盖后仍有 ConPTY/MSVC 源码错误，未改第三方源码。改锁当前稳定版 node-pty 1.1.0；tar SHA-512、286 个路径条目均核验，Node 22 可加载，npm 11 规范化后的 lock 仅新增 18 行目标依赖。
- Task 1 有效 RED：`pty-red-1` 因缺少 `probe-bun-node-pty.ts` 在 compile 阶段失败。实现后 `pty-green-1` 暴露 Bun 编译态按包名解析失败，改绝对外置入口；`pty-green-2` 已获初始尺寸、中文和 tick，修正额外 ECHO 字面回显假设；`pty-green-3` 六项行为全 true 但 Bun 事件循环不退出，显式 flush+exit 后 `pty-green-4` exit 0。
- Task 1 GREEN：`pty-auto-1/pty-route.json` 的 selectedRoute=`bun-node-pty`，initialSize/inputEcho/continuousTicks/chinese/resize/exitCode7、isolatedCwd/isolatedNative 全为 true；bridge typecheck exit 0，按隔离路径复核探针与 Node 子进程无残留。进入 Task 2。
- Task 2 有效 RED：`pty-backend`/`node-pty-helper` 两 suite 因四个生产模块不存在而失败；实现统一接口、直接后端、Node helper 和主端后聚焦测试通过。测试夹具初版缺 stdin.on，已补齐真实 ChildProcess 流接口；未改生产断言。
- 类型检查发现 `this.module` 经 any 加载后仍可能 undefined，连续两次未通过；改为显式 NodePtyModule 局部加载后 typecheck exit 0。
- 首屏竞态有效 RED：`started` 与首个 data 同批到达时订阅者收不到初始输出；两种进程适配器均增加订阅前早到块补发，kill 清空旧块，新增回归后聚焦 11/11。
- Task 2 真实 helper RED：`pty-helper-red-1` 明确失败于 HELPER_NOT_IMPLEMENTED。实现 helper 编译及编译型主端探针后，`pty-helper-green-1/pty-route.json` 的 selectedRoute=`node-helper`，六项行为与 isolatedCwd/isolatedNative 全 true；按该隔离路径查询 node/probe-helper 无残留。
- `pty-auto-2` 重新确认 auto 仍选择 `bun-node-pty` 且六项行为全 true；bridge 完整回归 29 文件 353/353，typecheck exit 0。Task 2 完成，进入 Task 3；未提交、推送或发布。
- Task 3 有效 RED：buffer 模块不存在，attach/input/resize 三项新协议测试返回 null。实现单调 seq、1 MiB/256 块缓冲、clear 空窗缺口、完整保留超大单块、UTF-8 65,536 字节限制及严格字段解析后聚焦 37/37。
- 新增四个 TerminalErrorCode 后 bridge typecheck 要求完整文案映射；补 OUTPUT_GAP/PTY_UNAVAILABLE/ATTACH_REQUIRED/DETACHED 固定中文说明，未改变 server 行为。
- Task 3 完整 GREEN：bridge 30 文件 360/360、extension 20 文件 158/158，两端 typecheck exit 0。进入 Task 4。
- Task 4 已写 `EmbeddedSession` 单元测试与真实 WS 集成测试，覆盖 opened 前缓冲、定向 token、连接所有权、输入/resize、3 秒重连、最终镜像恢复、输出缺口和 native 失败隔离。首次聚焦运行 2 个 suite 均因 `embedded-terminal` 模块不存在而失败，取得有效 RED。
- Task 4 核心实现后聚焦 12/12 通过。重连用例两次断言误取收集器中的旧 output，已改为按 seq 精确等待并补一个 attach 前已接收块；生产行为未因这些测试夹具错误放宽。生产入口、异常重启身份清理和 `--pty-smoke` 仍待完成，Task 4 尚未结束。
- Task 4 恢复矩阵新增身份持久化、真实 exit 文件、身份匹配清理、unknown 人工解除和启动即退出测试；首次运行分别因 identity 缺失、未读取 embedded store、exit 文件未生成和退出订阅丢失取得有效 RED。实现独立 `embedded-lease.json`、身份查询、退出结果迟到补发与定向 recover 后，`embedded-terminal/server-embedded-terminal` 两组 16/16 通过。生产入口与 `--pty-smoke` 仍待完成。
- Task 4 完成生产接线：原生 manifest 明确选择 `bun-node-pty`/`node-helper`，缺失或非法时仅 embedded spawn 延迟失败 `PTY_UNAVAILABLE`；index/tray 注入 embedded start/recover，并增加只在显式分支读取隔离假 CLI 的 `--pty-smoke`。入口、runtime、服务和 smoke 四组 36/36，bridge 完整 33 文件 387/387，typecheck exit 0。
- 隔离假 CLI 的 `CCC_PTY_SMOKE_MODE` 先取得等待 SIZE 超时的有效 RED；实现初始尺寸、连续 tick、中文 ECHO 和 EXIT 7 后，与生产 smoke 单测合计 4/4 通过。测试清理初版异步 kill 后 rm 遇到 EPERM，改为等待退出及有界 rm retry，不放宽行为断言。
- 真实编译 `ccc-terminal.exe --pty-smoke win32 x64` 在批准目录 `task4-smoke-1`、项目树外 CWD 和完整外置 node-pty 布局下通过，六项行为全 true、backend=`bun-node-pty`。缺 manifest 负控准确失败 `PTY_UNAVAILABLE`，以隔离 Node 替代行为 CLI 的异常路径准确失败 `PTY_SMOKE_INITIAL_SIZE_TIMEOUT`；两次均 exit 1。最终仅按两个隔离根目录的可执行路径复核并清理，cleaned=0、remaining=0。Task 4 完成，进入 Task 5；Chrome 页面尚未验收。
- Task 5 精确安装 `@xterm/xterm@5.5.0`、`@xterm/addon-fit@0.10.0`、`@xterm/addon-web-links@0.11.0`。TerminalClient、窗口去重、别名菜单与 App 入口先取得模块/按钮缺失 RED，再实现认证后 open、opened 后 attach、同 token/lastSeq 重连、连续 seq、输入/resize、pagehide 和失败不开 Claude；首轮聚焦 55/55。
- 真正 `terminal.html`/React/xterm 页面测试先因 TerminalApp 不存在而 RED。实现 FitAddon、WebLinksAddon、ResizeObserver、中文 onData、attached 后尺寸同步、公开 folder/session、结束按钮和 pagehide 后，页面测试 3/3。测试初版未把 mock client 置为 attached，修正夹具后通过，未放宽生产断言。
- 真实 background 入口测试发现 `terminal.open-window` 被 `ccc.*` 前缀过滤，监听器返回 false；只放行该明确消息类型后，窗口创建及异步应答通过。Task 5 聚焦 6 文件 59/59，扩展完整 24 文件 172/172，typecheck exit 0，production build exit 0 且输出 `terminal.html`。Task 5 自动化完成，进入 Task 6；真实 Chrome、IME、3 秒重连和窗口清理仍待 Task 7，未提交、推送或发布。
- Task 6 原生布局、SHA-256、Node 22 helper、探针路线和 macOS 签名顺序测试先 RED 后 GREEN，聚焦 6/6。对照真实探针目录发现 `node-addon-api` 漏包，新增精确断言再次取得 RED，补齐依赖复制与必需清单后恢复 6/6。
- `task6-release-run-1/pty-route.json` 实探选择 `bun-node-pty`，initialSize/inputEcho/continuousTicks/chinese/resize/exitCode7 全 true。最终 `build-exe.mjs win --pty-route ...` 构建 exit 0，完整目录包含双 exe、目标 node-pty/node-addon-api、原生文件与 manifest。
- 最终目录复制到项目树外 `task6-package-smoke-1/app` 后，布局与 SHA-256 校验通过，真实 `ccc-terminal.exe --pty-smoke` 六项行为全 true、backend=`bun-node-pty`。另建 `task6-package-missing-1` 残缺副本（复制时排除 conpty.node，不删除已有文件），verify 以 `NATIVE_LAYOUT` exit 1、smoke 以原生模块加载错误 exit 1；按两个隔离根目录复核 `remaining=0`。
- CI/Release 已接入真实路线探针、带报告构建、绝对路径布局校验、完整复制目录 smoke、macOS 内层签名与 app smoke；Windows zip 包含完整目录，pty-route 仅作 artifact、不进入 Release 资产。两份 YAML 均由 Bun.YAML 实际解析通过；未触发 workflow，macOS 签名与 app 冒烟仍无实机证据。
- Task 6 最终桥接完整回归 35 文件 394/394，typecheck exit 0。进入 Task 7 真实 Chrome 双终端验收；未提交、推送或发布。
- Task 7 真实浏览器接线审查发现 TerminalApp 使用 `/?token=`，而桥接只接受 `/ws`。新增组件精确 URL 断言先取得 RED（期望 `/ws`、实际 `/`），修复后 `terminal-page.test.tsx` 3/3、extension typecheck 与 production build 均 exit 0；尚未据此宣称真实终端窗口通过。
- 最终 CI/Release 路径替换后再次以 Bun.YAML 解析，两份均 `YAML_OK`；未触发 GitHub Runner。正在完成真实 Chrome/PTY 验收脚本，attach 负控和正常窗口验收尚未执行。
- 正常退出 RED→GREEN：`runtime.test.ts` 新用例先证明旧 SIGTERM 不调用异步 close；`entrypoints.test.ts` 两项再证明 index/tray 未接 `server.close()`。实现等待关闭、重复信号幂等和托盘退出顺序后，聚焦 19/19、bridge typecheck exit 0，并重新构建完整 Windows 发行目录。
- `embedded-red-1` 真实 Chrome attach 负控 exit 1，准确失败于 `attachedAfterOpenedOnSameConnection=false`；窗口可见/去重、认证先于 open、初始 resume、双视图只读均已先取得证据。截图确认停留在“正在接入终端输出”，未把窗口打开当作 attached；`runtimeErrors=[]`、清理 `remaining=[]`、清理错误为空。
- `embedded-green-1/2` 均在 ASCII 等待处 exit 1，但第二轮详细证据证明文字、Enter、两次 input、后续 PTY output 与 JSONL 镜像都已到达；根因是隔离假 CLI 普通模式只写助手转录而漏写终端回复。保留真实 RED，仅补假 CLI stdout，生产代码未改；两轮清理均为零残留。
- 重编译夹具后 `embedded-green-3` 的真实截图已显示 `FAKE_ECHO: hello embedded`，但脚本仍因 `.xterm-rows` DOM 查询未包含画布新文本而 exit 1。下一步把等待条件改为代理中的预期标记命中事件，并保留截图人工核对；不把该验收定位器问题改成生产行为。
- `embedded-green-4` 已真实通过 ASCII、中文与 IME：代理在 seq 7/9/11 命中三个固定输出标记，截图显示对应回复，IME 用户转录仅一条。随后按预期 RED 于正常假 CLI 缺少 `/ticks on`；开始为该隔离夹具补连续 tick 与 `/size`，仍未改生产行为，清理复核零残留。
- `embedded-green-5` 命中 tick-3 后暴露 resize 旧帧竞态及 `/ticks on` 被夹具误写为普通回复；修正等待目标帧、把终端命令接回同一 `else if` 链，并新增 JSONL 终端命令污染断言。green-6 初次夹具语法错误未启动窗口，green-6～9 继续定位 resize 快照/索引竞态，均定向清理。
- `embedded-green-10/11` 的页面 hidden 证明窗口尺寸与 `.xterm` 存在不等于真实可见；验收 Chrome 禁用遮挡/后台节流，并在打开和输入前 `bringToFront` 后，green-12 得到真实 132×36 客户端帧。随后先停止 tick 再查询尺寸，避免连续输出淹没证据。
- `embedded-green-13` 的真实子进程仍报告 `SIZE:120x32`；独立 `normal-resize-probe-1/2/3` 使用同一 Node 22 原生包复现，并排除空监听和即时查询假设。仅把正常假 CLI readline 改为交互模式后，probe-4 依次取得真实 `RESIZE:132x36`、`SIZE:132x36`、exit 0 与 remaining 0，根因在隔离夹具，不在生产桥接。
- `embedded-green-14` 的真实截图已有 132×36，但代理正则被 ANSI 相邻字符和 `\b` 阻断，旧 marker 还误匹配 RESIZE 子串。改为精确 RESIZE/SIZE 数值解析后，green-15 的当前已接入正常链路全部通过：输入、中文、IME、tick、真实 resize、双视图只读、JSONL 隔离和零残留均有证据。脚本仍因后续场景占位 exit 1，明确不是完整通过。
- `embedded-green-16` 新接入的 Hooks、折叠、外部会话、只读、非 owner、聊天断线、3 秒内重放与系统终端互斥前半段均已通过；结束按钮真实退出也已由页面和代理证明。脚本误在控制连接等待只发 owner 的 `terminal.exit` 而超时，已修正证据来源；生产代码未改，清理零残留。
- `embedded-green-17` 的无会话准备被 SDK 初始化竞态影响；仅给隔离假 CLI 增加 stream-json 延迟初始化开关后，green-18 取得真实 `--session-id` UUID 证据。该轮 Hooks、折叠、所有权、重连、结束恢复和双向互斥全为 true，真实重连 1015ms，runtimeErrors 与清理均为空；仍按占位非零结束，继续生命周期验收。
- `embedded-green-19` 在新生命周期前发现真实持久化缺口：无会话 PTY 已 attached，但私有记录停留在 Hook 抢先写入的 `active + backend=null + pid=null`，30 秒无完整身份；本轮清理零残留。新增 Windows 暂时 rename 失败测试取得 RED，存储层仅对 EPERM/EACCES/EBUSY 做三次有界重试，聚焦 15/15 和 typecheck 通过，真实双 exe 已重编，green-20 复验中。
- `embedded-green-20` 已真实通过无会话 UUID、3074ms 重连超时清理及刷新生成新 lease，但失败于缺口提示被随后的退出帧覆盖；清理仍为零残留。代理完整顺序确认客户端检测 seq 9→10 缺口后发送 close，服务随后发送 exit。新增“退出后保留错误原因和退出码”回归先 RED，再最小修复 `TerminalClient`；聚焦 9/9、extension typecheck 与 production build 均通过，开始 green-21。
- `embedded-green-21` 未进入终端流程，准备阶段的设置页 30 秒未显示已连接，代理零帧、桥接 stderr 与页面运行错误均为空；本轮清理零残留。增加脱敏设置页诊断与真实截图，继续 green-22，不能把这次准备失败解释成任何终端功能通过或失败。
- `embedded-green-22` 已真实通过输出缺口错误保留（`outputGapVisibleAndCloses=true`）与 pagehide owned PTY 清理；失败点为隔离桥接正常关闭探针的 `AttachConsole`，因此正常桥接关闭、身份恢复、unknown 与原生失败隔离仍没有本轮通过证据。`runtimeErrors=[]`、`realApiCalled=false`，本轮定向清理 remaining/errors 双空。
- 新建 `probe-console-interrupt.mjs`，只使用批准根目录的全新子目录、登记真实目标 PID 并定向清理。probe-1～4 是探针准备错误；probe-5～20 复现 detached 无 Console、共享 Console 安全拒绝以及 GenerateConsoleCtrlEvent/WriteConsoleInput 未取得目标正常退出，不能把 API 返回成功当作信号送达。
- probe-21～24 的 `SetForegroundWindow`、窗口切换与真实鼠标点击均未通过“前台句柄精确等于本轮 Console”的安全检查，因此 `SendKeys` 没有执行。probe-24 的目标窗口可见且边界正常，但 `foreground=0`，`remaining=[]`。
- probe-25 在非沙箱上下文重复同一最小 C# 对照，仍为 `foreground=0`，`sent=false`、`remaining=[]`；排除单纯沙箱权限解释。下一步先读取输入桌面/窗口站证据，再选择不依赖前台焦点的定向正常关闭路径，不重跑完整 green-23。
- probe-26 读取到 `windowStation=WinSta0`、`threadDesktop=Default`、`OpenInputDesktop ERROR:5`，解释前台输入不可用的环境边界。仅向核对为独占的隔离 Console 发送 WM_CLOSE 后，C# 目标真实记录控制台关闭事件、exit 0、remaining=[]。
- probe-27 真实桥接虽退出，但 exitCode=0xC000013A 且 runtime.json 保留，证明仅关窗尚未走正常清理。新增 SIGHUP 参数化回归取得预期 RED（close 0 次），将 SIGHUP 加入 `releaseRuntimeOnExit` 后聚焦 4/4、bridge typecheck 通过。
- 重编完整 Windows 发行目录后，probe-28 真实桥接 WM_CLOSE 取得 exitCode=0、runtimeReleased=true、remaining=[]。probe-29 在移除废弃 Ctrl+C/前台实验代码并接入真实 PID 跟踪后复验同样通过。
- 完整验收的 startBridge 已改用 `console-start-wait`，分别登记启动器和真实桥接 PID、核对发行副本路径；stopBridge 正常路径只发送定向 WM_CLOSE，异常路径复核 PID+路径+启动时间后才强杀。准备运行全新 `embedded-green-23`，尚未宣称完整通过。
- `embedded-green-23` 已真实通过正常桥接关闭结束 owned PTY，但随后重启重新绑定超时。私有记录被按既有安全策略恢复为 degraded 只读，后续恢复/原生失败场景未执行，不能记作完整通过；`runtimeErrors=[]`、`realApiCalled=false`、cleanup remaining/errors 双空。根因定位为 close 只等待 kill 请求和后端关闭，未等待真实 exit 及异步 `completeExit()` 的最终镜像、SDK 恢复与私有 lease 清除。下一步先写可控延迟退出和异步清理两条 RED，再做最小修复。
- 关闭竞态两条新回归首次运行均按预期失败于 `closed=true`，其余 19 项通过，确认 RED 有效。最小修复让 `TerminalRuntimeHandle.onExit` 可返回清理 Promise，lease 注册直接返回 `completeExit().catch(...)`；embedded adapter 先等真实 exit，再等全部退出清理 Promise，最后关闭 backend。聚焦 21/21、bridge 完整 35 文件 401/401、typecheck 均通过，Windows 双 exe 已重编且原生布局/SHA-256 校验通过。全新 `embedded-green-24` 真实验收已启动，尚无最终结果。
- `embedded-green-24` 已真实越过正常关闭后的 owned PTY 退出、重启绑定与恢复可写，`bridgeShutdownKillsOwnedPty=true`。随后失败于异常强杀隔离桥接后恢复夹具 PTY 同时消失，尚未进入 recover，因此不是 recover 误杀证据；后续 matched/unknown/native/Hook 字段未执行。`runtimeErrors=[]`、`realApiCalled=false`，`observations.cleanup.remaining/errors` 双空。正在区分 ConPTY 随 owner 退出行为与恢复分支缺口，不删除存活/身份断言或伪造通过。
- 进程退出恢复 RED→GREEN：新增 `ESRCH`/权限错误及“ConPTY 已退出、无 exit 文件”两条测试，首次分别失败于 helper 不存在和 idle 超时；最小实现只有 ESRCH 才走最终同步，其他错误仍进入身份核对/unknown。聚焦 4/4、bridge 完整 35 文件 403/403、typecheck 通过，双 exe 与原生布局/SHA-256 已重编校验。
- 真实验收异常场景已拆分：ConPTY 自动退出必须清 lease；另用本轮登记、独立于 ConPTY 的真实 Node 存活进程及完整身份，分别验证匹配时定向结束与启动时间不符时只读/人工解除不杀。私有 token 仅原地保留不输出。全新 `embedded-green-25` 已启动，尚无最终结果。
- `embedded-green-25` 已越过正常桥接关闭，并在异常 ConPTY 场景中观察到私有 lease 被清除；随后验收脚本立即调用 `control.terminalState().phase`，因 idle WS 帧尚未进入控制 inbox 而报 `Cannot read properties of null (reading 'phase')`。这是已复现的验收等待竞态，后续 matched/unknown/native/Hook 场景未执行，不记作完整通过；`runtimeErrors=[]`、`realApiCalled=false`、cleanup remaining/errors 双空。下一版只把 ConPTY 与 matched 两处断言改为等待 startBridge 之后的新 idle 帧，生产代码不变。
- `embedded-green-26` 已真实越过三种异常恢复：ConPTY 已退出自动清理、匹配身份只结束登记 survivor、unknown 与人工解除均不杀进程，且都恢复可写。原生 manifest 缺失已返回 `PTY_UNAVAILABLE`，系统终端随后可启动、Hook、退出并恢复 idle。最后等待“聊天另起 CLI”超时；时间戳证明目标 CLI 是系统终端恢复时启动并由聊天复用，且 stream-json 假 CLI 未实现普通用户回复，所以尚没有聊天完成证据。`commandHooksWithoutFailure=false` 仅因脚本未走到汇总；`runtimeErrors=[]`、`realApiCalled=false`、cleanup remaining/errors 双空。下一轮只修隔离夹具与取证，不宣称 green-26 完整通过。
- 隔离假 CLI 普通聊天最小探针先得到 `gotDelta=false/gotResult=false` 的有效 RED；补齐 stream-json 用户消息处理后得到双 true 的 GREEN。真实验收改为登记系统终端退出时恢复的 SDK PID，并要求同一 PID 收到固定聊天标记、产生 `chat.delta`、`chat.done` 和双方转录，不再要求聊天无意义地另起进程。
- `embedded-green-27` 完整验收退出码 0，独立读取证据确认 `ok=true`，全部 33 项必需证据均为 true；原生失败后同一恢复 SDK 进程完成普通聊天，`nativeFailureLeavesChatAndSystemTerminalUsable=true`，`commandHooksWithoutFailure=true`，`hookFailures=[]`，`runtimeErrors=[]`，`upstreamRequests=0`，`realApiCalled=false`，最终 cleanup remaining/errors 双空。重连实测 1011ms，afterSeq=27、latestSeq=31、连续重放 4 块；macOSVerified 仍明确为 false。下一步人工查看真实截图并完成最终回归与文档，尚不自动提交、推送或发布。
- 已人工查看 `embedded-green-27` 的 7 张根目录截图：独立终端正常可见，ASCII、中文、IME、连续 tick、真实 RESIZE/SIZE 132×36 均清晰；原生不可用时页面顶部保留明确错误；侧边栏与独立聊天窗口显示只读横幅、禁用写操作并保留草稿，compact、Task 和工具详情可展开，未见空白或伪造画面。green-27 没有另存缺帧/系统终端截图，继续核对此前同构建链的对应真实截图，不把 DOM/协议断言冒充截图证据。
- 最终 fresh 自动回归：bridge 35 文件 403/403、extension 24 文件 173/173，两端 typecheck 和扩展 production build 均退出码 0；构建明确生成 `terminal.html`，仅有既存大 chunk 提示。
- 为完整人工取证，只在验收脚本既有的缺帧可见断言和原生失败后系统终端 active 断言处增加截图，不改生产行为或放宽断言。全新 `embedded-green-28` 再次完整退出码 0，全部必需项为 true，缺帧丢弃真实 seq 9，系统终端为可见的 WindowsTerminal 窗口；普通聊天仍由同一恢复 SDK 进程完成。`runtimeErrors=[]`、`hookFailures=[]`、`upstreamRequests=0`、`realApiCalled=false`，cleanup remaining/errors 双空。
- 已人工查看 green-28 新增的 `embedded-output-gap.png` 与 `embedded-system-terminal.png`：页面持续显示“输出序号不连续”，并保留退出原因/退出码；真实 Windows Terminal 显示隔离假 CLI 提示符。阶段 B Task 7 的真实 Windows 验收和截图核对完成；macOS、GitHub Runner 与真实 API 仍不在本次通过范围内。
- 最终发行与工作区检查：`verify-native-layout.mjs` 对 `bridge/dist/ccc-bridge-win-x64` 的平台、架构、完整文件集合和 SHA-256 校验通过；CI/Release 两份 YAML 均由 Bun.YAML 实际解析通过，四个双终端/原生脚本 `node --check` 通过。README、guide、development、TODO 与持久化计划已同步到最终状态；不自动提交、推送、打 tag 或发布，根目录 zip/JPG 保持未跟踪。

## 2026-11-11 真实 Claude Code CLI 补验

- 直接真实 CLI 验收先因假上游未接受 `/v1/messages?beta=true` 在 01/02 准备阶段失败；仅修 URL pathname 匹配后，`real-cli-resume-20261111-03` 九项检查全部通过，确认真实 CLI 2.1.316 的 resume 请求包含首轮用户和助手内容，同一 JSONL 写入两轮，未访问真实 API。
- 双终端真实 CLI 01～05 未进入续聊：依次暴露主题、dummy key 默认 No、目录信任默认 No及首次画面读取过早。05 的状态记录证明向导处理代码未执行；06 改为条件驱动后越过主题/API key，但通用 trust 正则误匹配 Security notes；07 精确区分后到达真正目录信任页，一次 ArrowDown 仍未选中 Yes。每轮 cleanup remaining/errors 均为空，均未形成真实双终端通过证据。
- 三次向导阻塞后调整验收夹具边界：仅在全新隔离 `.claude.json` 预置已完成初始化、批准 dummy key 和信任空测试目录，不读取或修改用户配置。真实 `--resume`、Session Hooks、请求上下文、JSONL、双视图、退出恢复及清理断言不放宽。
- 第 08 轮真实插件终端已 active 且请求携带旧上下文，但 JSONL 缺少本轮；截图定位到继承的 `CLAUDE_CODE_CHILD_SESSION` 关闭了真实 CLI 转录。仅删除隔离环境中的该标记，并把隔离 projects 键修正为 CLI 实际使用的正斜杠路径。
- 第 09 轮插件终端的真实 resume、旧上下文、同一 JSONL、双视图和退出恢复全部通过，首次向导完全跳过；系统请求因历史中含上一轮 embedded 文本被夹具误分类。改为按最新用户消息判断阶段，生产代码未改。
- 直接真实 CLI 第 04 轮再次退出码 0，九项全 true，并显式排除继承子会话标记；真实 CLI 2.1.316 单独恢复 CC 会话的证据已连续两轮成立。
- 第 10 轮系统请求正确分类为 system，messageCount=7，旧上下文、同一 JSONL 和双视图镜像均通过；但定向 WM_CLOSE 后侧边栏持续只读。系统 lease 没有 exit.json，原等待又可能匹配插件关闭留下的旧 idle，不能宣称系统退出恢复通过。随后按登记 PID 复核包装进程已不存在，但该检查发生在脚本清理之后，不能单独证明清理前的进程状态。
- 第 11 轮仅增强取证：系统包装 PID 纳入完整身份登记和最终清理集合，关窗后采样 PID/exit.json/公开 phase，并且只接受关窗后的新 idle。首轮采样即得到 `processAlive=false`、`exitFile=false`、`phase=active`，随后等待本轮新 idle 超时，确认 Windows Terminal 关窗直接结束包装进程、来不及写退出文件，旧适配器因此永久保持 active。
- 系统关窗修复按 TDD 完成：新增“包装 PID 消失且无退出文件”用例先以退出回调 0 次取得 RED；最小实现优先读取 exit.json，无文件且明确 ESRCH 时通知 `process-exit`，存活、权限或查询未知均不释放。聚焦 6/6 与 bridge typecheck 通过；随后使用 `task6-release-run-1/pty-route.json` 重编双 exe，完整 `bun-node-pty` 原生布局和 SHA-256 校验通过。
- 第 12 轮真实 CLI 双终端验收退出码 0，`real-cli-dual-terminal-20261111-12/embedded-verification.json` 的 `ok=true`。插件与系统入口均真实 resume、请求携带旧用户/旧助手并写入同一 JSONL；系统关窗仍采样到 PID=false、exitFile=false，但新 idle、双视图恢复、`realCliSystemExitRestored` 和 `realCliBridgeShutdownClean` 全 true，cleanup remaining/errors 双空，`realApiCalled=false`。已人工查看 `real-cli-embedded-resume.png` 和 `real-cli-system-resume.png`，两轮旧对话及各自续聊均真实可见。
- 生产修复后的完整隔离假 CLI 双终端 `embedded-post-system-close-fix-20261111-01` 再次退出码 0，33 项必需证据全 true，Hook 失败、runtimeErrors、真实上游请求和最终清理残留均为零。bridge 35 文件 405/405、extension 24 文件 173/173，两端 typecheck 与扩展 production build 均通过。README、guide、development、TODO 与持久化记录已同步；macOS 和 GitHub Runner 仍未实际验收，不自动提交、推送、打 tag 或发布。

## 2026-11-11 Windows 绿色单文件

- 跨文件 1 MiB 固定块去重后，真实单文件从首轮 98,280,448 bytes 降到 54,132,736 bytes；加入长路径修复后的最终重建为 54,133,248 bytes（约 51.6 MiB），SHA-256 `001dec14921e6f186c4b2d2edb11865e6979d347c26488bd47612bffdee6709a`。没有把用户“不到 40m”的压缩估计冒充本次实测。
- 新增 `verify-portable-exe.mjs` 后首轮真实启动在批准深目录中准确暴露 `PathTooLongException`。新增超过 400 字符的 C# `long-path-prepare` 用例先取得同样 RED；在 WinForms/测试 Main 首次 IO 前启用长路径，内部 IO 使用 `\\?\`，公开返回值仍是不带前缀的普通路径，8 组 harness 全部通过并重新构建真实 exe。
- 生命周期第 02 轮除进度窗口外全部通过；探针 ticks 改字符串后 active 占用保护和 cleanup 均正确。第 03 轮同步窗口监视仍未见正常进度窗，根因是验收 spawn 的 `windowsHide:true` 隐藏 WinForms，而不是启动器没有窗口；改为与用户双击一致的非隐藏启动，不增加人为等待。
- 第 04 轮 `portable-lifecycle-20261111-04/portable-verification.json` 退出码 0、`ok=true`：单文件、真实进度、先清理再解压、旧版本/staging 回收、未知/foreign/junction 保留、活跃旧版本保护、篡改重建、重复启动目录有界、exe 旁无附属文件、GUI subsystem 和最终零清理残留全部通过。已人工查看 `portable-startup-progress.png`，显示“正在解压当前组件”和实际进度条。
- 完整便携假 CLI `portable-embedded-green-20261111-01/02` 均在正常托盘退出后、异常夹具 helper 清理处 RED；第一次按 .NET/WMI ticks 来源统一身份仍未消除失败，证明该假设不是根因。最终查明强杀父桥接后 helper 正在自行退出，`pidAlive()` 与 WMI 查询之间存在竞态；只有完整身份仍可核对时才定向 kill，查询不到则等待真实退出，身份不符仍失败。
- `portable-embedded-green-20261111-03/embedded-verification.json` 退出码 0，完整便携假 CLI 双终端全部必需项通过，`portableSingleFileOnly/portableRuntimeIdentity/portableGracefulShutdown=true`，`realApiCalled=false`，cleanup remaining/errors 双空。最后一次异常 helper 清理记录为 `killSent=false`、`identityAvailable=false`、`exited=true`，与自行退出竞态一致。
- CI 根目录策略 `portable-verification-root.mjs` 及三组测试完成 RED→GREEN：本机只接受原批准目录严格子目录，只有真实 GitHub Actions 额外允许 RUNNER_TEMP 严格子目录，项目树和缺失参数拒绝；尚未接入工作流。
- 真实 CLI 便携 `portable-real-cli-dual-terminal-20261111-01` 首轮建会话成功且没有真实 API 请求，但插件终端 `START_FAILED`，未进入 resume。最小探针首次误选 node-helper 后端，所得 node.exe ENOENT 仅为探针错误；当前 manifest 实际为 bun-node-pty。
- 新便携构建退出码 0：`CopilotCC.exe` 为 54,134,272 bytes（约 51.6 MiB），SHA-256 `9a32c30310efdf9b4b6eda17387a34a1687264e72269972494b99820f0995598`，payload SHA-256 `6ba809bae91e0a4167aaa5cceae578e43d24988a806f71f50dc3cc6d649c68b6`，ZIP 54,100,269 bytes，重建前原始文件合计 140,143,982 bytes。
- `portable-real-cli-dual-terminal-20261111-02/embedded-verification.json` 退出码 0、`ok=true`：真实 CLI 2.1.316 初始建会话、插件终端 resume/上下文恢复/镜像更新/退出恢复、系统终端 resume/上下文恢复/镜像更新/关窗恢复、单文件与内层 payload 身份、真实托盘退出、桥接正常关闭全部通过。三次本机假上游请求分别证明 initial、embedded、system 上下文递增，`realApiCalled=false`，runtimeErrors 为空，cleanup remaining/errors 双空；长路径启动与 console-list 关闭链均在实际 E2E 越过。
- 根目录白名单已接入 `verify-portable-exe.mjs`，本机/GitHub Runner 严格子目录策略与便携 payload、原生布局、PTY 后端聚焦测试 22/22 通过。首次 bridge typecheck 仍报多行 import 前的 `@ts-expect-error` 未生效，改为紧邻单行模块导入后待复测。

- `pty-backend.test.ts` 新增长路径回退与其他 spawn 错误不重试负控，先取得 1 项 RED；实现仅对明确 ConPTY 原生加载错误执行扩展路径 dlopen、恢复加载器并只重试一次后 9/9 通过。真实 CLI 随后能够启动，但关闭时又暴露 fork 子进程加载 conpty_console_list 的同一长路径问题。
- 实探否决 `useConptyDll` 方案：node-pty 该原生模式自身使用 MAX_PATH，报 `Cannot find conpty.dll`。改为在 `package-pty.mjs` 的发行副本 `node-pty/lib/utils.js` 统一追加长路径 dlopen 回退，同时覆盖父进程和 console-list 子进程；原生布局断言先 RED，随后 `native-layout + pty-backend` 15/15 通过，脚本语法检查通过。完整 Windows 双 exe 已重新构建并经原生布局/SHA-256 校验，正在重建单 exe并准备真实双终端复验。
- 根目录策略与便携四文件聚焦 22/22 后，bridge typecheck 初次报多行 import 的 `@ts-expect-error` 未生效；改成紧邻单行模块导入后 typecheck 通过。CI 与 Release 已接入启动器回归、单 exe 构建和 RUNNER_TEMP 生命周期验收，公开 Windows artifact 只保留 `CopilotCC.exe`，不再上传完整目录 zip；未触发云端 Runner。
- 新 payload 完整假 CLI `portable-embedded-green-20261111-04` 退出码 0，33 项终端行为及 3 项便携证据全 true；中文/IME、132×36、Hooks、双视图、重连、刷新、缺帧、异常恢复和原生失败隔离均覆盖，runtimeErrors/hookFailures/upstreamRequests 为零，cleanup 双空，真实截图已人工核对。
- 全量自动回归退出码 0：bridge 38 文件 422/422、extension 24 文件 173/173，两端 typecheck 和扩展 production build 通过，仅有既有大 chunk 警告。
- 生命周期第 05 轮 15 项功能断言虽全 true，但人工发现进度截图客户区全黑，明确不采用该视觉证据。仅修改验收探针：检测到下半客户区真实亮色像素后才保存，生产启动器不变且不增加人为延时。
- 生命周期第 06 轮 `portable-lifecycle-20261111-06` 退出码 0、`ok=true`，15 项必需断言全 true；源 exe 与验收副本 SHA-256 均为 `9a32c30310efdf9b4b6eda17387a34a1687264e72269972494b99820f0995598`，payloadHash 为 `6ba809bae91e0a4167aaa5cceae578e43d24988a806f71f50dc3cc6d649c68b6`，cleanup remaining/errors 双空。已人工查看新截图，真实显示“正在解压当前组件”和绿色进度条。
- 最终静态与聚焦检查：六个便携/原生相关测试文件 46/46、C# 启动器 8/8、bridge typecheck、相关脚本 `node --check`、完整原生布局/SHA-256 均通过；CI 1 job/5 个 run 段与 Release 5 jobs/15 个 run 段完成 YAML 解析和 Bash `-n`，公开目录仅含 54,134,272 bytes 的 `CopilotCC.exe`，最终 exe 与第 06 轮验收副本哈希一致。
- 文档收尾后再次执行完整回归：bridge 38 文件 422/422、extension 24 文件 173/173，两端 typecheck 和扩展 production build 全部退出码 0，只有既有大 chunk 警告。敏感模式初扫把 `task-…` 中的 `sk-` 子串误报为 API key；改为排除前置字母数字后，9 份文档/工作流无候选命中，Release 单 exe 资产检查和最终 `git diff --check` 通过。未自动提交、推送、打 tag 或发布。

## 2026-11-11 双终端交互缺陷修复

- 真实慢启动复现：固定 5 秒 status 等待在 5334ms 报 START_FAILED，同一 lease 在 7832ms 写 status 并真实显示 Windows Terminal，但公开状态已 idle、无 opened，形成迟到终端无 lease。
- 真实 Chrome 复现成功后旧 terminal.error 与 terminal.opened 成功提示同时存在。
- 普通假 PTY 的 xterm 滚轮/选择/合成复制粘贴正常；真实 CLI 即使收到 160 行固定回复仍无原生 scrollback，且未检测到标准 alternate-screen 或鼠标模式标记。
- 真实 CLI `Ctrl+O → [` 已证明可导出原生 scrollback：scrollHeight 566→2966，wheel 后 scrollTop 2400→1880，无 wheel 输入帧；诊断清理均为空。
- 用户已明确授权本轮生产/测试/验收/文档修改，并允许隔离 Chrome 用固定测试文本覆盖和读回系统剪贴板、不读取原剪贴板。下一步先写并运行 RED，尚未改生产行为。
- 系统终端修复真实验收 `interaction-fix-system-05` 退出码 0：受控 6.5 秒延迟从点击到 active 为 9637ms，新动作与 opened 均清旧错误；20 秒最终超时后 cancel 存在、start 不存在，迟到 status 未启动交互式 CLI，回退、Hooks、恢复、双视图只读、折叠与定向清理全部通过。
- 内嵌终端第 01～03 轮固定复制、Ctrl+C、Ctrl+Shift+C 均通过。多行粘贴诊断证明 Windows 剪贴板将 LF 规范为 CRLF，xterm 再将换行规范为 CR；代理帧同时含两行，且只有行间 CR、无末尾 CR，未加 bracketed paste。原生 readline 探针确认第二行保留在输入缓冲区，额外真实 Enter 后两行均提交。第 04 轮据此只修验收动作，不给生产粘贴添加隐藏回车；完整回归尚在进行。
- `interaction-fix-embedded-04` 完整假 CLI 真实验收退出码 0，独立核对 `ok=true`：工具栏、真实系统剪贴板多行复制、按钮与 Ctrl+Shift+V 多行粘贴、132×36 resize、Hooks、恢复、重连重放、关闭/刷新/桥接生命周期、系统/内嵌互斥均通过；`runtimeErrors=[]`、cleanup remaining/errors 双空、未调用真实 API。真实 CLI portable 第 01 轮随后启动，Ctrl+C 与可滚历史结果待取证。
- `interaction-fix-real-portable-01` 退出码 1：`portableSingleFileOnly/portableRuntimeIdentity/realCliCtrlCInterruptedRequest=true`，延迟上游收到 2 次进行中请求、1 次 abort，中断后新请求和转录继续；但“可滚历史”等待导出键超时。真实 Ctrl+O 画面为 `Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in notepad · ? for shortcuts`，没有 `[` 提示，因此本轮不记历史/滚轮通过，也不继续执行后续系统 resume/正常关闭断言。`realApiCalled=false`、`runtimeErrors=[]`，失败前定向托盘清理无残留。
- 历史检测根因修正后，以真实页脚而非可见 `[` 作为详细视图条件：新回归先因未发送 `[` 和超时提示缺少手动键序而 2 项失败，最小恢复安全导出后聚焦 8/8；普通画面明确不发送 `[`。完整扩展 24 文件 180/180、typecheck、production build，bridge 38 文件 427/427、typecheck均 fresh 通过。第 02 轮真实 portable 验收已启动，硬断言为导出键实际进入 PTY、scrollback 高度增长、滚轮上下移动原生视口且没有滚动方向键输入帧；结果待取证。
- `interaction-fix-real-portable-02` 已退出码 0并独立核对 `ok=true`：真实 CLI 2.1.316 在项目外单 exe 的插件终端和 Windows Terminal 中均恢复旧用户/助手上下文并同步镜像；Ctrl+C 产生 1 次本机延迟请求 abort，之后可继续。真实 Ctrl+O 和 `[` 均进入 PTY，scrollHeight 526→6222，滚轮向上/向下分别移动 5696→4976→5696，未发送滚轮方向键。便携身份、系统/内嵌退出恢复、托盘正常退出及桥接清理均通过，`outerExitCode=0`、`realApiCalled=false`、`runtimeErrors=[]`、cleanup 双空；历史滚轮、内嵌 resume、系统 resume 三张截图已人工查看。
- 最终 `interaction-fix-embedded-05` 完整假 CLI 便携回归退出码 0并独立核对 `ok=true`：复制/粘贴工具栏、真实系统剪贴板多行复制、Ctrl+C/Ctrl+Shift+C、按钮/Ctrl+Shift+V 中文多行粘贴、IME、132×36 resize、Hooks、折叠、重连重放、pagehide/桥接关闭/异常恢复、原生失败隔离与双终端互斥全部通过。`commandHooksWithoutFailure=true`、`realApiCalled=false`、`runtimeErrors=[]`、Hook 失败和 cleanup 均为空；初始窗口、中文 IME、选区复制和中文多行粘贴四张截图已人工查看。阶段 D 四项验收全部完成，仅剩文档与最终工作区复核；未提交或发布。

## 2026-11-12 GitHub Actions #42 跨平台测试修复

- 读取 CI #42（run `43058589061`，提交 `d4ce58f`）完整失败日志：Windows job 通过；Ubuntu job `130654648629` 与 macOS job `130654648912` 均为 5 个测试文件失败、25 项失败、398 项通过、4 项跳过。页面 annotation 和普通 stderr 不能替代完整断言统计。
- 12 项失败来自 `pty-backend`、`node-pty-helper`、`pty-smoke` 的 Windows 路径夹具：POSIX 不接受 `C:/work` 与 `C:/isolated/fake-claude.exe` 为绝对路径。通用夹具改为 `path.resolve(...)`，生产 `INVALID_REQUEST` / `PTY_SMOKE_CLI_REQUIRED` 校验和 Windows 长路径专项未放宽。
- 13 项失败来自 `server-terminal`、`server-embedded-terminal`：fixture 注入假运行时但漏注 CLI，`TerminalService` 在调用假适配器前解析真实 CLI，无 Claude 的 Runner 返回 `CLI_NOT_FOUND`，后续等待超时及预期 `PTY_UNAVAILABLE` 的断言都是同一准备缺口的下游表现。
- TDD 证据：先在系统/内嵌测试断言运行时收到 fixture 的临时假 CLI；首次误在 `extension` 目录执行为“无测试文件”，不记作 RED。改在 `bridge` 目录得到有效 RED：2 项失败、18 项通过，实际值是本机真实 Claude 路径。为 `ServerDeps.terminal` 增加可选 `resolveCli` 后同命令 20/20，生产缺省 `resolveClaudeExecutable` 不变。
- 修复后原失败五文件 36/36；完整 bridge 38 文件 427/427、C# 启动器 8/8、bridge typecheck 通过；extension 24 文件 180/180、typecheck、production build 通过，只有既有大 chunk 警告。文档同步前代码 diff 为 6 文件、18 行新增、9 行删除，`git diff --check` 通过。
- 用户已授权提交相关修复及必要文档并推送 `main`，提交身份只使用用户本人且不添加共同作者；下一步是审核最终 diff、提交、推送并读取新 run 的三平台结果。旧 #42 不是修复后证据，macOS 实机产品功能仍未验收，不打 tag、不发布 Release。

## 2026-11-12 CI #43 复验与 PTY 回退修复

- 已提交并推送 `1123bea6273d8e7d54b9eed63a13d4ec9163be7a`（`修复跨平台终端测试环境依赖`）；Author/Committer 均为 `aaahzb <aaahzb123@gmail.com>`，提交无正文、共同作者或 AI 署名。
- CI #43 run `43067186158` 第一次 macOS job `130685167802` 因 hosted arm64 容量未获 Runner，`steps=[]`，结论为 `cancelled`；Ubuntu job `130685168302` 与 Windows job `130685168279` 不受 `fail-fast:false` 下的 macOS 取消影响。随后仅重跑失败项，HTTP 201，未改代码或触发 Release。
- 第二次 macOS job `130695437524` 的共同单测 423 通过、4 跳过，随后真实 PTY 准备失败；Ubuntu job `130695437570` 与 Windows job `130695438899` 完整成功。Windows 的共同测试、真实 PTY、完整发行布局、项目树外 smoke、绿色单文件构建、启动器、项目树外生命周期及扩展测试/构建均逐项核实为 `success`。
- macOS 日志显示 Bun 路线先在 `spawn` 阶段报告 `posix_spawnp failed`，helper 回退随后重复复制共享依赖，在 `pty/node_modules/node-pty/LICENSE` 处以 `ERR_FS_CP_EEXIST` 失败。根因是两路线共用目标却各自拒绝覆盖复制；helper 当时未进入原生 PTY 行为验证。
- 新增 `bridge/scripts/pty-probe-dependencies.mjs` 和 `bridge/tests/pty-probe-dependencies.test.ts`，`run-pty-probe.mjs` 两路线统一调用暂存函数。完整结果以完成标记复用，无标记半成品明确拒绝。新测试先因模块不存在 RED，实现后 2/2；相关 `.mjs` `node --check` 与 bridge typecheck 通过。
- 项目外跨目标负探针 `ci43-auto-fallback-after-01` 中，两个 Darwin 编译程序在 Windows 均按预期不能原生执行，但 helper 已越过依赖暂存，`dependencyCollisionFixed=true`、`nativeBehaviorPassed=false`，无 `EEXIST` 或 `PTY_PROBE_DEPENDENCIES_INCOMPLETE`。该结果只支持准备阶段修复。
- 项目外 Windows 真实探针 `ci43-win-after-01` 选择 `bun-node-pty`，`initialSize`、`inputEcho`、`continuousTicks`、`chinese`、`resize`、`exitCode7` 全 true，`isolatedCwd` / `isolatedNative` 全 true。child 使用已核验的 Node 22.23.4；探针报告的运行时字符串属于编译程序，不混作 child 版本。
- 完整本地回归已通过：bridge 39 文件 429/429、启动器 8/8、bridge typecheck；extension 24 文件 180/180、typecheck、production build，只有既有大 chunk 警告。本轮待提交范围仅探针实现、两项新文件及同步文档，根目录 zip、JPG、`venv/` 保持未跟踪；新 SHA 的三平台 CI 仍待取得，不打 tag、不发布 Release。

## 2026-11-12 CI #44 与 Darwin spawn-helper 执行位修复

- 已提交并推送 `e4f1a75570c26a387b4b7620065879fa5bce3b8b`（`修复 macOS PTY 回退重复暂存`）。CI #44 run `43146771064` 的 Ubuntu job `130946307873`、Windows job `130946308407` 成功，macOS job `130946308234` 失败；macOS 共同测试 37 文件通过、2 跳过，425 项通过、4 跳过。
- macOS 日志不再出现 `EEXIST`：Bun 路线已到 `stage=spawn` 并报 `posix_spawnp failed`，helper 回退也到 `stage=spawn-helper` 并报 `SPAWN_FAILED: posix_spawnp failed`。这证明上一提交解决了重复暂存，同时暴露两条路线共同的原生启动问题。
- 直接核验官方 `node-pty@1.1.0` tarball：Darwin arm64/x64 的 `spawn-helper` 都是 `-rw-r--r--`（0644）；本机对应文件为正确 arm64 Mach-O，`pty.node` 可加载不代表辅助程序可执行。上游相关记录为 `microsoft/node-pty#850`。项目 CI 使用 Node 22.23.4；checkout/setup-node 的 Node 24 警告只属于 Action 自身运行时。
- 三项新回归先 RED：Darwin 暂存 `chmod` 调用为空、macOS 发行复制 `chmod` 调用为空、模拟 Darwin host 的 `0644` 布局被错误接受，共 3 失败、8 通过。新增 `pty-native-permissions.mjs`，暂存在完成标记前修复目标副本，发行打包复用同一函数，布局校验在 Darwin host 要求任一执行位；同命令转为 2 文件 11/11，四个 `.mjs` 的 `node --check` 通过。
- 完整回归为 bridge 39 文件 432/432、启动器 8/8、extension 24 文件 180/180，两端 typecheck 和扩展 production build 通过，只有既有大 chunk 警告。启动器独立命令首次误指仓库根目录、因模块不存在未执行；改用实际 `bridge/scripts/run-portable-launcher-tests.mjs` 后 8/8，不记作产品测试失败。
- 项目外 Windows 真实探针 `darwin-permission-fix-win-20261112-01` 由 Node 22.23.4 启动，选择 `bun-node-pty`，初始尺寸、输入、连续 tick、中文、resize、exit 7 与双隔离全 true。该结果只证明 Darwin 分支未破坏 Windows；新提交的 macOS Runner 仍是必需证据，实机 Terminal.app、窗口、签名和产品交互未验收，不打 tag、不发布 Release。

## 2026-11-12 CI #45 与 Darwin 测试夹具修复

- `34aab032cc4eb97a59605d7786e750ae84117832`（`修复 macOS PTY 辅助程序执行位`）已提交并推送。CI #45 run `43152101342` 总结论为 `failure`：Ubuntu job `130963441175`、Windows job `130963441176` 成功，macOS job `130963440887` 失败。Windows 的共同测试、真实 PTY、完整发行布局、项目树外 smoke、绿色单文件、启动器、生命周期与扩展步骤均逐项为 `success`。
- macOS 共同测试为 1 个文件失败、36 个通过、2 个跳过，1 项失败、427 项通过、4 项跳过。失败项是 `tests/pty-probe-dependencies.test.ts` 的“auto 回退复用完整暂存”，在 `ensureDarwinSpawnHelperExecutable()` 对 `prebuilds/darwin-arm64/spawn-helper` 执行 chmod 时 `ENOENT`；真实 PTY、发行布局、项目树外 smoke、artifact 与扩展步骤均 skipped，因此这次没有原生执行位修复通过或失败的结论。
- 根因是旧测试只创建 `node-pty/package.json`、`LICENSE` 和 `node-addon-api` 最小包，而 Darwin 生产逻辑按真实包结构要求 helper 存在。先只向该用例注入 `platform:"darwin", arch:"arm64"`，Windows 本地得到有效 RED：同一 `ENOENT`，该文件 1 失败、2 通过；再只补 `spawn-helper` 测试文件，生产文件未改，未允许缺失原生文件被静默忽略。
- 补夹具后聚焦 `pty-probe-dependencies.test.ts` 与 `native-layout.test.ts` 两文件 11/11，bridge typecheck 通过。最新完整回归为 bridge 39 文件 432/432、启动器 8/8、extension 24 文件 180/180，两端 typecheck 和扩展 production build 通过，只有既有大 chunk 警告。
- 当前待提交范围只有上述测试夹具与五份同步文档；根目录 zip、JPG、`venv/` 保持未跟踪。提交推送后必须读取新 SHA 对应的新 CI，不能继续沿用 #45；重点核实 macOS 共同测试、至少一条真实 PTY 路线六项行为、发行执行位、项目树外 smoke 和扩展步骤。即便全绿，macOS 实机 Terminal.app、真实窗口、签名和产品交互仍未验收，不打 tag、不发布 Release。
