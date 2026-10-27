# CopilotCC 历史工具活动与本地命令回放 Implementation Plan

**Goal:** 重载或恢复会话后仍显示工具活动，/model 等本地命令不再以 XML 用户正文出现。

**Architecture:** 保留实时 chat.tool。桥接 readTranscript 将 assistant tool_use 转为历史工具消息，并把本地命令三元组整理为一条活动；HistoryMessage 增加可选 toolName，App 回放时恢复该字段，复用 MessageList 活动行。

**Tech Stack:** TypeScript、Vitest、React 19、jsdom、WS、Bun exe、WXT。

## Constraints

- 严格先 RED 后 GREEN；实时 chat.tool 集成测试必须始终通过。
- 不改变工具执行、权限、busy、草稿、fast、模型或回答正文协议。
- 本地命令不是简单删除：保留命令、参数与 stdout；普通用户文本即使含标签片段也不得被误吞。
- 不向用户正在使用的桥接发送 chat.send，不调用真实 API，不停止或覆盖用户桥接（二次诊断时为 PID 16852）；隔离 exe 可对仅监听 127.0.0.1 的假上游做完整实时验证。
- exe 隔离验证仅使用已批准的 D:\ccc-fast-final-verify-20261026\tool-history-20261027。
- 不 commit、push、tag 或发布。

### Task 1：完整消息链 RED

- [x] 新增 App 集成测试：实时 chat.tool 到 DOM 通过，历史 toolName 恢复按预期失败。
- [x] 为 transcript 写入工具顺序、摘要、/model 合并及普通用户文本保护测试；13 项中 3 项因旧解析行为产生有效断言 RED。

### Task 2：历史协议与解析 GREEN

- [x] HistoryMessage 允许 role=tool 与可选 toolName；同步协议复制件。
- [x] readTranscript 按内容顺序输出文本和工具活动，复用实时 summarizeTool；本地命令输出不显示原始 XML。
- [x] App 的 session.history.data 映射保留 toolName；桥接目标 45 项、扩展消息链 6 项通过，实时 chat.tool 保持 GREEN。

### Task 3：回归与真实数据验证

- [x] 两端完整测试、类型检查和 git diff --check 通过：桥接 15 文件/196 项，扩展 14 文件/88 项；桥接离线 selftest 通过。
- [x] 生产 readTranscript 对真实会话恢复 Write/Edit/Bash 和 7 条 /model 活动；60 条回放中工具 28 条，用户原始本地命令 XML 为 0。

### Task 4：文档与分发

- [x] 更新 README、TODO 和本计划，记录实际测试数与手动验收边界。
- [x] 重建扩展 zip 并核对完整性、文件集合与逐字节内容：68 个文件一致，SHA-256 `0480c81c28942289379eda6408565010538a7d42937c86ef74786b5d8f4febfe`。
- [x] 重建桥接 exe，在批准目录以隔离 HOME 做 WS 历史回放验证；9 条消息全部匹配、chat.send=0，exe SHA-256 `0b62b8f12655efa3f443512734f502d7ceff91eca01a30f30a63331f7e427772`，未替换运行中的 exe。
- [x] 重建根目录桥接 zip：完整性通过，唯一条目为 `ccc-bridge-win-x64/ccc-bridge.exe`，与 dist exe 逐字节一致；SHA-256 `eb74d4518101e7edd23a5edb8c7541b010f167da6fce76e6572a9ac96863d082`。
- [x] Chrome 真实浏览器自动验收：CDP Extensions.loadUnpacked 加载真实扩展；修复前 31 条工具 DOM 高度均为 0，修复后 31/31 均为 16.5px，旧会话 Write/Edit/Bash、/model、emoji 与正文顺序恢复。
- [x] 二次根因修复：真实 CLI 2.1.301 具有完整 assistant/tool_use；隔离 exe 广播 chat.tool/chat.done 正常。CSS 回归测试有效 RED 后，仅为 .tool-activity 增加 flex-shrink:0；扩展 15 文件/89 项通过。
- [x] 完整实时自动验收：隔离 exe + 真实 CLI + 127.0.0.1 假上游 + 真实 Chrome，Read 的 chat.tool 到达且活动行高度 16.5px，chat.done 正常，runtimeErrors 为空；未调用真实 API、未写入模拟目标。
- [x] 二次扩展 zip：68 个文件与 chrome-mv3 逐字节一致，SHA-256 7f4201a9db235f604517182d3747582eacc8c40d6b793bbae6962b41adc07747；桥接产物无需重建。
- [ ] 用户现有 Chrome 人工视觉复核：替换/重载扩展后在窄侧栏与独立弹窗确认。
