# Anthropic Prompt Cache TRD

## 文档状态

已确认。适用范围：Gateway/AgentLoop 到 Anthropic Messages provider 的请求边界。

## 代码边界

- `src/context/cache/CachePlan.ts`：计算 provider-boundary 缓存计划和稳定 fingerprint。
- `src/context/DefaultContextRuntime.ts`：根据实际协议和模型能力生成计划，并在压缩后递增 generation。
- `src/model/providers/anthropic/request.ts`：将计划转换为 Anthropic `cache_control` marker。
- `src/router/RouterRuntime.ts`：provider/model 路由变化时丢弃不匹配的旧计划。
- `src/model/protocol/canonical.ts`：定义不写入 transcript 的 `CachePlan`。

## 核心契约

1. 只有实际 `protocol === "anthropic"` 且模型声明 `supportsPromptCache === true` 时启用缓存。
2. 默认布局必须是 `system + recent3`：system prompt 一个断点，投影后最后三个非 system message 各一个断点。
3. recent3 按消息位置选择，不过滤未完成 tool call、tool result、permission 或 elicitation 消息。
4. 默认不为 tool schema 添加断点；显式 `cachePlan.tools === true` 仍兼容，并将消息断点限制为两个。
5. 所有 marker 使用 `ttl: "5m"`，单请求最多四个断点。
6. `cache_control` 只允许出现在 provider request，禁止写入 canonical transcript。
7. system、tool schema、provider、model 或 recent3 内容变化时 fingerprint 必须变化；压缩或路由切换不得复用旧计划。

## 正常与恢复流程

- 新会话先缓存 system；有消息时再按 recent3 标记消息。
- 每次投影后重新计算计划；消息被裁剪、微压缩或完整压缩后递增 generation。
- Router 将请求切换到不同 provider/model 时清除旧计划，当前请求无缓存降级。
- 非 Anthropic provider 或不支持缓存的模型继续发送普通请求，不产生缓存 marker。

## 测试映射与证据

- `tests/context/cache-plan.spec.ts`：recent3 选择、fingerprint 和关闭条件。
- `tests/context/cache-runtime.spec.ts`：DefaultContextRuntime 的协议门控、投影截断和 generation。
- `tests/model/request/anthropic-cache-plan.spec.ts`：system/recent3、5m TTL、tools 兼容和四断点上限。
- `pnpm run build`：编译后的 provider/request 入口可用。
- ModelBest 或 Anthropic 真实命中率属于 external smoke/nightly，不作为离线单测证据。

## 限制与变更记录

- TTL 当前固定为 5 分钟，未新增配置字段。
- 2026-08-24：移除按完整 tool transaction 生成断点的旧 `CachedMicroCompactionEngine`，改为严格 `system + recent3`。
