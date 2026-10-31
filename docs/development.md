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

cd bridge && npm test                  # 桥接 16 个测试文件，290 个单测
cd bridge && npm run typecheck         # 桥接严格类型检查
cd bridge && npm run selftest          # 离线：握手 + 绑定流程，不调 API
cd bridge && npm run selftest:live     # 端到端：向真实 claude 发一条消息（走本机中转配置）

cd extension && npm test               # 扩展 19 个测试文件，146 个单测
cd extension && npm run typecheck      # 严格类型检查（需先 npx wxt prepare 或构建过一次）

# 预编译件架构审计（CI 门禁同款）：读文件头断言 CPU 架构，防"第三方二进制架构发错进包"
node bridge/scripts/check-arch.mjs bridge/node_modules/systray2/traybin/tray_windows_release.exe x64
```

生产入口装配回归同时覆盖普通 CLI 与托盘 exe，确保两者都注入同一份 `workspace.json` 持久化；Windows 产物另经项目树外隔离探针验证执行设置与文件夹绑定真实落盘。最终交互验收使用新 dist exe、独立 `CCC_BRIDGE_HOME` / `CLAUDE_CONFIG_DIR`、真实 CLI、`127.0.0.1` 假上游和真实 Chrome：Ask 多题/多选/Other/自定义答案、计划退回/批准、Write 拒绝/允许、工具状态/完整输出/Edit diff/错误、历史分页、双视图和重载恢复均通过；refusal UserDialog 还覆盖了同端口桥接重启恢复。compact/Task 最终回归另从真实扩展 UI 验证：网页附带与选中文字存在时 `/compact` 仍原文执行，普通消息附带不受影响，实时及重载后的压缩记录均有默认折叠的完整摘要，旧侧车长 Task 报告读取后也成为短状态与折叠详情。验收同时检查了页面截图和运行时错误，具体结果目录及未验证边界见 TODO。上述验证未调用真实 API。

`bridge/probe-sdk.mjs` / `probe2-sdk.mjs` / `bridge/scripts/probe-frames.mjs` 是 Agent SDK 直连探针（排障用，不经桥接直接验证 CLI 时序、权限模式与流式帧字段——"SDK 流不下发 effort" 就是用 probe-frames 实锤的）。

### 目录结构

```
shared/protocol.ts      # WS 协议单一来源
scripts/                # sync-protocol / gen-extension-key
bridge/                 # 本地桥接（Node + ws + Agent SDK）
  src/{config,session-manager,transcript,claude-session,interaction-store,server,resume-script,folder-picker,index}.ts
  scripts/              # build-exe / build-mac-app / build-tray-mac / check-arch / gen-icon / gen-iconset / mac-setup.command / 探针
  tray/main.swift       # 自研 macOS 菜单栏托盘助手（systray2 协议，arm64 原生，CI 现场 swiftc 编译）
extension/              # Chrome MV3 扩展（WXT + React）
  src/lib/{protocol,storage,attach-policy,ws-client,page-extract,popup-mode,popup-registry}.ts
  src/components/       # MessageList / InputBox / PermissionCard / AskCard / ElicitationCard / UserDialogCard / InteractionRecordView 等
  src/entrypoints/{background.ts, sidepanel/}
.github/workflows/      # ci.yml（三平台测试）/ release.yml（tag 触发构建发布）
```

### CI / 发版

- **CI**：push / PR 触发（`.github/workflows/ci.yml`），在 ubuntu / windows / macOS 三平台跑两端类型检查 + 单测 + 扩展构建。
- **发版**：打 tag 即自动构建并发布 Release（`.github/workflows/release.yml`）：

  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```

  流程：测试门禁 → Windows runner 编 `ccc-bridge-win-x64.zip`（bun 单文件 exe，内嵌桥形图标与托盘组件，打包前 `--smoke` 运行自检）、macOS runner 编 `ccc-bridge-darwin-arm64.dmg`（本机原生编译 → 组装标准 .app（悬索桥 icns、菜单栏驻留）→ swiftc 现场编译 arm64 托盘助手并跑协议冒烟 → 主程序 `--smoke` 运行自检 → ad-hoc 预签并校验 → dmg 附 Applications 快捷方式与一键解除隔离脚本，hdiutil 打包）、ubuntu runner 出扩展 zip（`wxt zip`，manifest 版本号自动取 tag）→ 汇总创建 GitHub Release。发布步骤读取完整 Git 历史，自动写入固定下载说明、上一 tag 到当前 tag 的非合并提交列表和 compare 链接，直接提交到 `main`、没有 PR 时也有实际更新条目。CI 门禁另对第三方预编译托盘组件做字节级架构审计（`check-arch.mjs`）——“构建成功 ≠ 能跑”，教训见 [TODO](../TODO.md)。

## 许可证

[MIT](../LICENSE)
