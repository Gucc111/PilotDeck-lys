# Team 状态与失效输入的隔离界面验证

日期：2026-10-25。

后续真实 Web 流程的验证见 [2026-10-26 实测报告](../2026-10-26-team-cases01-20/README.md)。本页截图仍属于独立组件验证，不能据后续实测将其改称真实服务截图。

通过临时 Vite 页面导入实际 `TeamModeControls`、`QueuedMessagesTray`、中文文案及现有 CSS，注入固定的停止中、超时清理和失效队列数据。使用本地无头 Chromium（Playwright）访问独立的 `127.0.0.1:4317`，没有连接用户的 pd 服务、Gateway 或模型。输入框外壳是静态占位；本记录验证组件布局，不证明真实 Team 执行或端到端停止。

检查了桌面 1365×980、移动端 390×844，分别使用浅色和深色主题。队列与详情面板各 4 张截图，共 8 张。自动检查均无页面脚本异常、无横向溢出。人工查看移动端浅色队列、移动端深色面板、桌面浅色面板、桌面深色队列：停止状态、恢复按钮、附件计数和长错误信息均可见，面板能够纵向滚动；未出现遮挡或横向裁切。

截图命名为 `<desktop|mobile>-<light|dark>-<queue|panel>.png`；面板截图滚动到底部，突出显示长路径错误及“尚未确认全部退出”提示。自动结果见 `visual-checks.json`。

验证时发现清理中的成员卡片曾显示“空闲”，已调整为“正在停止”。截图数据使用真实执行身份格式（activation、participant、stopVersion 及消息处理后缀），以及 Leader、通知和资源清理标记，重新截图验证了成员状态和中文对象名称；不在界面显示原始执行 UUID。

## 最终自动化验证

全部最终命令显式固定 Node 22.23.2（项目支持版本）。日志保存在 `logs/`。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 前端：`TeamModeControls`、`useTeamMode`、`QueuedMessagesTray`、`useChatComposerState.attachments`、`sessionLauncher`、`ChatReview`、`GitReviewTab`、`TurnFileResults`、`MainAreaV2` | 9 文件，77 项通过 | `frontend-tests.log` |
| Web bridge：`pilotdeck-bridge`、`pilotdeck-bridge.sending`、`routes/team-library`、`routes/checkpoints` | 4 文件，89 项通过 | `bridge-tests.log` |
| UI 构建及 postbuild | 通过；仅有现存大 chunk 提示 | `ui-build.log` |
| UI 完整类型检查 | 失败：既有 ignored `useChatRealtimeHandlers.test.ts` 引用两个不存在的导出 | `ui-typecheck.log` |
| UI 范围类型检查 | 通过；仅排除上述既有草稿测试 | `ui-typecheck-scoped.log`（无诊断输出） |

以上前端及 Web bridge 共 166 项测试通过；`git diff --check` 通过。

范围类型检查使用临时 `ui/.team-typecheck-scoped.json`，内容为 `{"extends":"./tsconfig.json","exclude":["src/components/chat/hooks/useChatRealtimeHandlers.test.ts"]}`，执行 `tsc --noEmit -p .team-typecheck-scoped.json` 后删除。原 tsconfig 和用户草稿测试没有修改。

首次从 ui 目录启动登录 shell 时自动使用了系统 Node 25，其全局 localStorage 与 jsdom 冲突，导致 7 项前端测试失败；原始结果保留为 `frontend-tests-node25-failed.log`，随后固定支持的 Node 22 重跑全部目标测试通过。首次把范围 tsconfig 放在 `/tmp` 导致 `vite/client` 解析不到，保留 `ui-typecheck-scoped-config-failed.log`；移到临时 ui 路径后通过。这两项是验证环境/配置问题，不作为产品失败或通过证据。

验收用例文档已更新当前消息、停止、重启和检查点行为，并核对 Case 01–25、F001–F073 保留且首次功能条目无重复。未修改 2026-10-23/24 的旧报告，也未执行新的真实模型端到端测验。
