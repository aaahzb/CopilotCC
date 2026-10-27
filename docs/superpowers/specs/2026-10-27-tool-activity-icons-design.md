# CopilotCC 工具活动行与分类图标设计

## 背景与目标

工具调用不能看起来像 assistant 回答正文。现有 chat.tool 已有独立消息类型，但扩展把通用扳手、工具名和摘要拼成一段文本，缺少明确的活动行结构。用户要求按工具使用跨平台 emoji，例如 WebSearch 使用放大镜。

## 已确认方案

- 仅修改扩展展示层，不修改桥接、WS 协议、工具执行、权限或回答正文。
- App 在 chat.tool 到 UiMsg 的转换中保留 toolName，text 只保存摘要；不再预先拼入通用扳手。
- MessageList 对带 toolName 的工具消息渲染专用 .tool-activity：图标、原始工具名、摘要分别使用 span。
- 工具活动行透明、无圆角、小字、单行；名称不压缩，长摘要省略，title 保留完整工具名与摘要。
- assistant 继续使用 .msg.assistant 和 Markdown；工具活动不添加 .msg 或 .assistant。
- 附带网页等既有 tool-card 状态行没有 toolName，继续走原 clickable 分支，行为和样式不变。

## 图标映射

- WebSearch：🔍；WebFetch：🌐。
- Read：📄；Edit/MultiEdit：✏️；Write：📝。
- Bash：💻；Grep：🔎；Glob：📁；上传：📁。
- 未识别工具：🔧。
- MCP 名称按小写语义兜底：含 search 使用 🔍；含 fetch/crawl/extract/map 使用 🌐；其余 🔧。
- 图标 span 使用 aria-hidden，工具名和摘要仍是可访问文本。

## 数据流

SDK assistant.tool_use → 桥接现有 onTool(name, summary) → 现有 chat.tool → UiMsg { role: "tool", toolName: name, text: summary } → MessageList 工具活动行。

## 测试与验收

- 先观察新测试 RED，再修改产品代码。
- WebSearch 必须显示 🔍、工具名和摘要，且不使用正文气泡类。
- 常用工具、MCP 与未知工具图标映射有覆盖。
- CSS 单行与摘要省略有断言；既有附带状态行保持 clickable。
- 完整扩展测试、类型检查、build、zip 文件集合和逐字节一致性通过。
- Chrome 窄侧栏和独立弹窗的真实视觉验收由用户执行，不用自动测试冒充完成。

## 非目标

不重做工具结果、折叠交互、历史工具回放或权限卡片；不重建桥接 exe；不引入新运行时依赖。
