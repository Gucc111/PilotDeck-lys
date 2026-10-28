# Team 人类交互面板与成员只读聊天：实现验证报告

本轮已实现 Teammate 的工具权限、用户问题和 Plan 授权直接交给用户；新增“团队交互”面板，保留未处理和已处理记录，并提供成员只读流式聊天。**后端与协议测试、前端相关测试、受控浏览器测试及两端构建通过。2026-10-28 后续修正过期测试后，全量前端类型检查也已通过。**

验证基于当前未提交工作区，基准提交为 `3bdbeae966dd0b432e5885aa0b38ecd2fec36a38`。测试期间没有重启用户的 `pd` 服务或修改 `~/.pilotdeck` 配置；没有调用外部真实模型，也没有重跑 Case 01–20。因此本报告是本次实现的分层验证，不能替代真实模型的完整使用验收。此前报告仍对应各自版本。

## 功能与证据

| 用户会遇到的场景 | 本次结果及证据 | 验证边界 |
| --- | --- | --- |
| 两位成员分别需要工具授权 | 请求进入各自的团队交互卡片；允许和拒绝只作用于原成员。会话工厂测试检查实际工具副作用；浏览器检查两成员通知、按钮和处理历史 | 工具/会话链路使用确定性模型替身；浏览器 API 使用 mock，未运行外部模型 |
| 成员提问或提交 Plan | 多选答案、取消、批准执行、拒绝执行送回原成员；计划内容和结果保留。Leader 的自身问题仍走普通会话通道 | 有后端真实工具等待/响应闭环及前端卡片测试；没有真人模型自主提问的验收 |
| 错误聊天/成员回答、重复点击或响应丢失 | 校验完整 owner 字段；并发响应至多消费一次；处理结果落盘失败后的重试不再次消费等待句柄 | Runtime/Gateway 自动化覆盖；浏览器只验证提交字段和失败界面，不负责证明服务端拒绝 |
| 刷新、停止、Gateway 重启 | 交互记录持久化；Team 停止后 pending 取消，Gateway 重启后失效请求过期，历史保留且不能继续执行 | 后端隔离实例完成恢复/失效测试；浏览器刷新从模拟 API 重读，未重启用户服务 |
| 查看成员工作过程 | 只读 URL 恢复 transcript 与当前流式内容；没有 Composer 或普通会话操作；根会话 watch/unwatch 随路由生效；旧运行帧不覆盖当前内容 | 后端验证持久化/流式块合并，浏览器验证订阅和渲染；完整浏览器→真实 Web bridge 网络链路尚未实测 |
| 普通通信和普通会话 | Teammate 同伴消息继续经 Leader relay；成员人类请求不进入 Leader 普通 Banner；普通 Leader 交互保持原路径 | 运行、prompt、Web bridge 和普通交互组件回归通过 |
| 移动端或长内容 | 桌面/390px 移动端、深浅主题、中英文下卡片可用；长 Plan、长响应错误可读，已处理卡无操作按钮 | 使用真实组件和受控数据；附 16 张截图 |

主要后端证据见 [76 项测试日志](logs/backend-tests.tap)；浏览器操作、截图和限制见 [浏览器验证报告](browser-validation.md)与[结果 JSON](browser-results.json)。

## 执行结果

| 检查层 | 结果 | 覆盖或限制 |
| --- | --- | --- |
| 后端构建：`npm run build` | 通过 | 编译当前后端和测试源码 |
| Runtime / 成员 stream / Gateway 会话工厂 / prompt | **76 / 76 通过** | [完整 TAP](logs/backend-tests.tap)，含权限副作用、问题/Plan 响应、owner/幂等、ledger恢复和普通通信回归 |
| Gateway 传输及既有命令回归 | **9 / 9 通过** | `team-human-interaction-transport`、`team-command`、`team-remote-generation`；Remote/Browser 客户端通过真实 localhost 认证 WebSocket 调用两项新 RPC 并接收专用事件；服务端 handler 为受控替身 |
| 前端及 Web bridge Vitest（9 个文件） | **74 / 74 通过** | Team hook/面板/只读路由、普通权限与问答、消息渲染、Web bridge、两项专用 HTTP action、只读路由 watch/unwatch |
| Chromium 受控浏览器 | **7 / 7 通过** | 4 种主题/视口组合、三类交互、失败状态、历史、只读 URL、流式订阅恢复；无页面运行异常 |
| 前端生产构建：`pnpm --dir ui run build` | 通过 | [构建日志](logs/ui-build.log)；仍有大 bundle 提示 |
| 全量前端类型检查 | **通过（2026-10-28 后续修正）** | `pnpm --dir ui run typecheck` 退出码 0；删除引用已移除停止逻辑的旧 `.test.ts` 草稿，将有效回归断言并入现有 `.test.tsx` 测试 |

后续修正未修改运行代码，也未通过排除测试绕过类型检查。原 `.test.ts` 文件被 Git 的 `*.test.ts` 草稿规则忽略，但仍在 TypeScript 的 `src` 检查范围内。现有 `useChatRealtimeHandlers.test.tsx` 新增停止确认、迟到的旧回合确认、非终止错误和“状态未知时经过 10 秒也不能自动解锁”的断言；执行 `pnpm --dir ui exec vitest run src/components/chat/hooks/useChatRealtimeHandlers.test.tsx`，**25 / 25 通过**。这次定向回归单独计数，不改写上表此前的 74 项测试或浏览器运行结果。

后端测试命令：

```sh
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/team/runtime.spec.js \
  dist/tests/team/participant-stream.spec.js \
  dist/tests/gateway/team-runtime-session.spec.js \
  dist/tests/gateway/team-prompt-generation.spec.js

node --test --test-force-exit --test-timeout 60000 \
  dist/tests/gateway/team-human-interaction-transport.spec.js \
  dist/tests/gateway/team-command.spec.js \
  dist/tests/gateway/team-remote-generation.spec.js
```

前端相关测试命令：

```sh
pnpm --dir ui exec vitest run \
  src/components/team-runtime \
  src/components/chat/view/subcomponents/PermissionRequestsBanner.test.tsx \
  src/components/chat/tools/components/InteractiveRenderers/AskUserQuestionPanel.test.tsx \
  src/components/chat-v2/SubagentDetailMessageFlow.render.test.tsx \
  server/pilotdeck-bridge.sending.test.js \
  server/routes/team-library.test.js \
  --reporter=json \
  --outputFile=../docs/testing/reports/2026-10-28-team-human-interactions/ui-results.json
```

浏览器命令：在 `ui` 目录执行 `pnpm exec playwright test -c e2e/team-interactions.config.mjs`。测试启动的独立 Vite 服务已关闭。76 项后端测试、[74 项 UI/Web bridge 测试](ui-results.json)、UI 构建和浏览器原始结果已保存；9 项传输测试计数来自本次终端执行记录。

## 未由本报告证明的内容

- 外部真实模型是否主动发起所需权限、问题和 Plan，以及接收用户决定后是否正确完成业务任务。
- 完整生产页面通过真实 Web bridge 网络连接同时展示多成员请求、浏览器真实断线再连接，以及服务进程重启的联合流程。现有证据分别覆盖后端会话/存储、真实 Gateway WebSocket 契约、Web bridge 单测及受控浏览器。
- 本轮没有 Case 01–20 的新通过率。Case 14/14A 的操作和证据要求已更新，应按新功能继续真实使用验收。
- Case 19 F060、Case 20 F063 经进一步调研和用户确认不是缺陷，本期排除；没有把它们作为本次修复目标或验收结论。运行既有生命周期自动化回归不改变这一范围。

## 文档同步

[Team 使用说明](../../../team-mode.md)描述新入口、直接向用户的交互、只读聊天和恢复行为；[端到端用例](../../team-mode-e2e-acceptance.md)的 Case 14 / 14A 包含双成员、各类响应、错误归属、历史和只读恢复的操作及证据字段。研究模块 02–06 和用户功能清单明确区分 DSH 参考与 PilotDeck 当前实现，不把 DSH 的分层审批、动态权限或治理 UI 当作本轮已实现功能。
