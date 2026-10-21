# Claude Code 侧边栏助手

> 把**网页信息**和 **Claude Code 的系统操作能力**结合起来的浏览器 copilot：侧边栏里边浏览网页边向 Claude 提问（页面内容自动进入上下文，无需复制粘贴），并让 Claude 直接把笔记、代码写进你绑定的本地文件夹。

![平台](https://img.shields.io/badge/平台-Windows%20x64%20%7C%20macOS%20arm64-blue)
![运行时](https://img.shields.io/badge/运行时-本机%20Claude%20CLI-orange)
![扩展](https://img.shields.io/badge/Chrome%20MV3-React%2019%20%2B%20WXT-green)

**不依赖 Anthropic 官方账号**：桥接直接 spawn 本机的 `claude` CLI，继承本机已有的环境变量（如国内中转的 `ANTHROPIC_BASE_URL` / token 配置）。

## 快速开始（下载 Release 使用）

到 [Releases](../../releases) 页下载最新版的两个包：

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `ccc-extension-x.y.z-chrome.zip` | Chrome / Edge | 浏览器扩展 |
| `ccc-bridge-win-x64.zip` | Windows 64 位 | 本地桥接（系统托盘程序） |
| `ccc-bridge-darwin-arm64.zip` | macOS（Apple Silicon） | 本地桥接（菜单栏程序） |

> macOS Intel / Linux 暂无预编译产物，请走「开发者 → 从源码运行」。

### 1. 安装扩展

1. 解压 `ccc-extension-*-chrome.zip` 到一个**固定位置**的文件夹（加载后不要移动或删除它）。
2. 打开 `chrome://extensions`，右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择解压出来的文件夹。

### 2. 运行桥接

- **Windows**：解压 `ccc-bridge-win-x64.zip`，双击 `ccc-bridge.exe`，图标出现在系统托盘。
- **macOS**：解压 `ccc-bridge-darwin-arm64.zip`，对 `setup.command` **右键 → 打开**（仅首次需要，自动完成赋权与签名），之后双击 `ccc-bridge` 常驻菜单栏。

### 3. 配对

托盘/菜单栏图标右键 →「复制配对串」→ 点 Chrome 工具栏的扩展图标打开侧栏 → 粘贴配对串 → 状态灯变绿即完成。然后点侧栏顶部的「＋新建」（或「▸ 详情」展开）输入绝对路径或点「选择文件夹…」完成绑定，就能开始边浏览边提问了。

## 功能与使用

- **别名**：一个「文件夹 + 会话」组合可保存为命名别名。侧栏顶部平时只有一个别名下拉，选中即切到它的文件夹+会话；点「＋新建」才展开绑定表单（名称 + 文件夹 + 会话），文件夹可点「浏览…」弹系统文件夹选择框（Windows 资源管理器对话框 / macOS Finder 对话框，也可手输路径）；平时文件夹与会话栏隐藏，点「详情」随时展开查看修改；「🗑删别名」只删别名本身，文件夹绑定与会话历史全部保留。别名存在桥接端 `~/.ccc-bridge/aliases.json`，重装扩展不丢；选中别名后再换文件夹或会话会自动写回该别名，永不脱钩。
- **绑定文件夹**：在别名详情区（或新建别名表单）输入绝对路径回车，或点「浏览…」弹系统选择框。绑过会的文件夹显示“已续聊”徽标并回放历史（回放气泡只显示用户实际问题，页面上下文包装不进气泡；完整发送内容与 📄/📎 附带标记保留，右键气泡可溯源，重载前后行为一致）；绑定行右侧的“会话 …⧉”芯片点击即复制 `claude --resume <会话ID>` 命令，用于在 cmd/终端里续接当前侧边栏会话。
- **多会话**：一个文件夹可有多个会话。详情区有「切换文件夹…」「切换会话…」两个下拉（会话按最近活跃排序，▶ 标记当前）以及「＋新会话」「🗑删会话」按钮；删除会话会弹确认并同时删除本地转录文件，不可恢复。
- **附带网页**（默认开）：首次提问或 URL 变化时自动带页面全文（文章页走 Defuddle 正文提取并保留低评分内容块；提取结果过少或非文章页时自动改用页面全文纯文本；截断 30000 字符）；同页后续提问只带选中文字，靠会话上下文衔接；每次发送会在消息区显示附带结果（成功字符数或失败原因），不再静默失败。
- **本次强制看页面**：输入框右上角悬浮「📄 强制看页面」按钮（不占布局）：点亮后下一条消息无视附带开关与同页去重、强制附带页面全文，用后自动失效；本轮回答期间若发生过 compact（上下文被压缩、页面内容丢失），按钮自动续亮一轮，确保下一条仍带页面。
- **附带标记与溯源**：气泡右上角 📄 表示该条附带了页面全文，📎 表示只附带了选中文字；右键气泡可查看实际发给 Claude 的完整内容（含页面上下文），支持一键复制；也可以直接点击附带状态行（带 🔍），弹出浮层临时查看同一份内容，关闭即消失。
- **Markdown 渲染**：回复按 GFM 渲染（表格、任务列表、删除线），代码块语法高亮（highlight.js）且右上角带复制按钮，数学公式（$...$ 与 $$...$$）用 KaTeX 渲染；附带状态行里的原始发送文本不渲染（保持原文核对）。
- **模型与 effort**：并入输入区执行选项同一行（附带网页 / 权限模式 / 模型 / effort），变更即时生效（桥接带 resume 重建会话，上下文不断）。发送按钮左侧常显当前生效的模型·effort（模型取 SDK init 上报值；SDK 流不下发 effort，桥接从 CLI 落盘的会话转录里读取最近一次请求实际携带的 effort，每回答粒度；两者缓存跨重载）。下拉的「自动」档同样直接显示当前实际生效值（如 `自动 · fable 5.1`），界面任何位置都不出现"默认"伪状态。
- **跟随滚动**：发送后消息区钉在底部，回答流式输出时持续跟随；上滚看历史即退出跟随，流式第一个字到达时右下角立即出现"⬇ 回到底部"按钮，点击平滑回底并恢复跟随。
- **右键菜单**：网页中选中文字 → 右键"用 Claude Code 询问选中内容" → 侧栏自动打开并带入引用。
- **权限模式**四档（输入框上方切换）：
  - `auto`（默认）：模型分类器自动审批，不逐条打扰；
  - `acceptEdits`：自动接受文件编辑，其余仍问；
  - `plan`：只规划不执行；
  - `逐条审批`：每次工具调用在侧栏弹卡片，手动允许/拒绝（30 秒无操作默认拒绝）。
- **停止**：生成中点"停止"发送 abort。

## 架构

```
Chrome 侧栏(React)  ⇄  ws://127.0.0.1:19280  ⇄  ccc-bridge(Node)  ⇄  Agent SDK  ⇄  claude CLI  ⇄  你的中转 API
        │                        (token 认证/Origin 白名单)         (stream-json 常驻会话)
        └─ chrome.scripting 按需提取页面 → Defuddle 转 Markdown → 随消息附带
```

- 侧栏页面直连 WebSocket（规避 MV3 service worker 30 秒回收）。
- 不装常驻 content script；发消息时才按需注入脚本提取 `outerHTML` + 选中文字，正文解析（Defuddle→Markdown）在侧栏页面内完成。
- 桥接维护 `文件夹 → sessionId` 映射（`~/.ccc-bridge/sessions.json`），重新绑定即 resume 会话；历史消息从 `~/.claude/projects/<slug>/<sessionId>.jsonl` 转录回放。

## 安全设计

- WS 只绑 `127.0.0.1`，并校验 Host 头防 DNS rebinding。
- token 配对：首连常量时间比较，失败即断开。
- Origin 白名单：首次生成 config.json 即预置本扩展固定 Origin，只接受本扩展连接；空数组 = 开发模式放行并警告。
- 页面读取权限：扩展声明了 http/https 全站权限，仅用于发消息时按需注入脚本读取当前页正文（无常驻 content script，不后台收集任何数据）。
- 防 prompt injection：新会话首条消息自动注入前缀，声明网页内容是数据不是指令。
- 配置文件在 `~/.ccc-bridge/`（token 随机生成 64 位 hex）。
- 页面 HTML 解析前先剥离 on* 内联事件处理器：DOMParser 文档会继承扩展页 CSP，否则真实页面 HTML 里的内联事件属性会让 chrome://extensions 挂满 CSP 误报（解析所得文档 scripting 禁用，本就无执行风险）。

## FAQ

- **中转 API 能用吗？** 能。桥接继承 spawn 时的环境变量，你本机 `claude` 能用，桥接就能用（`permissionMode: "auto"` 已在中转环境下实测通过）。
- **配对失败/一直连不上？** 先确认桥接在跑（托盘图标在）。白名单出厂已预置本扩展 Origin；若手动改过 `~/.ccc-bridge/config.json` 的 `allowedOrigins`，确认包含 `chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno` 并重启过桥接。
- **auto 模式异常怎么办？** 切换为 `acceptEdits`（设计上就是 auto 的降级预案）。
- **改端口？** 托盘右键「修改端口…」用浏览器打开本机设置页（与 WS 同一端口，不额外占端口），输入新端口保存即在线生效（写回 config.json，进行中的会话连接会断开），页面直接给出新配对串，到侧栏「⚙ 配对」粘贴一次即可。也可手改 `~/.ccc-bridge/config.json` 的 `port` 后重启桥接。端口被占用时桥接自动顺延（最多 10 个），配对串携带的总是实际端口。
- **chrome:// 等特权页无法提取？** 属浏览器限制，会在消息列表显示失败原因，不再静默降级。
- **想换托盘/ exe 图标？** 图标由 `bridge/scripts/gen-icon.mjs` 生成（Claude 橙桥形，a 拱桥 / b 拱桥+桥墩 / c 悬索桥三变体，当前用 c），`node bridge/scripts/gen-icon.mjs a|b` 后重新 `npm run build:exe` 生效；脚本输出浅/深底预览条到 `%TEMP%/ccc-icon-preview.png` 供挑选。

## 开发者

### 从源码运行

```bash
# 桥接（Node 22+）
cd bridge && npm i && npm start        # 开发态托盘：npm run tray

# 扩展（另一个终端）
cd extension && npm i && npm run build
# chrome://extensions → 开发者模式 → 加载已解压扩展 → 选 extension/.output/chrome-mv3
```

### 测试与自检

```bash
# 协议单一来源是 shared/protocol.ts，两端复制件由脚本同步（改协议只改它）
node scripts/sync-protocol.mjs

cd bridge && npm test                  # 桥接 60 个单测
cd bridge && npm run typecheck         # 桥接严格类型检查
cd bridge && npm run selftest          # 离线：握手 + 绑定流程，不调 API
cd bridge && npm run selftest:live     # 端到端：向真实 claude 发一条消息（走本机中转配置）

cd extension && npm test               # 扩展 24 个单测
cd extension && npm run typecheck      # 严格类型检查（需先 npx wxt prepare 或构建过一次）
```

`bridge/probe-sdk.mjs` / `probe2-sdk.mjs` / `bridge/scripts/probe-frames.mjs` 是 Agent SDK 直连探针（排障用，不经桥接直接验证 CLI 时序、权限模式与流式帧字段——"SDK 流不下发 effort" 就是用 probe-frames 实锤的）。

### 目录结构

```
shared/protocol.ts      # WS 协议单一来源
scripts/                # sync-protocol / gen-extension-key
bridge/                 # 本地桥接（Node + ws + Agent SDK）
  src/{config,session-manager,transcript,claude-session,server,index}.ts
  scripts/              # build-exe / gen-icon / mac-setup.command / 探针
extension/              # Chrome MV3 扩展（WXT + React）
  src/lib/{protocol,storage,attach-policy,ws-client,page-extract}.ts
  src/components/       # TokenGate / FolderBar / MessageList / InputBox / PermissionCard
  src/entrypoints/{background.ts, sidepanel/}
.github/workflows/      # ci.yml（三平台测试）/ release.yml（tag 触发构建发布）
```

### CI / 发版

- **CI**：push / PR 触发（`.github/workflows/ci.yml`），在 ubuntu / windows / macOS 三平台跑两端类型检查 + 单测 + 扩展构建。
- **发版**：打 tag 即自动构建并发布 Release（`.github/workflows/release.yml`）：

  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```

  流程：测试门禁 → Windows runner 编 `ccc-bridge-win-x64.zip`（bun 单文件 exe，内嵌桥形图标）、macOS runner 编 `ccc-bridge-darwin-arm64.zip`（本机原生编译，附 `setup.command` 一键初始化，ditto 打包保留可执行位）、ubuntu runner 出扩展 zip（`wxt zip`，manifest 版本号自动取 tag）→ 汇总创建带自动更新说明的 GitHub Release。
