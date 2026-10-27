# CopilotCC

> 把**网页信息**和 **Claude Code 的系统操作能力**结合起来的浏览器 copilot：侧边栏里边浏览网页边向 Claude 提问（页面内容自动进入上下文，无需复制粘贴），并让 Claude 直接把笔记、代码写进你绑定的本地文件夹。

![平台](https://img.shields.io/badge/平台-Windows%20x64%20%7C%20macOS%20arm64-blue)
![运行时](https://img.shields.io/badge/运行时-本机%20Claude%20CLI-orange)
![扩展](https://img.shields.io/badge/Chrome%20MV3-React%2019%20%2B%20WXT-green)

**不依赖 Anthropic 官方账号**：桥接直接 spawn 本机的 `claude` CLI，继承本机已有的环境变量（如国内中转的 `ANTHROPIC_BASE_URL` / token 配置）。

## 快速开始（下载 Release 使用）

到 [Releases](../../releases) 页下载最新版的安装包：

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `ccc-extension-x.y.z-chrome.zip` | Chrome / Edge | 浏览器扩展 |
| `ccc-bridge-win-x64.zip` | Windows 64 位 | 本地桥接（系统托盘程序） |
| `ccc-bridge-darwin-arm64.dmg` | macOS（Apple Silicon） | 本地桥接（菜单栏程序，标准 .app 包） |

> macOS Intel / Linux 暂无预编译产物，请走「开发者 → 从源码运行」。

### 1. 安装扩展

1. 解压 `ccc-extension-*-chrome.zip` 到一个**固定位置**的文件夹（加载后不要移动或删除它）。
2. 打开 `chrome://extensions`，右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择解压出来的文件夹。

### 2. 运行桥接

- **Windows**：解压 `ccc-bridge-win-x64.zip`，双击 `ccc-bridge.exe`，图标出现在系统托盘（单文件 exe，首次运行自动把托盘组件释放到 `~/.ccc-bridge/traybin/`）。
- **macOS**：打开 `ccc-bridge-darwin-arm64.dmg`，把「CopilotCC Bridge」拖进「应用程序」（不拖也行，下面的脚本会代劳），然后对 dmg 里的「首次使用-右键打开我.command」**右键 → 打开**——仅首次需要：浏览器下载的隔离标记会让 macOS 对免费签名误报"已损坏"（对 App 右键打开同样绕不过，必须先解除隔离），脚本自动完成安装、解除隔离并启动。之后双击「应用程序」里的 CopilotCC Bridge 即常驻菜单栏，无需再跑脚本。

### 3. 配对

托盘/菜单栏图标右键 →「复制配对串」→ 点 Chrome 工具栏的扩展图标打开侧栏 → 粘贴配对串 → 状态灯变绿即完成。然后点侧栏顶部的「＋新建」（或「▸ 详情」展开）输入绝对路径或点「选择文件夹…」完成绑定，就能开始边浏览边提问了。

## 功能与使用

- **别名**：一个「文件夹 + 会话」组合可保存为命名别名。侧栏顶部平时只有一个别名下拉，选中即切到它的文件夹+会话；点「＋新建」才展开绑定表单（名称 + 文件夹 + 会话），会话可下拉选择或直接粘贴会话 ID（整行 claude --resume 命令也行），文件夹可点「浏览…」弹系统文件夹选择框（Windows 资源管理器对话框 / macOS Finder 对话框，也可手输路径）；平时文件夹与会话栏隐藏，点「详情」随时展开查看修改；「🗑删别名」只删别名本身，文件夹绑定与会话历史全部保留。别名存在桥接端 `~/.ccc-bridge/aliases.json`，重装扩展不丢；选中别名后再换文件夹或会话会自动写回该别名，永不脱钩。
- **绑定文件夹**：在别名详情区（或新建别名表单）输入绝对路径回车，或点「浏览…」弹系统选择框。绑过会的文件夹显示“已续聊”徽标并回放历史（回放气泡只显示用户实际问题，页面上下文包装不进气泡；完整发送内容与 📄/📎/📁 附带标记保留，右键气泡可溯源，重载前后行为一致）；绑定行右侧的“会话 …⧉”芯片点击即复制 `claude --resume <会话ID>` 命令，用于在 cmd/终端里续接当前侧边栏会话。
- **多会话**：一个文件夹可有多个会话。详情区有「切换文件夹…」「切换会话…」两个下拉（会话按最近活跃排序，▶ 标记当前）以及「＋新会话」「🗑删会话」按钮；删除会话会弹确认并同时删除本地转录文件，不可恢复。
- **打开文件夹与续聊脚本**：别名详情区的「📂 打开文件夹」一键用系统文件管理器打开当前别名所在文件夹；桥接同时在文件夹里成对落两个续聊脚本——`继续聊天-<别名>.bat`（Windows：PowerShell/cmd 里直接运行或双击）和 `继续聊天-<别名>.sh`（Git Bash/macOS/Linux 终端里 `bash 继续聊天-<别名>.sh`），内容跟随当前会话 ID 自动刷新，改名/换绑/删别名全路径同步清理。想回到终端模式接着聊：在该文件夹的终端里运行对应脚本即可（等价 `claude --resume <会话ID>`）。
- **附带网页**（默认开）：首次提问或 URL 变化时自动带页面全文（文章页走 Defuddle 正文提取并保留低评分内容块；提取结果过少或非文章页时自动改用页面全文纯文本；截断 30000 字符）；同页后续提问只带选中文字，靠会话上下文衔接；每次发送会在消息区显示附带结果（成功字符数或失败原因），不再静默失败。
- **页面丰富度**（按别名各自配置）：别名详情区顶部可选——精简（约 5 千字，省 token 适合快问）/ 标准（约 3 万字，默认）/ 丰富（约 10 万字，长文求全）；只影响附带网页时注入正文的截断量，新建别名时也可一并选择；配置随别名存桥接 aliases.json，附带状态行会显示实际注入字符数（截断时标注原文字数）。
- **本次强制看页面**：底部发送行左侧「📄 强制看页面」开关（模型·effort 指示右边）：点亮后变亮蓝底并带 ✓（再点一次熄灭即取消，纯本地开关不发消息），下一条消息无视附带开关与同页去重、强制附带页面全文；用后自动熄灭失效，发送时消息区会显示「📄 已强制附带页面…」状态行作为生效凭证；本轮回答期间若发生过 compact（上下文被压缩、页面内容丢失），按钮自动续亮一轮，确保下一条仍带页面。
- **上传文件**：把文件拖进输入区，或点发送键左侧的 📁 按钮选择（可多选；单文件 ≤30MB、一次 ≤10 个、合计 ≤45MB），待传文件在输入框上方以芯片行展示，可单个移除。发送后桥接把文件保存到绑定文件夹根目录的 `copilotUploads/`（重名自动加 -1 后缀，不覆盖旧文件），并随消息注入 `[上传文件]` 说明块告知保存位置，Claude 用 Read 工具查看。
- **附带标记与溯源**：气泡右上角 📄 表示该条附带了页面全文，📎 表示只附带了选中文字，📁 表示该条上传了文件；右键气泡可查看实际发给 Claude 的完整内容（含页面上下文），支持一键复制；也可以直接点击附带状态行（带 🔍），弹出浮层临时查看同一份内容，关闭即消失。
- **Markdown 渲染**：回复按 GFM 渲染（表格、任务列表、删除线），代码块语法高亮（highlight.js）且右上角带复制按钮，数学公式（$...$ 与 $$...$$）用 KaTeX 渲染；链接只有 http/https 网址可点击（新标签打开），本地文件名等相对地址（如 `[标准知识.md](标准知识.md)`）渲染为纯文本，不会误跳到扩展内部地址；附带状态行里的原始发送文本不渲染（保持原文核对）。
- **模型与 effort**：输入框上方执行选项固定单行，只保留附带网页、fast off/on、权限模式和模型下拉，不再常驻 effort 下拉或 CC 状态。模型与 effort 变更即时生效（桥接带 resume 重建会话，上下文不断）；若变更时仍在生成，会先停止旧轮次并关闭旧 CLI，避免旧任务在后台继续写文件。
  - **下方选择入口**：发送按钮左侧常显当前生效的模型·effort；点击该文本向上展开 effort 选项（自动 / low / medium / high / xhigh / max），选择后关闭，点击外部或按 Escape 也会关闭且不触发停止。CC fast 真值紧跟在模型·effort 右侧。模型取 SDK init 上报值；SDK 流不下发 effort，桥接从 CLI 落盘的会话转录里读取最近一次请求实际携带的 effort，每回答粒度；两者缓存跨重载。effort 弹层的「自动」档同样直接显示当前实际生效值（如 `自动 · high`），界面任何位置都不出现"默认"伪状态。
- **原生 fast off/on**：输入区执行选项行可直接切换 Claude Code 原生 fast，默认 off；请求值同时保存在扩展设置和桥接 `workspace.json` 的 `execution` 中，桥接重启后恢复其已接受的最新设置。启动使用 `settings.fastMode`，单独切换使用当前 Query 的 `applyFlagSettings`，不是 CopilotCC 自做加速。生成中切换不会打断当前轮次，当前请求保持原速度，后续请求何时使用 fast 由 CC 决定。
  - **模型提升与恢复（对齐本机 CLI 2.1.301）**：只有真正的 off→on 才保存恢复基线并请求 Opus；off 请求恢复进入 fast 前的模型。重复 on 是幂等操作，fast 期间手动改模型不会被重复 on 打回 Opus；即使选择同值模型也会更新恢复基线。自动 hello/seeding 只恢复既有请求，不视为一次新提升。实际模型仍只采用 CC init/result 回报，不把控制请求成功当成实际状态。
  - **自动档与重启**：自动档提升前保存 CC `applied.model` 的完整实际模型 ID；off 恢复这个具体 ID，避免后续重建或重启又回到不固定的自动解析。恢复基线仅由桥接保存在 `execution.fastRestore`，不进入 WS 协议或扩展存储。fast 期间手动切回自动档时，off 保持自动且不伪造模型；尚无 Query 的自动 on→off 也直接恢复自动。旧版 fast-on 无基线记录升级时补建基线并将请求模型迁到 Opus，合法的新状态不会重复迁移。
  - **旧 CLI 降级**：`applied.model` 来自当前 CLI 运行时的 `getSettings()`，并非 SDK 公开 Query 类型契约；元数据不可用时优先使用提升前 init 的实际模型。仍无证据时继续允许 on，但已提升 Query 的 off 只关闭 fast、保留当前模型并显示非致命警告，不猜恢复模型。这里的恢复行为以用户本机 2.1.301 实测为准，其他 CLI 版本可能不同。
  - **请求与真值**：开关只表示请求值，下方模型·effort 状态右侧的 `(CC fast on)`、`(CC fast off)`、`(冷却中（cooldown）)` 或 `(等待 CC 回报)` 才是 CC 回报的实际状态；冷却期由 CC 原生处理，CopilotCC 不计时、不限速。等待确认期间，只有 CC 新帧明确回报的 fast 状态才结束等待；缓存回放和缺字段的旧 result 不会提前清除等待或回填旧状态。禁用原因可悬浮查看；CC 未附原因时也只如实显示 off，不编造原因。继续使用你的本机 CLI 与中转，不引入官方登录；中转和上游必须实际支持 fast，否则界面如实显示 off 或禁用原因。
- **跟随滚动**：发送后消息区钉在底部，回答流式输出时持续跟随；上滚看历史即退出跟随，流式第一个字到达时右下角立即出现"⬇ 回到底部"按钮，点击平滑回底并恢复跟随。
- **右键菜单**：网页中选中文字 → 右键"用 Claude Code 询问选中内容" → 侧栏自动打开并带入引用。
- **权限模式**四档（输入框上方切换）：
  - `auto`（默认）：模型分类器自动审批，不逐条打扰；
  - `acceptEdits`：自动接受文件编辑，其余仍问；
  - `plan`：只规划不执行；
  - `逐条审批`：每次工具调用在侧栏弹卡片，手动允许/拒绝（30 秒无操作默认拒绝）。
- **工具活动**：工具调用显示为透明、无圆角的紧凑单行，与回答正文气泡区分；按工具显示跨平台 emoji（搜索 🔍、网页 🌐、读取 📄、编辑 ✏️、写入 📝、命令 💻 等，MCP 按语义回退，未知工具 🔧）。保留工具名和摘要，长摘要省略，悬停查看完整内容；附带状态行的原点击行为不变。 重载或恢复会话时，工具调用与回答正文按原顺序回放；`/model` 等具有完整本地命令父链的记录合并为命令、参数和输出活动，原始 XML 不再作为用户正文。工具行在纵向 flex 消息列表中禁止收缩，长会话溢出时也不会被压成零高度。
- **停止**：发送后（含思考与工具调用期，不等首字）发送键即变为红色「■ 停止」，点击或在输入框按 Esc 立即中止本轮（等价 CLI 的 Esc）；已生成的部分文字保留并追加 ⏹ 标记，挂起的审批卡片一并取消。
- **独立窗口（弹窗）模式**：侧栏顶部「🗖 弹出」把聊天开成独立窗口（适合双屏：一块全屏看网页，另一块放聊天窗）。弹窗与侧边栏是**完全镜像的两个视图**：同一份界面，消息、流式输出、输入框草稿两边实时同步（弹窗里打一半，侧边栏接着打）。弹窗钉住弹出时的那个网页（页面提取对它生效，多 Chrome 窗口也不乱），顶栏「🎯 指向当前页」一键改钉新页面，「⇱ 回侧边栏」在钉住页窗口打开侧边栏并关掉弹窗（会话完全恢复）。弹出后再点一次扩展图标可隐藏侧边栏，不影响弹窗与页面的关联；弹窗手动关闭后重新打开侧边栏，会话原样恢复（在途生成、草稿、挂起审批都在）。吐字中途打开弹窗/侧边栏，新视图自动补齐在途气泡与已流出的半截回答，同样可随时按「■ 停止」。
- **页面关联徽标**：弹窗钉住某个页面后，该页面右下角出现一个徽标（📌 + 别名，颜色按别名取色），一眼确认"弹窗 ↔ 页面+别名"的映射；点徽标把对应弹窗唤到前台。页面刷新/导航后徽标自动重注入，弹窗关闭或换绑时自动摘除。

## 架构

```
Chrome 侧边栏(React) ┐
                     ├─(镜像视图)⇄ ws://127.0.0.1:19280 ⇄ ccc-bridge(Node) ⇄ Agent SDK ⇄ claude CLI ⇄ 你的中转 API
独立弹窗(同一 React) ┘              (token 认证/Origin 白名单)      (stream-json 常驻会话)
        │                                  └─ 唯一工作区：文件夹/会话/busy/流式/草稿/审批，状态广播给全部视图
        └─ chrome.scripting 按需提取页面（弹窗钉住原 tab）→ Defuddle 转 Markdown → 随消息附带
```

- 侧边栏/弹窗页面直连 WebSocket（规避 MV3 service worker 30 秒回收；SW 只做弹窗窗口与页面徽标的短命协调，被回收后扫描弹窗 URL 自愈）。
- **镜像架构**：桥接进程内只有一份工作区状态，侧边栏与弹窗都是它的视图——消息回显（chat.user）、流式增量（chat.delta）、草稿（chat.draft）、审批裁决（permission.resolved）全由桥接广播，视图不做本地乐观上屏，双端天然一致；新视图或断线重连发 client.ready 换一份按序快照（folder.bound → history → lists → settings.state → chat.sync），中途接入也能补齐在途流式与草稿。关掉任何一个视图都不杀会话；停止、切换/重建会话或桥接退出才会终结在途轮次；工作区绑定（文件夹+别名）与权威执行设置（权限/模型/effort/fast 请求值）持久化在 `~/.ccc-bridge/workspace.json`，桥接重启/升级后首个视图接入即自动恢复（连别名带会话续聊），扩展侧 lastFolder 回绑只是兜底。认证后的自动完整设置只给尚未初始化的桥接播种；已有执行设置时以桥接为准，旧视图的自动回放缓存不会撤销用户刚修改或失败回滚后的值。手动设置另带 fields 变更掩码，快照里未改的旧字段不会覆盖桥接；未初始化桥先收到 fastOnly 也会完整播种。旧版无 hello 的启动序列按首个 ready 前的帧序兼容，离线显式设置先应用，最后的自动完整帧只作 hello。主动绑定、新建、切换或删除会话才重置对话视图，恢复快照与自动回绑不会误清聊天和运行时真值。
- 不装常驻 content script；发消息时才按需注入脚本提取 `outerHTML` + 选中文字，正文解析（Defuddle→Markdown）在视图页面内完成；弹窗模式钉住原 tab 提取（弹窗聚焦时"活动 tab"是弹窗自己）。
- 桥接维护 `文件夹 → sessionId` 映射（`~/.ccc-bridge/sessions.json`），重新绑定即 resume 会话；历史消息从 `~/.claude/projects/<slug>/<sessionId>.jsonl` 转录回放。

## 安全设计

- WS 只绑 `127.0.0.1`，并校验 Host 头防 DNS rebinding。
- token 配对：首连常量时间比较，失败即断开。
- Origin 白名单：首次生成 config.json 即预置本扩展固定 Origin，只接受本扩展连接；空数组 = 开发模式放行并警告。
- 页面读取权限：扩展声明了 http/https 全站权限，仅用于发消息时按需注入脚本读取当前页正文（无常驻 content script，不后台收集任何数据）。
- 防 prompt injection：新会话首条消息自动注入前缀，声明网页内容与上传文件名是数据不是指令。
- 配置文件在 `~/.ccc-bridge/`（token 随机生成 64 位 hex）。
- 页面 HTML 解析前先剥离 on* 内联事件处理器：DOMParser 文档会继承扩展页 CSP，否则真实页面 HTML 里的内联事件属性会让 chrome://extensions 挂满 CSP 误报（解析所得文档 scripting 禁用，本就无执行风险）。

## FAQ

- **中转 API 能用吗？** 能。桥接继承 spawn 时的环境变量，你本机 `claude` 能用，桥接就能用（`permissionMode: "auto"` 已在中转环境下实测通过）。macOS 的 .app 不读 `~/.zshrc`：v2026.10.23.9 起桥接会借登录 shell 自动补齐缺失的 `ANTHROPIC_*`/`CLAUDE_*`/代理变量（只补缺的、不覆盖已有的），写在 zshrc 里的中转配置照常生效。
- **桥接怎么找 claude CLI？** 按 `CLAUDE_CODE_PATH` 环境变量 → PATH 查找 →（仅 mac/linux）常见安装位置（`~/.claude/local/claude`、Homebrew 两前缀等）→ 登录 shell 探测 的顺序解析（win 下自动取 npm 全局包里的原生 claude.exe，.cmd shim 无法直接拉起）。macOS 从 Finder/Dock 启动的 .app 不读 `~/.zshrc`、PATH 只有系统默认——后两级兜底正是为它准备的，终端里能跑 `claude` 的安装都能自动找到；极端情况仍可设 `CLAUDE_CODE_PATH` 显式指定。
- **配对失败/一直连不上？** 先确认桥接在跑（托盘图标在）。白名单出厂已预置本扩展 Origin；若手动改过 `~/.ccc-bridge/config.json` 的 `allowedOrigins`，确认包含 `chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno` 并重启过桥接。
- **auto 模式异常怎么办？** 切换为 `acceptEdits`（设计上就是 auto 的降级预案）。
- **改端口？** 托盘右键「修改端口…」用浏览器打开本机设置页（与 WS 同一端口，不额外占端口），输入新端口保存即在线生效（写回 config.json，进行中的会话连接会断开），页面直接给出新配对串，到侧栏「⚙ 配对」粘贴一次即可。也可手改 `~/.ccc-bridge/config.json` 的 `port` 后重启桥接。端口被占用时桥接自动顺延（最多 10 个），配对串携带的总是实际端口。
- **macOS 报"已损坏，无法打开"？** 免费分发没有 Apple 开发者证书（$99/年的 Developer ID + 公证才有「放行即可」的体验），浏览器下载的隔离标记下 macOS 对 ad-hoc 签名一律报损坏、且对 App 右键打开也绕不过——对 dmg 里的「首次使用-右键打开我.command」右键 → 打开一次即可（解除隔离后，以后双击即用）。
- **macOS 看不到桥接图标？** 图标在屏幕最上方菜单栏的右侧——菜单栏驻留程序按设计不占底部 Dock；刘海屏菜单栏太挤时系统会藏起新图标，关掉几个菜单栏应用再看。仍没有：终端跑 `cat ~/.ccc-bridge/tray-error.log` 把内容发给开发者。
- **chrome:// 等特权页无法提取？** 属浏览器限制，会在消息列表显示失败原因，不再静默降级。同理，若把侧栏自身（chrome-extension://…/sidepanel.html）开成普通标签页，该页按设计不附带——否则聊天界面本身会进入上下文，模型可能把扩展内部地址当来源写进产物。
- **弹窗模式没有页面徽标？** chrome:// 等特权页无法注入脚本，徽标缺席但聊天与钉住不受影响；普通页面刷新后徽标会自动回来。
- **弹窗里能选别名/换文件夹/切会话吗？** 能，和侧边栏完全一样——两边是同一工作区的镜像视图，任一边的操作两边同时生效。
- **另一个 CMD 正在用 Fable，会把侧边栏也带成 Fable 吗？** 不会。每个 CLI 进程独立运行；「自动」档才跟随本机 CLI 配置，显式选择 Sonnet 等模型时由桥接传参。扩展会在每次认证及断线重连后先发送带自动播种标记的完整模型/权限/effort/fast 设置，再恢复工作区；未初始化的桥接据此播种，已有权威执行设置的桥接则忽略这份可能过期的副本，避免旧视图撤销新设置或失败回滚。
- **升级桥接后聊天区空了？** 聊天记录从未丢：转录在 `~/.claude/projects/`、映射在 `~/.ccc-bridge/`。新版会在首个视图接入时自动恢复上次的工作区（文件夹+别名+会话续聊）；旧版遗留的"没定下会话"别名，选中时会自动回退续上该文件夹的现有会话（不再误开空会话），实在不行还可在详情区「切换会话…」手动选回任意历史会话。
- **升级桥接后别名下拉空了？** 数据没丢（`~/.ccc-bridge/aliases.json` 还在）。v2026.10.23.5 之前的镜像版有门控 bug：桥接重启后尚未绑定文件夹时别名列表不下发，扩展又在纯等推送，于是下拉永空。升到 .5+ 快照恢复时别名列表无条件下发，自动恢复；旧版临时解法：手动绑定一次文件夹（或新建/选中任一个别名）即可触发列表推送。
- **续聊脚本怎么运行？** Windows 在 PowerShell/cmd 里直接运行（或双击）`继续聊天-<别名>.bat`；Git Bash/macOS/Linux 终端里 `bash 继续聊天-<别名>.sh`。本质就是 `claude --resume <会话ID>`，手敲这一行也行。
- **想换托盘/ exe 图标？** 图标由 `bridge/scripts/gen-icon.mjs` 生成（Claude 橙桥形，a 拱桥 / b 拱桥+桥墩 / c 悬索桥三变体，当前用 c），`node bridge/scripts/gen-icon.mjs a|b` 后重新 `npm run build:exe` 生效；脚本输出浅/深底预览条到 `%TEMP%/ccc-icon-preview.png` 供挑选；扩展图标由 `scripts/gen-ext-icon.mjs` 复用同一形状库生成（extension/public/icon/，改后重新 `npm run build` 生效）。

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

cd bridge && npm test                  # 桥接 196 个单测
cd bridge && npm run typecheck         # 桥接严格类型检查
cd bridge && npm run selftest          # 离线：握手 + 绑定流程，不调 API
cd bridge && npm run selftest:live     # 端到端：向真实 claude 发一条消息（走本机中转配置）

cd extension && npm test               # 扩展 89 个单测
cd extension && npm run typecheck      # 严格类型检查（需先 npx wxt prepare 或构建过一次）

# 预编译件架构审计（CI 门禁同款）：读文件头断言 CPU 架构，防"第三方二进制架构发错进包"
node bridge/scripts/check-arch.mjs bridge/node_modules/systray2/traybin/tray_windows_release.exe x64
```

生产入口装配回归同时覆盖普通 CLI 与托盘 exe，确保两者都注入同一份 `workspace.json` 持久化；Windows 产物另经项目树外隔离探针验证执行设置与文件夹绑定真实落盘。

`bridge/probe-sdk.mjs` / `probe2-sdk.mjs` / `bridge/scripts/probe-frames.mjs` 是 Agent SDK 直连探针（排障用，不经桥接直接验证 CLI 时序、权限模式与流式帧字段——"SDK 流不下发 effort" 就是用 probe-frames 实锤的）。

### 目录结构

```
shared/protocol.ts      # WS 协议单一来源
scripts/                # sync-protocol / gen-extension-key
bridge/                 # 本地桥接（Node + ws + Agent SDK）
  src/{config,session-manager,transcript,claude-session,server,resume-script,folder-picker,index}.ts
  scripts/              # build-exe / build-mac-app / build-tray-mac / check-arch / gen-icon / gen-iconset / mac-setup.command / 探针
  tray/main.swift       # 自研 macOS 菜单栏托盘助手（systray2 协议，arm64 原生，CI 现场 swiftc 编译）
extension/              # Chrome MV3 扩展（WXT + React）
  src/lib/{protocol,storage,attach-policy,ws-client,page-extract,popup-mode,popup-registry}.ts
  src/components/       # TokenGate / FolderBar / AliasBar / MessageList / InputBox / PermissionCard
  src/entrypoints/{background.ts, sidepanel/}
.github/workflows/      # ci.yml（三平台测试）/ release.yml（tag 触发构建发布）
```

### CI / 发版

- **CI**：push / PR 触发（`.github/workflows/ci.yml`），在 ubuntu / windows / macOS 三平台跑两端类型检查 + 单测 + 扩展构建。
- **发版**：打 tag 即自动构建并发布 Release（`.github/workflows/release.yml`）：

  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```

  流程：测试门禁 → Windows runner 编 `ccc-bridge-win-x64.zip`（bun 单文件 exe，内嵌桥形图标与托盘组件，打包前 `--smoke` 运行自检）、macOS runner 编 `ccc-bridge-darwin-arm64.dmg`（本机原生编译 → 组装标准 .app（悬索桥 icns、菜单栏驻留）→ swiftc 现场编译 arm64 托盘助手并跑协议冒烟 → 主程序 `--smoke` 运行自检 → ad-hoc 预签并校验 → dmg 附 Applications 快捷方式与一键解除隔离脚本，hdiutil 打包）、ubuntu runner 出扩展 zip（`wxt zip`，manifest 版本号自动取 tag）→ 汇总创建带自动更新说明的 GitHub Release。CI 门禁另对第三方预编译托盘组件做字节级架构审计（`check-arch.mjs`）——"构建成功 ≠ 能跑"，教训见 TODO。

## 许可证

[MIT](LICENSE)
