# CopilotCC 开发文档

[项目首页](../README.md) · [用户指南](guide.md) · [当前待办](../TODO.md) · [历史验证记录](history/README.md)

## 架构

```text
Chrome 侧边栏(React) ┐
                     ├─ 镜像视图 ⇄ ws://127.0.0.1 ⇄ ccc-bridge(Node)
独立弹窗(同一 React) ┘       token / Origin 白名单          │
                                                           Agent SDK
                                                               │
页面按需提取 ──→ Defuddle → Markdown ──→ 随消息附带       claude CLI
```

- 侧边栏和弹窗直连 WebSocket，避免 MV3 service worker 回收影响长会话。Service worker 只协调弹窗和页面徽标。
- 桥接持有唯一工作区状态，包括文件夹、会话、流式输出、草稿、工具活动和审批。两个视图只渲染桥接快照与事件，不做本地乐观上屏。
- 新视图或重连通过 `client.ready` 获取有序快照。关闭视图不会结束会话；停止、切换会话或桥接退出才会终结当前轮次。
- 工作区和权威执行设置保存在 `~/.ccc-bridge/workspace.json`。扩展缓存只用于播种未初始化的桥接，不能覆盖桥接中更新的设置。
- 页面只在发送消息时通过 `chrome.scripting` 按需提取。弹窗钉住原标签页，避免聚焦弹窗后读错页面。
- 会话转录位于 `~/.claude/projects/<slug>/<sessionId>.jsonl`，文件夹与会话映射位于 `~/.ccc-bridge/`。

### 终端续聊

- `TerminalLeaseManager` 独占工作区写入权，状态为 `idle → starting → active/degraded → stopping → idle`。系统终端与插件终端共用 lease、Session Hooks 和转录 watcher。
- 每次 lease 使用独立随机 Hook token。SessionStart 只接受 `startup/resume/clear/compact/fork`；10 秒无有效事件进入 degraded，不按文件修改时间猜会话 ID。
- 接管期间聊天视图只读，转录按单调 revision 同步。真实进程退出后依次完成最终镜像、SDK 会话恢复和 idle。
- 进程恢复核对 PID、可执行路径和启动时间。只有明确不存在才自动清理；状态未知时保持只读，人工解除不会杀进程。
- Windows 系统终端使用 GUI `ccc-bridge.exe` 和 Console `ccc-terminal.exe`。包装进程负责身份、启动准许、取消和退出记录，不能把 GUI 启动器退出当成 Claude 退出。
- macOS 系统终端使用 Terminal.app。`ps` 子进程固定 `LC_ALL=C`，避免中文 Locale 破坏启动时间解析，同时保留严格身份校验。
- 插件终端使用 xterm.js + `node-pty@1.1.0`。ANSI 画面不冒充聊天 JSONL；输出按 `leaseId + seq` 进入有界缓冲，同一页面可在 3 秒宽限内重连。
- `attachToken` 只保存在原终端页面内存。刷新产生新文档和新 lease，旧 PTY 被定向清理；输出序号缺口必须显示错误并结束 owned PTY。
- 普通 lease 关闭不能关闭共享 PTY backend。桥接整体退出才沿 `server.close()` 统一关闭 backend，避免第二次打开出现 `PTY_BACKEND_CLOSED`。
- 原生路线由真实编译产物探针选择 `bun-node-pty` 或 `node-helper`。原生文件缺失只让插件终端返回 `PTY_UNAVAILABLE`，系统终端和普通聊天仍可使用。

### Windows 绿色单文件

完整发行目录包含双 exe、`pty/`、`pty-manifest.json`，以及 node-helper 路线需要的 `runtime/`。绿色发布把同一布局压缩、跨文件去重后内嵌进 `CopilotCC.exe`，公开资产只有单文件。

私有运行目录为 `<CCC_BRIDGE_HOME>/runtime/<payloadSha256>/`。启动器在命名 Mutex 内校验或原子发布当前组件，只清理带 CopilotCC 专有标记的旧版本和暂存目录；活跃、未知、foreign product、junction 和权限异常目录保留。

发行副本中的 `node-pty` 使用规范 `\\?\` 路径和 `process.dlopen()` 回退，规避 Win32 深层 `.node` 路径的 `MAX_PATH` 限制。仓库 `node_modules` 不被改写，补丁文件及哈希进入发行清单。

## 从源码运行

前置条件：Node.js 22+。原生 PTY 构建、假 CLI 编译和发布流程另需 Bun。

```bash
npm --prefix bridge ci
npm --prefix extension ci

# 终端一：桥接；开发态托盘使用 npm --prefix bridge run tray
npm run dev:bridge

# 终端二：扩展开发构建
npm run dev:extension
```

也可以在扩展目录运行 `npm run build`，然后在 `chrome://extensions` 加载 `extension/.output/chrome-mv3`。macOS arm64 开发态托盘先执行一次 `bash bridge/scripts/build-tray-mac.sh`，以构建本机托盘助手。

## 日常验证

在仓库根目录执行：

```bash
npm run check           # 生成副本、本地文档链接、项目脚本测试
npm run typecheck       # 两端严格类型检查；扩展先自动执行 wxt prepare
npm test                # 项目脚本、桥接和扩展测试
npm run build           # 扩展生产构建
npm run verify          # 顺序执行以上全部步骤，任一失败即停止

npm --prefix bridge run selftest        # 离线握手与绑定，不调 API
npm --prefix bridge run selftest:live   # 真实 CLI/API 请求，需单独授权
```

`shared/protocol.ts`、`shared/pairing.ts`、`shared/upload-note.ts` 是单一来源。修改后运行 `npm run sync:protocol`，不要直接编辑 `bridge/src/` 和 `extension/src/lib/` 中的对应副本。`npm run check:generated` 只读检查漂移，不会改写文件。

新增或移动 Markdown 后运行 `npm run check:docs`。检查覆盖当前工作树中未忽略的文档，包含尚未提交的新文件，并忽略代码块和行内代码中的链接示例。

预编译件架构审计：

```bash
node bridge/scripts/check-arch.mjs \
  bridge/node_modules/systray2/traybin/tray_windows_release.exe x64
```

## Windows 高级终端验收

这些脚本会启动真实 Chrome、原生窗口和隔离进程，不属于默认测试。运行前必须明确批准一个**项目树外**目录，并在 Git Bash 中设置其绝对路径：

```bash
# 示例路径仅演示格式；换成你已明确批准的目录，不要直接使用盘符根目录。
export CCC_VERIFY_ROOT="D:/path/to/approved-copilotcc-verification"
APPROVED="$CCC_VERIFY_ROOT"
```

未设置变量时，脚本仍兼容旧本机默认目录；新环境应显式配置。每次 `--root` 都必须是 `$APPROVED` 下全新的空子目录，不能使用批准根目录本身、项目树内目录或已有证据目录。脚本不覆盖或删除旧证据，也不停止或替换用户正在使用的桥接。

### 构建与系统终端

```bash
npm --prefix extension run build
node bridge/scripts/run-pty-probe.mjs --route auto --target win \
  --root "$APPROVED/fresh-pty-probe-win"
node bridge/scripts/build-exe.mjs win \
  --pty-route "$APPROVED/fresh-pty-probe-win/pty-route.json"

mkdir -p "$APPROVED/bin"
bun build bridge/scripts/fake-terminal-claude.ts --compile \
  --target=bun-windows-x64 --outfile "$APPROVED/bin/fake-claude.exe"

# 有效负控：必须非零退出，并指出 Hook 会话跟随证据缺失
node bridge/scripts/verify-system-terminal.mjs \
  --root "$APPROVED/fresh-hook-negative-run" --negative-control hooks

# 正常验收：换一个全新空目录
node bridge/scripts/verify-system-terminal.mjs \
  --root "$APPROVED/fresh-system-normal-run"
```

正常结果必须包含 `commandHooksWithoutFailure=true`、`runtimeErrors=[]` 和 `realApiCalled=false`。准备阶段异常、连接失败或普通超时不能记作有效负控。

### 插件终端与真实 CLI

```bash
# attach 负控：必须在 attachedAfterOpenedOnSameConnection=false 处非零失败
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-embedded-negative-run" --negative-control attach

node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-embedded-normal-run"

# 真实 CLI 单独 resume；只访问脚本启动的本机假上游
node bridge/scripts/verify-real-cli-resume.mjs \
  --root "$APPROVED/fresh-real-cli-resume"

# 真实 CLI 双终端 resume、镜像与退出恢复
node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-real-cli-dual-terminal" --real-cli-resume-only
```

真实 CLI 补验使用独立 `CCC_BRIDGE_HOME`、`CLAUDE_CONFIG_DIR` 和工作目录，不调用真实中转或真实 API。证据只保留固定标记和计数，不保存私有请求正文或请求头。

### 绿色单文件

```bash
node bridge/scripts/run-portable-launcher-tests.mjs
node bridge/scripts/build-portable-exe.mjs

node bridge/scripts/verify-portable-exe.mjs \
  --root "$APPROVED/fresh-portable-lifecycle"

node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-portable-embedded" --portable

node bridge/scripts/verify-embedded-terminal.mjs \
  --root "$APPROVED/fresh-portable-real-cli" --portable --real-cli-resume-only
```

生命周期验收检查源 exe 与隔离副本哈希、单文件布局、清理、占用保护、篡改重建、重复启动和真实进度窗口。GitHub Actions 中，生命周期脚本也接受 `$RUNNER_TEMP` 的严格子目录；具体命令以工作流为准。

发行等价验收不能只加载 `wxt build` 的目录。先运行 `npm --prefix extension run zip`，在干净快照中把最终 zip 解压到新的空 `extension/.output/chrome-mv3`，再运行上述 portable Chrome 和真实 CLI 命令。Windows Git Bash 自带的 GNU tar 不支持 zip，应显式使用 `C:/Windows/System32/tar.exe`；Release 工作流使用同一工具。

历史验收结果和未覆盖边界见[当前待办](../TODO.md)与[历史开发日志](history/2026-11-17-development-log.md)。旧日志中的计数和运行状态不要当成当前结果。

## 目录结构

```text
shared/                  # 协议、配对和上传说明的单一来源
scripts/                 # 根级验证、协议同步和扩展密钥工具
bridge/
  src/                   # 工作区、会话、转录、交互与终端生命周期
  src/tool-format.ts     # 实时与历史共用的工具摘要、结果和 diff 格式化
  scripts/               # 构建、PTY 探针、布局校验和隔离验收
  launcher/              # WinForms 绿色启动器及 C# 行为测试
  tray/main.swift        # macOS arm64 菜单栏助手
extension/
  src/entrypoints/       # background、sidepanel、terminal
  src/components/        # 消息、输入、审批、提问和交互记录组件
  src/lib/               # 协议、存储、WS、页面提取和弹窗协调
docs/history/            # 历史日志、交接报告和脱敏证据
.github/workflows/       # 三平台 CI 与标签发布
```

## CI 与发布

- CI 在 push 和 PR 时运行 Ubuntu、Windows、macOS 三平台门禁，包括仓库检查、两端类型检查与测试、扩展构建，以及平台原生构建和项目树外验收。Windows 还会对最终绿色单文件和当前扩展构建运行真实 Chrome 离线验收。
- Release 在 `v*` 标签上先运行同平台测试门禁，再分别构建 Windows 单 exe、macOS DMG 和扩展 zip。Windows 任务下载最终扩展 artifact，从 zip 解压后对同一待发布单文件运行真实 Chrome，通过后才上传资产。公开资产按固定名称汇总，缺失任一资产都会失败。
- 标签采用 `vYYYY.MM.DD.N`。四段版本号通过脚本直接写入包 JSON，避免 `npm version` 把末段改成预发布版本。

```bash
git tag v2026.11.23.1
git push origin v2026.11.23.1
```

发布前仍应运行 `npm run verify`。该命令不包含高级终端 E2E；Windows 发行等价验收还需按上节实测最终单文件和扩展 zip。云端矩阵、macOS 签名/DMG 和真实 API 是独立证据，不能互相替代。CI 与 Release 修改必须同步检查。

## 许可证

[MIT](../LICENSE)
