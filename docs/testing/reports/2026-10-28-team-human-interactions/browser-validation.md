# Team 人类交互：受控浏览器验收

本次运行 **7 项浏览器测试全部通过**，无跳过、无页面运行异常，耗时约 6.3 秒。测试使用当前工作区的真实 React 组件，在独立 Vite 页面中运行；HTTP API 与 WebSocket 事件均为测试替身。它证明界面和前端数据流能够按契约工作，**不等同于真实 Gateway、真实工具副作用或外部模型的端到端验收**。

未启动、停止或修改用户的 `pd` 服务，也未改动 `~/.pilotdeck` 配置。测试中的 `/fixture/project` 仅是模拟 API 数据，不是新增测试项目。

## 运行与证据

- 命令（在 `ui` 目录）：`pnpm exec playwright test -c e2e/team-interactions.config.mjs`
- 运行时间：2026-10-28 00:40（Asia/Shanghai；机器时间见 JSON 的 `startTime`）。
- 运行结果：[browser-results.json](browser-results.json)。`expected: 7`、`unexpected: 0`、`skipped: 0`、`flaky: 0`。
- 测试入口：[team-interactions.spec.mjs](../../../../ui/e2e/team-interactions.spec.mjs)。
- 实际加载：`TeamModeControls`、`useTeamMode`、`TeamInteractionPanel`、普通权限/问答/Plan 卡片、`TeamTeammateRouteView` 和只读消息渲染组件。
- 独立服务：`127.0.0.1:5188`，测试结束后关闭。WebSocket 替身只允许 `watch-session` / `unwatch-session`，缺少根会话订阅时拒绝发送成员流式事件；任何模型提交命令都会让测试失败。

## 已覆盖

| 测试 | 操作和结果 | 主要证据 |
| --- | --- | --- |
| 桌面浅色 / 英文 | 团队详情和团队交互并列；两位 Teammate 各有三类通知；6 项 pending 数量正确。卡片不重复配置；长 Plan 可读，expired 记录只读 | [面板](screenshots/desktop-light-en-panel.png)、[长 Plan](screenshots/desktop-light-en-long-plan.png)、[过期历史](screenshots/desktop-light-en-expired-history.png) |
| 移动深色 / 中文 | 390px 视口下同样显示两位成员和三类通知；长 Plan 没有横向溢出，授权按钮可见；过期卡没有处理按钮 | [面板](screenshots/mobile-dark-zh-panel.png)、[长 Plan](screenshots/mobile-dark-zh-long-plan.png)、[过期历史](screenshots/mobile-dark-zh-expired-history.png) |
| 桌面深色 / 英文 | 桌面深色下重复布局、长内容和只读历史检查 | [面板](screenshots/desktop-dark-en-panel.png)、[长 Plan](screenshots/desktop-dark-en-long-plan.png)、[过期历史](screenshots/desktop-dark-en-expired-history.png) |
| 移动浅色 / 中文 | 移动浅色下重复布局、长内容和只读历史检查 | [面板](screenshots/mobile-light-zh-panel.png)、[长 Plan](screenshots/mobile-light-zh-long-plan.png)、[过期历史](screenshots/mobile-light-zh-expired-history.png) |
| 三类交互与历史 | 对两名成员分别允许/拒绝工具、回答多选/取消问题、批准/拒绝 Plan；前端请求带完整 owner 字段。6 次响应各自更新原记录；7 条 handled（含原过期记录）保留，刷新后恢复过滤和历史 | [已处理记录](screenshots/desktop-handled-history.png)、JSON 对应测试 |
| 响应失败 | 模拟 HTTP 503 和长错误：原请求保持 pending、允许按钮仍可重试，移动端不横向溢出。随后打开问题卡按 Escape 只关闭窗口，没有提交取消或答案 | [长错误](screenshots/mobile-light-long-response-error.png)、JSON 对应测试 |
| 成员只读聊天 | 点“查看聊天”进入成员 URL 并订阅 root；显示历史，无输入框及发送/停止/模型等操作。流事件直接更新内容，不逐块发 HTTP；旧 activation / stopVersion 不显示。重连和刷新恢复单份内容，返回时取消订阅并保留 pending 过滤；直接 URL 可读取同一 transcript | [流式内容](screenshots/desktop-readonly-stream.png)、[直接 URL](screenshots/desktop-readonly-direct-url.png)、JSON 对应测试 |

视觉检查已查看移动深色面板、移动长 Plan、移动长错误、桌面只读流式聊天截图：文字、按钮和卡片均可辨认，长内容在卡片内滚动。截图使用固定测试数据，不是对用户现有 Team 的操作记录。

## 验证边界

- mock API 对应的 allowed/denied/answered 等状态用于验证前端响应和展示，不能证明工具实际执行或实际被拒绝。
- 成员历史、pending、handled 来自 API 替身；刷新验证的是前端重读和恢复，不能证明 runtime store 的原子持久化。后端测试必须另证。
- WebSocket 替身验证订阅与事件处理契约；真实 Web bridge 的 watcher 分发、浏览器网络断线、进程重启需要服务集成证据。此处的“重连”由恢复事件驱动，不是断开真实 TCP 连接。
- 没有调用外部模型，不能验证模型是否主动发起目标请求、怎样响应用户答案或是否正确完成委派任务。
- 不把这些 7 项测试等同于 Case 01–20 全量补跑，也不覆盖 Case 19 F060、Case 20 F063；这两项已由用户确认不是缺陷，本期排除。
