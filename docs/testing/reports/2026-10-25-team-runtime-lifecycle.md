# 检查点撤销与 Team 消息、停止行为实施验证

日期：2026-10-25。工作区：`PilotDeck-lys`，分支 `team-mode-v2`。

后续真实服务与模型的验证见 [2026-10-26 实测报告](2026-10-26-team-cases01-20/README.md)。本文保留实施当日的自动化与隔离验证记录；后续实测不改变本文各证据的验证层级。

## 交付行为

例如你让“发布评审团队”检查代码：Leader 委派测试任务后可以继续思考；同目录的测试员无需等待 Leader 整个 Agent Loop 结束才进入模型请求。测试员提出问题时，消息进入 Leader 当前回合的邮箱，等当前模型请求或工具批次结束后进入下一次请求。工具调用及其结果仍保持配对。

测试员完成后，程序通知只说明成员、任务 ID 和状态。Leader 通过 `team_collect` 读取最终结果。普通 `team_send_message` 用于协调，不再由程序把最终回复同时塞进通知。Leader 已自行结束时，有效消息仍可启动同一聊天的后续回合。本次没有增加强制存活、等待工具或轮询优化。

你点击停止后，整个 Team 的旧任务、消息、通知和待发用户输入失效。界面先显示“正在停止”；执行及资源清理完成才显示“已停止”。不配合取消的执行或 MCP 清理失败会继续显示待清理对象，禁止开始新运行。失效输入保留正文和附件引用，可放回输入框，用新 token 明确发送。旧重试和晚到 Abort 不影响新运行。

服务重启同样不会继续旧 queued 任务或催办消息，也不会发送恢复通知唤醒 Leader。浏览器刷新及连接断开不属于服务重启。

自动工作区快照、文件备份、检查点回退及整轮工作区锁已经移除。已有用户备份不删除。Git 使用独立 `repository_operation`；产物卡片、预览、下载、引用和普通聊天编辑/Fork 保留。旧恢复边界仍影响历史重放，不会让曾隐藏的内容重新出现。

## 验证方法与边界

- 使用临时目录、受控模型流、受控工具、持久化写入故障及同步屏障，验证时序、状态和调用次数。模型替身返回固定响应，不访问真实模型服务。
- Remote 测试使用临时端口的真实认证 WebSocket，验证契约透传及断线消费；不连接用户服务。
- 视觉验证使用独立 Vite fixture 导入实际组件，覆盖桌面/手机、深/浅主题及长错误。它证明组件布局，不等同于完整 Web 端到端验证。
- 未操作 `pd` tmux 服务，未访问 3002，未改动用户 `~/.pilothome`，未执行真实模型端到端验收。

## 验收项与证据

| 计划验收项 | 实现与验证证据 |
| --- | --- |
| 同目录并发、零检查点 | `tests/gateway/checkpoint-restoration.spec.ts` 同时挂起两个普通会话的模型请求，确认两者都已进入请求且 Git 操作可执行；`tests/gateway/team-runtime-session.spec.ts` 挂起 Leader 请求，确认同目录成员已进入模型。检查无新检查点目录。 |
| Git、产物、普通编辑/Fork、旧恢复历史 | `tests/gateway/repository-operation.spec.ts`、`tests/session/repository-operations.spec.ts` 验证独立接口、参数、短锁及 Git 操作；session/web 产物测试、`replace-last-turn`、`fork-compact-snapshot`、恢复边界回放测试验证保留行为。旧恢复接口拒绝且已有备份/工作文件内容保持不变。 |
| 通知插入时机 | `tests/agent/loop/team-steer-fence.spec.ts` 覆盖工具批次配对、应用前后取消、回合上限；`tests/gateway/team-runtime-session.spec.ts` 验证忙碌 Leader/成员在同一回合收到协调消息；原 user-steer、terminal/mailbox 测试继续通过。 |
| 最小生命周期改动 | `tests/team/runtime.spec.ts` 验证成员任务异步/串行边界、通知待确认不阻塞下一项成员任务；保留直接读状态的 collect；`team-runtime-session` 验证空闲 Leader 自动续作及原回合继续。没有新增 sleep、等待工具或强制 Leader 保持运行。 |
| 结果与去重 | `tests/team/message-delivery.spec.ts` 区分入队与 `steer_applied`、并发重复、持久化查询与 Abort 竞态；runtime 写入失败测试验证稳定批次和一次唤醒计数；Gateway 测试验证完成通知不包含成员最终正文，正在执行及重启后的重复输入只返回收据。 |
| 停止与重启 | `tests/team/runtime.spec.ts` 覆盖领取前后、未应用消息、迟到输出、旧 token、日志迁移和重启时 queued 任务/消息失效；`team-preflight-abort` 覆盖准备期间停止、旧 runId、附件处理中失效；`team-prompt-generation` 覆盖旧审批和补充信息回复失效。 |
| 用户队列和新运行 | Web bridge sending 测试验证 Team 队列在 Abort/Gateway 实例变化/bridge 重启后失效，普通队列保留原行为；composer/useTeamMode 测试验证放回输入框、附件保留、新 token 和新选择收据。Gateway 集成验证新运行重建角色绑定，旧 Abort 被隔离。 |
| 真实停止状态 | runtime 受控执行不响应取消时保持 `stopping`；`team-mcp-cleanup` 验证共享关闭 Promise、失败重试、指定 Team 资源范围；停止第二阶段在所有执行清理后再关闭晚创建的资源。Gateway draft Abort 等待实际清理，超时明确报错。 |
| 客户端、迁移、历史一致性 | `team-remote-generation` 验证 Remote submit/steer/Abort/runtime_stop 原始代次透传与错误；`team-observer-write-failure` 验证观察者写失败不终止服务端执行；runtime v1→v2 原子迁移及坏记录拒绝测试；普通 steer、聊天和队列回归保留。 |

以上证据是自动化测试覆盖，不能据此宣称真实模型一定会合理委派、少轮询或成功交付。

## 执行结果

| 检查 | 结果 |
| --- | --- |
| 后端完整构建（含 TypeScript） | 通过；[日志](2026-10-25-team-runtime-assets/logs/backend-build.log)。 |
| 后端相关综合回归 | **552 项：551 通过、0 失败、1 跳过**。跳过项为 Windows 专用 cmd 测试；[日志](2026-10-25-team-runtime-assets/logs/backend-regressions.log)。 |
| Gateway 最后补充复验 | 16/16 通过。综合回归后仅补齐空闲成员消息的回复/转发关联文本，复验真实会话工厂及受控模型集成；[日志](2026-10-25-team-runtime-assets/logs/gateway-final.log)。 |
| 前端相关回归 | **9 个套件、77 项通过**，包括 Team 状态、输入队列、Git、文件产物与主界面；[日志](2026-10-25-team-runtime-assets/logs/frontend-tests.log)。 |
| Web bridge 相关回归 | **4 个套件、89 项通过**，包括 Team 队列失效、代次边界和旧检查点接口拒绝；[日志](2026-10-25-team-runtime-assets/logs/bridge-tests.log)。 |
| UI production build | 通过；[日志](2026-10-25-team-runtime-assets/logs/ui-build.log)。 |
| 完整 UI 类型检查 | **未通过，既有阻塞**：未被 Git 跟踪的 ignored 草稿 `ui/src/components/chat/hooks/useChatRealtimeHandlers.test.ts` 引用不存在的 `ABORT_ACK_TIMEOUT_MS`、`shouldUnlockOnTerminalFrame`。没有修改此文件或为旧测试重新加入提前解锁逻辑；[完整错误](2026-10-25-team-runtime-assets/logs/ui-typecheck.log)。 |
| 本次代码范围的 UI 类型检查 | 临时配置继承原 tsconfig，仅排除上述既有草稿文件后 `tsc --noEmit` 通过；临时配置已删除。此结果不能替代完整检查；[日志](2026-10-25-team-runtime-assets/logs/ui-typecheck-scoped.log)。 |
| diff 格式检查 | `git diff --check` 通过。 |

前端验证固定 Node 22.23.2。一次从 ui 工作目录启动的登录 shell 选用了 Node 25，触发 localStorage 环境错误；已按项目 Node 22 要求重跑，保留初次失败日志。构建输出有包体大小提示，不影响构建通过。

综合验证期间暴露并修复了两处真实成员消息竞态：模型准备就绪与持久化接纳边界落在前一投递的清理期间时，重试信号可能丢失。现在两者共用待重试标记，新增同步屏障测试覆盖该窗口。另有 30ms 超时测试先读到通用清理占位、后读到具体对象的测试同步问题，已改为等待具体对象落盘，不修改产品 30 秒上限。

后端综合范围：Team、Gateway、Agent、session、web、tool 以及项目忽略规则；不运行真实模型 E2E 脚本。

```sh
npm run build
node --test --test-force-exit --test-concurrency=4 --test-timeout=60000 \
  'dist/tests/team/**/*.spec.js' 'dist/tests/gateway/**/*.spec.js' \
  'dist/tests/agent/**/*.spec.js' 'dist/tests/session/**/*.spec.js' \
  'dist/tests/web/**/*.spec.js' 'dist/tests/tool/**/*.spec.js' \
  dist/tests/pilot/project-gitignore.spec.js
```

## 视觉记录

共 8 张，包含 1365×980 桌面、390×844 手机、深浅主题、失效队列及清理详情。自动检查无横向溢出、无页面脚本异常；人工核对了状态、按钮、附件计数、纵向滚动和长路径换行。

- [方法和完整截图清单](2026-10-25-team-runtime-assets/README.md)
- [手机深色：清理超时与长错误](2026-10-25-team-runtime-assets/mobile-dark-panel.png)
- [桌面浅色：失效输入放回输入框](2026-10-25-team-runtime-assets/desktop-light-queue.png)

## 保留边界

- 文件产物扫描、生命周期 Hook、模型路由等模型前工作仍存在；撤销检查点锁不意味着所有模型前延迟都消失。
- 停止不会撤销已发生的文件修改及外部副作用，也不能强制杀死任意不配合取消的工具；这类情况保持清理中。
- 完成通知不附带最终正文，但无法阻止模型在自然语言协调消息中主动重复内容；没有语义去重。
- 已写入的输入、应用消息及完成结果保留为历史。失效阻止重新投递和启动，不删除历史；新运行角色提示明确旧指令只作历史背景。
- 现有用户检查点备份、历史报告和调研资料保留；本次没有执行 Git 提交。

使用说明见 [Team 模式](../../team-mode.md) 与 [Git 和文件产物说明](../../chat-checkpoints-git.zh.md)。
