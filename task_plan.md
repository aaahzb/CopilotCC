# 双终端功能执行计划

日期：2026-11-10
执行方式：Inline Execution
状态：Windows 绿色单文件、真实 Claude Code CLI 2.1.316 双终端、完整假 CLI、生命周期、双终端交互缺陷修复及最终静态检查均已完成；单文件真实大小 51.6 MiB，公开 CI/Release 已接为仅发布 `CopilotCC.exe`。GitHub Actions #42 已实际运行并暴露跨平台测试准备缺陷，六文件修复及本地完整回归已完成；修复后的三平台云端复验、macOS 实机与真实 API 中转仍未验收。本轮已获提交并推送 `main` 授权，不包括 tag 或 Release。

## 目标

依次完成系统终端与插件独立终端，共用 lease、Session Hooks、TranscriptWatcher 和结构化历史镜像。严格先 RED 后 GREEN，不自动提交、推送、打 tag 或发布。

## 阶段 A：共用核心与系统终端

- [x] Task 1：共享协议与严格帧解析（30/30，bridge typecheck 通过）
- [x] Task 2：Lease 状态机与私有持久化（6/6，bridge typecheck 通过）
- [x] Task 3：HTTP/command Hooks 与 10 秒降级（bridge 全套 319/319；command 实探成功，HTTP 实探失败并保守回退）
- [x] Task 4：常驻 watcher 与 revision 镜像（bridge 3/3、extension 2/2，两端 typecheck 通过）
- [x] Task 5：私有包装进程与系统终端启动器（聚焦 15/15、bridge 全套 333/333，typecheck 通过）
- [x] Task 6：Server 接线、双写防护与重启恢复（聚焦 92/92、bridge 全套 342/342，typecheck 通过）
- [x] Task 7：扩展入口、只读界面与双视图镜像（聚焦 53/53、扩展全套 158/158，typecheck/build 通过）
- [x] Task 8：编译产物与真实 Windows 验收（有效负控、最终双 exe 正常验收、完整回归与 README/guide/development/TODO 文档均完成）

详细步骤：`docs/superpowers/plans/2026-11-10-terminal-core-system.md`

## 阶段 B：插件独立终端

- [x] Task 1：原生依赖与真实 PTY 路线探针（node-pty 1.1.0；有效 RED；auto 选择 bun-node-pty；输入/tick/中文/132×36/exit 7 全通过）
- [x] Task 2：统一 PTY 后端与 Node helper 回退（聚焦 11/11、bridge 353/353、typecheck 通过；直接/helper 真实探针均全绿）
- [x] Task 3：输出 seq、有界重放与严格协议（聚焦 37/37、bridge 360/360、extension 158/158、两端 typecheck 通过）
- [x] Task 4：Embedded runtime、所有权与 3 秒重连（bridge 387/387、typecheck；真实编译 bun-node-pty 冒烟及缺失/超时负控通过，隔离进程 0）
- [x] Task 5：terminal.html、xterm.js 与认证顺序（聚焦 59/59、extension 172/172、typecheck/build 通过，产物含 terminal.html）
- [x] Task 6：原生发行布局、CI 与 macOS 签名（Windows 真实路线/完整目录/外部冒烟与负控通过，bridge 394/394；macOS 仅脚本和 dry-run，未实机验收）
- [x] Task 7：双终端真实 Windows 验收与文档（green-27/28 全部必需项通过，关键截图人工核对；bridge 403/403、extension 173/173、两端 typecheck、扩展 build、原生布局和 YAML 检查通过）

详细步骤：`docs/superpowers/plans/2026-11-10-embedded-terminal.md`

## 阶段 C：Windows 绿色单文件

设计与计划：`docs/superpowers/specs/2026-11-11-portable-single-exe-design.md`、`docs/superpowers/plans/2026-11-11-portable-single-exe.md`。用户已批准，继续 Inline，不自动提交或发布。

- [x] Task 1：生产入口便携负载目录识别（新增 7 项先 RED；entrypoints 23/23、bridge typecheck 通过）
- [x] Task 2：启动器清理、ZIP 发布与进度界面（含长路径回归后 C# harness 八组通过；聚焦 24/24、bridge typecheck 通过）
- [x] Task 3：真实压缩单文件构建（当前构建 54,134,272 bytes，约 51.6 MiB；SHA-256 `9a32c30310efdf9b4b6eda17387a34a1687264e72269972494b99820f0995598`；payload SHA-256 `6ba809bae91e0a4167aaa5cceae578e43d24988a806f71f50dc3cc6d649c68b6`）
- [x] Task 4：生命周期验收与发布接线（第 06 轮 15 项必需断言全 true，真实进度截图人工复核，cleanup 双空；新 payload 假 CLI 第 04 轮与真实 CLI 第 02 轮通过；CI/Release 仅发布单 exe）
- [x] Task 5：完整真实双终端回归与文档交付（bridge 38 文件 422/422、extension 24 文件 173/173、两端 typecheck、扩展 build；最终聚焦 46/46、启动器 8/8、原生布局、工作流和脚本语法检查通过；README/guide/development/TODO/执行记录同步）

## 阶段 D：双终端交互缺陷修复（2026-11-11，已获本轮修改与固定文本剪贴板验收授权）

- [x] Task 1：以失败测试固定系统终端 6–8 秒慢启动、最终超时取消和 child 启动准许握手，再最小实现（聚焦 13/13；`interaction-fix-system-05` 完整真实验收通过）。
- [x] Task 2：以失败测试固定成功后清旧启动错误、复制/粘贴按钮与快捷键、真实 transcript 检测后导出可滚历史，再最小实现（聚焦 50/50；`interaction-fix-embedded-04` 完整假 CLI 真实验收通过）。
- [x] Task 3：两端完整回归、typecheck、扩展 production build、完整 Windows 目录与绿色单 exe 重建（bridge 427/427、extension 180/180；新 exe 54,134,784 bytes）。
- [x] Task 4：用新 exe + 真实 Chrome + 真实 CLI/隔离假上游复验慢启动、迟到取消、滚轮、选择、中文/多行复制粘贴、Ctrl+C 中断和 resize；`interaction-fix-system-05`、`interaction-fix-real-portable-02`、`interaction-fix-embedded-05` 均完整通过且关键截图已人工核对，文档已同步。
- [x] 全程此前未自动提交、推送、打 tag 或发布；CI #42 已提供 GitHub Runner 真实失败证据，macOS 实机与真实 API 中转仍保持未验收边界。

## 阶段 E：GitHub Actions #42 跨平台测试修复（2026-11-12）

- [x] 获取完整 Ubuntu/macOS 失败日志并分类：5 文件、25 项失败；12 项 Windows 路径夹具不适用于 POSIX，13 项假运行时测试在入口被真实 CLI 解析的 `CLI_NOT_FOUND` 阻断，Windows CI 通过。
- [x] 严格 RED→GREEN：新增系统/内嵌运行时实际收到注入 CLI 的断言，本机先 2 项失败、18 项通过；可选 `resolveCli` 注入点后 20/20，生产默认解析不变。
- [x] 通用路径夹具改用 `path.resolve(...)`，不放宽生产绝对路径校验；原失败五文件 36/36，bridge 427/427、启动器 8/8、extension 180/180，两端 typecheck 与扩展 build 通过。
- [ ] 按已获授权仅提交相关修复和文档、核对用户本人身份并推送 `main`；跟踪新提交的三平台真实 CI。未获 tag/Release 授权，macOS 实机产品仍未验收。

## 当前阻塞

1. 无首次修改授权阻塞：用户已选择创建 `feature/dual-terminal` 并授权按计划修改已有文件。
2. 阶段 E 已获提交修复及必要文档、推送 `main` 的明确授权；提交只能使用用户本人身份，不含共同作者或 AI 署名，不延伸到 tag/Release。
3. 阶段 A Task 1～8、阶段 B Task 1～7 和后续真实 Windows 验收均已完成。CI #42（提交 `d4ce58f`）已真实触发：Windows 通过，Ubuntu/macOS 在共同测试步骤各失败 25 项，后续平台步骤未执行；六文件修复后的本地回归通过，但新提交对应的三平台 Runner 结果仍待取得，macOS 实机仍无证据。
4. 曾误写项目外文件 `D:\SVN_Cursor\bridge\tests\terminal-child.test.ts`；正确项目内文件已建立，项目外误写文件仍保留，删除前必须另获用户确认。
5. `README.md`、`docs/guide.md`、`docs/development.md`、`TODO.md` 已完成双终端更新；本次同步 CI #42 的真实失败分类、修复和本地证据，继续区分云端自动测试与 macOS 实机产品验收。
6. 阶段 C 最终证据：单 exe 54,134,272 bytes（约 51.6 MiB），SHA-256 `9a32c30310efdf9b4b6eda17387a34a1687264e72269972494b99820f0995598`。真实 CLI `portable-real-cli-dual-terminal-20261111-02`、完整假 CLI `portable-embedded-green-20261111-04`、生命周期 `portable-lifecycle-20261111-06` 均退出码 0；生命周期 15 项全 true，进度截图人工确认非黑帧，源/副本哈希一致，所有最终 cleanup remaining/errors 双空。完整 bridge 422/422、extension 173/173 和两端 typecheck/build 通过；最终聚焦 6 文件 46/46、启动器 8/8、原生布局/SHA-256、CI/Release YAML 与 20 个 shell 段语法通过。

## 遇到的错误

| 错误 | 次数 | 处理 |
|---|---:|---|
| CI #42 通用夹具的 Windows 绝对路径在 Ubuntu/macOS 被判为相对路径 | 12 项 | 通用夹具改 `path.resolve(...)`；生产校验、相对路径负测试与 Windows 长路径专项保持不变 |
| CI #42 两个 WS 套件未注入 CLI 路径，假运行时之前即返回 `CLI_NOT_FOUND` | 13 项 | 增加可选 `resolveCli` 测试注入点并断言实际收到注入值；生产默认解析不变 |
| 首次 RED 命令在 `extension` 目录执行，未找到目标测试 | 1 | 不作为测试证据；改在 `bridge` 目录运行，得到有效 2 项 RED，随后同命令转 20/20 |
| 并行最终复验的扩展命令继承 `bridge` CWD，误跑桥接且缺少 build script | 1 | 不记作扩展失败；改用 `npm --prefix D:/.../extension` 明确目录，扩展 typecheck、180/180 和 production build 均通过 |
| Task 5 四个新模块不存在，RED 为 4 个 suite 失败 | 1 | 按计划补最小实现，聚焦测试转为 15/15 |
| `TerminalBackend` 从 `terminal-lease` 误导入，typecheck 失败 | 1 | 改从 `protocol` 导入，typecheck 与全套测试通过 |
| `terminal-child.test.ts` 首次写到项目外错误根路径 | 1 | 已在正确项目路径重建；误写文件未擅自删除，等待用户确认清理 |
| Task 6 首轮聚焦回归出现测试夹具/目标版本错误 | 1 | 补 `runtimeInfo()` 与 sessions.get/set 假实现，`findLastIndex` 改为 ES2022 兼容写法；未改生产断言，复测 78/78 与 typecheck 通过 |
| Task 8 首次负控停在初始绑定准备阶段 | 1 | 查明 bind 不自动选最新会话、SDK settings 为内联 JSON；只修验收夹具并换新目录，首次结果不记作有效 RED |
| `final-run-1` 人工解除后出现一条 SessionEnd helper 失败 | 1 | 定位为解除后端点已移除而脚本仍发送 exit；改用定向 WM_CLOSE 清理隔离窗口，新增 Hook 零失败必需条件，`final-run-2` 通过 |
| 复制证据的 Node 内联 Windows 路径被转义 | 1 | 复制未发生；改用正斜杠绝对路径后以 COPYFILE_EXCL 成功保存 |
| 追加错误记录时旧字符串未精确匹配 | 1 | 未发生修改；重新读取对应行后按原文编辑 |
| 残留进程清理命令被 Bash 展开 PowerShell 变量 | 1 | 首次仅解析失败、未终止进程；改用 UTF-16LE EncodedCommand，最终隔离测试进程剩余 0 |
| Conda 创建 venv 时读取既有中文环境路径发生 GBK 解码错误 | 1 | 事务已回滚且 python.exe 不存在；改用 PYTHONUTF8=1，不读取或改写既有环境配置 |
| npm 的 Node 22 引导安装超过 10 分钟未产生运行时 | 1 | 已停止该后台安装；保留隔离目录不删除，改走 Node 运行时 zip 镜像与哈希校验，Node 22.23.4 已可用 |
| Conda 回滚残留元数据导致第二次 create 未释放 Python 文件 | 1 | 未删除目录；先核对 conda list，再在原 venv 内强制重装缺失包，Python 3.12.16 与 venv pip 已可用 |
| npm 安装 node-pty 时 node-gyp 子进程混用系统 Node 25 | 1 | 停止该次安装；改用显式 Node 22.23.4、PATH 首位和 Node 22 头文件镜像，不宣称安装完成 |
| 直接 node-gyp rebuild/configure 日志不完整或超时 | 2 | 使用详细独立日志；Node 22 头文件/node.lib 校验和通过，VS2022+SDK 检测成功，configure 最终正常退出 |
| node-gyp build 报 MSB8040，缺 Spectre 缓解库 | 1 | 根因是 node-pty binding.gyp 强制 Spectre；仅对本次 MSBuild 传入 SpectreMitigation=false，不改第三方源码、不安装 VS 组件 |
| `node-gyp build -- -p:...` 被当成 MSBuild target | 1 | 已读 node-gyp build.js 确认 Windows 会把额外参数统一加 `/t:`；改用同一配置中的 MSBuild 直接传 `/p:SpectreMitigation=false` |
| Git Bash 把 MSBuild `/nologo` 等参数转成路径 | 1 | MSB1008 未执行编译；直接 MSBuild 改用等价的 `-` 开关，避免 POSIX 路径转换 |
| 1.0.0 继续编译出现 ConPTY 类型与 winpty goto/MSVC 错误 | 1 | 不改第三方源码；改查上游稳定版，1.1.0 提供已核验的 N-API 全平台预编译包，计划锁定版本据实更新 |
| Bun 编译态按包名找不到外置 node-pty | 1 | Node 22 与未编译 Bun 均能解析同一目录，定位为编译态解析差异；改用隔离包绝对 lib/index.js，真实原生模块随后成功加载 |
| 探针额外等待字面量 ECHO 回显而超时 | 1 | 中文响应与连续 tick 已到达，证明输入生效；去掉计划外的 readline 字面回显假设，保留计划规定的输入响应断言 |
| 所有 PTY 行为通过后 Bun 探针仍被外层 60 秒超时 | 1 | stdout 已证明六项行为与隔离均为 true，子进程 exit 7；N-API 句柄保持事件循环，一次性探针改为 flush 后显式退出并复核无残留 |
| NodePtyBackend 假 helper 的 stdin 缺少 on/writable | 1 | 测试首次运行仅该夹具报错；补齐真实 ChildProcess stdin 接口后复测，不放宽生产管道错误处理 |
| BunPtyBackend 动态模块加载后类型仍可能 undefined | 2 | 两次 typecheck 均失败；将 createRequire 结果显式收窄为 NodePtyModule，第三次 typecheck exit 0 |
| started 与首屏 data 同批到达时初始输出丢失 | 1 | 新增测试先 RED；两适配器缓存订阅前数据并在 onData 补发，kill 清旧块，聚焦 11/11 与真实 helper 探针通过 |
| 新增 TerminalErrorCode 后错误文案 Record 不完整 | 1 | bridge typecheck 准确列出四个缺项；补固定中文说明后两端 typecheck 通过，未改变 server 分支行为 |
| background 一次 Edit 的 old/new 参数写反，后续注释精确匹配又失败 | 2 | 两次均未修改文件；重新按当前原文编辑。第二个重复 Step 2 复选框也用相邻命令作唯一上下文 |
| TerminalApp 首轮 RED 后 mock client 未进入 attached | 1 | 失败是测试夹具与真实客户端状态不一致；调用 onAttached 前设置 attached，不放宽 fit/resize 断言，页面 3/3 |
| background 把 terminal.open-window 当非 ccc.* 消息过滤 | 1 | 真实入口测试先证明 listener=false；只精确放行该消息，聚焦 59/59 |
| Task 5 typecheck 报 nullable folder 与 windows.create 可能 undefined | 1 | folder 标题/占位显式处理 null，窗口结果先判 win?.id；typecheck 与完整构建通过 |
| Task 6 对照探针发现 node-addon-api 未随发行目录复制 | 1 | 新增精确 manifest 断言先 RED；两种路线复制该生产依赖并把 package.json 纳入必需校验，6/6 通过 |
| 项目 venv 未安装 PyYAML | 1 | 不额外污染环境；改用现有 Bun.YAML 对 CI/Release 两份工作流实际解析，均通过 |
| TerminalApp 真实 WS 路径为 `/`，服务器只接受 `/ws` | 1 | 先增加组件精确 URL 断言取得 RED，再改 `/ws?token=`；页面 3/3、typecheck 与 production build 通过 |
| `cmdStart()` 正常信号退出未调用 `server.close()` | 1 | 已定位到真实生产缺口；下一步先写失败测试，再接通关闭与 owned PTY 清理，不以强杀冒充 |
| 验收 tail 首次长 heredoc 引号解析失败，随后正则反斜杠被截断 | 2 | 首次未执行写入；改用 Edit 分段，修正 `replace(/\\/g, …)` 后 `node --check` 通过 |
| `embedded-green-1/2` 等待终端 `FAKE_ECHO` 超时 | 2 | 截图、脱敏代理和 JSONL 证明输入/Enter/PTY/镜像均到达；正常假 CLI 只把助手回复写入转录而漏写 stdout。保留 RED，仅补隔离夹具的终端回复，不改生产输入链 |
| `embedded-green-3` 画面已有回复但 DOM 等待仍超时 | 1 | 确认是 `.xterm-rows` 定位器未反映画布新文本；改代理只记录固定标记命中并保存真实截图，不增加生产测试接口 |
| `embedded-green-4` 正常会话 `/ticks on` 超时 | 1 | ASCII/中文/IME 已通过；假 CLI 把该命令当普通文本。作为有效 RED，最小补正常夹具 tick/size，不改生产代码 |
| `embedded-green-5` resize 过冲且 tick 命令污染夹具转录 | 1 | 代理证明 132×36 曾到达，脚本读旧帧导致继续放大；改为等待本轮新帧。另把 `/clear` 接回 `else if` 链并新增 JSONL 污染断言 |
| `embedded-green-6` 首次编译在 `return` 后多出大括号 | 1 | `Expected "finally" but found "else"` 在启动窗口前失败；删除多余大括号后重新编译，不把该轮记为运行验收 |
| `embedded-green-6～9` resize 等待读取旧帧或目标提前到达 | 4 | 逐次取消过期快照和索引过滤，最终改为一次窗口调整并等待目标帧；不放宽 132×36 断言，各轮均定向清理 |
| `embedded-green-10/11` 页面 hidden 导致 resize 时序失败 | 2 | 去除最小化启动并在打开及输入前 `bringToFront`；窗口证据增加 normal、visible 和真实 `.xterm` 三项 |
| `embedded-green-12` 可见后目标帧通过，但 tick 淹没 `/size` 证据 | 1 | 验收 Chrome 禁用遮挡和后台节流；先 `/ticks off` 再 resize，并记录数值型 `pty.size`，不再只看固定文本 |
| `embedded-green-13` 子进程报告 120×32 而非 132×36 | 1 | 已确认同连接 resize 先于 `/size`、无协议错误，清理为零；正在用同一原生包区分真实 resize 未应用与 Bun 假 CLI 尺寸未刷新，不硬编码通过值 |
| 正常假 CLI resize 对照的空监听与即时查询均未通过 | 2 | Node 22 直接 PTY 也复现 120×32；空监听无效，等待事件又超时。最终仅将 readline 改为交互模式后，真实 RESIZE/SIZE 132×36、exit 0、remaining 0 全通过 |
| `embedded-green-14` 画面已有 RESIZE 132×36 但代理仍等待 | 1 | 完整 PTY 链已生效；readline 重绘把 ANSI 尾字符直接拼在标记前，`\bRESIZE` 不可靠。改用不依赖词边界的精确 RESIZE/SIZE 解析；该轮清理为零 |
| 删除旧 size marker 时 Edit 的数组结尾写成 `};` | 1 | 精确匹配失败、未修改文件；重读原文后按 `];` 修正，随后执行语法检查 |
| `embedded-green-15` 仍以“后续场景尚未接入”exit 1 | 1 | 当前正常链路已全部越过，真实 resize/SIZE 132×36、JSONL 隔离和零残留已核实；保留非零门槛，继续接入 Hooks、重连、缺帧、生命周期与异常恢复，不记作完整通过 |
| `embedded-green-16` 控制连接等待 `terminal.exit` 超时 | 1 | owner 页面和代理均已收到真实退出；该帧不是向控制连接广播。改从 owner 代理连接取证，生产代码不变，本轮清理零残留 |
| `embedded-green-17` 无会话启动参数不是 `--session-id` | 1 | `session.new` 同步启动 SDK，初始化先于终端点击形成竞态；只给隔离假 CLI 增加 stream-json 延迟开关，green-18 真实参数与全部已接入场景通过 |
| `embedded-green-19` 活跃 lease 的 backend/PID/身份长期为空 | 1 | Hook 抢先保存 active 后，后端补存失败只广播而未落盘；真实错误紧挨 opened。新增暂时 rename 失败回归先 RED，存储层三次有界重试后聚焦 15/15、typecheck 通过并重编双 exe |
| `embedded-green-20` 输出缺口提示被紧随的退出帧覆盖 | 1 | 代理确认丢 seq 9、收 seq 10、close、exit 的顺序；新增回归先 RED，致命错误后的退出保留错误原因并追加退出结果，聚焦 9/9、typecheck/build 通过 |
| `embedded-green-21` 准备阶段设置页未连接 | 1 | 代理零帧、桥接 stderr 为空、页面运行错误为空，未进入终端场景；清理零残留。增加不含 token 的设置页连接/截图诊断，不能用本轮评价缺口修复 |
| `embedded-green-22` 首次正常关闭停在 `AttachConsole` | 1 | 输出缺口错误保留与 pagehide 已真实通过；后续关闭/恢复/原生失败隔离未执行。建立最小隔离 Console 探针，不重复跑完整 Chrome 验收 |
| Console 探针准备及启动路径错误 | 4 | probe-1～4 分别为源码提取、CRLF、C# 截断和发行目录层级错误，均未形成生产验收证据；逐项修正后才开始进程行为诊断 |
| `AttachConsole`、共享 Console 与多类 Ctrl+C 路径未形成关闭证据 | 20 | probe-5～24 已排除 detached 无 Console、共享 Console 风险和简单 JS 回调假设；不沿用“新进程组就是根因”的猜测。前台检查始终阻止发送，未向用户窗口发键 |
| 非沙箱最小对照仍 `foreground=0` | 1 | probe-25 与 probe-24 相同，排除单纯沙箱权限解释；两轮 `remaining=[]`，下一步检查输入桌面并改用不依赖前台焦点的定向正常关闭路径 |
| 定向 WM_CLOSE 退出但真实桥接未执行清理 | 1 | probe-26 原生目标收到 CTRL_CLOSE 并 exit 0；probe-27 真实桥接 exit 0xC000013A 且 runtime 残留。SIGHUP 回归先 RED，加入既有异步关闭后 4/4、typecheck 通过 |
| stopBridge 多行精确替换未匹配 | 3 | 均未完成目标替换；改用明确函数边界的 Node 脚本替换并 `node --check`，不改变验收断言 |
| `embedded-green-23` 正常关闭后重新绑定超时 | 1 | owned PTY 已真实退出，但 `closeEmbedded()` 只等待 kill/backend close，未等待真实 exit 与异步 `completeExit()`；新增两条回归均先按 `closed=true` 取得 RED，再让 adapter 等待真实 exit 与退出清理 Promise、lease 回调返回 `completeExit()`。聚焦 21/21、bridge 401/401、typecheck 和双 exe 构建通过，green-24 真实复验中 |
| `embedded-green-24` 异常强杀后 ConPTY 子进程已退出 | 1 | 正常关闭后的重新绑定已越过；失败在 recover 之前，不是 recover 误杀。保留身份安全断言，先为“PID 确认不存在且无 exit 文件”的清理分支写 RED，并将仍存活身份匹配故障注入与 ConPTY 自动退出分开验收；本轮 cleanup 双空 |
| 新进程存活测试的结尾替换匹配到 3 处 | 1 | 首次未修改文件；改用前一项测试的完整结尾作为唯一上下文后成功，不把编辑失败记作 RED |
| `git diff --check` 报样式文件末尾多余空行 | 1 | 位于本功能已授权的 `extension/src/entrypoints/sidepanel/style.css:219`；最终收尾时仅移除末尾多余空行并复跑检查，不影响正在进行的真实验收 |
| `embedded-green-25` 在 ConPTY 退出恢复后读取 `null.phase` | 1 | 私有 lease 已清除，但验收在 idle WS 帧到达前同步读取控制 inbox；限定等待 startBridge 后的新 idle 帧，matched 分支同步修正。生产代码不变，本轮 runtimeErrors/realApiCalled/cleanup 均符合边界 |
| `embedded-green-26` 等待原生失败后聊天另起 CLI 超时 | 1 | 时间戳证明最后一个 CLI 在系统终端退出恢复时启动，之后聊天复用它；隔离假 CLI 的 stream-json 分支又只处理控制帧，没有普通用户回复。先补夹具最小聊天 RED，再要求同一恢复进程返回聊天 marker 与 chat.done，不要求无意义的新进程 |

| 单文件深目录真实启动报 `PathTooLongException` | 1 | 新增超过 400 字符的 C# 回归先 RED；进程入口在首次 IO 前启用长路径，内部使用扩展路径、传给内层仍用普通路径，8/8 通过 |
| 验收探针启动时间 ticks 经 JS 数值失真 | 1 | 改为 JSON 字符串并排除探针自身；第二轮生命周期除进度截图外全通过，cleanup 双空 |
| 正常进度窗口前两轮未被抓取 | 2 | 同步监视仍不可见，定位为 Node `windowsHide:true` 给 WinForms 外层传入 SW_HIDE；改为与用户双击一致的 `windowsHide:false`，不增加生产延时，第 04 轮真实截图和全部必需项通过 |
| 便携负控首轮内层目录被误判 | 1 | 真实文件位于预期哈希目录，进程探针正斜杠与期望路径反斜杠直接比较导致 RED；改用 `path.resolve` 统一表示，保留严格父子目录和 64 位哈希断言，cleanup 双空 |
| 多行 import 前的 `@ts-expect-error` 未生效 | 1 | 便携聚焦 22/22 通过但 typecheck 报未使用指令与 `.mjs` 缺声明；改为紧邻单行模块导入后，bridge typecheck 通过 |
| Bun/Win32 原生模块深路径加载失败 | 2 | conpty 启动与 conpty_console_list 关闭分别暴露 MAX_PATH；后端及发行 utils.js 统一使用扩展路径 `process.dlopen` 回退，真实 CLI 第 02 轮启动和关闭均通过 |
| 生命周期第 05 轮进度截图是黑帧 | 1 | `PrintWindow` 成功不代表已绘制，不采用该视觉证据；验收增加客户区亮色像素门槛，不改生产或人为延时，第 06 轮真实文字和绿色进度条可见，15 项全通过 |
| 敏感信息初扫误报文档中的 `task-…` | 1 | 命中的是普通任务路径里的 `sk-` 子串，不是 API key；正则排除前置字母数字后，9 份文档/工作流扫描通过，未打印候选秘密值 |

## 固定约束

- 不读取或输出私有配对配置、API key、hook token、attachToken 或完整进程环境。
- 不停止或替换用户正在使用的桥接，不调用真实 API。
- 隔离验证只能使用已批准的 `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110`。
- 根目录 zip/JPG 保持未跟踪、未提交。
- Git 作者与提交者只能是用户本人，禁止共同作者尾注。
- macOS 无真实运行证据时保持未验收。
