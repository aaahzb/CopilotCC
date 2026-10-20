# Claude Code 侧边栏助手

把**网页信息**和 **Claude Code 的系统操作能力**结合起来的浏览器 copilot：点击 Chrome 工具栏图标在右侧打开聊天框，绑定一个本地文件夹作为 Claude Code 工作目录后，就能一边浏览网页一边向 Claude 提问（页面内容自动进入上下文，无需复制粘贴），并让 Claude 直接把笔记、代码写进绑定的文件夹。同一文件夹再次绑定即恢复上次会话（等价 `claude -c` 的效果）。

**不依赖 Anthropic 官方账号**：桥接直接 spawn 本机的 `claude` CLI，继承你本机已有的环境变量（如国内中转的 `ANTHROPIC_BASE_URL` / token 配置）。

## 架构

```
Chrome 侧栏(React)  ⇄  ws://127.0.0.1:19280  ⇄  ccc-bridge(Node)  ⇄  Agent SDK  ⇄  claude CLI  ⇄  你的中转 API
        │                        (token 认证/Origin 白名单)         (stream-json 常驻会话)
        └─ chrome.scripting 按需提取页面 → Defuddle 转 Markdown → 随消息附带
```

- 侧栏页面直连 WebSocket（规避 MV3 service worker 30 秒回收）。
- 不装常驻 content script；发消息时才按需注入脚本提取 `outerHTML` + 选中文字，正文解析（Defuddle→Markdown）在侧栏页面内完成。
- 桥接维护 `文件夹 → sessionId` 映射（`~/.ccc-bridge/sessions.json`），重新绑定即 resume 会话；历史消息从 `~/.claude/projects/<slug>/<sessionId>.jsonl` 转录回放。

## 安装与启动

### 1. 桥接（bridge）

```bash
cd bridge
npm i
npm start
```

启动后控制台打印三样：`ws://127.0.0.1:19280/ws`、**配对 token**、配置目录（默认 `~/.ccc-bridge/`）。

把扩展 Origin 写入 `~/.ccc-bridge/config.json` 的 `allowedOrigins` 后重启 bridge：

```json
{ "allowedOrigins": ["chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno"] }
```

（扩展 ID 由 `wxt.config.ts` 里固定的 manifest key 决定，重新生成 key 需同步改这里。）

### 2. 扩展（extension）

```bash
cd extension
npm i
npm run build
```

`chrome://extensions` → 开开发者模式 → 加载已解压扩展 → 选 `extension/.output/chrome-mv3`。

### 3. 配对

点击工具栏图标打开侧栏 → 粘贴 bridge 打印的 token → 状态灯变绿即连接成功。token 只需配一次（存 `chrome.storage.local`）。

## 使用

- **绑定文件夹**：顶部输入绝对路径回车。绑过会的文件夹显示"已续聊"徽标并回放历史。
- **附带网页**（默认开）：首次提问或 URL 变化时自动带页面全文（文章页走 Defuddle 正文提取，非文章页回退为页面纯文本；截断 30000 字符）；同页后续提问只带选中文字，靠会话上下文衔接；每次发送会在消息区显示附带结果（成功字符数或失败原因），不再静默失败。
- **附带标记与溯源**：气泡右上角 📄 表示该条附带了页面全文，📎 表示只附带了选中文字；右键气泡可查看实际发给 Claude 的完整内容（含页面上下文），支持一键复制；也可以直接点击附带状态行（带 🔍），弹出浮层临时查看同一份内容，关闭即消失。
- **右键菜单**：网页中选中文字 → 右键"用 Claude Code 询问选中内容" → 侧栏自动打开并带入引用。
- **权限模式**四档（输入框上方切换）：
  - `auto`（默认）：模型分类器自动审批，不逐条打扰；
  - `acceptEdits`：自动接受文件编辑，其余仍问；
  - `plan`：只规划不执行；
  - `逐条审批`：每次工具调用在侧栏弹卡片，手动允许/拒绝（30 秒无操作默认拒绝）。
- **停止**：生成中点"停止"发送 abort。

## 自检

```bash
cd bridge
npm run selftest        # 离线：握手 + 绑定流程，不调 API
npm run selftest:live   # 端到端：向真实 claude 发一条消息（走本机中转配置）
```

## 安全设计

- WS 只绑 `127.0.0.1`，并校验 Host 头防 DNS rebinding。
- token 配对：首连常量时间比较，失败即断开。
- Origin 白名单：配置后只接受本扩展的连接。
- 页面读取权限：扩展声明了 http/https 全站权限，仅用于发消息时按需注入脚本读取当前页正文（无常驻 content script，不后台收集任何数据）。
- 防 prompt injection：新会话首条消息自动注入前缀，声明网页内容是数据不是指令。
- 配置文件在 `~/.ccc-bridge/`（token 随机生成 64 位 hex）。

## FAQ

- **中转 API 能用吗？** 能。桥接继承 spawn 时的环境变量，你本机 `claude` 能用，桥接就能用（`permissionMode: "auto"` 已在中转环境下实测通过）。
- **auto 模式异常怎么办？** 切换为 `acceptEdits`（设计上就是 auto 的降级预案）。
- **改端口？** 编辑 `~/.ccc-bridge/config.json` 的 `port`，侧栏配对界面填同一端口。
- **chrome:// 等特权页无法提取？** 属浏览器限制，会在消息列表显示失败原因，不再静默降级。

## 开发

```bash
# 协议单一来源是 shared/protocol.ts，两端复制件由脚本同步（改协议只改它）
node scripts/sync-protocol.mjs

cd bridge && npm test       # 桥接 26 个单测
cd extension && npm test    # 扩展 12 个单测
cd extension && npx tsc --noEmit   # 严格类型检查
```

`bridge/probe-sdk.mjs` / `probe2-sdk.mjs` 是 Agent SDK 直连探针（排障用，不经桥接直接验证 CLI 时序与权限模式）。

## 目录结构

```
shared/protocol.ts      # WS 协议单一来源
scripts/                # sync-protocol / gen-extension-key
bridge/                 # 本地桥接（Node + ws + Agent SDK）
  src/{config,session-manager,transcript,claude-session,server,index}.ts
extension/              # Chrome MV3 扩展（WXT + React）
  src/lib/{protocol,storage,attach-policy,ws-client,page-extract}.ts
  src/components/       # TokenGate / FolderBar / MessageList / InputBox / PermissionCard
  src/entrypoints/{background.ts, sidepanel/}
```
