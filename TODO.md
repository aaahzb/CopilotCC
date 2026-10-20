# Chrome Claude Code 侧边栏助手 — TODO

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
- 修复与功能（2026-10-20）：① 模型/effort 选择并入输入区执行选项同一行（不再单独占行）；② 修复重载后回放消息冒出页面上下文原文的不一致——transcript.ts 回放时剥离桥接发送包装（防注入前缀 + [页面上下文]/[选中文字] 块），新增 1 个测试（桥接共 29 个单测）；③ 页面提取信息量提升：Defuddle 传 removeLowScoring:false 保留低评分内容块，且结果 <1500 字符且不足全文 1/3 时改用全文纯文本；④ 绑定行右侧加会话 ID 芯片，点击复制 claude --resume <id> 续接命令（sessionId 由 folder.bound/chat.done 推送到侧栏，新会话首轮回复后可见）。
