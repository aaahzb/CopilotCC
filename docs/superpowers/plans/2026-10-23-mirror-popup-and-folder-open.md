# 实施计划：独立窗口镜像模式 + 别名打开文件夹/续聊脚本

> 设计稿见同名 specs 文件。内联执行（改动跨协议/桥/视图强耦合，不适合并行子代理）。

## 任务序列

1. **协议**：shared/protocol.ts 加 chat.send{display?,note?} / chat.draft / chat.user / chat.sync / permission.resolved / folder.open / folder.opened；跑 sync-protocol.mjs；protocol 测试更新。
2. **桥接 resume-script.ts + open-in-file-manager**：纯函数+IO，先测后写（命名清洗/内容/标记防误删/幂等）。
3. **桥接 server.ts 工作区重构**：per-connection 状态上提为 Workspace；send→broadcast；快照推送；folder.open 路由；脚本保鲜/清理钩子；ws close 不再杀会话。跑 90+ 既有测试保底 + 新镜像用例。
4. **扩展 page-extract**：snapshotActiveTab 拆 resolve+shared；新增 snapshotTab(tabId)。补单测。
5. **扩展 popup-mode.ts + background.ts**：参数解析/弹窗 URL/去重聚焦；pin 协调 + 徽标注入生命周期。补单测。
6. **扩展 App.tsx 镜像化**：渲染以广播为准（去乐观上屏）；快照接入；草稿受控；弹出/钉住顶栏；folder.opened 反馈。InputBox 草稿受控改造；AliasBar 加打开文件夹按钮；style.css 补弹窗顶栏/徽标宿主样式。
7. **文档**：README 功能/架构/FAQ/目录结构；本 TODO 收口。
8. **门禁与发版**：两端 typecheck+test+wxt build 全绿 → 提交 → tag v2026.10.23.3 → 给用户推送指令。

## 每任务验证

- 2/3：`cd bridge && npm run typecheck && npm test`
- 4/5/6：`cd extension && npm run typecheck && npm test && npm run build`
- 全量收口再各跑一遍。
