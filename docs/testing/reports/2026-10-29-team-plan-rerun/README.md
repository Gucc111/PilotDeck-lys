# Leader / Teammate Plan 真实端到端复验

日期：2026-10-29，北京时间 11:42–11:52 完成主要操作。依据 [Case 14、14A](../../team-mode-e2e-acceptance.md)定向验证；**本次测试范围通过，没有发现新的 Plan 阻塞或授权异常，不表示整套 Team 验收通过。**

Leader 和两名 Teammate 都从默认审批状态真实调用 `enter_plan_mode`，创建计划并提交 `exit_plan_mode`。成员计划进入团队交互面板，Leader 自身计划使用普通底部卡片。成员批准、继续讨论并附批注、批准后的实际执行，以及刷新恢复均取得真实证据。Plan 下 `team_inspect` / `team_collect` 成功，派工和发消息仍被拒绝。

## 测试方式与环境

- 任务发送、选择 Team、打开交互面板、刷新、批准计划、继续讨论及允许一次文件写入，全部通过 Computer Use 操作真实 Web 页面；使用真实 Gateway 和外部模型，没有 mock Plan 请求或用 API 代替用户裁决。
- 测试配置通过实际 Team library API 创建；Gateway API 只读回 runtime、主聊天和成员 transcript，配合实际文件取证。创建脚本和只读观察代码见 [observe.mjs](scripts/observe.mjs)。`setup` 会创建配置，已经执行一次，不应重复运行；`observe <label>` 仅取证。
- tmux `pd` 启动服务：Web `http://127.0.0.1:3002`，Gateway `ws://127.0.0.1:18789/ws`；`PILOT_HOME=/Users/gucc1/.pilotdeck`。Gateway 使用仓库源码，UI 在测试前执行 `npm --prefix ui run build` 成功。
- HEAD：`6e1e5ad5fa9d37e984eb44b333bed38412aafb91`，叠加此前未提交的 Plan 修复。基线包含两个关键源码及 UI index 的 hash，见 [baseline.json](evidence/baseline.json)。本次未修改产品代码，未重新运行后端自动化测试；真实模型结果与上一轮自动化结果分开评价。
- 固定工作区：`/Users/gucc1/Codes/team-mode-acceptance/release-app`。测试角色均配置 `read_file`、`write_file`、`edit_file`、`enter_plan_mode`、`exit_plan_mode`、`todo_write`；skills / MCP 为空，执行审批均为 `default`。没有使用已移除的角色“计划模式”配置。

| 角色 | 配置模型 | participant ID |
| --- | --- | --- |
| QA1029-Plan-leader | `llmcenter/claude-opus-4-8` | `49e3c94b-74fa-4e67-87c6-8a5765c9492f` |
| QA1029-Plan-reviewer | `llmcenter-openai/deepseek-v4-pro-0813` | `74dcd30b-622c-4f0a-a8c3-508b62bf042c` |
| QA1029-Plan-tester | `llmcenter-openai/deepseek-v4.1-flash` | `da06d4ca-f0be-484c-b246-82e6d264522c` |

冻结配置见 [setup.json](evidence/setup.json)、[最终 runtime 与 transcript](evidence/final-after-refresh.json)。成员实际调用的返回模型字段及工具结果另摘录于 [tool-evidence.json](evidence/tool-evidence.json)，主聊天历史保留 Leader 的模型字段。

Team：`QA1029-Plan`，ID `b70da716-273f-4647-9f98-cde13c264b79`。

- [实际主聊天](http://127.0.0.1:3002/session/web:s_43fe0b9a-019d-41b9-82cd-0544906d106e)
- Root：`web:s_43fe0b9a-019d-41b9-82cd-0544906d106e`
- activation：`a8adc73f-7980-46f8-9858-b2121b13f9d6`；stopVersion：`0`
- reviewer work：`0907385e-b462-44d5-b074-d01acd3351b6`
- tester work：`5ddf9714-fce3-48bf-9b16-ba4d86b26b1e`

## 实际操作与结果

第一轮通过模型下拉菜单选择 `QA1029-Plan` 和已登记的 release-app，在输入框要求 Leader 各委派一次任务：成员先进入 Plan，写带独特标题的计划，提交后等待用户，只在批准后创建测试标记。Leader 派工后结束回合。第二轮在同一聊天要求 Leader 本人进入 Plan，查询团队、收集结果、尝试受限制的派工/发消息，然后提交自己的计划。完整用户输入见 [主聊天历史](evidence/final-after-refresh.json)和 [刷新后 AX](screenshots/11-leader-final-after-refresh.ax.txt)。

| 检查 | 实际操作与判定 | 证据 |
| --- | --- | --- |
| 两个成员进入 Plan | 两者均真实调用 enter → 在返回目录写 markdown → exit；各产生一条 `plan_approval`，同时 pending | [pending](evidence/pending.json)、[工具调用/结果](evidence/tool-evidence.json)、[双成员待处理](screenshots/01-two-plan-pending.jpg) |
| 请求直接到用户 | 两张成员卡分别显示 Plan 通知；Leader 无成员审批底部卡。此时 Root inactive，Leader history 没有成员 exit 调用；后续成员完成通知与 collect 属正常结果处理 | [pending](evidence/pending.json)、[计划详情弹窗](screenshots/02-reviewer-plan-detail.jpg) |
| pending 刷新恢复 | 两个计划仍 pending 时刷新页面，重开面板，两个通知均可恢复和操作 | [刷新截图](screenshots/03-pending-after-refresh.jpg) |
| 成员继续讨论/拒绝执行 | tester 计划点击 Continue Discussion，填写 `QA1029_DECLINE_NOTE`，要求不执行、不再提交。Ledger 为 declined；原成员 exit 的工具结果包含准确批注，最终报告拒绝，未创建标记且只提交一次 | [填写批注](screenshots/04-tester-decline-with-note.jpg)、[拒绝历史](screenshots/05-tester-declined-history.jpg)、[工具证据](evidence/tool-evidence.json) |
| 成员批准执行 | reviewer 点击 Execute Plan，ledger 为 approved，原成员 exit 返回已批准；后续先 todo_write 再请求写入标记 | [批准历史](screenshots/06-reviewer-approved-history.jpg)、[决定后状态](evidence/after-plan-decisions.json) |
| 文件权限仍独立生效 | reviewer 获批后另产生 write_file 权限卡；核对路径/内容后点击 Allow once，真实文件生成。Plan 批准没有直接放行该工具 | [文件授权](screenshots/07-approved-plan-write-permission.jpg)、[最终文件及 ledger](evidence/final-after-refresh.json) |
| Leader 进入与退出 Plan | Leader 真实 enter，写 `QA1029 LEADER APPROVAL` 计划并 exit；普通底部显示完整计划。点击 Execute Plan，再通过普通文件权限卡 Allow once，生成 Leader 标记 | [Leader Plan 卡](screenshots/09-leader-plan-card.jpg)、[文件权限卡](screenshots/10-leader-write-permission.jpg)、[最终聊天](screenshots/11-leader-final-after-refresh.jpg) |
| Plan 下只读查询 | Leader 已 enter 后调用 team_inspect、team_collect，真实 finished 事件均 ok:true，返回名单及已有结果 | [运行中原始事件](evidence/leader-plan-pending.json)、[摘录](evidence/tool-evidence.json) |
| Plan 下写操作边界 | 同轮尝试 team_delegate、team_send_message，均返回 plan_mode_violation；最终仍仅两项原任务、零普通消息，没有触发新成员执行 | [运行中事件](evidence/leader-plan-pending.json)、[终态](evidence/final-after-refresh.json) |
| 已处理历史刷新恢复 | 最终刷新后面板保留 approved / declined / allowed；打开 declined 详情仍有完整计划、批注及处理时间，无再次裁决按钮 | [最终历史](screenshots/12-history-after-refresh.jpg)、[拒绝详情](screenshots/13-declined-detail-after-refresh.jpg)、[对应 AX](screenshots/13-declined-detail-after-refresh.ax.txt) |

“拒绝”路径实际使用现有 Continue Discussion 操作，对应 `continue_planning`，不是另一个独立的永久拒绝按钮。测试指令要求成员收到该决定后结束；没有测试继续修改计划、再次提交的新一轮流程。

### 实际文件效果

以下均在 release-app 内，通过只读文件检查核实，不以模型的完成说明代替：

| 相对路径 | 最终结果 |
| --- | --- |
| `out/QA1029-reviewer-approved.txt` | 存在，内容严格等于 `QA1029_REVIEWER_EXECUTED` |
| `out/QA1029-tester-declined.txt` | 不存在 |
| `out/QA1029-leader-approved.txt` | 存在，内容严格等于 `QA1029_LEADER_EXECUTED` |

三份完整计划保存在 `.pilotdeck/plans/qa1029-reviewer.md`、`qa1029-tester.md`、`qa1029-leader.md`，报告副本见 [plan-files.json](evidence/plan-files.json)。

### 交互身份

下表均属于上述同一 Root / activation / stopVersion，完整 owner、requestId、快照、创建及处理时间见 [最终核对](evidence/verification.json)。

| 交互 | interaction ID | 最终状态 |
| --- | --- | --- |
| reviewer Plan | `8542dd94-6dc8-4387-a3c0-122b1c763c84` | approved |
| tester Plan | `d87d1d9e-4c78-444e-a971-cefaca03d19a` | declined |
| reviewer write_file | `3e4324f0-96b4-455c-bdce-7a722358fa59` | allowed |

Leader 自身交互沿用普通会话通道，不混入成员 ledger。最终截图展示成员各自保留的结果：

![刷新后的成员 Plan 处理历史](screenshots/12-history-after-refresh.jpg)

## 对旧报告的更新与覆盖边界

[10/28 报告](../2026-10-28-team-interaction-rerun/README.md)中的两项 Plan 问题，本轮在已加载修复的真实服务上均未再出现：成员能实际调用 enter / exit；Leader Plan 下 inspect / collect 可用。旧报告作为旧版本记录保留，不改写当时的失败证据。

- **F044：本次 Plan 主流程通过。** 两名成员独立请求、完整计划、批准/继续讨论、准确批注、实际执行/不执行、Leader 不代答均已覆盖。
- **F045：仅补足 Leader 自身 Plan 授权回归，整项保持部分覆盖。** 未在 Plan pending 时停止 Team 或重启 Gateway，也未重测普通非 Team 会话的 Plan；不继承其他日期的权限/问题结果冒充此次 Plan 失效覆盖。
- **Case 14A：补足 Plan 通知、详情、处理历史、pending 与 handled 刷新恢复。** 未重跑全部只读聊天、分页、真实断线/重连、跨 activation 旧事件、并发响应/响应丢失、错误 owner、503/长错误、键盘焦点及移动端/浅色/语言组合。当前截图为桌面深色英文界面、中文计划正文。
- 未尝试 Leader 拒绝分支；成员已覆盖 Continue Discussion，未覆盖重新规划并再次提交。未对未配备 Plan 工具的角色重做负向测试。
- 其他旧问题不属于此次 Plan 定向复验，不据此宣称已修复。F060、F063 仍按用户要求排除。

## 收尾与证据复核

[verify.mjs](scripts/verify.mjs)仅核对已有证据和文件，不提交任务、不响应请求；运行结果 [verification.json](evidence/verification.json)的 19 项断言全部通过。它核对真实 enter 结果、批准/批注到达原成员、目标文件、拒绝后未重提、Plan 查询/写操作边界、终态与基线 hash；页面表现另由 Computer Use 截图及 AX 证明。

最终 Root 无 active turn，两成员均结束、两项 work 均 completed，三条交互均已处理，无 pending。两个关键源码与 UI index hash 与本次基线一致。测试配置和记录保留供查看，服务继续在 3002 运行。本次只新增报告、证据及验收文档的 Plan 前置条件和报告链接，未实施产品修复。
