# 当前待办与验证边界

本页只保留尚未有关闭证据的事项，最后整理于 2026-11-23。历史日志中的“待提交、待推送、待打 tag”已被后续提交覆盖，不再重复列入。旧记录不代表今天仍能复现同一问题，开始处理前应先重新确认。

完整的开发、CI/CD 和真机验收记录见[历史文档](docs/history/README.md)。

## 功能问题

- [ ] **重新确认 macOS 原始插件终端窗口故障。** 2026-11-14 交接时，“插件终端窗口创建失败，未启动 Claude”未复现、未定位，缺少原始 RED。Terminal.app Locale 故障和二次打开失败是另外两条已修复链路，不能替代这一项。证据见[返回报告](docs/history/2026-11-14-macos/RETURN-REPORT.md)。
- [ ] **验证或改进 macOS Bun 直用 PTY 路线。** 最近一次记录仍为 `initial-size_TIMEOUT`，当前使用 `node-helper`。不要把回退路线成功写成 Bun 直路线通过。

## 尚未覆盖的端到端场景

- [ ] `auto_mode_server_fallback` 已有契约和单元链路，尚需触发真实 CLI 回调并完成真实 Chrome E2E。
- [ ] MCP form / url elicitation 尚需真实 Chrome 中的人工填写、提交和持久化隐私检查。
- [ ] 最终 Chrome 验收尚未单独触发 `EnterPlanMode` 工具回调；实际权限模式显示已有覆盖，但没有独立 EnterPlanMode 卡片。
- [ ] `OfferChromeSetup`、`ShowOnboardingRolePicker`、`PublishPlugin`、`ProposeGoal`、`ProposeSkills` 等当前未启用的条件工具没有专用实现或真实 E2E；未适配的交互工具应继续安全拒绝。
- [ ] 2026-11-23 本轮 Windows 真实 Chrome 离线验收未获写系统剪贴板授权；真实多行复制、Ctrl+C、Ctrl+Shift+C、按钮粘贴和 Ctrl+Shift+V 五项仍需单独复验。终端工具栏显示已检查，不能把该项记成剪贴板行为通过。

交互能力的详细边界见[用户指南](docs/guide.md#交互支持矩阵与验证边界)。

## 真机与人工复核

这些项目只有历史待办，没有后续关闭证据。它们表示“待确认”，不表示当前构建必然失败。

- [ ] Windows 真实 CLI 的“首字出现前直接滚轮触发自动导出”、alternate 视图翻页和冷却行为仍需人工复核。2026-11-23 最终单文件已自动覆盖 resume、手动触发历史导出后的真实滚轮、Ctrl+C 中断、双视图镜像和关闭恢复。
- [ ] 插件终端关闭后再次打开：确认正常退出、无“上次没有正确关闭”提示，并区分既有残留提示与本轮新产生的问题。
- [ ] 终端启动日志与杀毒软件影响：确认首次打开和转录分页耗时；决定是否配置 Kaspersky 排除，以及转录句柄是否需要空闲关闭。不要在未确认前修改用户杀毒软件设置。
- [ ] 真实长会话中的 compact 状态、压缩记录位置、输入框拖拽、窄侧栏与独立弹窗视觉和交互手感。
- [ ] fast 模型提升/恢复、生成中切换设置、多视图同步等历史人工验收项；自动测试通过不能替代这些真实界面复核。
- [ ] 实际运行本次整理后的云端 CI 与 `v*` Release，确认 Windows 最终资产门禁和 macOS DMG。本机发行等价验收已通过，云端结果以 GitHub Actions 为准。

## 验证入口

- 日常改动运行 `npm run verify`，覆盖生成副本、文档链接、脚本测试、两端类型检查、单元测试和扩展生产构建。
- 桥接离线行为运行 `npm --prefix bridge run selftest`；真实 API 验收需要单独明确授权，不属于默认验证。
- Windows 高级终端验收先阅读[开发文档](docs/development.md)。本机通过 `CCC_VERIFY_ROOT` 明确批准项目树外根目录，每次只使用新的空子目录。
- CI 与 Release 使用相同的三平台测试门禁；Windows CI 和 Release 还必须对最终单文件运行真实 Chrome，Release 使用最终扩展 zip 的解压目录。本机等价验收已通过，云端状态以 GitHub Actions 的实际运行为准。
