# CopilotCC 工具活动行与分类图标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工具调用以区别于回答正文的紧凑活动行显示，并按工具名称展示跨平台 emoji。

**Architecture:** 保留现有 chat.tool 协议，只在 App 的 UiMsg 转换中增加 toolName。MessageList 按 toolName 选择图标并渲染结构化活动行，CSS 保证非气泡、单行和摘要省略。

**Tech Stack:** React 19、TypeScript、Vitest、jsdom、现有 CSS、WXT。

## Global Constraints

- 遵循已批准的 2026-10-27-tool-activity-icons-design.md。
- 严格先 RED 后 GREEN；不改变桥接、协议、工具执行、权限、busy 或回答正文。
- 既有附带状态行没有 toolName，必须保持 clickable 分支。
- 不删除文件，不 commit、push、tag 或发布；只重建扩展，不重建桥接 exe。

### Task 1：工具活动 RED

**Files:** Create extension/tests/message-list.test.tsx；Modify TODO.md。

- [x] Step 1：新增 jsdom 挂载与结构测试。构造 role=tool、toolName=WebSearch、text=查询词的消息，断言 .tool-activity 不含 .msg/.assistant，图标为 🔍，工具名与摘要分span，assistant 仍为 .msg.assistant。
- [x] Step 2：新增映射与兼容测试。覆盖 WebFetch/Read/Edit/MultiEdit/Write/Bash/Grep/Glob/upload、MCP search/extract、未知工具；无 toolName 的 sentText 状态行仍为 clickable。
- [x] Step 3：读取 sidepanel/style.css，断言工具活动行 nowrap，摘要 text-overflow:ellipsis。
- [x] Step 4：运行 npx vitest run tests/message-list.test.tsx，确认失败来自缺少 toolName 活动和样式，而不是挂载错误。

### Task 2：结构化活动行 GREEN

**Files:** Modify extension/src/components/MessageList.tsx、extension/src/entrypoints/sidepanel/App.tsx、extension/src/entrypoints/sidepanel/style.css。

- [x] Step 1：UiMsg 增加可选 toolName；App 的 chat.tool 分支写入 toolName: m.name、text: m.summary，不再拼接 🔧。
- [x] Step 2：MessageList 增加工具图标映射，带 toolName 时渲染 .tool-activity、aria-hidden 图标、.tool-name 和可选 .tool-summary，title 保留完整内容。
- [x] Step 3：CSS 为 .tool-activity 设置透明背景、无圆角、flex、nowrap、overflow:hidden；名称不压缩，摘要 min-width:0、overflow:hidden、text-overflow:ellipsis。
- [x] Step 4：运行目标测试、完整 npm test 和 npm run typecheck，全部通过后才进入分发。

### Task 3：文档与扩展分发

**Files:** Modify README.md、TODO.md、本计划；Generated extension/.output/chrome-mv3/** 与 extension zip。

- [x] Step 1：README 说明工具活动行与图标；TODO 记录 RED/GREEN、实际测试数和手动验收边界。
- [x] Step 2：运行 npm run build、npm run zip、unzip -t，并核对 zip 与 chrome-mv3 文件集合和逐字节内容，重新计算 SHA-256。
- [x] Step 3：运行 git diff --check，勾选已有证据支持的步骤，交付新 zip；不宣称 Chrome 视觉验收完成。
