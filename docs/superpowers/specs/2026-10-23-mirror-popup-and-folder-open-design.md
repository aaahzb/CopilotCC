# 2026-10-23 独立窗口镜像模式 + 别名打开文件夹/续聊脚本 · 设计稿

## 背景与目标

用户双小屏：聊天框与网页挤在同一浏览器窗口。目标：
1. 聊天框可弹出为独立 OS 窗口（拖到副屏），浏览器全屏看网页；弹出后用户可手动隐藏侧边栏，映射不丢；随时切回侧边栏模式。
2. 别名详情区一键打开别名所在文件夹；文件夹内放置 `继续聊天-<别名>.sh`，终端运行即 `claude --resume` 回到该别名当前会话。

## 核心架构决策：桥接内单一工作区 + 视图镜像（用户拍板）

现状：桥接按 WS 连接持有状态（folder/claude/currentAliasId 每连接一份）——多视图各自 resume 同一会话有并发隐患，关视图即杀会话（中断生成）。

新架构：桥接进程内**唯一工作区**（Workspace），侧边栏与弹窗均为只读/回写视图：

- Workspace 持有：folder、claude 会话、mode/model/effort、currentAliasId、busy、streamText（本轮已流出文本）、inflightUser（本轮用户气泡）、pendingPerm（挂起审批）、draft（输入框草稿）。
- 一切状态事件**广播**给全部已认证连接：chat.user / chat.delta / chat.tool / chat.done / chat.error / chat.aborted / permission.request / permission.resolved / folder.bound / session.list.data / alias.list.data / chat.draft。
- 用户消息不再由发送方本地乐观上屏：chat.send 携带 display（原始输入）与 note（附带结果说明），桥接组装最终文本后广播 chat.user，所有视图同时上屏。
- 请求-响应类仍按连接定向：auth.* / folder.picked / folder.opened / session.history.data（快照推送除外，见下）。
- 新视图（或断线重连）发 client.ready，桥接按序推送快照：folder.bound（若已绑定）→ session.history.data（主动推送转录回放）→ session.list.data → alias.list.data → chat.sync{ busy, streamText, user, permReq, draft }。中途打开立即补齐在途流与草稿。
- 视图不再自动回绑 lastFolder：只有快照显示工作区为空（无 folder.bound）且本地有 lastFolder 时才发 folder.bind 引导首绑。folder.bound 到达一律刷新 lastFolder（修 alias.select 不刷新导致的 stale 回绑）。
- 停止：busy 经快照/广播镜像，任何视图随时可 abort 共享会话；chat.aborted 广播，各视图保留部分文本 + ⏹。
- 流式：SDK 每 delta 立即广播一帧（不攒批），同时追加进 streamText 供快照；新视图一次性补齐存量后接实时流。
- 会话生命周期：不再随连接关闭；随桥接进程存活。桥接退出时子进程 stdin EOF 自行结束。
- 草稿镜像：chat.draft 双向；~200ms 防抖；IME composition 期间不上报；后到覆盖；发送后清空；快照携带。

## 弹窗模式

- 侧栏顶栏「⧉ 弹出」：取当前窗口活动标签页 → 去重（同 tab 已有弹窗则聚焦）→ chrome.windows.create popup 窗，URL = sidepanel.html?popup=1&tab=<tabId>&alias=<aliasId?>。
- 弹窗复用同一份 App（样式/逻辑天然一致）：解析 URL 参数进入弹窗模式；aliasId 存在时快照后 alias.select 精确还原；页面提取改用钉住的 tabId（snapshotTab(tabId)：chrome.tabs.get + scripting 注入；标签关闭给出可见错误）。
- 弹窗顶栏：「📌 《页面标题》」（tabs.onUpdated 监听标题/URL 变化；onRemoved 变灰）+「🎯 指向当前页」（getLastFocused windowTypes:["normal"] 取活动标签换钉，lastUrl 重置）+「⇱ 回侧边栏」（sidePanel.open 最近正常窗口 + window.close()）。
- 关联徽标（双端 key，用户拍板）：后台 SW 协调。弹窗上报 pin{tabId, aliasName, hue, winId}；后台 scripting.executeScript（isolated world，有 runtime API）向被钉页面注入 Shadow DOM 浮动徽标（右下半透明：色点+别名名；点击徽标 → 聚焦对应弹窗）。hue = hash(aliasId) → 弹窗顶栏同色系，双屏一瞥验映射。tabs.onUpdated(complete) 重注入；windows.onRemoved/onRemoved(tab)/换绑/回侧栏 全路径清理。
- 多弹窗（用户拍板允许）：各自钉各自页面，均为同一工作区视图，无并发会话隐患。
- 隐藏侧栏：手动（X 或图标）；不影响弹窗（映射由弹窗自身 + 后台 SW 持有，与侧栏页面死活无关）。

## 别名打开文件夹 + 续聊脚本

- 协议：folder.open（无参，服务端解析：当前别名.folder ?? 工作区.folder）→ folder.opened{ path, script } / folder.error。
- 桥接 openInFileManager：win explorer.exe / mac open / linux xdg-open（spawn+unref，explorer 假退出码容忍）。
- resume-script.ts：`继续聊天-<别名>.sh`（非法字符 <>:"/\|?* 与控制符 → "-"，空名回退"未命名"，截 60 字符）；内容=标记注释 + cd "$(dirname "$0")" + exec claude --resume "<sid>"；无会话时输出提示 exit 1；内容不变跳过写入；chmod 0755 尽力而为。
- 保鲜时机：folder.open / alias.create / alias.select / 粘性同步后 / chat.done（会话 ID 权威时刻）/ session.switch/new/delete 后。
- 清理：alias.delete → 删该别名脚本（仅认标记，防误删）；alias.update 改 name/folder → 删旧写新（当前别名）。
- UI：别名详情区「📂 打开文件夹」按钮（current || bound 可用）+ 4 秒临时反馈（folder.opened）。

## 边界与明确排除

- 镜像范围：消息流、busy、审批、别名/文件夹/会话、设置（chrome.storage 变更监听）、草稿。**不镜像**：各视图钉住的页面（各钉各的，附带以发送视图为准）、上传待选列表。
- 视图开关永不中断生成；只有用户亲手点停止。
- chrome:// 等不可注入页面：徽标注入失败静默，弹窗芯片仍显示（弹窗侧为权威显示）。
- 弹窗间并发发消息：同一工作区串行处理，后到消息排队为下一轮（与单视图连发语义一致）。

## 测试

- bridge：resume-script 单测（命名清洗/内容/标记防误删/幂等跳过）；server 新增用例（双客户端镜像广播、中途接入快照、draft 单向不回显发送方、folder.open 注入假 opener、permission.resolved 广播、连接关闭不杀会话）。
- extension：popup-mode 参数解析；page-extract snapshotTab（钉住/标签关闭/自身页拒绝）；deriveAttachKind。
- 门禁：两端 typecheck + test + wxt build；CI 三平台 + release 冒烟不变。

## 文档

README（独立窗口模式、镜像架构、打开文件夹/续聊脚本、FAQ×3）、TODO（架构决策记录）、目录结构同步。
