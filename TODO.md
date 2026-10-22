# CopilotCC — TODO

- [x] Task 1: 仓库脚手架与协议同步/密钥脚本
- [x] Task 2: bridge 骨架 + config.ts
- [x] Task 3: shared/protocol.ts + 校验函数
- [x] Task 4: session-manager.ts
- [x] Task 5: transcript.ts
- [x] Task 6: claude-session.ts
- [x] Task 7: server.ts
- [x] Task 8: index.ts CLI + selftest 验证
- [x] Task 9: extension 骨架（WXT + background）
- [x] Task 10: storage.ts + attach-policy.ts
- [x] Task 11: ws-client.ts
- [x] Task 12: page-extract.ts + UI 组件 + App 装配
- [ ] Task 13: 端到端手动验收 + README.md

## 配对信息

- 扩展 ID: `cnalihjaacpahpjkpneacjcfbhboglno`
- allowedOrigins: `chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno`
- manifest.key: 见 wxt.config.ts（Task 9 写入）

## 端到端手动验收（Task 13，待用户执行）

桥接已冒烟启动通过，真实 config.json 已生成且 allowedOrigins 已预填为本扩展 ID。验收步骤：

1. `cd bridge && npm start` → 记下打印的 token
2. `chrome://extensions` 加载 `extension/.output/chrome-mv3`（确认 ID = cnalihjaacpahpjkpneacjcfbhboglno）
3. 点图标开侧栏 → 粘贴 token → 状态灯变绿
4. 绑定一个已存在的文件夹 → 显示已绑定（无"已续聊"徽标）
5. 打开技术文档页提问"这页讲了什么，100 字总结" → 回答确实来自该页面
6. 同页追问某概念（不附全文）→ 回答能引用页面内容（上下文保留）
7. 让它"把 XX 知识点写成 notes/xx.md"（auto 模式）→ 文件夹真实出现该文件
8. 网页选中文字 → 右键"用 Claude Code 询问选中内容" → 侧栏带入引用
9. 切"逐条审批"再让其写文件 → 审批卡片点允许后写入成功
10. 关侧栏重开、重新绑定同文件夹 → "已续聊"徽标 + 历史消息回放
11. 杀掉 bridge → 状态灯变红；重启 bridge → 自动重连变绿且可继续对话（resume 生效）
12. 全部通过后把顶部 Task 13 勾选并提交

## 修复记录（2026-10-20）
- 验收第 5 项失败：页面内容未附加且无任何提示（静默降级）。已修复：
  - `page-extract.ts` 返回 `SnapshotResult{page,error}`，失败原因不再吞掉；
  - `App.tsx` 发送后追加附带状态行（📄已附带/⚠️失败原因/ℹ️同页不重复附带）；
  - `wxt.config.ts` 增加 http/https 全站 host_permissions，消除 activeTab 授权死角（切 tab 后侧栏仍可读当前页）。
- `page-extract.ts` 增加回退：Defuddle 提不出正文时（非文章型页面，如 GitHub 列表页）退化为页面纯文本，保证任何页面都能附带。
  - tsc 通过、扩展 12 测试全绿、已重新 build。待用户重载扩展后重测第 5 项。
- 新需求（2026-10-20）：附带标记 + 右键查看实际发送内容。已实现：`UiMsg` 增加 `sentText`/`attachKind`，用户气泡角标 📄(全文)/📎(选中)，右键弹层展示完整发送文本并支持复制；发送失败/部分失败仍保留 ⚠️ 状态行。
- 易用性修复（2026-10-20）：附带状态行可点击展开查看实际发送全文（details 内嵌 pre），与右键气泡等效。
- 交互修正（2026-10-20）：附带状态行从 details 内联展开改为点击弹出临时浮层（复用右键查看器），看完即关，不在消息区留长文。
- 渲染增强（2026-10-20）：消息气泡补 KaTeX 数学公式（remark-math + rehype-katex + katex css），表格/行内代码补暗色样式。GFM 与代码块此前已支持。
- 新功能（2026-10-20）：代码块语法高亮（rehype-highlight + github-dark 主题）与右上角复制按钮；文件夹栏"切换聊天…"下拉（切换即绑定并回放对应历史）；聊天框上方模型（默认/fable/opus/sonnet/haiku）与 effort（默认/low/medium/high/xhigh/max）下拉，经 settings.set 推送桥接并带 resumeId 重建会话保上下文；消息区"⬇ 回到底部"按钮（离底超 120px 时出现）。
- 桥接修复（2026-10-20）：src/index.ts 自检脚本误用服务端专用 encode() 发客户端消息（folder.bind/chat.send），改为 JSON.stringify；bridge 补上 tsc --noEmit 检查（此前只给扩展配了，该历史错误因此长期未被发现）。协议 settings.set 扩展 model/effort 字段并同步两端副本，新增 2 个协议测试（桥接共 28 个单测）。
- 调整（2026-10-20）：模型/effort 选择栏从聊天框顶部移到输入框上方（贴近权限模式切换行），去掉与输入框叠压的分隔线。
- 已知问题（2026-10-20，根因已基本定位）：cmd 里交互式 claude -c 看不到桥接会话历史（界面报 No conversations found in this project.）。原因：交互式界面的会话枚举依赖 claude.json 的 projects 注册项与 history.jsonl 记录，SDK 驱动的会话（条目 entrypoint=sdk-cli/sdk-ts）不写这两处，故交互式枚举为空；会话 jsonl 本身完好落盘于 ~/.claude/projects/ 对应项目目录，print 模式 claude -p -c 实测可正常续接（上下文完整）。早前怀疑的路径大小写假设已被实验双向排除。绕开方式：claude -p -c "问题" 单发续接；或 claude --resume 后跟会话 ID 显式指定（ID 见 ~/.ccc-bridge/sessions.json）。
- 修复与功能（2026-10-20）：① 模型/effort 选择并入输入区执行选项同一行（不再单独占行）；② 回放溯源升级：协议 HistoryMessage 增加可选 sentText/attachKind 字段，transcript.ts 回放时拆解桥接发送包装——气泡只显示用户问题，完整发送内容（去防注入前缀）保留在 sentText 供右键溯源，📄/📎 附带标记同样保留，重载前后行为与当前会话完全一致（桥接 29 个单测全绿）；③ 页面提取信息量提升：Defuddle 传 removeLowScoring:false 保留低评分内容块，且结果 <1500 字符且不足全文 1/3 时改用全文纯文本；④ 绑定行右侧加会话 ID 芯片，点击复制 claude --resume <id> 续接命令（sessionId 由 folder.bound/chat.done 推送到侧栏，新会话首轮回复后可见）。
- 新功能（2026-10-20）：一个文件夹多会话——协议加 session.list/new/switch/delete 与 SessionInfo；桥接枚举 ~/.claude/projects/<slug>/*.jsonl 生成会话列表（标题取首条用户消息拆包装前 30 字，mtime 倒序；deleteTranscript 防路径穿越）；FolderBar 改双下拉（切换文件夹/切换会话）+ ＋新会话/🗑删会话（删除带确认并清本地转录）；切会话清空消息区并回放目标历史；桥接测试 29→37。
- 新功能（2026-10-20）：桥接托盘 exe——tray.ts 入口（systray2 托盘菜单：复制 token/打开配置目录/退出；图标由 scripts/gen-icon.mjs 生成内嵌 base64）；scripts/build-exe.mjs 用 bun build --compile 出 win-x64（--windows-hide 无黑窗）与 darwin-arm64 交叉编译产物，traybin 原生二进制同级配套；macOS 需 chmod +x 与 codesign ad-hoc 签名（README 有步骤）。
- 修复（2026-10-20）：① 扩展 WS 断线重连后不回绑文件夹（服务端每条连接状态独立），客户端显示已绑定但发消息报"请先绑定文件夹"；改为 conn 每次进入 open 都回绑当前/上次文件夹，folder.bound 的 refs 守卫保证同会话重绑不清屏。② 托盘 exe 黑窗：bun 编译 flag 误写 --windows-hide（被静默忽略，PE 子系统仍为 CONSOLE），改 --windows-hide-console 后子系统为 GUI；copyToClipboard 的 clip 补 windowsHide。③ 托盘菜单移除"打开配置目录"（config.json 仅 token/port/allowedOrigins 可配，README 已写明），菜单精简为复制 Token/退出。④ FolderBar：绑定后路径回填输入框；会话下拉空态占位"（此文件夹暂无历史会话）"。桥接 37 + 扩展 12 测试全绿，双平台 exe 已重建（win 版子系统已验证为 GUI）。
- 新功能与加固（2026-10-20）：① 配对串——shared/pairing.ts（ccc1.+base64url(JSON{h,p,t})，纯 JS 编解码不依赖 Buffer/atob，sync-protocol.mjs 扩展为同步 protocol.ts+pairing.ts 两个文件）；兼容裸 token 回退默认 127.0.0.1:19280；托盘菜单"复制配对串"，npm start 与 --print-pairing 输出配对串。② 端口保证——startServer 异步化（返回实际端口），监听失败或被无关程序占用自动顺延（最多 10 个端口）；auth.ok 携带 instance 字段，启动后自探测握手认亲，同 token 重复实例直接拒绝；runtime.json 单实例守卫（claim/write/release + 退出钩子）；探测连接用 terminate 断开（CONNECTING 状态 close() 不断 socket 会泄漏）。③ 扩展——TokenGate 改单框配对串输入；连接状态栏加「⚙ 配对」按钮支持中途改端口/换桥（换桥清空界面状态后重连）；ExtSettings 增 host 字段（默认 127.0.0.1，界面不暴露）。④ 实验确认本机 Windows 下 Node 同端口重复 listen 会抛 EADDRINUSE（早前"双桥并存"未复现，防御仍保留）。桥接 45 + 扩展 16 测试全绿。
- 新功能（2026-10-20）：托盘直接改端口——桥接同端口内置 /config 设置页（与 WS 共用端口，不占额外端口；Host 头校验防 DNS rebinding + token 鉴权，GET 表单页 / POST 改端口）；托盘菜单加「修改端口…」用默认浏览器打开该页，保存后在线切换（先在新端口完成监听+自探测再拆旧服务，失败不影响现状），写回 config.json 并经 update-menu 刷新托盘状态行与 tooltip，页面直接给出新配对串，扩展「⚙ 配对」粘贴一次即完成重配对；server.ts 重构为 http.createServer + WebSocketServer({server})（修：ws 会把 http server 的 error 转发到 wss，监听失败须挂 wss error 监听防未捕获异常）；npm start 打印设置页地址。扩展无需改动。桥接 45→47 + 扩展 16 测试全绿。
- 改进（2026-10-20）：修改端口从「打开网页设置页」升级为「系统原生弹窗输入」主路径（win=PowerShell VisualBasic InputBox，-EncodedCommand 传中文防代码页乱码；mac=AppleScript display dialog；linux=zenity/kdialog 依次尝试），改完新配对串自动复制到剪贴板并弹结果提示；StartedServer 暴露 setPort（持久化与 onPortChanged 回调收进 rebind，托盘进程内直调不走 HTTP）；弹窗工具不可用时回退原网页设置页。桥接 47→48 + 扩展 16 测试全绿。
- 修复（2026-10-20）：托盘「修改端口」弹窗看不见——VisualBasic InputBox 从无窗口后台进程弹出时不抢前台，被 Chrome 压住（用户连点两次都看不到，残留两个等输入的 powershell 进程）；改为自绘 WinForms Topmost 对话框（Shown 时 Activate + 全选默认值，powershell 加 -Sta），MsgBox 结果提示加 4096 SystemModal 置顶。另发现本机沙箱拦截 node/timeout 嵌套 spawn powershell（EPERM），powershell 实测只能由 Bash 直调（已存记忆）。exe 已重建。
- 修复（2026-10-21）：弹窗置顶后仍不可见，根因升级定位——GUI 子系统 exe 以 windowsHide 拉起 console 子进程时，SW_HIDE 启动标志被子进程第一个窗口继承，InputBox/WinForms 弹窗进程活着（WinForms 程序集已加载、92MB 常驻等输入）但窗口恒隐藏；wmic 实锤残留进程父进程=ccc-bridge.exe。「修改端口…」放弃弹窗路径，固定走浏览器打开本机设置页（openUrl，实测可靠的形态），tray.ts 删除 promptText/showMessage/runCmdCapture/psEncoded 等全部弹窗机制；孤儿弹窗进程已清理（注意：另有父进程非桥接的 powershell 属用户自己的，不动）。桥接 48 测试全绿，双平台 exe 已重建并冒烟通过。
- 新功能（2026-10-21）：输入区发送按钮同行最左显示当前生效的「模型 · effort」只读指示（InputBox 加 send-row 布局，样式随 style.css），改动入口仍是上方下拉。扩展 16 测试全绿并已重新 build。
- 完善（2026-10-21）：模型/effort 指示从「显示下拉原值（空则写"默认"）」改为「显示实际生效值」——协议 chat.done 增加可选 model/effort 字段（SDK system/init 每轮开头重发：model=实际模型 ID；effort=经环境变量/组织上限/模型能力降级后的实际档位，null=不下发 effort 参数，老 CLI 缺字段=不上报且不缺省覆盖旧值）；claude-session 捕获最新一帧随 onDone 传出并暴露 runtimeInfo()；扩展缓存到 chrome.storage（ccc.runtime，换桥清空），重载后首轮回复前也有真值；显示压短（claude-fable-5-1→"fable 5.1"，新增 lib/format.ts + 3 例测试）；显示优先级：手动选择 > 上报值 > 不显示该段（不再出现"默认"字样）。
- 修复（2026-10-21）：effort 指示拿不到真值——探针（bridge/scripts/probe-frames.mjs，真实 SDK query 逐帧打印）实证 SDK 流全程不下发 effort（init 缺字段、assistant 帧、result.modelUsage 均无）；改为 result/success 时读会话转录末尾最近一次 api-request-blob 的 effort（transcript.ts 新增 extractEffortFromTranscript/readTranscriptEffort：cwd+sessionId 按既有 slug 规则定位 jsonl，仅读末尾 8MB 窗口，最近 blob 无 effort 字段=null、无 blob=undefined 不覆盖 init 值；SAFE_SESSION_ID 防路径穿越复用）；转录证据优先于 init 上报值（每回答粒度，符合"每个回答值都不一样"的实然）。transcript.ts 顺带支持 CLAUDE_CONFIG_DIR。教训：Write 覆盖前先看 git status——transcript.ts 是存量文件（历史回放在用），初版误覆盖后按原版全文+新增函数合并恢复。
- 新功能（2026-10-21）：「📄 强制看页面」悬浮按钮 + compact 自动续期——协议 chat.done 增加 compacted 字段；claude-session 检测 system/compact_boundary（及 status+compact_result）帧置 compactPending，本轮 done 时上报；扩展 App 增 forceAttach 状态机：点亮后下一条消息无视附带开关与同页去重强制带全文（attachNote 显示"已强制附带"），用后失效，chat.done 按 compacted 自动续亮一轮，chat.error 清零；InputBox textarea 外套 .ta-wrap（position:relative）按钮绝对定位于右上角，不占布局，.on 高亮态。
- 修复（2026-10-21）：消息区不随流式输出滚动——原实现没有任何自动滚动，onScroll 只维护按钮显隐。MessageList 引入跟随模式（followRef）：在底部阈值内即跟随，新落地消息/流式增量到达时即时赋值贴底（smooth 追不上增量）；上滚离底即退出跟随，内容增长时重估按钮（流式第一个字到达按钮立即出现）；用户消息数增加（自己发送或历史回放落地）强制恢复跟随；点「回到底部」平滑滚到底，落地后由 onScroll 恢复跟随。
- 优化（2026-10-21）：托盘/exe 图标从红色圆点改为 Claude 橙桥形——scripts/gen-icon.mjs 全量重写为桥形生成器（32 单位坐标系形状库：胶囊条/圆弧/抛物线垂缆，6x 超采样覆盖率转 alpha 抗锯齿；手写 PNG/ICO 编码，ICO 内嵌 16/32/48/256 四档 PNG）；a 拱桥 / b 拱桥+桥墩 / c 悬索桥三变体可选（生成浅/深底预览条到 %TEMP%/ccc-icon-preview.png），当前用 c；托盘 src/icon.ts 与 exe assets/icon.ico 同源，build-exe.mjs 经 bun --windows-icon 内嵌 exe 图标（ico 缺失时报错提示先跑 gen-icon）；exe 资源段已验证内嵌 256px PNG，冒烟通过。
- 新功能（2026-10-21）：CI/CD 与 Release 组织——.github/workflows/ci.yml（push/PR 触发，ubuntu/windows/macOS 三平台跑两端 typecheck+单测+扩展构建）；release.yml（打 v* tag 触发：测试门禁 → windows runner 编 win-x64 zip（7z）、macos runner 编 darwin-arm64 zip（附 setup.command 一键初始化，ditto 保留可执行位）、ubuntu 出扩展 zip（wxt zip）→ gh release create --generate-notes 汇总发布）；build-exe.mjs 支持 win|darwin 平台过滤参数（mac runner 不碰 --windows-icon 的 PE 写入）；wxt.config.ts 删除硬编码 version 改继承 package.json（CI 按 tag npm version 写入）；两端 package.json 加 typecheck、扩展加 zip 脚本；新增 .gitattributes（脚本强制 LF 行尾 + 图标/图片二进制保护）；bridge/scripts/mac-setup.command（chmod+x/xattr 去隔离/codesign ad-hoc 一条龙）；README 按 Best-README-Template 实践重组（Release 下载快速开始前置 + 资产对照表 + 白名单配置进快速开始 + 开发者区后置）。
- 修复（2026-10-21）：模型/effort 下拉残留"默认"伪状态——未手动选择时只显示"模型默认/effort 默认"，用户无从得知当前实际生效值；自动档 label 改为动态呈现桥接上报真值（自动 · fable 5.1 / 自动 · high），首次聊天真值未到时如实显示"自动（跟随 CLI 配置）"；props 注释同步更新，UI 全链路不再出现"默认"字样。
- 修复（2026-10-21）：侧栏 CSP 误报——DOMParser 解析出的文档会继承扩展页 CSP，解析含 on* 内联事件处理器属性的真实页面 HTML 时，Chrome 对每个属性报一条 "Executing inline event handler violates CSP"（仅编译期检查，解析文档 scripting 禁用、无实际执行；headless Chrome 最小复现实验：脏 HTML 恰好报 4 条与用户所见一致，剥离后 0 条）。page-extract.ts 新增 stripInlineHandlers() 在字符串层剥离 on* 属性（兼容双引号/单引号/无引号/大写/换行写法），Defuddle 与全文纯文本两条解析路径共用；新增 tests/page-extract.test.ts 5 例；README 安全设计补对应说明。
- 修复（2026-10-21）：release.yml 发布作业报 "failed to run git: not a git repository" —— publish job 缺 actions/checkout@v4，gh release create 无 git 仓库上下文无法定位远端仓库（build-win/build-mac/build-ext 三作业其实都已成功）。补 checkout 后用新 tag v2026.10.21.2 重发；旧 tag v2026.10.21.1 保留（对应一次失败 run，重跑无效——Re-run 仍用旧 tag 上的旧 workflow 定义）。
- 易用性（2026-10-21）：桥接白名单出厂预置——config.json 首次生成即写入发布版扩展固定 Origin（config.ts 的 DEFAULT_EXTENSION_ORIGIN，由固定 manifest key 派生），新用户免手抄；存量空数组配置不迁移（空数组仍是开发模式放行+警告）。server.ts Origin 校验放行无 Origin 头的本机进程（selftest/探针，浏览器 WS 必发 Origin）。新增 key→ID 推导一致性测试。README 快速开始砍掉原第 3 步。
- 新功能（2026-10-21）：别名系统——「文件夹+会话」组合命名为别名（AliasRecord：id 16hex / name / folder / sessionId|null；存桥接 ~/.ccc-bridge/aliases.json 随配置目录走，重装扩展不丢）；协议新增 alias.list/create/update/delete/select 与 folder.pick；服务端粘性同步 syncCurrentAlias（select/create 后文件夹或会话变化自动写回别名，无当前别名不反向吸附，消除客户端竞态）；bindFolder(p, forceSessionId) 三分支抽取共用（undefined=按 sessions.json 映射 / null=强制新会话 / string=续聊，转录已删退回新会话并修正别名）；原生文件夹选择框 folder-picker.ts（win=PowerShell FolderBrowserDialog 挂 TopMost 隐形 owner 防压后台；mac=osascript choose folder；取消/不支持/出错统一回 null，UI 留手输退路；5 分钟超时兜底；pickSeq 代际号作废迟到结果）；扩展 AliasBar 包 FolderBar（平时一行别名下拉，＋新建才展开绑定表单，详情可点开；删除别名弹确认声明"仅删别名，会话保留"；提交时文件夹变了强制新会话）；App.tsx 接 alias.list.data / folder.picked（pickResolverRef 请求-响应配对）。桥接 60→72（alias-manager 5 例 + alias 路由 7 例）+ 扩展 24 测试全绿，selftest 离线通过，扩展 wxt build 通过。
- 修复（2026-10-21）：exe 托盘模式别名功能静默失效——tray.ts 与 index.ts 各自装配 startServer 依赖，AliasManager 只注入了 index.ts（npm start 路径），exe 入口 tray.ts 漏注入，alias.* 消息全被 if (!aliases) 守卫静默丢弃（72 例单测全经 boot() 注入 aliases，覆盖不到生产装配层）；tray.ts 补齐注入（import + 实例 + deps），一次性探针实测重建 exe 的 alias.list 往返正常。教训：ServerDeps 新增字段时 index.ts 与 tray.ts 两个入口都要接线。
- 新功能（2026-10-21）：别名创建表单支持手动输入会话 ID——下拉加「手动输入 ID…」项，选中后出现 ID 文本框（任意文件夹路径均可搭配手输 ID，不再强制新会话），可直接粘贴整行 claude --resume 命令（前端剥离命令前缀）；桥接鬼会话退回新会话时补发 folder.error 警告（必须在 folder.bound 之后发：客户端收 bound 清屏会抹掉先发的警告），alias.select 鬼会话用例补警告断言。桥接 72 + 扩展 24 测试全绿。
- 修复（2026-10-21）：新建别名表单与详情区互斥——原先两者可同时展开，文件夹+会话控件叠两套（用户截图指出红蓝框功能重叠）；＋新建时自动收起详情，点详情自动放弃创建表单。纯扩展侧改动。
- 更名与图标（2026-10-21）：产品定名 CopilotCC——扩展 manifest name/action、侧栏 title、右键菜单、托盘状态行与 tooltip、/config 设置页、README 标题全部换新；技术标识不动（npm 包名 ccc-* / 配置目录 ~/.ccc-bridge / zip 资产名 / 扩展固定 key 与 ID / 仓库名）。扩展补图标：gen-icon.mjs 重构为可 import（主流程加执行守卫，导出 render/encodePng/encodeIco/VARIANTS），scripts/gen-ext-icon.mjs 复用悬索桥变体 c 生成 16/32/48/128 PNG 到 extension/public/icon/，wxt.config.ts 注册 manifest.icons 与 action.default_icon，与托盘/exe 同一视觉身份；PNG 全平台 Chrome 通用。桥接 72 + 扩展 24 测试全绿，双端 typecheck 与构建通过。

### 2026-10-21：修复 Release 缺扩展 zip（upload-artifact 隐藏目录排除）

- 根因：actions/upload-artifact v4.4+ 默认排除隐藏目录下的文件。wxt zip 产物在 `extension/.output/`（点开头即隐藏目录），glob 匹配到的唯一文件被过滤，无文件时只 warn 不报错，build-ext 绿色但 artifact 为空，publish 汇总后 Release 只有 win/mac 两包（v2026.10.21.5 实际症状）。
- 修复（release.yml）：扩展 zip 先 `cp extension/.output/*-chrome.zip .` 拷到仓库根（非隐藏路径）再上传，path 改为 `ccc-extension-*-chrome.zip`；三个 upload-artifact 全部加 `if-no-files-found: error`（今后静默缺包直接变红）；publish 创建 Release 前加 `ls -la assets/` 让收集结果日志可见。
- 教训：CI 步骤绿色不等于产物真的上传了，artifact 上传必须配 `if-no-files-found: error` 兜底；点开头目录（.output/.next/.wxt 等）下的文件 upload-artifact 默认不收，要么拷出来要么 `include-hidden-files: true`。
- 验证：本地 `npx wxt zip` 产物为 `extension/.output/ccc-extension-<version>-chrome.zip`（1.35 MB），路径文件名与预期一致；v2026.10.21.6 流水线需确认 build-ext 上传步骤不再 warn、Release 资产含扩展 zip。

### 2026-10-21：mac 包改 dmg、win 包改单文件 exe

- 背景：用户预期 mac 是 dmg 包；win zip 里两个 exe（ccc-bridge.exe + traybin/tray_windows_release.exe）令人困惑，预期单文件。托盘组件是 systray2 的平台进程（主程序拉起的子进程，不能单独运行），它硬性要求 CWD/traybin 布局。
- win 单文件：托盘组件（3.6 MB）base64 内嵌进 exe——build-exe.mjs 编译前把 src/traybin-win-b64.ts 临时覆盖为真实内容、编完还原占位（仓库只存占位，脚本内 TRAYBIN_B64_PLACEHOLDER 与入库占位须逐字一致）；tray.ts 首跑释放到 ~/.ccc-bridge/traybin/（大小不一致即重写=升级跟随），chdirToTraybinParent 候选顺序：内嵌释放目录 → exe 旁（mac 包/旧版 win 包）→ CWD → node_modules（开发态）。与图标内嵌（icon.ts）同一模式。
- mac dmg：release.yml 的 ditto zip 改 hdiutil create（-volname CopilotCC -format UDZO），dmg 是真实文件系统，天然保留可执行位；README 强调 dmg 只读，须先把文件夹拷出来再跑 setup.command（codesign 要往二进制写签名）。

### 2026-10-21：修复 exe 进聊天秒断（SDK 原生 CLI 解析靠 CWD 侥幸命中）

- 根因：Agent SDK 未显式传 `pathToClaudeCodeExecutable` 时，沿 import.meta.url/CWD 向上找 node_modules 里的原生 CLI 包。此前 exe 的 CWD 在项目树内（dist/ 位于 bridge/ 之下），侥幸命中 bridge/node_modules 所以一直能跑；单文件改动把 CWD 挪到 ~/.ccc-bridge 后搜索落空，SDK 在 query() 初始化同步抛 "Native CLI binary for win32-x64 not found"，异常沿 bindFolder 冲出无 try/catch 的 WS 消息处理器 → 进程死亡 → WS 1006 → 侧栏"秒断"。推论：历来所有 Release zip 在没有项目树的机器上进聊天必崩，此前只跑本地构建所以从未暴露。
- 修复：① claude-session.ts 新增 resolveClaudeExecutable()——`CLAUDE_CODE_PATH` 环境变量优先，其次 where/which claude（win 下 shim 是同目录 .cmd/.ps1 无法直接 spawn，优先取相邻 node_modules 里的原生 bin/claude.exe），结果只解析一次并缓存，显式传给 SDK；解析不到则回退 SDK 默认行为。② server.ts 消息分发整体裹 try/catch：处理器内同步异常转 chat.error 发侧栏并 console.error 留痕，进程与连接保活。③ 回归测试：createSession 同步抛异常 → chat.error 且后续消息正常（72→73 全绿）。
- 顺带修复：release.yml 三处 `npm version` 改 node 直写 package.json——npm version 会做 semver 规范化，把 4 段版本号 2026.10.21.7 改写成 2026.10.2-1.7（.7 扩展 zip 文件名被改写事故）。
- 教训：编译分发形态下一切"沿 CWD/相对路径找资源"的 SDK 默认行为都是定时炸弹（托盘组件、CLI 解析同型，须全部显式化）；exe 的端到端验证必须在项目树外的隔离目录做（CCC_BRIDGE_HOME 隔离配置 + stderr 重定向 + WS 探针脚本复现，本次靠它抓到确定根因）。

### 2026-10-21：新功能——聊天上传文件（落盘 copilotUploads）

- 侧栏：输入区可拖入文件或点发送键左侧 📁 按钮多选（≤10 个、单文件 ≤30MB、合计 ≤45MB，扩展侧友好拦截先于协议层），待传文件芯片行可单个移除；发送时 FileReader 读成 base64 随 chat.send.uploads 上送。
- 协议：chat.send 增加 uploads?: UploadFile[]（name + dataB64），三层上限 MAX_UPLOAD_FILES=10 / 单文件 41MB b64 字符 / 总量 60MB b64 字符（ws 100MiB 帧内），越界整帧拒绝。
- 桥接：saveUploads 落盘绑定文件夹根目录 copilotUploads/（basename+剥控制字符防穿越，重名自动 -1 后缀不覆盖，坏 b64/空文件/超 30MB 逐条 failed 回 chat.error，全失败则本次不发送）；随后把 [上传文件] 说明块（composeUploadNote 含真实落盘路径）拼在客户端原文前发给 Claude。
- 气泡/回放：attachKind 新增 "upload"（📁 标记），右键气泡/点击附带状态行溯源完整发送内容与看页面一致；转录回放按 [上传文件] 标记识别（优先级高于页面/选中，一条消息可同时带两者）。
- 防注入：GUARD_PREFIX 扩展覆盖 [上传文件] 块（文件名是数据不是指令）；transcript.test.ts 的 GUARD 字面量夹具改 import claude-session 同源常量，前缀文案再改不拖垮测试。
- shared 单源：upload-note.ts（UPLOAD_DIR + composeUploadNote）经 sync-protocol.mjs 逐字同步两端。
- 验证：桥接 83 + 扩展 29 测试全绿，双端 typecheck/构建通过；隔离 exe 端到端探针（CCC_BRIDGE_HOME 隔离 + 临时绑定目录 + 带 txt 上传发问）实测文件落盘一致、Claude 经 Read 读出内容、桥接存活。探针心得：WS 握手即鉴权——URL 必须 /ws?token=...（auth 消息是空操作）；握手后服务器会推 session.list.data 等帧，等特定帧须按类型过滤。

### 2026-10-22：新功能——页面信息丰富度（按别名配置）

- 协议：PageRichness = brief/standard/rich + isPageRichness 守卫；AliasInfo 与 alias.create/update 增加可选 pageRichness（非法值剥掉不下发）；alias.list.data 随别名下发扩展。
- 桥接：AliasRecord 持久化 pageRichness（aliases.json；未设置不落字段 = 标准档）；create/update 透传；syncCurrentAlias 部分更新天然保留该字段。
- 扩展：attach-policy 新增 PAGE_RICHNESS_CAPS（精简 5 千 / 标准 3 万 / 丰富 10 万字符），composeMessage 按当前别名档位截断；附带状态行显示实际注入字符数（截断时标注原文字数）；AliasBar 新建表单与详情区顶部都加丰富度下拉，详情区改动即发 alias.update 落盘。
- 验证：桥接 86 + 扩展 30 测试全绿（协议校验/管理器持久化/路由透传/组装截断四层用例），双端 typecheck、扩展 wxt build、桥接 exe 构建通过。

### 2026-10-22：修复 macOS 上传文件名清洗漏反斜杠（CI 抓到的跨平台 bug）

- 根因：sanitizeUploadName 用 path.basename 去路径穿越，POSIX 实现不认反斜杠，Windows 风格穿越名（..\..\evil.txt）在 macOS 上整串漏过清洗；本地 Windows 测试一直绿所以从未暴露，CI macos-latest 矩阵抓到。
- 修复：basename 改按正反斜杠切分（name.split(/[\\/]/).pop()），两端平台行为一致；测试夹具不动（期望本就是跨平台契约）。桥接 86 全绿。
- 教训：凡路径/分隔符处理的代码，Windows 本地绿不代表 POSIX 绿；上传/落盘类功能的清洗逻辑一律手写分隔符处理，不依赖 path 模块的平台语义。

### 2026-10-22：修复详情区「页面丰富度」行深色主题下隐形

- 根因：richness-row 行样式写死 `color: #555` 灰字（浅色主题习惯），侧栏实际是深色主题（body 底 #1e1f24、主文字 #e4e6eb），灰字压在深底上近乎隐形，用户报告"背景是灰色的字也是灰色的"；下拉也没有暗底控件样式。
- 修复：行文字删掉写死的灰字与 12px 字号，继承面板主文字色；下拉补齐暗底控件约定（background #2a2b31 / color inherit / border #444 / 圆角 4px），与 .alias-switch、.alias-create select 一致。
- 教训：侧栏是深色主题，新 UI 元素配色一律 `color: inherit` + 复用既有控件样式（#2a2b31 底 / #444 边），不引入任何新灰色。

### 2026-10-22：新功能——随时强停本轮生成（等价 CLI 的 ESC）

- 根因（用户报告"少了强停机制"）：停止键的显示条件是"流式文字已开始"（streaming !== null），而 Claude Code 轮次里思考与工具调用常占大头，首字之前没有任何停止入口；发送键此时是禁用态，观感就是"没法停"。
- 协议：ServerMessage 新增 chat.aborted（无字段）——桥接确认中止立即下发，客户端据它解除 busy。
- 桥接：claude-session 跟踪 turnActive（send 起、result 帧止）；abort() 空闲时空操作（防 done 在途竞态误吞下一轮 result），进行中则立即发 onAborted（不等 CLI 收尾帧）+ 吞掉该轮收尾 result + 挂起审批立即按拒绝释放 + interrupt() 通知 CLI 停止（拒绝吞掉，不影响已下发的 aborted）；server 事件接线 onAborted → chat.aborted。
- 扩展：新增 busy 状态（发送即置位；chat.done/error/aborted、换文件夹/会话、断线、换桥接清零），InputBox 的 streaming prop 改 busy——停止键整轮可见；停止键改红色 ■ 样式；输入框 Esc 中止（输入法组合中的 Esc 不拦截）；submit 加 busy 兜底防 Enter 连发。
- 中止观感对齐 CLI：已生成的部分文字保留为正式气泡，追加"⏹ 已手动停止本轮生成"标记。
- 验证：桥接 90 + 扩展 30 测试全绿（新增 abort 中止/空闲空操作/interrupt 拒绝/路由下发 4 例），双端 typecheck、扩展构建通过。
- 教训：「进行中」状态要锚在用户动作（发送）上，不能锚在 UI 表现（首字到达）上——否则思考/工具调用期就是控制真空。
