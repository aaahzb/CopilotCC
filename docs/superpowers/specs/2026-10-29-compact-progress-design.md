# CopilotCC 压缩进度可见性设计

**日期：** 2026-10-29
**状态：** 已获用户批准（真实方案：跳秒 + 完成后真实压缩率；顶部状态栏 + 聊天记录行）

## 背景与问题

Claude Code 在自动压缩（auto-compact）、手动 `/compact` 或空闲压缩（idle compaction）期间，CopilotCC 聊天框长时间无任何动静，用户不知道背后在做什么，产生焦虑，也无法对压缩后的记忆质量建立预期。

## 真实事件源（真 CLI 2.1.301 探针实证）

本机假上游 + 真实 CLI 触发 `/compact`，stream-json 实录帧序列：

1. `{type:"system", subtype:"status", status:"compacting"}` —— 压缩开始
2. `{type:"system", subtype:"status", status:null, compact_result:"success"|"failed", compact_error?:string}` —— 压缩结束
3. `{type:"system", subtype:"compact_boundary", compact_metadata:{trigger, pre_tokens, post_tokens, cumulative_dropped_tokens, duration_ms}}` —— 边界元数据（在结束帧之后约 4ms 到达）

**CLI 不输出进度百分比。** 桥接当前已能看到上述帧（用于 `chat.done` 的 `compacted` 标记），但未实时透出。

## 目标行为

- 压缩期间：顶部状态栏显示 `● 已连接 · 正在压缩…（Xs）`，秒数本地 1 秒跳变（真实流逝时间，非伪造进度）。
- 压缩结束：聊天消息流插入一条系统记录行（紧凑灰行、非气泡，样式同工具活动行）：
  - 成功且有元数据：`🗜 已压缩上下文 156k → 42k tokens（-73%）`
  - 成功无元数据：`🗜 已压缩上下文`
  - 失败：`⚠️ 上下文压缩失败，继续使用当前上下文`
- 压缩率 = `1 - postTokens / preTokens` 实算，仅在完成后可知。

## 架构与数据流

**关键时序修正（探针实证）：`compact_result` 结束帧比 `compact_boundary` 元数据帧早到约 4ms。** 若扩展分别处理两者，完成行永远拿不到压缩率。改由桥接做短窗口归并：

1. `shared/protocol.ts` 新增服务端广播（单一来源，`scripts/sync-protocol.mjs` 同步两端），只含两个 phase：
   - `chat.compact { phase: "start" }`
   - `chat.compact { phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number }`
2. 桥接 `claude-session.ts`：收到 `compact_result` 不立即广播，挂起并起 250ms 归并窗口；窗口内收到 `compact_boundary` 则合并元数据一次性发 done；窗口超时或结果为 failed 则按无元数据立即发。收到 `status:"compacting"` 立即发 start（并先冲掉挂起的 done）。
3. `chat.sync` 快照增加 `compacting: boolean`：压缩中途新打开/重连的视图立即看到提示（秒数从接入时刻起算，属近似）。
4. 桥接 `server.ts` 用 onCompact 事件维护 `workspace.compacting` 并广播；扩展 App 维护提示状态与记录行；断线清理（沿用 busy 防卡死逻辑）。

## 边界与降级

- 老 CLI 不发 status 帧：无任何显示（同 fast runtime pending 的静默降级）。
- `compact_result: "failed"`：记录行显示失败文案，状态栏提示清除。
- `compact_boundary` 缺 metadata：记录行退化为简单文案。
- info 帧晚于 done 帧到达（实证 4ms）：扩展在 done 时插入记录行，使用已缓存的 info；迟到的 info 不再回头改行。
- 记录行随转录持久化（2026-10-30 起）：transcript 解析 compact_boundary 条目按原位置回放同款记录行，重载扩展/回看历史均可见；实时行与历史行文案同口径。
- 断线/换会话/中止：清除压缩中状态。
- 后台预压缩（precompute）发同样的帧：自动兼容。
