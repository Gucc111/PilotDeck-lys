# Team 消息顺序修复验收报告

执行日期：2026-11-07  
代码目录：`/Users/gucc1/Codes/work/modelbest/PilotDeck-lys`  
验收目标：验证 Leader 与 Teammate 在忙时接收 Team 消息、批量注入、实时流式输出、刷新恢复及只读成员聊天中的消息顺序。

本报告只记录本次真实执行的结果。自动化测试通过不等于真实模型任务交付通过；页面显示 queued、accepted 或 input_accepted 也不单独证明消息已经被模型消费。

## 1. 验收环境

- Web UI：`http://127.0.0.1:3002`
- Gateway：`ws://127.0.0.1:18789/ws`
- 服务会话：tmux `pd`
- 测试项目工作区：`/Users/gucc1/Codes/team-mode-acceptance/release-app`
- Team：`E2E统一模型消息顺序验收团队-20261107`
- Team ID：`461d4957-3601-4f10-a5f7-db0d1278c7c2`
- Root session：`web:s_e56ecd4b-508e-4c69-af31-5b55f085949c`
- Activation：`bc05e23e-5bf2-48d9-8e28-05e34ad38523`
- Stop version：`0`
- Transcript：`/Users/gucc1/.pilotdeck/projects/Users-gucc1-Codes-team-mode-acceptance-release-app/chats/web:s_e56ecd4b-508e-4c69-af31-5b55f085949c.jsonl`

本次实际使用的模型配置：

- Leader：`llmcenter-openai/glm-5.3-mb`
- Teammate：`llmcenter-openai/deepseek-v4.1-flash-mb`

参与者：

| 角色 | display name | participant ID |
|---|---|---|
| Leader | Leader | `e45eee88-57ce-439e-826f-25f66721eed5` |
| Teammate A | E2E顺序测试员A | `09b15aa8-a414-4e0c-b473-dfaa0642e9ff` |
| Teammate B | E2E顺序测试员B | `d09907c9-c179-4275-b70b-d67df31594d5` |

## 2. 自动化检查

以下检查均通过：

```bash
npm run build
pnpm --dir ui typecheck
pnpm --dir ui exec vitest run src/stores/sessionTimeline.test.ts
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/session/transcript-ordering.spec.js \
  dist/tests/team/participant-stream.spec.js
pnpm --dir ui build
```

结果：

- 后端 Team/transcript 定向测试：7 个通过。
- 前端 `sessionTimeline.test.ts`：14 个通过。
- 前端全量 TypeScript 检查通过。
- 前后端构建通过。
- UI 构建只有已有的 Browserslist 和大 chunk 警告，没有构建失败。

这些检查覆盖了写入队列、旧 transcript 读取、Team participant 流合并、前端时间线排序等代码路径，但不能替代真实浏览器和真实模型验收。

## 3. 真实浏览器验收结果

### 3.1 第一轮：Leader 运行期间接收两名 Teammate 消息

任务标识：`ORDER_E2E_20261107`

操作过程：

1. 在 Leader 页面发起任务，要求 A、B 分别先发送唯一标记的进度消息，再读取真实项目文件，最后发送唯一标记的结论。
2. 两名 Teammate 真实读取 `release-app` 项目文件。
3. Leader 在成员执行期间继续接收成员消息，并发送补充指令。
4. 在任务完成后刷新 Leader 页面，核对页面和 transcript。

实际出现的消息关系：

```text
Leader → B / Leader → A：任务分派
A → Leader：PROGRESS-A
B → Leader：PROGRESS-B
A → Leader：CONCLUSION-A
B → Leader：CONCLUSION-B
Leader → B：补充指令
B → Leader：CONCLUSION-B2
```

结果：**通过**。

证据：

- 页面中旧输出、Team 消息和补充指令按处理顺序显示，没有把批次后的新消息放到最顶部。
- 刷新 Leader 页面后，消息仍然存在且顺序保持。
- transcript 中顶层 `sequence` 和 `transcriptOrder` 均为 `1..53`，无重复、无回退。
- Team 消息可以通过 `teamBatchId`、`teamEventIds`、`teamTurnOrigin` 与对应回合关联。

截图：

- [注入前](screenshots/leader-before.png)
- [发送后](screenshots/leader-after-send.png)
- [成员仍运行时的页面](screenshots/leader-injected-before-release.png)
- [完成后](screenshots/leader-after-complete.png)
- [刷新恢复后](screenshots/leader-after-refresh.png)

### 3.2 第二轮：两批 Team 消息和 Teammate 忙时注入

任务标识：`ORDER_E2E_2_20261107`

第一批实际时序：

```text
10:25:29.432 Leader → A：任务指令
10:25:31.053 A → Leader：PROGRESS2-A-20261107
10:25:34.358 A → Leader：CONCLUSION2-A-20261107
10:25:37.482 Leader → B：任务指令
10:25:39.186 B → Leader：PROGRESS2-B-20261107
10:25:42.007 B → Leader：CONCLUSION2-B-20261107
```

第一批结论：**部分覆盖**。

A 已于约 `10:25:36.452` 结束，B 的进度消息约在 `10:25:39` 创建。因此，这一批没有严格满足“ A 仍在运行时 B 发消息”的条件，不能把它作为该条件的通过证据。它仍证明了两名成员的消息能够落盘、展示和恢复。

第二批实际时序：

```text
10:26:55.063 Leader → A：SUPP2 指令
10:26:57.283 A → Leader：SUPP2-PROGRESS-A-20261107
10:27:04.941 Leader → B：SUPP2 指令
10:27:06.621 B → Leader：SUPP2-PROGRESS-B-20261107
```

此时 A 的回合仍处于运行状态，Team runtime 显示：

```text
participant: E2E顺序测试员A
turnId: c3f0cc9d-20c3-476f-a2c3-9595e30d1b21
status: waiting_approval
```

B 随后完成并发送：

```text
SUPP2-CONCLUSION-B-20261107
```

第二批结论：**忙时注入时序通过；B 的第二批业务执行通过**。

这说明在 A 仍处于运行/等待状态时，B 的新消息可以进入当前 Team 运行，并且页面和落盘数据能保持消息身份和批次关系。A 之后触发了 `bash` 工具权限请求，并通过 Team 交互面板允许；该处理历史仍保留为：

```text
participant: E2E顺序测试员A
kind: tool_permission
toolName: bash
status: allowed
```

### 3.3 第二轮未完成部分：模型服务错误

A 的后续模型请求失败，错误为：

```text
服务器内部错误: Retries exhausted: 2/2
```

Leader 最终汇总请求也收到同类错误。transcript 中可见：

```text
event: model_request_failed
provider: openai
modelErrorCode: api_error
providerMessage: Retries exhausted: 2/2
```

因此第二轮不能标记为完整业务流程通过：

- 第二批忙时注入：通过。
- B 的第二批真实执行和结论：通过。
- A 的最终结论：被模型服务错误阻塞。
- Leader 的最终汇总：被同一模型服务错误阻塞。

该错误属于本次使用的 `llmcenter-openai/glm-5.3-mb` 请求链路失败证据，不能归因于消息排序修复，也不能用页面中已出现的进度消息替代最终业务结果。

### 3.4 刷新恢复和 transcript 顺序

第二轮 transcript 当前共有 112 条记录。检查结果：

- 顶层 `sequence` 为 `1..112`，全部唯一且连续。
- `transcriptOrder` 为 `1..112`，全部唯一且连续。
- 关键 Team 消息均带有回合、批次和事件关联信息；刷新后没有丢失或重复。
- 页面刷新后，之前已经显示的 Team 消息和模型错误仍然可以读取。

截图：

- [第二轮发送前](screenshots/second-before-send.png)
- [第二轮完成后](screenshots/second-after-complete.png)
- [第二轮刷新恢复后](screenshots/second-after-refresh.png)

## 4. Teammate 只读聊天和 Team 交互历史

本轮另外检查了两名 Teammate 的只读聊天入口：

- A 的历史 transcript 可以打开并刷新恢复。
- B 的历史 transcript 可以打开并刷新恢复。
- 只读视图没有 Composer、textbox、Send、Stop、模型选择等普通会话操作。
- 返回 Team 主视图后，Team 交互面板仍然可以打开。
- A 的工具权限历史仍在 Team 交互面板中，没有转移为 Leader 普通会话的权限卡片。

结果：**通过**。

截图：

- [Teammate A 只读聊天](screenshots/teammate-a-readonly.png)
- [Teammate B 只读聊天](screenshots/teammate-b-readonly.png)
- [Team 交互面板中的已处理历史](screenshots/team-interactions-handled.png)

## 5. 尚未完成或未执行的场景

以下场景本次没有足够证据，不能标记为通过：

| 场景 | 状态 | 原因 |
|---|---|---|
| Leader 严格忙时注入复现两次 | 部分覆盖 | 第一轮成功，第二轮第一批中 A 已结束后 B 才发送；第二轮第二批满足忙时条件 |
| Teammate 严格忙时注入复现两次 | 部分覆盖 | 已验证 A 处于运行/等待时 B 消息到达，但没有完成两次同条件复现 |
| A 最终结论和 Leader 最终汇总 | 阻塞 | `Retries exhausted: 2/2` |
| Gateway 重启后恢复 | 未执行 | 本轮没有实际重启 Gateway |
| 深色主题专项 | 未执行 | 未保存专项截图和结果 |
| 浅色主题专项 | 未执行 | 未保存专项截图和结果 |
| 移动宽度专项 | 未执行 | 未保存专项截图和结果 |
| 两批连续注入的完整模型消费顺序 | 部分覆盖 | 第二批注入和 B 的执行已验证；A 后续模型请求失败，无法完成整轮业务闭环 |

没有将旧报告中的未重跑场景自动算作本次通过，也没有把模型服务失败之后的页面状态解释为完整任务完成。

## 6. 总体结论

本次修改相关的自动化检查全部通过。第一轮真实浏览器场景验证了 Leader 页面在成员消息进入期间的顺序、刷新恢复和 transcript 递增位置。第二轮验证了 Teammate A 仍处于运行/等待状态时，Teammate B 的消息可以进入 Team 运行；B 的第二批工作真实完成，权限处理记录也能保留并在 Team 交互面板中查看。两名 Teammate 的只读聊天能够直接打开、刷新恢复，并且没有普通会话的输入和控制组件。

本次验收尚不能宣称全部端到端场景通过。第二轮中 A 的后续请求和 Leader 汇总请求都被 `llmcenter-openai/glm-5.3-mb` 的 `Retries exhausted: 2/2` 阻塞；Gateway 重启、主题和移动端专项没有执行；严格忙时条件的重复复现次数也不足。后续若继续验收，应优先在模型服务稳定后重跑第二轮 A/Leader 的完整闭环，并补做 Gateway 重启、深浅主题和移动宽度场景。
