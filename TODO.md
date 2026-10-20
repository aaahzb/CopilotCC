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
