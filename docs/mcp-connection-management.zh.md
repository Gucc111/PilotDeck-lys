# MCP 统一连接与调度

Gateway 通过 `McpConnectionManager` 管理普通聊天、Leader 和 Teammate 的实际 MCP 客户端。对话历史和权限仍属于各 Agent；连接与调用调度按 MCP 配置决定。

## 配置和使用

```json
{
  "mcpServers": {
    "browser": {
      "command": "my-browser-mcp",
      "connection": "shared",
      "usage": "serial"
    },
    "database": {
      "url": "http://localhost:3000/mcp",
      "connection": "separate",
      "usage": "concurrent",
      "maxConnections": 3
    }
  }
}
```

- `connection` 默认 `separate`；`shared` 在同一 Gateway 内复用同一有效资源的客户端。不同 MCP ID、凭证、目录、命令或地址不会合并。
- `usage` 默认 `concurrent`；`serial` 对同一资源的工具调用使用 FIFO 队列，即使 Agent 各自持有客户端也要依次调用。
- `maxConnections` 省略表示不限，必须是正整数。`shared` 只能省略或填 `1`。连接建立中、已建立和关闭中均占名额；失败的本地关闭保留名额以便重试。
- 设置页配置连接和调用策略，Team 成员页只授予 MCP 使用能力，并可明确选择“可选 MCP”。普通聊天启用的 MCP 默认必需。
- `perSession` 仅控制为实际 stdio 连接追加临时 `--user-data-dir`，需要 MCP 自身支持该参数；它不再选择共享策略。内置浏览器的输出目录也属于实际连接。
- `concurrencySafe` 继续影响一个 Agent 自身的工具批次，不代替跨 Agent 调度。
- 已删除 `maxPerSessionMcpInstances`；旧配置不限制运行时条目数。已有 MCP 未填写新字段时采用新默认值。

- 分别连接不会自动隔离账号、业务数据或浏览器环境。
- 依次执行只约束单次工具调用，多步操作之间仍可能插入其他 Agent 的调用。

例如两个成员共用浏览器且依次执行工具时，A 填完表单后，B 仍可能在 A 提交前修改页面。如果业务要求完整流程不可穿插，需要业务侧事务、锁或独立环境。

## 执行和生命周期

Team 配置检查只检查配置、工作目录、模型及能力，不启动 MCP。成员执行准备只初始化自己的获授权 MCP，握手与完整分页工具发现成功后，正式连接继续供执行使用。B 启动不会触发 A 或 Leader 的额外握手。

管理器对一个初始化批次同步预留全部所需名额，不占住部分新增资源再等待另一资源。满额保留当前连接，最多等待 120 秒；排队和服务端执行使用独立超时。取消会清除排队；尚未完成的握手所占名额直到实际清理完成才释放。

工具发现失败与合法空列表分别处理；分页完整读取，名称冲突明确失败。必需 MCP 失败阻止模型请求。可选 MCP 缺失在用户状态和模型指令中同时说明。每次模型请求前刷新工具快照；连接代次或能力变化后禁止使用旧定义直接派发调用。

Teammate 结束释放引用；普通聊天和 Leader 随缓存 session 关闭或淘汰、Team 停止释放。停止 Team 只取消和清理本方使用者。最后一个引用释放才关闭物理连接；共享引用仍在时不会误关其他聊天。

设置页显示占用者、等待者和失败阶段。空闲使用者可“释放 MCP 连接”，对应缓存 session 下次执行重建。模型准备或调用期间禁止主动释放；等待可单独取消。取消后的缓存引用也会在下次执行重建。

HTTP 正常关闭尝试 SDK `terminateSession()`，之后关闭本地 transport。远端终止不支持或失败会留下清理诊断，不声称远端 session 已释放。本地关闭失败可重试，不能复用该失败客户端。

串行调用在派发后取消、超时或发生传输错误时，远端可能仍在执行。管理器保留“调用执行状态未知”，阻止后续串行调用。使用者检查实际操作结果后，可以在设置页重置该资源。释放所有引用也不会自动清除未知状态。自动重放仍要求只读或幂等标注，恢复后再次核对标注，写操作不盲目重放。

配置和策略采用准备时的版本。同一资源策略冲突时，新版本等待旧引用释放，仍遵守 120 秒等待。Team 保持全队空闲后下一次用户执行才刷新配置的边界。

## 接口与边界

内部 `mcpManage` RPC 提供 `status`、`cancel`、`release`、`reset`；UI 通过 `/api/mcp/connections` 查询或操作。Gateway `mcp_status` 事件提供 `connecting`、`waiting_capacity`、`waiting_call`、`ready`、`failed`、`unknown`，含使用者、占用者、阶段和重试原因。资源摘要包含敏感配置以防错误合并，但状态和 Team 持久化不包含凭证。

不协调其他 Gateway 或进程，不推测两个不同 MCP 名称背后是否为同一设备。当前功能发现和注册仅保证 tools；不承诺 resources 或 prompts 支持。

## 验证记录（2026-11-03）

构建使用 `npx tsc -p tsconfig.json`、`npx tsc --noEmit -p ui/tsconfig.json` 和 UI 自身 build；没有运行会准备电脑操控图标的根构建脚本。

本次结果：MCP 与 Team 回归 **206/206**，额外配置与会话回归 **54/54**，UI 与保存接口测试 **33/33**；后端和 UI TypeScript 检查通过，UI build 通过（仍有现有的大 chunk 提示）。

自动化分层如下：

1. `tests/mcp/runtime/McpConnectionManager.spec.ts` 使用可控客户端和时钟，覆盖四种策略、共享握手、引用、凭证及目录身份、原子预留、120 秒等待、取消、FIFO、配置版本等待、关闭失败重试、未知状态和重连后的工具快照。
2. `tests/gateway/mcp-connections.spec.ts` 使用实际 stdio 子进程及 Gateway/WebSocket，覆盖共享、完整分页、模型请求工具列表、发现失败、冲突、等待及取消、释放、取消缓存后的重建和超时可重试传播。`tests/mcp/managed-http.spec.ts` 使用实际本地 HTTP MCP 服务验证握手、分页、session DELETE 成功及不支持/失败诊断；Team 回归覆盖普通聊天、Leader 与成员共用实际子进程，以及配置冻结边界。模型由可控测试实现驱动，不能当成真实 provider 验证。
3. 使用隔离 Pilot Home、真实 `llmcenter-openai/deepseek-v4.1-flash` 和本地 stdio MCP 服务，验证两个聊天共用一个进程、每个聊天实际调用 MCP、取消已有缓存引用后再次执行成功；三次成功调用共用一个进程。再验证 `maxConnections: 1` 的空闲占用者不被回收、等待状态可见、UI 可取消；工具发现失败发生在模型请求前。实际浏览器确认等待行禁用释放、取消结果和工具加载失败阶段，失败记录可释放。

保留的精简证据：

- [真实 provider 请求工具名称、Gateway 状态和调用结果](testing/mcp-connection-management/provider-evidence.json)
- [stdio 服务进程、握手、分页及调用起止记录](testing/mcp-connection-management/server-evidence.json)
- [连接满额界面](testing/mcp-connection-management/capacity-wait.png)
- [取消结果和工具加载失败界面](testing/mcp-connection-management/cancel-and-discovery-failure.png)

证据不含模型凭证、用户消息全文或模型答复全文。真实 provider 验证之后还修正了 Gateway 超时错误的可重试字段，以及合并握手期间每个使用者的连接状态；这些改动有对应回归测试。

本次未运行真实 provider 驱动的 Team 全场景、HTTP 故障恢复及所有四种策略组合；这些行为的已有证明来自对应管理器和真实传输自动化测试。没有把可控模型、单元测试或仅启动进程描述为真实模型端到端验收。120 秒精确超时由可控时钟验证。

复现自动化命令：

```sh
npx tsc -p tsconfig.json
node --test --test-timeout 60000 'dist/tests/mcp/**/*.spec.js' 'dist/tests/gateway/team*.spec.js' 'dist/tests/team/*.spec.js' dist/tests/gateway/mcp-connections.spec.js
node --test --test-timeout 60000 'dist/tests/pilot/config/*.spec.js' dist/tests/gateway/active-turn-snapshot.spec.js dist/tests/gateway/browser-use-args.spec.js dist/tests/gateway/gateway-ws-client-disconnect.spec.js dist/tests/gateway/optional-feature-defaults.spec.js dist/tests/gateway/steer-turn.spec.js dist/tests/gateway/dialog-model-selection.spec.js
npx tsc --noEmit -p ui/tsconfig.json
npm --prefix ui test -- src/components/mcp/McpConnectionStatus.test.tsx src/components/settings/configurationRegression.test.tsx src/components/settings/view/extensions/utils/mcpServerForm.test.tsx server/services/mcpConfig.test.js
npm --prefix ui run build
```
