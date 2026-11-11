# CopilotCC 双终端模式设计

日期：2026-11-10
状态：用户已批准设计，待书面 spec 审阅

## 1. 背景与目标

CopilotCC 已能在别名所在文件夹生成续聊脚本，也能扫描 Claude Code 的 JSONL 转录并展示会话历史。本功能在此基础上增加两个入口：

1. 打开系统终端并继续当前会话。
2. 打开插件内的独立终端窗口并继续当前会话。

两种终端中产生的用户消息、助手消息、工具活动、审批结果和会话变化都应按各自能力同步到插件。终端新建的会话必须自动出现在插件会话列表中，不能依赖用户手动刷新。

整个工作区同一时间只能有一个由 CopilotCC 管理的终端接管当前会话。接管期间插件是只读镜像，终端退出后恢复插件输入，避免桥接 SDK Query 与交互式 CLI 同时写同一会话。

## 2. 已确认的决策

- 同时实现系统终端和插件内嵌终端，不在两者之间二选一。
- 插件终端采用 xterm.js；后端优先验证 node-pty 直接进入 Bun 桥接的可行性。
- Windows 系统终端优先使用 Windows Terminal，没有时使用可见的系统控制台回退。
- macOS 系统终端使用 Terminal.app。
- 插件终端放在独立 Chrome 窗口，不放进狭窄的侧边栏。
- 两种模式共用会话接管、会话事件、转录监听和历史解析。
- 不依赖 Remote Control、官方 Anthropic 登录或任何云端中转服务。
- 保留用户现有 Claude Code 配置和 API 中转环境，不修改全局 Claude 设置。

## 3. 范围

本次支持现有发行目标：

- Windows x64，Windows 10 1809 及以上，使用 ConPTY。
- macOS arm64，使用 POSIX PTY。

系统终端回退只覆盖上述平台。Linux、Windows x86、macOS Intel、多分屏、多标签终端管理器和通用 SSH 终端不在本次范围内。

## 4. 非目标与边界

- 不把 xterm.js 当作 shell；它只负责终端显示和输入。
- 不解析 ANSI 文本来重建结构化聊天消息。
- 不承诺系统终端的聊天镜像逐字流式更新；它按 CLI 写入 JSONL 的事件同步。
- 不恢复已经随桥接退出而销毁的 PTY 屏幕或进程。
- 不阻止用户绕过 CopilotCC，另外手工启动 Claude 进程写同一会话。独占保证覆盖由 CopilotCC 启动和识别的终端。
- 不因为终端中出现内部通知、compact summary 或子代理报告，就把它们显示成用户发言。
- 不自动提交、推送、打 tag 或发布 Release。

## 5. 总体架构

```text
                         ┌─ 系统终端适配器
别名行终端菜单 ──────────┤  Windows Terminal / Terminal.app / 可见控制台
                         │
                         └─ 插件终端适配器
                            terminal.html + xterm.js + PTY
                                      │
                          共用 TerminalLeaseManager
                                      │
                 ┌────────────────────┼────────────────────┐
                 │                    │                    │
        本地 Session Hooks      进程生命周期监控      SDK Query 停机/恢复
                 │                    │
                 └──────────┬─────────┘
                            │
                  JSONL TranscriptWatcher
                            │
              现有 transcript 解析器 + 稳定 ID 合并
                            │
              会话列表、聊天镜像、只读状态、错误反馈
```

### 5.1 共用核心

**TerminalLeaseManager** 是唯一会话所有权协调者，负责：

- 建立、恢复和释放终端 lease。
- 接管前停止桥接自己的 SDK Query。
- 在接管期间拒绝所有会改变当前会话的请求。
- 接收并校验本次终端的 SessionStart 事件。
- 跟踪当前终端实际使用的 sessionId。
- 终端退出后最后同步一次转录，再恢复 SDK Query 和插件输入。

**TranscriptWatcher** 负责文件变化，不负责判断进程所有权：

- 监听当前绑定文件夹对应的 Claude projects 目录。
- 发现新文件、修改和删除后刷新会话列表。
- 当前接管会话变化时生成最新结构化历史页。
- 通过事件防抖和周期对账降低平台 watch 丢事件的影响。

**现有 transcript 解析器** 继续作为结构化历史的唯一语义来源，包括工具结果合并、Edit diff、Ask、ExitPlanMode、compact、Task 通知和稳定 ID。

### 5.2 两种终端适配器

系统终端适配器只负责可见窗口、私有启动包装进程和退出状态，不直接解析聊天内容。

插件终端适配器额外负责 PTY 输入、输出、resize、输出序号、短暂断线重连和连接归属。它的原始终端输出只进入 xterm.js；侧边栏聊天镜像仍来自 JSONL。

## 6. 用户界面

### 6.1 别名主行

在现有 📂 按钮附近增加一个紧凑的 `>_` 按钮，点击后显示两个命令：

- `在系统终端打开`
- `在插件终端打开`

使用一个菜单入口，避免在主行同时增加两个按钮。当前未绑定文件夹时两个命令均不可用，并保留原因提示。

Windows 未检测到 Windows Terminal 时，系统终端命令仍可使用，但成功反馈必须明确说明已回退到系统控制台，不能静默伪装成 Windows Terminal。

### 6.2 独立插件终端窗口

插件终端使用单独的 `terminal.html`，通过现有 Chrome runtime/background 窗口协调能力创建和去重，但不使用聊天弹窗的网页钉住参数。

打开顺序固定为：别名行菜单先让 background 打开或聚焦 `terminal.html`；终端页面完成正常桥接认证后发送 `terminal.open { mode: "embedded" }`；桥接创建 lease 并返回 `terminal.opened`；随后同一连接发送 `terminal.attach` 绑定输入输出。窗口创建失败时不会启动任何 Claude 进程。系统终端仍由别名行直接发送 `terminal.open { mode: "system" }`，不需要 `terminal.attach`。

窗口包含：

- xterm.js 终端区域。
- 当前模式、文件夹和会话状态。
- 连接中、接管中、降级、退出和错误状态。
- 明确的结束终端按钮。

必须支持窗口缩放、CJK、中文输入法、滚动历史和 Claude Code 所需的键盘输入。终端尺寸变化通过 PTY resize 同步，不能只改变 CSS 大小。

### 6.3 聊天视图只读状态

侧边栏和独立聊天窗口同时显示：

> 终端接管中 · 当前为只读镜像 · 终端退出后恢复输入

接管期间禁用发送、停止、审批回答、Ask 回答、新建/删除/切换会话、换绑文件夹和会改变当前会话的别名操作。已有草稿保留且不清空。历史展开、分页、复制和滚动仍可使用。

前端禁用只是体验层；桥接必须独立拒绝这些请求并返回可见错误，不能依赖按钮状态保证安全。

## 7. 会话 lease 与生命周期

### 7.1 状态模型

```text
idle → starting → active → stopping → idle
          │          │
          │          └→ degraded → stopping → idle
          └──────────────→ idle（启动失败并恢复原 SDK Query）
```

每个 lease 至少记录：

- 随机 leaseId。
- `system` 或 `embedded` 模式。
- 目标文件夹。
- 初始 sessionId 和最近确认的 currentSessionId。
- 创建时间和状态。
- 私有包装进程或 PTY 子进程的 PID 与启动身份。
- 独立于扩展配对 token 的随机 hook token。

广播给扩展的公开状态不得包含 hook token、进程环境或任何凭据。

### 7.2 打开终端

1. 桥接从当前别名文件夹、否则当前绑定文件夹解析目标；扩展不得传入任意路径、sessionId 或可执行命令。
2. 校验文件夹存在，且当前没有 busy、待审批或其他交互请求。存在时拒绝打开，不自动 abort。
3. 先进入 `starting`，阻止新的聊天或会话切换请求。
4. 保存当前会话信息并停止桥接自己的 SDK Query。
5. 有当前会话时使用 `claude --resume <sessionId>`；没有时由桥接生成 UUID 并使用 `claude --session-id <uuid>`。
6. 启动失败时清理本次私有资源，恢复原 SDK Query，广播 `idle` 和可见错误。
7. 启动成功后保持插件只读，等待 SessionStart 和转录事件。

CLI 路径解析、macOS 登录 shell 环境补齐和中转环境继承复用现有 `claude-session` 能力。不得把环境变量、API key 或配对信息写入启动脚本、命令行日志或广播消息。

### 7.3 准确跟随会话变化

通过 CLI 已支持的 `--settings` 为本次进程附加本地 SessionStart/SessionEnd Hooks，不修改用户全局设置。Hook 事件统一进入现有桥接的回环 HTTP 接收端，URL 携带 leaseId，请求使用独立 hook token 认证。真实探针已确认本机 CLI 2.1.316 的 HTTP Hook 10 秒未到达，而 command Hook 对照成功，因此当前生产固定由随桥接发布的本地 command helper 转发同一事件；HTTP settings 仅作为保留能力，后续必须重新通过真实探针才能启用，绝不按 semver、最新文档或最新转录文件猜测能力/会话。

SessionStart 事件包含的 `session_id`、`transcript_path`、`cwd` 和 `source` 用于确认当前会话，覆盖：

- `startup`
- `resume`
- `clear`
- `compact`
- `fork`

桥接校验 hook token、leaseId、目录归属和转录路径后才接受事件。事件中的路径不能直接成为任意文件读取授权。

`/clear`、`/resume` 和 fork 后，插件跟随新确认的 sessionId，更新当前会话及别名所指向的会话；compact 若保持同一 sessionId，则只更新内容，不清空聊天视图。

SessionEnd 的 `clear`、`resume` 等事件本身不释放 lease。是否结束接管由实际包装进程或 PTY 的退出决定，避免旧会话结束事件与新会话启动事件之间的竞态。

启动后 10 秒仍未收到任何有效 SessionStart、但终端进程仍存活时，lease 进入 `degraded`：

- 插件继续保持只读，避免双写。
- 继续监听初始会话和刷新会话列表。
- 明确提示未收到会话事件，终端内切换会话时插件不能可靠跟随。
- 不根据“最新修改文件”猜测当前会话。
- 退出后恢复到最后一次由 hook 确认的会话；从未确认时恢复初始会话。

### 7.4 退出与恢复

终端退出后：

1. 停止接收输入。
2. 对当前确认会话执行最后一次转录和会话列表同步。
3. 释放 lease。
4. 按最后确认的 sessionId 重建桥接 SDK Query。
5. 恢复两个聊天视图的输入和会话操作。

从未收到有效 hook 时恢复初始会话，不猜测终端最后使用的其他会话。

### 7.5 关闭插件终端窗口

关闭或刷新插件终端页面表示结束该终端，不提供原屏幕恢复。桥接在 PTY 客户端断开后给予 3 秒重连宽限；只有原页面仍存活、终端状态仍保留的重连才可以继续。

宽限结束仍无有效重连时，桥接结束自己拥有的 PTY 子进程并完成正常退出同步。会话转录保留，用户可以再次打开终端续聊。

桥接正常退出时结束其拥有的 PTY 子进程。异常重启后，只有核对 PID 与启动身份都符合的记录才允许清理遗留子进程，避免误杀 PID 复用后的其他程序。内嵌 PTY 不跨桥接重启续接。

### 7.6 系统终端的桥接重启恢复

系统终端使用桥接私有包装进程记录 PID、启动身份和退出状态，不能以 `wt.exe` 已返回来判断 Claude 已退出。

系统 lease 持久化在桥接私有配置目录。桥接重启后：

- 原包装进程身份仍匹配时恢复 watcher 和只读状态。
- 原进程已退出时先同步转录，再清除 lease 并恢复插件输入。
- 身份无法确认时保持只读并显示可见错误，不能贸然启动第二个写入者。界面提供“确认原终端已关闭并解除接管”操作；只有用户明确确认原终端已关闭后才清除该 lease，不根据猜测杀进程。

## 8. 会话发现与转录同步

### 8.1 一般会话发现

当前文件夹绑定期间，watcher 始终监听对应 projects 目录，而不是只在终端接管期间监听。

- 新 JSONL 文件出现后刷新 `session.list.data`。
- 文件标题随后变化时继续刷新列表。
- 删除文件后刷新列表。
- 非 CopilotCC 启动的普通终端，其新会话也能被发现。
- 只有携带当前有效 lease token 的 SessionStart 才能改变接管会话；普通新文件不能自动夺取当前镜像。

监听使用 250ms 防抖，并每 2 秒进行一次轻量目录对账。实现不能依赖单次 `fs.watch` 事件一定到达。

### 8.2 结构化镜像更新

每次当前接管转录发生有效变化后，读取最新历史页，并按现有稳定 ID 与界面记录合并：

- 新记录按转录顺序追加。
- 已存在记录允许由后续工具结果、审批结果或状态更新。
- 用户已加载的更早分页保留，不因最新页刷新而丢失。
- 相同稳定 ID 不重复显示。
- 切换 sessionId 时才清空不再属于当前会话的视图。

最新页使用独立的服务器推送消息，不伪装成客户端主动请求历史的应答。消息携带 sessionId、页面记录、分页信息和递增 revision；旧 sessionId 或旧 revision 的消息不得覆盖新状态。

长输出、diff、原始参数、长报告、compact summary 和内部摘要继续默认折叠并可完整展开。

### 8.3 内嵌终端原始输出

PTY 输出消息携带 leaseId、递增 seq 和字符串数据块，只发送给已绑定的终端连接。

桥接保留有界重放缓冲，用于原页面短暂断线后的缺口补发。客户端检测到无法覆盖的序号缺口时必须显示错误并结束该终端，不伪造连续屏幕或静默丢输出。页面刷新不依赖重放缓冲恢复整个终端。

## 9. 协议方向

协议单一来源仍为 `shared/protocol.ts`，桥接和扩展复制件由现有同步脚本生成。

新增逻辑消息分为：

- `terminal.open`：只携带模式，不携带路径、sessionId 或命令。
- `terminal.attach`：插件终端窗口绑定现有 lease。
- `terminal.input`：已绑定连接的终端输入。
- `terminal.resize`：行列尺寸。
- `terminal.close`：请求结束自己拥有的 lease。
- `terminal.state`：向所有视图广播公开 lease 状态。
- `terminal.opened` / `terminal.error`：请求结果和可见错误。
- `terminal.output`：带序号的 PTY 数据块。
- `terminal.exit`：退出码或退出原因。
- 独立的转录镜像推送：携带 sessionId、最新页和 revision。

所有输入、resize、attach 和 close 都校验 leaseId 与 WebSocket 连接归属。终端原始输入是用户明确打开终端后的交互能力，但初始进程和参数仍只能由桥接按当前工作区构造。

## 10. 系统终端启动

### Windows

1. 检测 `wt.exe`，优先启动 Windows Terminal。
2. 使用服务端目标文件夹作为 starting directory。
3. 启动桥接私有包装进程，由它启动解析后的 Claude CLI 并记录生命周期。
4. 没有 Windows Terminal 时使用可见系统控制台，GUI 窗口必须保持 `windowsHide: false`。
5. 不以进程 spawn 成功或窗口进程存在代替真实窗口验收。

### macOS

通过 `osascript` 启动 Terminal.app，在正确目录运行同一私有包装命令。保留现有登录 shell 环境补齐，避免 GUI 桥接找不到 CLI 或丢失用户中转环境。

私有启动文件放在 `CCC_BRIDGE_HOME` 下的终端运行目录，不再向用户项目额外生成第二套续聊脚本。现有“打开文件夹”续聊脚本行为保持不变。

## 11. PTY 与发行打包

### 11.1 路线选择

优先路线是 Bun 桥接直接加载 node-pty，保持单一桥接进程。Bun 的 Node-API 兼容声明不等于 node-pty 的输入、输出和打包已经可靠，因此必须先通过隔离探针。

如果直接路线在实际目标上失败，回退为独立 Node PTY helper：

- 主桥接继续负责 lease、hooks、watcher 和协议。
- helper 只负责 PTY。
- 发行包携带所需运行时，不要求用户另装 Node。
- 不改变两种终端都要交付的范围。

不允许只做 xterm.js 页面而没有真实 PTY 后端。

### 11.2 发布硬门槛

- Windows 编译后的 exe 在项目树外、隔离 CWD 和隔离配置目录中加载原生 PTY。
- 验证输入、持续输出、resize、退出和中文，不只验证 `require` 成功。
- macOS arm64 验证原生模块、PTY 行为和 `.app` 签名。
- 若原生模块需要外置，安装包必须一并安装，不能要求用户手工复制。
- Release 构建不得静默遗漏承诺的原生模块。
- 单机加载失败时，插件终端命令显示具体错误，系统终端继续可用；其他聊天功能不受影响。

## 12. 错误处理

| 情况 | 行为 |
| --- | --- |
| 未绑定文件夹或目录不存在 | 不启动，显示原因 |
| 插件 busy 或有待处理交互 | 拒绝接管，不自动中止 |
| 已有 lease | 聚焦插件终端，或提示系统终端已接管；不创建第二个写入者 |
| 未找到 CLI | 恢复原 SDK Query，显示安装/路径错误 |
| Windows Terminal 不存在 | 使用可见控制台并明确提示回退 |
| 原生 PTY 模块不可用 | 仅插件终端失败，系统终端和聊天保留 |
| Hook 超时但进程存活 | 进入 degraded，只读并保持列表同步，不猜测新会话 |
| Hook token 或路径校验失败 | 拒绝事件并记录不含凭据的错误 |
| Watcher 单事件丢失 | 周期对账补齐，不能永久停止刷新 |
| 终端异常退出 | 最后同步、释放 lease、显示退出原因并恢复输入 |
| 启动失败 | 清理本次资源并恢复原会话 |
| 桥接重启 | 系统 lease 核对后恢复；内嵌 PTY 从转录恢复而不伪造续接 |

错误消息不得包含 API key、hook token、配对 token 或完整进程环境。

## 13. 安全要求

- 扩展不能提交任意可执行命令、启动路径或转录读取路径。
- Hook 端点只监听现有桥接的回环服务，使用每次 lease 独立随机 token。
- Hook token 与扩展配对 token 分离，且不出现在广播状态中。
- 对 hook 的 cwd、sessionId 和 transcript_path 做归属校验。
- 启动参数由桥接生成；sessionId 必须是合法 UUID。
- 不修改全局 Claude 设置，不读取或打印用户私有配对配置。
- 测试继续使用隔离 `CCC_BRIDGE_HOME` / `CLAUDE_CONFIG_DIR` 和本机假上游。
- 不调用真实 API，不停止或替换用户正在使用的桥接。
- 不在盘符根目录创建验证目录，继续复用已批准的验证根目录。

## 14. 测试策略

所有新行为按 TDD 先取得有效 RED，再写最小实现取得 GREEN。

### 14.1 单元与集成测试

- lease 全状态迁移、重复打开、启动失败回滚和退出恢复。
- busy、审批、Ask、会话切换和换绑在接管期间被服务端拒绝。
- SessionStart 各 source、新会话跟随、compact 同会话和无效 token/path 拒绝。
- SessionEnd 与 SessionStart 竞态不误释放 lease。
- watcher 新建、修改、删除、防抖和周期对账。
- 最新页与已加载旧页合并、稳定 ID 去重、工具结果更新和 revision 防旧包覆盖。
- 系统启动器参数、路径含空格/中文、Windows 可见窗口配置和 macOS 命令构造。
- PTY 输入输出序号、resize、连接归属、短暂重连和关闭清理。
- 别名行菜单、只读状态、草稿保留、两个聊天视图同步和错误可见性。
- 现有打开文件夹、聊天、工具详情、compact 和 Task 回放测试不得回归。

### 14.2 真实 Windows 验收

使用新构建的隔离产物和真实 Chrome：

1. Windows Terminal 窗口真实可见，目录和续聊会话正确。
2. 模拟没有 `wt.exe` 的环境，回退窗口真实可见且提示正确。
3. 插件终端真实输入、持续输出、中文、resize 和结束恢复。
4. `/clear` 后新会话自动进入列表，镜像跟随正确 sessionId。
5. `/resume` 后跟随所选已有会话。
6. 侧边栏与独立聊天窗口同步只读，直接构造协议请求也不能双写。
7. 系统终端异常关闭、插件终端断线、桥接重启均按状态模型恢复。
8. 编译后的 exe 在项目树外运行，不能侥幸读取仓库 `node_modules`。
9. 真实浏览器控制台无未处理运行错误。

### 14.3 macOS 验收

在 macOS 环境验证 Terminal.app、arm64 PTY、应用包和签名。仅完成交叉编译或代码审查不能写成 macOS 已验收；无法取得真实运行证据的项目必须明确保持未验收状态。

## 15. 实施阶段与完成定义

### 阶段 A：共用核心与系统终端

交付 hooks、watcher、lease、只读镜像、系统终端启动和恢复，并完成相应单测与 Windows 真实验收。

### 阶段 B：插件终端

交付 xterm.js 独立窗口、真实 PTY、重连/关闭行为、原生发行包和跨平台验证。

阶段 A 完成不等于整个需求完成。本功能只有两种模式、终端新会话发现、同步、独占和恢复都取得对应证据后，才可声明完成。

完成后同步更新 README、`docs/guide.md`、`docs/development.md` 和 TODO；这些已有文件的修改仍需按用户规则取得确认。
