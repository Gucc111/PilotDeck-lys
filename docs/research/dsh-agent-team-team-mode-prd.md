# DSH Agent Team（dsh-agent-team）Team 模式产品调研报告（PRD 式）

> 调研对象：`/Users/gucc1/Codes/third-party/dsh-agent-team`（GitHub `ArmourPiercer1/dsh-agent-team`，`master @ d455a274`，2026-10-12）
> 宿主：DeepSeek Harness（DSH，`@deepseek-ai/dsh`），该仓库是 DSH 的 **Team 模式外部插件**（"DSH Agent Team vNext"）
> 调研日期：2026-10-14
> 文档性质：以产品经理视角对该 Team 模式做的 **逆向 PRD**。所有条目均来自仓库内的冻结设计文档、已合入代码与测试证据；凡"设计文档有、代码未见"或"代码存在、人工验收未跑"的条目都单独标注，不混为已交付。

---

## 0. 阅读指南

| 符号 | 含义 |
| --- | --- |
| **FR-x.y** | 功能需求细则编号（本报告自编，便于引用） |
| ✅ | 代码已实现（有源码 + 单元/E2E 测试或实宿主证据） |
| 🟡 | 代码已实现，但仓库自己登记为"有缺陷/有缺口/人工验收未跑" |
| 📐 | 仅见于冻结设计文档（Architecture / UI Design 20260829），客户端或运行时代码中未发现对应实现 |
| ❌ | 明确不做（Out of scope） |

本报告结构：

1. 产品概述（定位、背景、目标、角色、范围、发布状态）
2. 核心概念与对象模型
3. 端到端用户旅程
4. 功能需求细则（FR-1 ～ FR-16，本报告主体）
5. 非功能需求
6. 已知限制、缺口与欠债登记
7. 版本演进与路线
8. 产品评估（PM 视角的观察）
附录 A 术语表 / 附录 B 关键文件索引 / 附录 C 错误码速查

---

## 1. 产品概述

### 1.1 一句话定位

> 在不修改 DeepSeek Harness 任何源码的前提下（**CORE PATCH BUDGET = 0**），以外部插件形式为 DSH Web 产品提供"**一个 Leader Agent + 0..N 个持久化 Member Agent**"的团队协作模式：用户用 YAML 蓝图定义团队，用"新建团队"面板创建团队，Leader 通过 15 个 `team_*` 工具委派、跟进、收集、消息、审批、治理成员；人类在"团队"标签页中观察全部成员状态、时间线、事件台账，并裁决审批、治理权限。

### 1.2 背景与要解决的问题

该项目是对一个更早的 fork 内 Team 实现（"legacy Team mode"，冻结在 tag `legacy-agent-team-pre-vnext`）的 **重建**。legacy 的核心问题（`docs/migration/legacy-behavior-inventory.md` §0 G1–G7）：

| 编号 | legacy 错误假设 | vNext 纠正 |
| --- | --- | --- |
| G1 | 静态角色 id（`memberId`）同时充当运行时身份 | `templateId` 是静态定义，`instanceId` 是运行时身份 |
| G2 | Team 状态写成 DSH SessionEvent 存在会话日志里 | Team 控制面状态存在独立的 **TeamDomain** sidecar，禁止新增 Team 专用 SessionEvent |
| G3 | 成员 = 可续写的 subagent 激活 | MemberInstance = Team 拥有的独立 Agent + 独立 Session |
| G4 | 当前 cwd 下 `.dsh/teammates/` 文件即团队花名册权威 | 团队身份与 Root Session 绑定；workspace 只是实例的运行位置 |
| G5 | 定义表 / 激活表 / 待审批表全是进程内 Map，重启即丢 | 全部 durable，重启后可精确恢复 |
| G6 | 一个成员定义同时至多一个激活 | 一个模板可产生 0..N 个持久实例，允许并行 |
| G7 | Leader session 就是 Team 实体 | TeamSession 是 Root Session 上的正交绑定，`TeamSessionId = RootSessionId` |

此外 legacy 依赖修改 upstream 源码（session-controller wiring、known-event-types 等），每次 upstream 升级都要三方合并；vNext 把"零 upstream 补丁"定为第一红线。

### 1.3 产品目标与设计原则

来自 Architecture §1、UI Design §1 与 pre-alpha3 设计 §1：

1. **静态定义与动态实体分离**：Blueprint/Template 回答"团队是谁"，TeamSession/Instance 回答"这次跑的是谁"。
2. **与 DSH 普通 Agent 基础设施正交**：不造第二套 LLM runtime / Session / Tool / Preset；只消费公开 seam。
3. **Durable 身份不依赖进程内状态**：进程 cache、live Agent handle、UI store、cwd 都不是权威。
4. **每个运行时可变字段都有明确 authority 与生命周期**：谁能改、在哪个边界改、改到什么范围、是否持久、对 in-flight 还是 future work 生效、是否被 PolicyState / 外部硬策略抑制。
5. **Identity first / Read-effective-first / Provenance visible / No silent fallback**（UI 原则）。
6. **Fail-closed**：任何故障只能缩小 Agent 能力，不能造成权限扩张；安全相关变更 durable-before-ack。
7. **第一人称与聚合控制面分离**：Chat/Trajectory 只显示该 Agent 自己的历史；Team 标签页显示团队聚合控制面；不向 Chat 注入合成事件。
8. **无人值守可运行**：异步委派 + 完成唤醒 + 审批通知 + 幂等 requestToken + 重启恢复。

### 1.4 目标用户与角色

| 角色 | 说明 | 权限（概要） |
| --- | --- | --- |
| **Human User / Operator**（人类操作员） | 在 DSH Web UI 中操作的人。传输层只有"一个 DSH_HOME 一个匿名已认证操作员"，无细粒度身份 | 创建团队、创建/归档/恢复/处置成员、发消息/发任务、裁决所有审批、设置 override/PolicyState、grant/revoke 权限（受 `teamHardEnvelope` 封顶）、确认兼容性警告 |
| **Leader**（LeaderInstance） | Root Session 上的 Leader Agent，= 团队唯一特殊成员 | 15 个 `team_*` 工具；可创建成员、委派、收集、消息、裁决 `leader-approval` / `envelope-mutation`、归档成员、grant/revoke 成员权限（受 `permissionMutationEnvelope` + `teamHardEnvelope` 封顶）；不能裁决 `user-approval`，不能自批 |
| **Member**（MemberInstance） | Leader 创建的持久化成员 Agent，各自拥有 child Session | 按模板 `teamTools` 暴露子集；可报告进度、发消息、请求审批；**永远不是审批 resolver**；不能改自己的权限 |
| **Human Admin** | Alpha.4 权限阶梯顶层 | **本版本无 resolver**（`CONTROL_UNRESOLVABLE_AUTHORITIES = ['human-admin']`），需要 Admin 的审批同步终止为 `authority-unavailable` |

### 1.5 范围

**In scope（vNext 已交付或在交付中）**：团队蓝图（YAML）与目录；团队创建（含兼容性预检、one-shot 上下文交接）；Leader 工具集；成员生命周期；同步/异步工作单元与完成唤醒；团队消息（含中转策略）；进度/活动；控制/审批（含升级、介入面）；能力策略与运行时权限治理（Alpha.2–Alpha.4）；MCP/Skills/模型路由治理；Team UI（创建面板、团队标签页五大区、Dock、设置页）；远程 API（35 方法，v1–v9）；持久化与重启恢复；Root fork 识别；Legacy 只读检视。

**Out of scope（Architecture §2 / UI Design §47 明确不做）**：

```
formal WorkstreamInstance / WorkflowState / 自动工作流推进 / 任务完成自动推断
DAG 调度器 / 路由器驱动的自动激活 / 任意 transition effects
Git branch/worktree 生命周期管理
跨路线强制信息流控制
Blueprint 热升级 / rebind；Blueprint 在线编辑器 + 保存回写
per-member AgentPreset
实例对话克隆；跨 Session live memory/history 搜索
Team 专用 DSH SessionEvent 词汇；core/host/client 补丁依赖
官方私有实验性 Agent Teams runtime 依赖
Global Team Trajectory；向 Chat/Trajectory 注入合成 Team 事件
自动迁移 legacy Team Session
```

### 1.6 发布状态（截至 2026-10-12）

| 项 | 值 |
| --- | --- |
| 稳定基线 | `0.1.0-rc.1`（`origin/stable @ b0e5aeb4`，2026-09-05，人工 + Playwright 验证过的 P0–P9 全量产品） |
| 开发线 | `master` = `0.1.1-alpha.2`（9 个包同版本）；宿主 pin `@deepseek-ai/dsh@0.2.0-rc.2` |
| 已完成阶段 | P0–P9 + T12 生产垂直（GO）、Alpha.1、Alpha.2 能力补全与权限边界加固、exec 自治契约、pre-Alpha.3 重构（PR #37–#50）、Alpha.3 权限生命周期（PR #57–#61）、宿主 0.2.0-rc.2 升级（PR #62）、**Alpha.4 硬治理 PR0–PR7 全部合入**（PR #65–#247） |
| Alpha.4 状态 | **"PR merged = implementation merged"，但"人工验收（Alpha.3 九步权限面人工通过）= NOT_RUN"，阶段关闭 = pending**（plan §7.7 四分法，不得合并表述） |
| 工程规模 | 1575 commits（2026-08-29 → 2026-10-12），9 包 ≈ 2669 源文件，runtime 包 652 文件；全仓 `TODO/FIXME` = 0（欠债全部记在散文登记册，见 §6） |
| 安装 | 一条命令：`pnpm dsh plugin --profile web add github:ArmourPiercer1/dsh-agent-team[#0.1.0-rc.1|#stable]`；预构建产物提交在仓库内，无需 `allowBuilds` |

---

## 2. 核心概念与对象模型

### 2.1 对象图

```text
TeamBlueprintCatalog ──resolve immutable revision──▶ TeamBlueprint@R
                                                      ├─ LeaderTemplate（恰好 1 个，persona 非空）
                                                      ├─ MemberTemplate ×N
                                                      └─ requirements / envelopes / policyStates / quotas / capabilities
            │ TeamIntent（创建前暂态：选蓝图、工作区、预设、兼容性探测、确认）
            ▼
TeamSession（id = RootSessionId；0 或 1 个 / Root Session；绑定不可变 Blueprint snapshot）
  ├─ LeaderInstance（= Root Agent/Session；instanceId 固定 `inst-leader`；无 childSessionId；不可独立归档/处置）
  ├─ MemberInstance ×0..N（instanceId `inst-…`；各绑定 1 个 durable child Session；0/1 个 live Agent 驻留）
  ├─ Admission State（OPEN / BLOCKED_WARNING / BLOCKED_FATAL / DEGRADED_ACKNOWLEDGED）
  ├─ PolicyState（团队级运行治理模式，默认 `default`）
  ├─ Overlays / Human Overrides（分层治理记录）
  └─ TeamLedger（append-only 协调事实台账）
            ▲
       TeamDomain（Team 拥有的 durable sidecar，建在 DSH 公开 StorageDomain 之上；唯一控制面权威）
```

### 2.2 术语速查（详见附录 A）

| 术语 | 一句话定义 |
| --- | --- |
| TeamBlueprint | 可复用、可版本化的静态团队定义（YAML frontmatter 文档）；身份 = `blueprintId@revision` + `contentHash` |
| TeamIntent | 创建前的 Team 拥有的 staging 对象（不是 Session，不进侧栏） |
| TeamSession | Root Session 对一个 Blueprint snapshot 的不可变 Team 绑定 |
| LeaderInstance / MemberInstance | 运行实体；runtime identity = `(rootSessionId, instanceId)`；`label` / `templateId` / `groupId` 都不是身份 |
| contextPolicy | `persistent`（默认，后续工作续用同一 child Session）/ `fresh_per_delegation`（每次新委派创建新实例） |
| groupId | 可选不透明分组元数据，无状态/权限/生命周期语义 |
| Admission | 团队能否接收新 Team work（与成员 lifecycle 分离） |
| Compatibility | Blueprint requirements 与真实环境的匹配结果：PASS / WARNING（可确认）/ FATAL（不可确认） |
| PolicyState | TeamSession 当前运行治理模式，不是任务进度 |
| Autonomy Overlay / Explicit Human Override | Agent 在 envelope 内产生的 overlay vs 人类明确设置的 durable override |
| External Hard Policy | 宿主侧不可越过的上限（任何 Team actor 含人类都不能越过） |
| Residency | 持久化成员当前是否有 live Agent 驻留进程内（resident / resuming / cold），与 lifecycle 独立 |
| Restore vs Resume… | Restore = `ARCHIVED → SETTLED`，不调模型；Resume… = 向 SETTLED 成员发送新工作，可能冷恢复 Agent 并进入 RUNNING |
| requestToken | 每个逻辑操作唯一的幂等 token；同 token 重放 = 零副作用 / 续接同一工作单元 |

### 2.3 架构不变量（节选自 Architecture §42 的 67 条）

- 一个 Root Session 最多一个 TeamSession；`TeamSessionId = RootSessionId`。
- Blueprint 绑定后不可原地替换；snapshot 冻结 Blueprint 语义，不冻结外部环境（模型/工具/MCP 可用性、外部硬策略）。
- Blueprint 必须恰好包含一个完整的 LeaderTemplate。
- 一个 MemberTemplate 可产生 0..N 个持久 MemberInstance；对既有实例的 follow-up 永远续用同一 child Session。
- 成员 lifecycle = `CREATED / RUNNING / SETTLED / ARCHIVED / DISPOSED`；Archive/Dispose 必须先 close admission + quiesce/drain 再提交；Restore 不 resume Agent。
- 默认成员上下文不继承 Leader 全量 transcript 或兄弟 transcript；跨成员信息共享必须显式。
- Human override 可以超过 Team autonomy boundary，但不能超过 External Hard Policy，也不能创造不存在的能力。
- Member 不能 unrestricted self-escalate；Leader/router/automation 永远不能越过 Team envelope。
- Team control-plane durable authority = TeamDomain；禁止新增 Team 专用 DSH SessionEvent。
- Team-wide 顺序来自 TeamLedger，不跨子会话日志按时间戳伪造全序。
- Root fork = 同 Blueprint snapshot + 零 MemberInstance；成员 child fork = 普通独立 AgentSession。
- Existing legacy Team Sessions = READ-ONLY，不自动迁移。
- 缺公开 seam 时输出 `CORE_SEAM_BLOCKER`，不扩大 core patch。

---

## 3. 端到端用户旅程

### 3.1 安装与部署（Operator）

1. 在目标机器 `pnpm dsh plugin --profile web add github:ArmourPiercer1/dsh-agent-team#<ref>`；CLI reconcile 自动把包内 `cordis.patch.yml`（bundle 层）并入 profile。
2. bundle 层插入 3 行并禁用 1 行：`dsh-agent-team`（host 行）、`team-spill-local`（Team 感知的 spill 存储，替代被禁用的 `spill-local`）、`dsh-agent-team-client`（client 行）。
3. 操作员如需定制（真实模型、团队蓝图、默认工作区），在 profile 层写同 `id` 的 **完整** host 行覆盖（整段替换，非字段级 merge）。
4. 启动 `dsh web`；boot 行出现即插件树加载完成；用带 token 的 URL 打开页面，核验四个 UI 入口（侧栏"新建团队"、团队标签页、composer 上方 Team dock、设置页 Team 区段）。

### 3.2 蓝图编写（Operator / 设计者）

1. `node scripts/blueprint-authoring.mjs stage <blueprintId> --dir <blueprintDir>` 生成 `*.draft.yaml`（草稿不进目录）。
2. 在编辑器中编辑草稿（`schemaVersion: 3`，一个 leader + N 个 members，requirements、envelopes、policyStates、quotas、`permissionMutationEnvelope`、`teamHardEnvelope`）。
3. `validate-save` 做格式/身份检查并原子写入 `<blueprintId>.yaml`。
4. 在"新建团队"面板点"刷新蓝图目录"立即可见（目录无缓存、无 watcher，每次查询重扫）。
5. 可用 `curl /team-remote/catalog.get` 做强解析预检（listed-but-unresolvable = 文档逻辑错误）。
6. 改设计 = 新 revision；已绑定团队保持旧 snapshot。

### 3.3 创建团队（Human）

```text
侧栏「新建团队」 ─▶ 创建面板（TeamIntent）
  选蓝图 + revision → 选工作区 → 选运行时预设（切换即重跑兼容性）→ 可选初始任务 → 可选上下文交接（Start Team from Here）
  兼容性：✓ 就绪 / ⚠ 警告（需勾选"我已了解上述降级"）/ ✕ 无法创建（FATAL，按钮禁用）
  [创建团队] 或 [创建并发送] 或 [确认警告并创建]
  ─▶ team.create(v2) 绑定 Root → 打开 Root Session → （有初始任务）team.admitInitialWork → Leader 首轮
```

失败路径：三个阶段（create / open / work）各自可重试；`work` 阶段失败时**团队已创建且 Root 已打开**，面板保留并提示可重试初始任务。

### 3.4 Leader 协作循环（模型侧）

```text
team_list_templates → team_delegate(templateId, label, prompt[, async 默认 true]) → 立即返回 admitted 收据
   成员在 child Session 异步执行 → durable settlement → 系统向 Leader 发送 [team-work-settled requestToken=…] 唤醒
Leader: team_collect([requestToken]) 读取终态结果 → team_follow_up(instanceId, prompt) 续接 → team_send_message 协调
成员遇审批：durable leader-approval 请求 + Leader 收到通知 → team_list_pending_control → team_resolve_control(allow|deny|escalate)
Leader 收尾：team_report_progress / team_archive_member
```

### 3.5 人类观察与干预（Web UI）

团队标签页：顶部刷新/错误条 → 损坏记录警告条（如有）→ **时间线**（Gantt）→ **成员组**（Leader 组 + 模板组 → 实例行 + 操作按钮）→ **治理**（兼容性 / 策略状态 / 生效配置与覆盖 / 治理介入 + 权限管理）→ **活动与进度** → **团队事件**（台账，含待裁决项的详情面板与 允许/拒绝）。composer 上方 Dock 显示 `N 运行中 · M 待裁决` 并可展开。

### 3.6 重启与恢复

宿主重启后：TeamDomain 中的团队与成员全部保留；团队标签页零态可列出"已持久化的团队"并提供"以 Team 模式打开 / 回到 Leader"与"以普通模式打开"；成员不会自动唤醒；未投递的完成/审批通知**不重放**，Leader 用 `team_collect` / `team_list_pending_control` 作为恢复路径。

### 3.7 归档 / 恢复 / 处置

RUNNING 成员归档 → 先中断当前工作、drain 后代、再 durable `SETTLED` → `ARCHIVED`（两次提交）；Restore → `SETTLED`（只恢复可用性）；Dispose → 终态但历史保留。

### 3.8 Legacy 会话

打开旧实现创建的会话 → 团队标签页显示只读 banner 与解码摘要，不提供任何可执行操作。

---

## 4. 功能需求细则

### FR-1 插件装载与宿主集成

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-1.1 | 以 DSH Cordis 组合插件形式交付两个入口：host 半（`packages/runtime/.../plugin/host.js`，导出 `name` + 无副作用 `apply(ctx, config)`）与 client 半（`packages/client/composition-shim`，经 `dsh.client` manifest 被 Web module graph 动态发现）。 | ✅ |
| FR-1.2 | 零 upstream 补丁：不 import 私有 API、不 patch-package、不 vendored 修改副本；不可实现的行为输出 `CORE_SEAM_BLOCKER` 并阻塞。 | ✅ |
| FR-1.3 | 根 `package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml` 与 `dsh.client.platform = web`，使 `dsh plugin add github:` 一条命令安装并登记；安装面产物（`packages/runtime/dist`、`packages/client/composition-shim`）预构建提交，包无生命周期脚本 ⇒ 无需 `allowBuilds`。 | ✅ |
| FR-1.4 | bundle 层 `cordis.patch.yml`：`- id: spill-local, disabled: true`；插入 `dsh-agent-team`（host）、`team-spill-local`（`dsh-agent-team/spill-local`）、`dsh-agent-team-client`（client）。行配置机器无关，不含 file:// 路径。 | ✅ |
| FR-1.5 | profile 层同 `id` 行覆盖语义 = **整段 config 替换**（last-write-wins，非字段级 merge）；省略字段即丢弃。 | ✅ |
| FR-1.6 | host 行配置校验 fail-closed：缺必填字段 → `TEAM_PLUGIN_CONFIG_INVALID`；glue/seam 模块不可解析 → `TEAM_PLUGIN_GLUE_UNAVAILABLE`；公开服务缺失（`agents` / `connection` / `workspaceRegistry`）→ `TEAM_PLUGIN_SERVICE_MISSING`。 | ✅ |
| FR-1.7 | host 行配置键（见下表）。 | ✅ |
| FR-1.8 | Team 感知 spill provider（`team-spill-local`）：公开 `LocalSpillStore` 的严格超集，同一 `spillStore` 服务名、同一 config（`root`、`cleanupPeriodDays` 默认 30）；为受管 Team 会话额外记录 durable **artifact-read grant**（成员在 strict-read 下可读回自己产生的 spill 产物）；非 Team 会话行为与上游逐字节等价。升级时 profile 层旧 `spill-local` 配置不会自动迁移，需改写为 `id: team-spill-local`。 | ✅ |
| FR-1.9 | 插件随包附带 2 个 Skills（`team-leader-operations`、`team-blueprint-authoring`），通过 DSH 公开 `skills` provider registry 注册，rank 550（高于用户目录、低于 DSH 自带）；目录每次 `list()` 重扫；缺失只 warn 不阻塞。 | ✅ |
| FR-1.10 | 注册 4 个客户端扩展槽：`conversation.view`（id `team`，order 20，标题"团队"）、`conversation.input.dock`（id `team`，order 15）、`settings.section`（id `team`，order 50）、`sidebar.footer.action`（id `team-new`，order 10，标签"新建团队"）。显式**不**注册 `conversation.chat.node`（不向 Chat 注入 Team 标记）。 | ✅ |
| FR-1.11 | client 行配置仅 `dshHome?: string`：为空则 legacy 检视面不可用，零态仅显示 vNext 内容。 | ✅ |
| FR-1.12 | 宿主版本门：`peerDependencies` 精确 `0.2.0-rc.2`（master 线）；0.1.0-rc.1 stable 线对应 DSH 0.1.2-rc.1；版本门由宿主真实 evaluator 求值，旧/新版本拒绝。 | ✅ |
| FR-1.13 | host `apply()` 启动顺序（`host.ts`）：① 最前段同步注册会话激活围栏（`agent/created` + `agent/disposed` 全局监听）→ ② 校验 config 并填默认工作区 → ③ 注册 upstream resolver → ④ 校验硬注入服务 `agents / storageDomain / sessions / sessionPersistence / workspaceRegistry` → ⑤ 解析 storage seam 并按 `bootPhase` create / open / create-or-open 打开 TeamDomain → ⑥ 绑定 ownership resolver 到围栏 → ⑦ 构建蓝图权威（saved-source index + 冻结 registry + 行内 anchor）→ ⑧ 加载 live-agent glue → ⑨ 组装 production root（填充 control / permission plane / policy reader / artifact authority 引用）→ ⑩ 挂载 `/team-remote`（`connection` 服务缺席时有界等待）→ ⑪ `boot()`（fresh：写种子 + 创建 Leader agent；resume：冷再水化）。readiness `starting → ready | failed`（失败为终态不重试）。 | ✅ |
| FR-1.14 | bootstrap 失败 → `console.error` 并 **关闭激活围栏**（避免无关会话被挂起）；durable 权限 overlay 启动失败 → `TEAM_PLUGIN_PERMISSION_AUTHORITY_UNAVAILABLE`；权限读面 warm-up 失败不阻塞启动，只 loud 记录，Leader 扩权在重建前被拒（有界恢复）。 | ✅ |

**host 行配置键（`cordis.patch.yml` + `docs/INSTALL.md` §3.2/§3.3）**

| 键 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `bootPhase` | `"create-or-open"`（出厂）/ `"resume"` / `"create"` | `create-or-open`：已有 `team_domain` 则 adopt，否则初始化全新介质（重启安全）；`resume`：严格只加载已有；`create`：严格全新世界（已有 stamp → `TEAM_DOMAIN_EXISTS`） |
| `rootSessionId` | 必填，出厂 `"team-root"` | 行自带的 bootstrap 团队 Root Session id，每个世界唯一 |
| `blueprintSource` | 必填，内联 YAML（literal block，首末 `---`） | 行内 bootstrap 蓝图（出厂为 `my-team-bp-1@1`，schemaVersion 3，1 leader + 1 worker） |
| `blueprintDir` | 可选 | 已保存蓝图源目录（绝对或相对 host 进程 cwd）；缺省 = 文件系统目录禁用，只有内联蓝图可解析 |
| `defaultWorkspace` | 可选，缺省 = `process.cwd()`（`dsh web` 启动目录） | Root 默认工作区；projection fold 要求每个团队行有可解析工作区 |
| `seedMembers` | 必填，出厂 `[]` | 启动时预置成员 |
| `generation` | 必填，出厂 `1` | 环境事实代数 |
| `deniedSelection` | 必填，出厂 `null` | 预设拒绝选择（fail-closed 必填字段） |
| `mcpServers` | `[{ name, port: number|null }]`，出厂 `[]` | 0..N 个 MCP server（streamable-http `http://127.0.0.1:<port>/mcp`）；name 唯一；`port: null` = 只声明不配端口（挂载时 fail-closed 点名） |
| `mcpServer` | legacy 单字段，`{name, port} | null` | 与 `mcpServers` 同时出现时必须为 `null`，否则 ambiguous 拒 |
| `staticModel` | `{ provider, model }`，出厂 `deepseek-official / deepseek-v4-flash` | 部署默认模型；模板无 `modelPreference` 时回退于此 |
| `environmentFacts` | `[{ domain, subject, available, generation }]` | 行声明的环境事实（出厂：tool/web、skill/base、persona/standard） |
| `externalPolicyFacts` | `{ hard: {}, capabilityExists: {} }` | 外部硬策略与能力存在性事实 |
| `glueUrl` / `seamUrl` | 可选 | 显式指定 glue / seam 模块；缺省由 host 入口自身位置推导 |
| `capabilityFacets` | 可选 `Record<string, facetSources>` | capability overlay facet 源集；缺省每个 facet 从空集解析（boot world 中诚实报 `available: false`） |
| `presetSubstrate` | 可选 `{ presetId, personaKind }` | 脚本化测试世界的预设基底事实；生产路径改为 live 观测 DSH `agentPresets` |
| `remoteMountWaitMs` | 非负整数，默认 `30000` | `/team-remote` 挂载等待 `connection` 服务出现的有界窗口（每 100ms 轮询） |
| `rootPresetId` / `memberPresetId` | 可选 | Root(Leader) / 成员 agent 挂载用的 AgentPreset id；缺省 = 部署默认预设 |
| `teamSkills` | 可选 `[{ name, description, content, provider? }]` | 行配置级 Team 管理 skill 定义（与随包 `.agents/skills` 并存） |
| `fixtureWorld` | 可选 boolean，默认 `false` | 仅测试固定场景世界；生产不可达 |

### FR-2 团队蓝图（TeamBlueprint）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-2.1 | 文档形态：恰好一个 YAML frontmatter 记录（`---` 包围），禁止 markdown 正文（`markdown-body-not-allowed`）；BOM 去除、CRLF 归一；YAML 必须干净解码。 | ✅ |
| FR-2.2 | 身份：`schemaVersion`（正整数；**当前仅支持 3**，1/2 定义但退役 → `SCHEMA_VERSION_MISMATCH`，目录中列为 `migration-required`）、`blueprintId`（非空 ≤128，无空白/控制字符/`@`）、`revision`（正整数，惯例写成 `"1"`）。 | ✅ |
| FR-2.3 | 顶层字段闭集（未知字段即拒）：`schemaVersion, blueprintId, revision, displayName, description, leader, members, requirements, teamEnvelope, memberEnvelopes, permissionMutationEnvelope, policyStates, quotas, capabilityPolicy, metadata`；v2 加 `teamRequirements`；v3 加 **必填** `teamHardEnvelope`，且 `permissionMutationEnvelope` 在 v3 变为必填（无隐式默认）。 | ✅ |
| FR-2.4 | 模板字段（leader 与 member 同一 schema）：`templateId`（必填）、`displayName`（≤128）、`description`（≤4096）、`persona`（**必填**非空 ≤32768，允许换行）、`modelPreference`、`contextPolicy`、`capabilities`；v2+ 加 per-template `requirements`。标识符类字段禁止控制字符与空白；散文类字段允许 tab/换行。legacy 字段 `memberId` 在任何深度被拒。 | ✅ |
| FR-2.5 | 硬不变量：恰好一个完整 LeaderTemplate；模板 id 全局唯一；`memberEnvelopes[].templateId` 必须引用已声明模板；requirements `(domain,name)` 唯一；envelope 内 allow/deny 不重叠；policyStates 只引用冻结字段；quotas 正整数且 `maxConcurrent ≤ maxInstances`。校验 all-or-nothing。 | ✅ |
| FR-2.6 | `modelPreference`：`provider/model` 或裸 `model`（继承 `staticModel.provider`）；成为模板静态策略值（低于任何 durable override、高于部署默认）；非法格式拒整份蓝图（`invalid-model-preference`）。team tools 不提供 `model` 参数，运行时改模型走 durable override。 | ✅ |
| FR-2.7 | `capabilities`（存在时四个子字段必填）：`teamTools`（`{kind: allow, items}` 或 `{kind: deny}`）、`builtinToolDeny`（内置工具名数组，只达 global 可限制层）、`skills`、`mcp`（allow 即初始授权，deny/空/legacy = 不挂任何 MCP）；可选 `permissions`。缺 `capabilities` = legacy 模式，继承全部 15 个 team tools。 | ✅ |
| FR-2.8 | `permissions`：`default ∈ {ask, deny}`（`allow` 拒）；三个 lane `allow/ask/deny` 必填数组；`tool ∈ {read, read_image, write, edit, lsp, bash, pwsh}`；`resource.kind ∈ {exact, subtree, any}`。shell 类（bash/pwsh）：exact/subtree 任何 lane 任何角色都拒；`any` 的 allow lane 仅 **Leader 模板**允许（exec 自治契约，运行时双闸），member 模板拒；ask/deny lane 的 `any` 任何角色合法。 | ✅ |
| FR-2.9 | envelope token 语法 `[a-z][a-z0-9._-]{0,127}`；识别两类：团队治理操作（`assign-task, create-member, send-message, report-progress, request-control, resolve-control, archive-member, restore-member, dispose-member`）与 exec 授权 token（`bash` / `pwsh`）；其他 slug 可解析但惰性。成员有效 envelope = `teamEnvelope.allow − deny` ∩ 该模板 `memberEnvelopes` 条目 − instance overlay（fail-closed 交集）。 | ✅ |
| FR-2.10 | `requirements`（v1 平铺 `{domain, name, optional}`；v2/v3 结构化 `{requirementId, type, subjects, complete}`）：type ∈ `tool, skill, mcpServer, modelRoute, persona, teamStructure`；persona 类 subject 必须是 **persona kind**（闭集当前仅 `standard`），不是预设 id。 | ✅ |
| FR-2.11 | `policyStates[]`：`id`（小写 slug ≤64）、`description`、`fields`；简单蓝图只需 `default`。 | ✅ |
| FR-2.12 | `quotas.team` / `quotas.members`：各 `{maxInstances, maxConcurrent}`；**members 配额按模板执行**（每个模板各限 N 实例，`TEAM_RUNTIME_QUOTA_EXCEEDED_TEMPLATE_INSTANCES`），不是全队总量。 | ✅ |
| FR-2.13 | `permissionMutationEnvelope`（Leader 扩权上限）与 `teamHardEnvelope`（Human User 扩权上限）：同一语法 `rules: [{ operationClass, matcher: exact|subtree|fingerprint, maximumEffect: allow|ask|deny }]`；文件类 exact/subtree，shell 类仅 fingerprint，无 `any`；`rules: []` = 该角色无扩权权限（诚实零位）。 | ✅ |
| FR-2.14 | 内容身份 `contentHash` 由校验后内容派生；绑定团队时冻结 `(blueprintId, revision, contentHash)` 进 registry；同身份不同内容再冻结 → `TEAM_BLUEPRINT_REVISION_FROZEN`；已绑定团队首次工作准入时比对 hash，不一致 → `TEAM_RUNTIME_BLUEPRINT_HASH_MISMATCH`。 | ✅ |
| FR-2.15 | 目录（`blueprintDir`）规则：`*.yaml/*.yml` 一文件一 `(blueprintId, revision)`；`*.draft.yaml/*.draft.yml` 忽略；无状态每请求重扫；路径分隔符名拒；同身份两文件 → `TEAM_BLUEPRINT_REVISION_DUPLICATE`（**整个目录查询失败**，见 §6）。 | ✅ |
| FR-2.16 | 蓝图目录三级权威：per-team bound snapshot（最高）→ `blueprintDir` saved sources → 行内 `blueprintSource` anchor。 | ✅ |
| FR-2.17 | 目录检视三态：`ok` / `migration-required`（v1/v2，可列出、不可解析/启动）/ `rejected`（无身份）。 | ✅ |
| FR-2.18 | 本地 authoring 工具链 `scripts/blueprint-authoring.mjs stage | validate-save`（无 Web 编辑器、无 Blueprint CRUD Remote）。 | ✅ |
| FR-2.19 | v1/v2 蓝图不自动迁移；绑定 v1/v2 的团队 start/resume 以 `BLUEPRINT_MIGRATION_REQUIRED` 拒绝（零 agent 创建、无确认路径）；宿主 anchor 为 v1/v2 时宿主 **降级启动**而非死机。 | ✅ |
| FR-2.20 | legacy `.dsh/teammates/*.md` 一次性导入适配器（`packages/legacy/teammates-adapter.ts`，输出新 Blueprint 文档）存在，但 **未接入运行时/UI 入口**。 | 🟡 |

### FR-3 TeamIntent 与团队创建

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-3.1 | 全局入口：侧栏底部"新建团队"（宽模式图标 + 文字，56px rail 仅图标 + 500ms tooltip）；点击打开模态覆盖层（`role=dialog aria-modal`，backdrop 关闭）；**不创建任何 Session**。 | ✅ |
| FR-3.2 | 上下文入口："从此处开始团队"按钮位于普通会话团队标签页零态，打开内嵌创建面板并带入交接源（`handoffSource = 当前会话`）。 | ✅ |
| FR-3.3 | 📐 UI 设计中的第三入口（普通会话 header action "Start Team from Here"）。 | 📐 |
| FR-3.4 | 面板字段 A：蓝图下拉（加载中 / 无蓝图 / 占位"选择蓝图…" / `displayName (rev N)`）+ "刷新蓝图目录"按钮（代数守卫、逐行 detail 重置、所选蓝图消失即重置选择）+ 目录错误块。 | ✅ |
| FR-3.5 | 字段 B/C：蓝图详情（displayName、source、description、模板数）；revision 下拉。 | ✅ |
| FR-3.6 | 字段 D：工作区下拉（默认"默认工作区"；候选来自 DSH workspace 面；从当前会话预填）。 | ✅ |
| FR-3.7 | 字段 E：上下文交接块（仅有交接源时显示）：复选框"生成一次性摘要"（默认勾选）→ `handoff.prepare` → "摘要已就绪 + 预览（title + bullets）"；失败三联"重试 / 不带交接继续 / 取消"；取消为面板内终态。 | ✅ |
| FR-3.8 | 字段 F：运行时预设下拉（AgentPreset，提示"选择团队运行的 Agent 预设；切换会重新运行兼容性检查"）。 | ✅ |
| FR-3.9 | 字段 G：初始任务 textarea（"交给 Leader 的初始任务…"）。 | ✅ |
| FR-3.10 | 字段 H：兼容性状态块，`data-intent-status ∈ none/checking/OPEN/BLOCKED_WARNING/BLOCKED_FATAL/DEGRADED_ACKNOWLEDGED/unknown`：OPEN "✓ 就绪"；WARNING 列出每项 requirementId/不可用 subjects/detail + 确认复选框"我已了解上述降级，继续创建"（**从不默认勾选**，结果变化即重置）；FATAL "✕ 团队无法创建" + 逐项 fatal + persona 专用文案；无 Continue-anyway。 | ✅ |
| FR-3.11 | 主按钮三态：`创建团队` / `创建并发送`（有初始任务）/ `确认警告并创建`；FATAL 或未确认 WARNING 或探测中 → disabled；创建中显示"正在创建…"。 | ✅ |
| FR-3.12 | 创建流程（TCM M4 v2 两阶段）：客户端铸造 root session id → `team.create`（v2，含 `workspace`）→ 打开已创建会话 → 若有初始任务 `team.admitInitialWork`（`requestToken` 幂等）→ `pullProjection` → 关闭面板。 | ✅ |
| FR-3.13 | 错误与重试：错误块标注 `stage ∈ create/open/work`；`work` 失败显示"团队已创建且 Root 已打开；初始任务未投递，可重试"（只重发 admitInitialWork，同 token 同 prompt）；其他阶段显示"Root 会话 ID 已保留…可重试"（从 create 重来，同 root id）。覆盖层只在终端成功时关闭。 | ✅ |
| FR-3.14 | TeamIntent 不进侧栏、不切换 Chat/Trajectory、不伪造 SessionId；仅真实 Root Session 创建后才出现侧栏行。 | ✅ |
| FR-3.15 | 创建时工作区绑定：`team.create` v2 的 `workspace` 必须是 **已注册** 工作区路径（不存在或未注册 → `TEAM_PLUGIN_WORKSPACE_NOT_FOUND`，不会代为创建工作区）；attach 失败 → `TEAM_PLUGIN_WORKSPACE_ATTACH_FAILED`。 | ✅ |
| FR-3.16 | 创建侧 preflight：`team.create` 内重新 resolve 蓝图并重评 requirements（`enforceCreationPreflight`）；v3 治理一致性门 `checkGovernanceStart → open | warning-required | corrupt | migration-required`，位于 durable bind 之后、`startRootAgent` 之前；`warning-required` 时 Root 存在但不 live，确认后经同一门重入；`corrupt` 不可确认。 | ✅ |
| FR-3.17 | 📐 UI 设计中的"蓝图自选中后目录 revision 变化提示（Use rev18 / Keep rev17 / Review）"、"AgentPreset 切换窗口（Root 无 turn 且无成员 provisioning）"。 | 📐 |
| FR-3.18 | Leader / 成员身份安装：蓝图 `leader.persona` / 模板 `persona` 经 `PersonaOverlaySlot` 以 scoped 方式安装到该 agent scope 的公开 `deployment:persona` system-prompt 段（与所选运行时预设的可组合 persona 叠加）；预设 persona 为 `complete:true` 时为结构性 FATAL，不做任何绕过。 | ✅ |

### FR-4 兼容性与准入（Compatibility / Admission）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-4.1 | Requirement 类型闭集 `tool, skill, mcpServer, modelRoute, persona, teamStructure`；未知类型 `MALFORMED_DTO`。 | ✅ |
| FR-4.2 | 结果：全部可用 → `PASS`；`complete:true` 未满足 → `FATAL`（persona 类 → `TEAM_PERSONA_COMPLETE_PRESET_CONFLICT` / `PERSONA_INCOMPATIBLE`；其他 → `COMPLETE_REQUIREMENT_NOT_MET`）；`teamStructure` 不可用 → FATAL `STRUCTURAL_CAPABILITY_MISSING`；普通类不可用 → `WARNING`（`CAPABILITY_UNAVAILABLE`）。 | ✅ |
| FR-4.3 | Admission 状态：`OPEN` / `BLOCKED_WARNING`（有未确认警告）/ `BLOCKED_FATAL` / `DEGRADED_ACKNOWLEDGED`（警告均已有效确认）。 | ✅ |
| FR-4.4 | 确认（ack）绑定 `requirementId + mismatchFingerprint + environmentFingerprint`；判定 `VALID / STALE / MISSING`；环境代数漂移后旧确认不覆盖新问题；FATAL 永不可确认。 | ✅ |
| FR-4.5 | 指纹 `fp-v1:<8hex><8hex>`（两次 FNV-1a over canonical JSON）；`NO_PROBE_GENERATION = -1` 区分从未探测。 | ✅ |
| FR-4.6 | 环境事实合并：persona 域 **只取 UI 上报**（所选预设的 persona kind），其他域只取行配置 `environmentFacts`。客户端用静态 id 表 `PRESET_PERSONA_KIND_ROSTER[row.id] ?? row.id` 推 persona kind ⇒ **自定义预设 id 被当成自己的 id 上报，必然 FATAL**（已登记缺口）。 | 🟡 |
| FR-4.7 | 含必需非 persona 需求（如 `mcp`）的蓝图经 **UI** 创建时，客户端不构造这些域的事实 ⇒ 判 unmet ⇒ FATAL ⇒ 创建按钮永久禁用（REPORT T1.4，用户裁决仅记录）；行配置路径不受影响。 | 🟡 |
| FR-4.8 | 门范围：有未处理 warning/fatal 时阻止新 Team work 准入（Root 新 prompt、新 delegate/create、新 follow-up、SETTLED 成员新工作）；**不回滚** in-flight 工作。 | ✅ |
| FR-4.9 | 重探测触发闭集 `ROOT_COLD_RESUME / MEMBER_COLD_RESUME / NEW_ACTIVATION / CAPABILITY_GENERATION_CHANGE / STALE_GENERATION_BEFORE_NEW_WORK`（`compatibility.reprobe`）。 | ✅ |
| FR-4.10 | pre-Alpha.3 能力五层模型：Policy（allowed/denied）/ Requirement（none/optional/required）/ Supply（configured/missing）/ Readiness（unknown/reachable/unreachable）/ Materialization（not-applicable/pending/mounted/failed）互不混淆；重启后 readiness/materialization 重置为 unknown/not-applicable 再探测。 | ✅ |
| FR-4.11 | Recovery 模式（派生，不存 flag）：团队级 required 失败 → 全部普通工作暂停，recovery/control/诊断/lifecycle 可用；模板级 → 仅该模板受阻；optional 失败 → 继续运行、状态 degraded、写 durable 遥测。Recovery 授权面 ⊆ 正常授权面 − 不可用能力（不得 deny→ask、ask→allow、扩 fs 范围）。 | ✅ |
| FR-4.12 | optional 需求不可用需 `DegradationConsent`（durable，同蓝图重启不重复询问）；required 模板需求不可用需人类显式 disable template（durable 环境处置），恢复后不自动 re-enable。 | ✅ |
| FR-4.13 | 治理 UI 的"确认警告"按钮**永久 disabled**（`compatibility.get` 只给聚合计数，没有逐项 requirementId；wire gap 已登记）。 | 🟡 |

### FR-5 Leader 工具集（15 个 `team_*` 工具）

公共约束：每个调用必带 `rootSessionId`（≤255）与 `requestToken`（非空 ≤128）；目标成员一律用 **instanceId**（label/templateId 被拒）；调用方会话的 owning root 必须等于请求的 root（`TEAM_TOOL_CALLER_ROOT_MISMATCH`）；模板 `teamTools` 决定模型可见子集，legacy 模板见全部 15 个；**工具暴露 ≠ 授权**（envelope 与 resolver 闭包仍是权威）。

| # | 工具 | 用途 | 关键参数（除公共两项） | 结果 status | 角色 / guard |
| --- | --- | --- | --- | --- | --- |
| 1 | `team_list_members` | 列出全部成员实例（templateId、label、lifecycle、bound child session） | — | `executed` | 任意；unguarded |
| 2 | `team_list_templates` | 列出蓝图成员模板（templateId、displayName、contextPolicy） | — | `executed` | 任意 |
| 3 | `team_inspect_config` | 纯读某实例生效配置：`effective`（model/tools/skills/mcp）、`operationPermissions`、`policyState`、`requirement`、`recovery` | `targetInstanceId` | `executed` | 任意；零副作用 |
| 4 | `team_create_member` | 显式从模板创建新成员 | `delegationTemplateId`, `label`(≤256), `groupId?`, `workspace?`(≤512) | `executed` | activation authority 把关；unguarded |
| 5 | `team_delegate` | 委派工作：建新成员并委派 **或** 委派给既有实例（二选一） | `delegationTemplateId` xor `delegationInstanceId`, `label`, `groupId?`, `workspace?`, `taskSummary?`(≤512), `prompt`(必填 ≤16384，自包含), `attachedContext?`(≤32768), `async?`（**缺省 true**） | `executed`（effect 含 `workStatus`） | 续接形式 guarded on target |
| 6 | `team_follow_up` | 对既有实例投递后续工作（续用同一 child Session） | `targetInstanceId`, `prompt`, `taskSummary?`, `attachedContext?`, `async?`（缺省 true） | `executed` | 始终 guarded |
| 7 | `team_collect` | 按 requestToken 读回工作单元 durable 状态（running / succeeded / failed / unavailable） | `requestTokens` 1..64 | `executed` | 纯读 |
| 8 | `team_send_message` | 向一个实例发消息（中转策略决定投递路径） | `recipientInstanceId`, `body`(≤8192), `subject?`(≤256) | `delivered` | guarded on recipient |
| 9 | `team_report_progress` | 记录某实例某主题进度 | `instanceId`, `subject`(≤256), `progress ∈ in-progress|completed|blocked`, `summary?`(≤512), `lastAction?`, `correlation?` | `progress-recorded` | guarded；stale-sequence 有界重试 1 次 |
| 10 | `team_request_control` | 请求某操作范围的审批 | `kind ∈ leader-approval|user-approval|envelope-mutation`, `targetInstanceId`, `actionName`(≤128), `toolName?`, `summary?` | `control-requested` | 同 scope 幂等；至多一次通知 |
| 11 | `team_resolve_control` | 对待裁决请求记录决定 | `requestId`, `decision ∈ allow|deny|escalate`, `note?` | `control-resolved` / `control-escalated` | resolver 闭包：leader-approval→leader/human；user-approval→human；envelope-mutation→leader/human；member 永不 |
| 12 | `team_list_pending_control` | 列出未解决审批请求（跨 carrier），含精确 requestId | `limit?`(默认 50，≤100) | `pending-control-listed`（`pending[]`, `count`, `truncated`） | **Leader-only**（`TEAM_TOOL_PENDING_LIST_NOT_LEADER`） |
| 13 | `team_archive_member` | 归档一个成员（RUNNING/SETTLED 合法；先 quiesce 再提交） | `targetInstanceId` | `executed` | **Leader-only**（`TEAM_TOOL_ARCHIVE_NOT_LEADER`）；guarded on target |
| 14 | `team_grant_permission` | 向成员授予 durable 权限 overlay 规则 | `targetInstanceId`, `rules` 1..32：`{operationClass, matcher: exact|subtree(value≤4096) | exec(intent{tool: bash|pwsh, command, workdir?, run_in_background?, timeoutMs?, sandbox_permissions?}), effect: allow|ask|deny}` | `permission-mutated`（`changed`） | **Leader-only**；收紧即生效，扩权需 carrier 覆盖 + v3 双 ceiling；超限 `PERMISSION_AUTHORITY_CEILING_INSUFFICIENT`；规则集相等重放不提交 |
| 15 | `team_revoke_permission` | 撤销成员 overlay 规则（可能构成 reveal 式扩权，门同 grant） | 同 14 | `permission-mutated` | 同 14 |

统一结果词汇：`executed / rejected(code,message) / blocked(reason, requestId?) / delivered / progress-recorded / control-requested / control-resolved / control-escalated / pending-control-listed / permission-mutated`；`rejected` 与 `blocked` 是正常控制流，不抛异常。guard 阻断原因闭集：`request-pending / decision-deny / request-stale / allow-consumed / scope-mismatch / target-stale`；`no-request` 放行（不 blanket block，保 Leader 日常自治）。

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-5.1 | 工具层拒绝码闭集：`TEAM_TOOL_BAD_ARGUMENTS / CALLER_UNRESOLVED / PENDING_LIST_NOT_LEADER / ARCHIVE_NOT_LEADER / PERMISSION_NOT_LEADER / PERMISSION_UNWIRED / PERMISSION_CANONICALIZE_FAILED / CALLER_ROOT_MISMATCH`。 | ✅ |
| FR-5.2 | `requestToken` 纪律：新逻辑操作新 token；同 token 仅用于重试同一操作（exactly-once 准入与 async 续接）；读操作不消费 token。 | ✅ |
| FR-5.3 | 模板 `teamTools: {kind: deny}` = 零 team tools；`allow.items` 未知名静默忽略。Leader 要做审批循环需在 `teamTools` 中暴露 `team_list_pending_control` + `team_resolve_control`，且 envelope 允许 `resolve-control`。 | ✅ |
| FR-5.4 | `builtinToolDeny` 经 `agentCtx.tools.restrict({deny})` 施加于 global 工具层；预设 own-layer 的 `subagent` 不可 deny（列入即 setup 失败 `unknown global tool "subagent"`）；`subagent_fork` 可 deny 且在严格权限预设上必须处置。 | 🟡 |
| FR-5.5 | 注意：`team_resolve_control` 本身 unguarded，重复裁决不会去重；裁决后投递给 Leader 的控制请求消息不会被清除（CTL-1，已登记）。 | 🟡 |

### FR-6 成员生命周期

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-6.1 | 状态闭集 `CREATED / RUNNING / SETTLED / ARCHIVED / DISPOSED`（成员专用；TeamSession 无此 FSM，用 Admission State）。 | ✅ |
| FR-6.2 | 操作与合法边（共 9 条）：`ADMIT_WORK`: CREATED/SETTLED→RUNNING；`SETTLE`: RUNNING→SETTLED；`ARCHIVE`: SETTLED→ARCHIVED；`RESTORE`: ARCHIVED→SETTLED；`DISPOSE`: CREATED/RUNNING/SETTLED/ARCHIVED→DISPOSED。其余均 `LIFECYCLE_ILLEGAL_TRANSITION`；DISPOSED 出边 `LIFECYCLE_TERMINAL_STATE`。 | ✅ |
| FR-6.3 | 归档 RUNNING 成员：close admission → 中断当前活动 → drain 驻留后代 → 等待静默 → durable `SETTLED` → durable `ARCHIVED`（两次提交，FSM 无 RUNNING→ARCHIVED 边）；归档 SETTLED：一次 ARCHIVE 提交（仍 quiesce）。CREATED/ARCHIVED/DISPOSED 目标在任何 live 效果前被拒。 | ✅ |
| FR-6.4 | Restore 只恢复 durable 可用性：不调模型、不发 prompt、不开 turn、不恢复驻留；UI 立即显示可再接收工作但不显示 RUNNING。 | ✅ |
| FR-6.5 | Dispose 同样先 quiesce；终态不可恢复、不接新工作；child Session 的 Chat/Trajectory 与 Team 台账历史保留；UI 文案禁止"删除成员"。 | ✅ |
| FR-6.6 | Residency 与 lifecycle 分离：SETTLED 成员可被驱逐 live Agent（`cold`）而 lifecycle 不变；新工作到来时 cold resume → admit → RUNNING。`liveToken` 只由 `(instanceId, residency)` 对计算。 | ✅ |
| FR-6.7 | 已归档成员仍留在台账审计读取中（lifecycle 门控执行，不门控审计）；新建成员不继承已归档成员的 overlay。 | ✅ |
| FR-6.8 | 实例 `workspace`：显式 > 团队 `defaultWorkspace`；首次 RUNNING 后终身锁定（`WORKSPACE_MUTATION_FORBIDDEN`）；换路线 = 新实例；`contextPolicy` 创建后不可变。 | ✅ |
| FR-6.9 | 委派目标解析：指定 instanceId → 续接；模板级 + `fresh_per_delegation` → 永远新建；模板级 + `persistent` → 续接唯一可接收工作的实例，无则新建，多个则 `DELEGATION_TARGET_AMBIGUOUS`。 | ✅ |
| FR-6.10 | 观察到的异常：成员 `RUNNING` 可跨宿主重启残留（挂起工作的域状态不归位，REPORT OBS-3）。 | 🟡 |

### FR-7 工作单元（Work Unit）：委派、跟进、收集与完成唤醒

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-7.1 | 委派三阶段：Phase A durable admission（返回收据）→ Phase B 成员 turn → Phase C durable settlement（`succeeded / failed / unavailable`）。 | ✅ |
| FR-7.2 | **默认异步**（2026-09-27 用户裁决）：无 `async` 参数即 admission 提交后立即返回（`workStatus: "admitted"`, `settled: false`, 无结果），工作 detached 运行，Leader turn 结束不取消它。 | ✅ |
| FR-7.3 | `async: false` 同步：tool call 阻塞到 settlement，结果随 tool result 返回；若成员在其中触发 `leader-approval`，通知排在被阻塞的 Leader turn 之后 ⇒ 已知调度限制（不是死锁：请求 durable、人类通道开放，但 Leader 无法在该 turn 内自决）。 | 🟡 |
| FR-7.4 | `team_collect`：纯读；每个 token 报 `running`（在途或 settlement 前崩溃）或终态（逐字来自 durable settlement，重启后仍可读）。同 token 再次 delegate = **续接**该单元而非再准入一个。 | ✅ |
| FR-7.5 | 完成唤醒（work-completion wakeup）：仅 async 单元在 **durable 终态**（经 `scanWorkStatus` 确认 `settledSequence` 存在）后，由 action router 的观察者触发；向 Leader 投递最小元数据通知 `[team-work-settled requestToken=…]`（含 `instanceId`、`taskSummary?`，不含结果正文）；Leader idle → `followup` 开新 turn；running → `steer` 注入当前 turn（自然合并 N 个完成为 1 个唤醒 turn）；成功边界 = inbox 接受，不等 `whenIdle`。 | ✅ |
| FR-7.6 | 通知 best-effort：provenance `source.kind = plugin:dsh-agent-team`（非 user）；失败只记日志不影响 settlement/`team_collect`；**不**做 durable 重放、ACK、wake budget；同 token 终态重放不重发通知。重启后恢复路径 = `team_collect`。 | ✅ |
| FR-7.7 | `WORK_DELIVERY_FAILED` 走 fail-closed settle（已终态，应通知）；`DURABLE_WRITE_FAILED` 时 token 仍表现为 `running / resumePossible`，不声称完成。 | ✅ |
| FR-7.8 | 同一成员允许多个工作单元重叠；完成身份是 `(rootSessionId, requestToken)` 而非成员 lifecycle 变迁。 | ✅ |
| FR-7.9 | 成员 `prompt` 自包含（不继承 Leader/兄弟上下文），大材料走 `attachedContext`；成员首个 model-facing 上下文 = 模板 persona + prompt + attachedContext + 必要结构性团队身份。 | ✅ |
| FR-7.10 | Root 初始工作 `team.admitInitialWork`（v2）：`(rootSessionId, requestToken)` 幂等；重复 → `TEAM_RUNTIME_INITIAL_WORK_ALREADY_ADMITTED`。 | ✅ |
| FR-7.11 | 实测缺陷：成员 `team_report_progress` 合法参数路径非确定性挂起导致 root 死锁（REPORT F3，3 挂 / 1 成功；推论为 activity ledger 提交与工作准入在同一 per-team 串行链互等）。 | 🟡 |

### FR-8 团队消息（`team_send_message` / `member.send`）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-8.1 | 实例寻址（`fromInstanceId → toInstanceId`）；Leader 使用保留身份 `inst-leader`。 | ✅ |
| FR-8.2 | 中转（mediation）规则闭集：① 人类发送 → direct；② Leader 发送 → direct；③ 成员→Leader → direct（向上协调永不中转）；④ 成员→同伴 → 仅当**发送方**最新 instance-scoped autonomy overlay 含 `messagingPeerDirect: true` 时 direct，否则 **mediated**（投递到 Leader 的 session，标注 `intended-for` 同伴，Leader 自行转发，运行时永不自动转发）；⑤ 任何身份/记录缺失 → mediated（fail-closed）。 | ✅ |
| FR-8.3 | 投递成功边界 = 接收方 inbox 接受（`followup` 返回），**不等待**接收方 turn 结束（修复 Leader↔Member 互等死锁）；接收方不 live → `MESSAGING_TARGET_NOT_LIVE` fail-closed，intent 事实仍记台账。 | ✅ |
| FR-8.4 | 接收 relay 不授予对源 Session 的任何读取/搜索能力；relay 文本 `[team-relay] from=… to=…` / `[team-relay:mediated via leader] from=… intended-for=…`。 | ✅ |
| FR-8.5 | 限制：`body` ≤8192（tool）/ ≤200000（remote `member.send`）；`subject` ≤256/≤255；envelope 需含 `send-message`（`TEAM_RUNTIME_ENVELOPE_OUT_OF_BOUNDS` typed 零副作用）。 | ✅ |
| FR-8.6 | 无 `async` 选项、无重试队列、无 steer/inject 变体（明确非目标）。 | ❌ |

### FR-9 进度与活动（Progress / Activity）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-9.1 | `team_report_progress` 写 durable 活动事实：`subject / progress(in-progress|completed|blocked) / summary / lastAction / correlation`；Leader 与成员均可调。 | ✅ |
| FR-9.2 | 投影 `MemberActivitySummaryDto`（status/subject/summary/lastAction/correlation/lastProgressAt/openIntervals）+ live overlay `MemberLiveActivityDto`（residency/currentAction/lastActivityAt/runningSince/admittedWorkCorrelation）。 | ✅ |
| FR-9.3 | 进度 **不是** workflow authority：不自动切换 PolicyState、不激活 reviewer、不归档、不推进 DAG。 | ✅ |
| FR-9.4 | UI"活动与进度"面板：每条 current-work 行显示状态点（进行中蓝/已完成绿/受阻红）、subject、状态词、`负责人 {member}`、summary；空态"暂无活动进度"；非交互。 | ✅ |

### FR-10 控制 / 审批 / 介入（Control / Approval / Intervention）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-10.1 | 请求种类（兼容 carrier）：`leader-approval`（resolver = leader 或 human）、`user-approval`（human only）、`envelope-mutation`（leader 或 human）；member 永不是 resolver；不能自批、不能同级批。 | ✅ |
| FR-10.2 | 触发路径：成员参数级权限解析为 `ask` → 自动创建 durable `leader-approval` 请求并挂起 tool call；Leader 自己的 `ask` → `user-approval`；或显式 `team_request_control`。`deny` 不创建请求。 | ✅ |
| FR-10.3 | 发现路径：新 `leader-approval` 请求 → 团队锁释放后 fire-and-forget 向 Leader 投递模型可见通知（C1，文本以 `[team-control requestId=<id>]` 开头，`followup` + `whenIdle`，at-least-once liveness，**重启不重放**，投递失败仅为 liveness 失败）；兜底 `team_list_pending_control`（纯读，仅 Leader）。 | ✅ |
| FR-10.4 | 决定：`allow` 授权 **精确 scope 恰好一次**，由下一次 guarded 执行消费（check-and-reserve exactly-once）；`deny` 终止该次调用；`escalate` 不是决定值而是 leg 事实（`control-escalation-recorded`）+ 终结该 leg（`decision: deny, reason: escalated`）并为更高 authority 开新 leg（同 `approvalCaseId`）。durable 决定值闭集 `allow | deny | stale-denied`。 | ✅ |
| FR-10.5 | guard 范围：仅包裹 4 个受管 team work 操作（delegate / follow-up / send-message / report-progress）；scope = `{root, targetInstanceId, actionName, toolName, correlation = requestToken}`；DSH 基础工具（write 等）不经此 guard（宿主沙箱独立前置闸）。 | ✅ |
| FR-10.6 | 审批 payload：请求携带完整归一化 `reviewPayload` + `payloadDigest`；UI 展示与实际执行使用同一冻结对象；缺 payload/digest 的 legacy 行 → "无法完整审阅"（允许禁用、拒绝可用）。 | ✅ |
| FR-10.7 | Authority 阶梯 `member < leader < human-user < human-admin`；`requiredAuthority` 从阶梯默认起（成员 ask→Leader；Leader 自扩→Human User；Human User 自扩→Human Admin），**仅当** desiredEffect 超过候选 reviewer 的 `grantCeiling` 才上升；`bindingDocs(leader) = {teamHardEnvelope, permissionMutationEnvelope}`，`bindingDocs(human-user) = {teamHardEnvelope}`，`bindingDocs(human-admin) = {}`。 | ✅ |
| FR-10.8 | 合法动作（服务端派生）：reviewer 不足 → `deny | escalate`；足够且非 admin → `allow | escalate | deny`；admin → `allow | deny`。 | ✅ |
| FR-10.9 | Human Admin 无 resolver：需升级到 admin 的 case **同步**终止为 `authority-unavailable`（leg 行"born terminal"+ 终态 deny），不产生 pending、不重试、UI 无释放入口 ⇒ shell 类规则 `allow→ask` 收紧是"单向门"（授权文档明示勿这样做）。 | 🟡 |
| FR-10.10 | 单次操作状态机：`created → preflight-passed → pending-review → approved → execution-succeeded | execution-unavailable | stale | denied | authority-unavailable | authority-undetermined`；allow 后再校验（authority/ceiling 重算、capability last-mile）；allow 不可被后续调用复用。 | ✅ |
| FR-10.11 | Intervention 统一投影：`kind ∈ approval|warning|error`，`responseBehavior ∈ informational|wait-for-response`，`blockScope`（configuration-operation / operation / subject-new-work / team-new-work / null），`status ∈ open|acknowledged|resolved|authority-unavailable|stale`，`requiredAuthority?`、`currentReviewAuthority?`、`legalActions[]`、`fingerprint?`、观察计数；介入面不是权威源。 | ✅ |
| FR-10.12 | 治理警告（GovernanceWarning）：envelope 一致性 `consistent / mismatch / undetermined`，在蓝图发布、团队启动、运行边界三阶段计算；指纹去重（重复只更新计数/时间）；确认只影响提醒状态，**从不改变授权**；warning 永不伪装成 ControlRequest。 | ✅ |
| FR-10.13 | 损坏控制记录：strict reader 拒绝的 leg 列为 corrupt（`team.listCorruptControlLegs` v9，最多 20 条）；UI 固定警告条可见、不可关闭；corrupt 行既不 pending 也不可裁决；对 corrupt 行 reject 零写入；带 corrupt leg 时受管操作仍可继续（验收检查 2）。 | ✅ |
| FR-10.14 | 介入动作 `intervention.act(allow|deny|escalate|acknowledge)` 与 `team.resolveControl` 走同一 `ControlService` 写路径，服务端重新派生 principal、`reviewAuthority`、legal actions，拒绝 `caller == beneficiary`。 | ✅ |
| FR-10.15 | 历史形态的 `sweep(timeout)` 自动 deny（legacy 120s）**未**在 vNext 出现；pending 请求无超时；撤回/终结语义待裁决（C-7）。 | 🟡 |

### FR-11 能力策略与权限治理

#### FR-11.A 能力策略（Capability policy，Alpha.1/2）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-11.1 | 能力 cell 闭集 `model / tools / permissions / skills / mcp`（`permissions` cell 不作为 authority 暴露于 inspect）。 | ✅ |
| FR-11.2 | Team 内分层（升序）`blueprint < policyState < template < templateOverlay < instanceOverlay < humanOverride`，之后与外部事实求交：`capabilityExists=false` → deny；外部 hard deny → deny；外部 allow-list 与 Team allow 求交。任何层都没给值 → `unspecified` → fail-closed deny。 | ✅ |
| FR-11.3 | Provenance 词汇 `static / leader / member / human`；PolicyState 变严时 autonomy overlay"存储但抑制"而非删除；人类 override 不被 PolicyState 抑制。 | ✅ |
| FR-11.4 | 唯一生产读路径 `EffectivePolicyReader.resolveMemberPolicy(root, instance)`，ModelSelection / MCP 视图 / inspect / activation 全部由其派生，消费者不得各自拼装优先级。 | ✅ |
| FR-11.5 | 模型：`modelPreference` 模板静态值 < durable override（governance / humanOverride）；in-flight request 不换模型，新选择在下一安全 request 边界生效；无模板偏好回退 `staticModel`。 | ✅ |
| FR-11.6 | MCP：每个 agent 每个 request 边界实际挂载集 = 行 `mcpServers` ∩ 模板 `capabilities.mcp` 静态门 ∩ 有效治理 cell；不在集合内 **不挂载**（不是先挂再隐藏）；模型可见工具名 `mcp__<server>__<tool>`；allow 支持 `*`；per-server 独立收敛（deny-first，单 server 失败不回滚他者，有界 cooldown/backoff，每次重要尝试写 `capability-runtime-event` 事实）。 | ✅ |
| FR-11.7 | Capability 选择与 Operation permission 分层：`builtinToolDeny / teamTools / skills / mcp` 决定工具是否存在于 surface；`permissions` 决定具体一次调用是否允许。 | ✅ |

#### FR-11.B 参数级操作权限（Alpha.2）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-11.8 | 7 个受管工具 `read, read_image, write, edit, lsp, bash, pwsh`；资源 `exact`（文件键）/ `subtree`（经公开 `FileSystem.contains` 判容器，不解析 targetKey）/ `any`；静态优先级 `deny > ask > allow > policy.default`；每次决定 fresh canonicalize（无安装期 authority 缓存，symlink 拓扑变化随之变化）。 | ✅ |
| FR-11.9 | 执行点：公开 `tools/pre-execute` listener + 单调 end-cap guard，授权 marker 绑定执行身份；hostile prepended allow 不能绕过；capability 级 deny 优先于参数权限；cold resume 重装 enforcement。 | ✅ |
| FR-11.10 | 外部硬策略 last-mile recheck：Team allow 后仍经 DSH 外部硬 guard；UI 显示"团队裁决：已允许 / 执行：被托管策略阻止"而非"审批失败"。 | ✅ |
| FR-11.11 | shell 双闸（exec 自治契约）：Leader 模板 allow lane 的 `{tool: bash|pwsh, resource: any}` 只有在 Leader 有效 mutation envelope 含同名 token（`bash` ≠ `pwsh`）时才自动放行，否则降级为 `ask → user-approval`（人类裁决）；无隐式默认 allow；成员 exec 的 ask → `leader-approval`（Leader 批，不必上人类）。 | ✅ |
| FR-11.12 | Permission Coverage Gate（模板声明 `permissions` 时启用）：最终 model-facing surface 上每个工具必须有 authority owner，分类 `MANAGED_OPERATION_PERMISSION / OTHER_MANAGED_TEAM_TOOL / OTHER_MANAGED_MCP / SAFE_UNMANAGED / KNOWN_SENSITIVE_UNMANAGED / UNKNOWN_UNMANAGED`；后两类 FATAL（不 auto-hide，不提供 ack escape hatch），唯一修复 = `builtinToolDeny` 或实现 adapter。 | ✅ |
| FR-11.13 | 已知可用性缺陷：SAFE 注册表仅 `todo_write`，`grep/glob/subagent/subagent_fork/ralph/workflow/web_fetch/web_search/job_*/send_message/interrupt_agent/list_agents` 为 KNOWN_SENSITIVE，`ask_user_question/present/skill/create_goal/...` 未分类 ⇒ **声明权限的蓝图在常规宿主预设上无法建队**（操作员实测 19 个工具被拒，TM-4）；错误消息不带 remediation（TM-5）；`builtinToolDeny` 条目不 trim（TM-8）。 | 🟡 |
| FR-11.14 | C2 开放风险：DSH 子代理不继承成员的 agent-local 参数权限/内置 deny 治理；非 minimal 预设上 `subagent` 不可 deny ⇒ 建议用 `minimal` 预设或记录为接受的临时风险。 | 🟡 |

#### FR-11.C durable 权限 overlay 与授权封顶（Alpha.3 / Alpha.4）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-11.15 | 唯一治理写权威 `GovernanceMutationService`：Leader tool lane（`team_grant/revoke_permission`）、远程 `override.mutatePermission`（v7，必填 `reason`）、restore-ruleChange 全部经同一 dispatcher；durable-before-ack；完整快照 append（无逐规则 delta）。 | ✅ |
| FR-11.16 | 成员不能发起任何 durable 权限变更（含收紧）；Leader 对成员：收紧/同值直接提交，扩权在 `permissionMutationEnvelope` 内直接提交，超出则生成不可变 **mutation proposal + ApprovalCase**；Leader 对自己：收紧可直接，扩权需 Human User/Admin；Human User：超出 `teamHardEnvelope` 需 Human Admin。 | ✅ |
| FR-11.17 | 有效 ceiling 代数：对同 operationClass 的全部规则求值；任一 subtree 包含关系不可判定 → `undetermined`（吸收态，禁止任何批准）；无匹配 → 扩权面 `no-authority` / 审批面 identity（无收窄）；有匹配取最小 `maximumEffect`（`deny < ask < allow`）；"加一条匹配规则不会提高 ceiling"单调性受测试保护；两份文档分别求值，永不合并。 | ✅ |
| FR-11.18 | 批次原子：多规则变更的 required authority = 各上升区域最小 authority 的最大值；任一区域 undetermined → 整批拒绝，无自动裁剪、无部分提交。 | ✅ |
| FR-11.19 | 提案身份绑定 team/target/kind/规范化规则/requestedEffect/`baseGeneration`+`baseSnapshotId`/beneficiary/蓝图 contentHash/reason；subtree 提案绑定根身份而非后代枚举；根 canonical 身份漂移 → `stale`。allow 后内联提交重入 per-team chain，重校验 lifecycle/generation/matcher/authority，终态 `mutation-committed | no-change | stale | denied | authority-unavailable | authority-undetermined`。 | ✅ |
| FR-11.20 | 消费点重校验（A1-14）：guard 在 per-team 锁内用持久化的 `authorityScope`（exact/fingerprint，永不 subtree）重算 ceiling；undetermined 或 required authority 上升 → 零消费拒绝。 | ✅ |
| FR-11.21 | 权限变更通知：对**正在 running** 的成员至多一次 `Agent.inject`（不唤醒 idle/cold 成员），文本 `[team-perm-changed team=… instance=… generation=…]` 仅带代数与规则计数；通知不是授权；runtime-context 快照是权威解释上下文。 | ✅ |
| FR-11.22 | 读面：`override.getPermission`（overlay 当前 authority + 升序 audit 历史，非生效结果）、`override.getPermissionAdministration`（蓝图身份、静态基线、两份 envelope、overlay 代数/provenance、生效摘要、一致性诊断；剥离 authority-bearing 字段）。 | ✅ |
| FR-11.23 | PolicyState 切换：`policyState.set(target{stateId, cells{locked?, value?}}, actor)`，显式人类/授权 Leader 切换，durable transition 记录；不表示任务进度。 | ✅ |
| FR-11.24 | 能力 override：`override.set/reset(capability, value{allow items | deny}, actor, scope team|instance, expectedGeneration?)`；v7 乐观代数守卫 `OVERRIDE_GENERATION_CONFLICT`；reset = 审计保留的撤销（逐条回退 undo 栈，非一次归零）。 | ✅ |
| FR-11.25 | 外部硬策略对所有角色（含人类）绝对封顶；Human override 不能创造不存在的能力。 | ✅ |

### FR-12 Team Web UI

#### FR-12.A 团队标签页（`conversation.view` "团队"）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.1 | 零态（非团队/未解析）状态行按 read-state 结果：`已确认当前会话未加入团队` / `团队归属读取失败 — code: message` / `团队归属响应异常` / `无法读取团队归属，等待连接恢复` / `正在加载团队状态…` / `正在读取团队归属…` / `团队信息尚未成功加载，正在重试` / `当前会话未能关联到团队` / `团队信息加载失败`；**不再**用肯定式"未加入团队"掩盖冷读失败。 | ✅ |
| FR-12.2 | 零态组件：刷新按钮"刷新团队视图"、legacy 检视注释、"已持久化的团队"列表（每行 root id、`blueprintId@revision`、默认工作区、`N 名成员`、创建时间、按钮"以 Team 模式打开 / 回到 Leader"与"以普通模式打开"[不执行 Team ensure]、逐行 pending/错误）、"从此处开始团队"按钮/内嵌创建面板。零态 roots 每 3 秒轮询。 | ✅ |
| FR-12.3 | 就绪态顶部状态栏：归属过期 banner"团队归属刷新失败，当前显示上次成功的数据"、更新失败注释（保留旧帧）、"正在更新…"、刷新按钮。 | ✅ |
| FR-12.4 | 损坏记录警告条（`role=alert`）：数量 + 逐条序号/可归属性 + 截断标记；不可关闭、不可操作；完整性检查失败时替代 `role=status` 提示。 | ✅ |
| FR-12.5 | 五个分区固定顺序：时间线 → 成员组 → 治理（有 governance face 时）→ 活动与进度 → 团队事件。 | ✅ |
| FR-12.6 | 刷新机制：per-session `TeamRefreshCoordinator` 3 秒轮询，每轮先轻量 `team.getReadState`，身份变化才 full `team.getProjection`；标签页隐藏暂停；手动刷新强制一轮；连接恢复触发一轮；无乐观更新，所有命令成功后 `pullProjection` 为准。 | ✅ |
| FR-12.7 | 📐 UI 设计中的 Team Header（蓝图名·rev、Policy、Compatibility badge、Runtime preset、Perspective、计数）作为独立头部；现实现把这些信息分散在成员组/治理卡片中，无独立 header。 | 📐 |
| FR-12.8 | 📐 "Forked Team Session" 一次性说明、"Template Session defaults…"模板菜单、Instance Detail 右侧栏（desktop 分栏）。 | 📐 |

#### FR-12.B 时间线（Timeline）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.9 | Gantt 式：每个非 Leader 成员实例一条 lane（侧栏成员名 + 色块，当前成员高亮）；每个 RUNNING 区间一根 bar；同 lane 多段；归档/处置不删历史 bar；空态"暂无委派记录"。 | ✅ |
| FR-12.10 | 交互：指针锚点滚轮缩放（最小 1 秒域）、拖拽平移、键盘（←/→ 平移，Shift×5；+/= 放大；-/_ 缩小；0/Esc 重置）、双击重置、hover 200ms tooltip（成员名、起止、时长、"(进行中)"）、running 区间每秒 tick 延伸、点击 bar 导航到该成员会话、右键菜单禁用。 | ✅ |
| FR-12.11 | 📐 groupId 作为 lane tag / filter；模板分组层级（Template → Instance lane）。 | 📐 |

#### FR-12.C 成员组（Members）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.12 | Leader 组（固定首位，点击导航 Root）：`{name} · {N} 活跃`；"Team 模式开关行"：按钮"以 Team 模式打开 / 回到 Leader"、"以普通模式打开"，模式 badge"Team 模式/普通模式"（仅停留在该 root 时显示），错误注释。 | ✅ |
| FR-12.13 | 模板组（每模板一组，含 0 实例时也建组）：`{name} · {N} 活跃`、"+"创建实例按钮（`aria-label` 创建成员实例）、创建错误注释。 | ✅ |
| FR-12.14 | 实例行：导航按钮（无绑定 session 时禁用）、状态点（created 琥珀/running 蓝/settled·archived·disposed 绿）、状态词（已创建/运行中/已结算/已归档/已处置）、当前动作或"暂无动作"、`{N} 项待裁决` badge、操作按钮集（按 lifecycle）、命令错误注释（code + message + requestToken）。 | ✅ |
| FR-12.15 | 操作矩阵（`memberActionsForLifecycle`）：`followup`（RUNNING"发送跟进"/ SETTLED"发送任务…"或"恢复…"）、`send`"发送消息…"、`archive`"归档"（确认框，RUNNING 加警告"该成员正在运行。归档将停止当前工作…"）、`restore`"恢复"（无确认直接执行）、`dispose`"处置"（确认框，正文明示历史保留）、组级 `create`。有 pending 命令时全部禁用。 | ✅ |
| FR-12.16 | 对话框：创建实例（只读模板、`fresh_per_delegation` 提示"新的委派会创建新实例。"、Label 必填、Group 可选、Workspace 可选）；发送任务（prompt 必填）；发送消息（Subject 可选 + Body 必填）；确认框（归档/处置）。均 body-portaled Modal，Esc/mask 关闭。 | ✅ |
| FR-12.17 | 重复 label 合法，UI 不以 label 为 key；实例 id 在详情/诊断可见。 | ✅ |

#### FR-12.D 治理（Governance）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.18 | 兼容性卡：badge（`✓ 兼容` / `✕ 结构性错误` / `⚠ 降级` / `⚠ 需要处理`）、计数行 `{warning} 项警告 · {fatal} 项致命 · {acknowledged} 项已确认` + Generation + 最后探测时间、"审查"（`compatibility.get` 详情）、"重新检查"（`compatibility.reprobe`，提示新代数不被旧确认覆盖）、"确认警告"（永久禁用，见 FR-4.13）。 | 🟡 |
| FR-12.19 | 策略状态卡：`策略 [state]`、帮助文案"策略控制团队当前的运行时治理范围，不代表任务进度。"、"审查"加载 cell 编辑器（每 capability：名称 + locked 标记、当前值"未设置/允许 [items]/拒绝"、`select none|allow|deny` + items 输入）、"提交"（预览"将提交：…"，无变更禁用）。 | ✅ |
| FR-12.20 | 生效配置 + 覆盖卡：每成员一块；配置行（名称、值、来源、状态词、suppressed/unavailable 标志、effectiveFrom、硬策略 requested/effective/reason）；覆盖编辑器（capability model/tools/skills/mcp、kind allow/deny、items、"查看覆盖"/"设置覆盖"/"重置覆盖"、当前值或"无显式人工覆盖"）。 | ✅ |
| FR-12.21 | 治理介入面板（v8+ 宿主）：标题"治理介入"，空态"当前没有介入项。"；每行 `kind · status · responseBehavior`、`currentReviewAuthority → requiredAuthority`、blockScope、warning 结构块（source id/fingerprint/observationCount）或 requestId+legOrdinal、终态行"终态：…"（无按钮）、操作按钮严格来自服务端 `legalActions`（允许/拒绝/升级/确认）。 | ✅ |
| FR-12.22 | 权限管理子卡：身份行（team/member、generation 或"蓝图默认"、source）、规则平面列表 `{lane} · {matcherKind} {resource} · {effect}`（subtree 不展开成目录树）、空态"无生效规则。"、诊断列表。 | ✅ |

#### FR-12.E 团队事件（Ledger / Events）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.23 | 顶部控制栏：类别过滤 `all/team/member/lifecycle/message/control/policy/compatibility/progress`；实例/模板过滤；错误 + 重试；"加载更早"（本地窗口加深，初始 200）；"还有 {N} 条事件未加载"。 | ✅ |
| FR-12.24 | 每行紧凑单行，可点击导航关联会话：状态点、时间、13 种已知类型本地化（工作准入、成员创建、生命周期、消息、控制请求、控制裁决、裁决消费、进度、活动开始、活动结束、策略变更、治理提案、控制升级）+ unknown 原始 factType、actor、摘要、状态 badge（等待裁决 / 损坏 · 不可裁决 / 允许 / 拒绝 / 过期拒绝；外部策略双行"团队裁决：已允许 / 执行：被托管策略阻止"）。 | ✅ |
| FR-12.25 | 待裁决控制请求详情面板（行内兄弟 div）：请求方、种类、操作、工具、原因、创建时间、当前状态、请求的 authority、subject、Request ID、渲染模式（standard/legacy-compatible/recovery-v1/unsupported-subject/corrupt-record）、摘要 digest、完整 payload `<pre>`；允许/拒绝按钮仅当 `controlSurfaceMode === 'enabled'`（v4 探测确认）且 kind 可由人类裁决；incomplete/unsupported/corrupt 时按钮禁用并给出原因；只读模式注释"当前宿主未提供 v4 人工控制裁决"。 | ✅ |
| FR-12.26 | 内部事实类型（如 `artifact-read-granted`）从展示行隐藏但不影响计数/分页；三处注册（runtime 类别表、client 类别表、`INTERNAL_FACT_TYPES`）必须同步。 | ✅ |
| FR-12.27 | 已登记 UI 缺陷：无折叠分组导致一次人工裁决翻页约半分钟（UI-1）；行排版破损、payload 溢出裁断（UI-2）；刷新按钮 pending 态横向跳动（UI-3）；刷新偶发极慢（UI-4）；各面板状态互相矛盾 + 悬浮"任务"面板遮挡（UI-5）；多团队 home 中非首团队的 ledger 静默截断（F11，frontier 与 total 单位错配）；状态需整页 reload 才收敛（F5）。 | 🟡 |

#### FR-12.F Dock、设置页、Legacy

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-12.28 | Dock（composer 上方，仅团队会话渲染）：折叠一行"团队 · {N} 运行中 · {M} 待裁决"（零计数段省略）+ 展开/收起 chevron；展开显示成员列表（名 + 状态点）与活动列表；"打开团队标签页"跳转按钮为 **no-op**（宿主无跨入口视图激活 seam，D-T9-4 降级）。 | 🟡 |
| FR-12.29 | 设置页 Team 区段：静态帮助文案（"团队成员配置 / 未配置团队成员 / 在以下目录创建 Markdown 定义文件…"），**仍描述 legacy `$DSH_HOME/teammates/*.md` 机制**，未更新到蓝图流程。 | 🟡 |
| FR-12.30 | Legacy 会话：零态 + `legacyInspect` 成功解码为 `legacy-team` 时显示只读 banner（"本会话由旧版 Team 实现创建。/ Team vNext 不会将其作为 vNext 团队恢复或变更。/ 历史 Chat 与 Trajectory 仍可访问。"）+ 解码摘要（team id、leader session、花名册计数、成员列表）；无任何可执行操作；检视失败保留普通零态 + 一行错误。 | ✅ |
| FR-12.31 | 国际化：zh/en 双字典，约 200+ 键（settings、member、view.*、ledger、control、interventions、intent、member.dialog、dock、governance、handoff、legacy、entry）。 | ✅ |
| FR-12.32 | 无障碍：对话框 `role=dialog aria-modal`、Dock chevron `aria-expanded/aria-controls/aria-label`、时间线键盘操作、状态均有文字标签；📐 完整的 a11y 规范（焦点陷阱、屏幕阅读器可读 blocked reason）未逐项验证。 | 🟡 |

### FR-13 远程 API（`/team-remote`，v1–v9，35 方法）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-13.1 | 传输：请求 `{type:'client-request', rpcId, method, payload:{version:1..9, params}}`（payload 闭合仅两字段）；响应 `{ok:true, value:{data, provenance:{origin:'team-remote', method, endpoint, contractVersion, requestToken, projectionGeneration, effectSequence}}}` 或 `{ok:false, error:{code, message, details}}`。 | ✅ |
| FR-13.2 | 边界错误码 `contract-version-unsupported / unknown-method / malformed-request / malformed-params / method-version-unsupported / internal-error`；约 110 个后端 typed 码闭集原样透传，闭集外降级 `internal-error`（`MESSAGING_INTERNAL` 故意不透传）。 | ✅ |
| FR-13.3 | 所有方法 params 为闭合字段集（未知字段 → `malformed-params`），因此 `asRole/impersonate` 类字段不可能不升版本就出现。 | ✅ |
| FR-13.4 | 版本演进：v1 23 方法基线；v2 `team.admitInitialWork` + workspace-aware `team.create`；v3 `team.listRoots`/`team.ensureRootLive`；v4 `team.resolveControl`；v5 `team.prepareOrdinaryOpen`；v6 `team.getReadState` + `durableGeneration/liveToken`；v7 `override.set/reset` 加 `expectedGeneration` + `override.mutatePermission/getPermission`；v8 `intervention.list/get/act` + `override.getPermissionAdministration`；v9 `team.listCorruptControlLegs`。高版本兼容全部低版本方法。wire 版本从不选择授权代数。 | ✅ |
| FR-13.5 | 安全模型：连接门（HMAC cookie + loopback/Host fence + same-origin）在 dispatch 之前；传输只有"每 DSH_HOME 一个匿名操作员"身份；payload 中 `caller/actor` 只是 **claim**，服务端只用它在 durable 行中选择/校验 scope（`deriveAdmissionCaller / deriveMutationActor / deriveAckCaller / deriveControlCaller`）；`team.resolveControl` / `intervention.act` payload 无角色字段；伪造 → `TEAM_REMOTE_FOREIGN_TEAM` / `TEAM_REMOTE_PRINCIPAL_INVALID`；`human-admin` 不可由任何 payload 产生。 | ✅ |
| FR-13.6 | 投影拉取：v1–v5 以 `generation` 判 `apply/duplicate/stale/foreign/rpc-error/transport-loss/inconsistent`（新状态永不被旧响应覆盖）；v6 以 `(durableGeneration, liveToken)` 判，同代数不同 liveToken = live-only 变化不刷 ledger；台账分页 tracker 5 项形状校验（anchor、严格递增、页长、cursor、total 非降）；重连指数退避 `[cap/2, cap]`。 | ✅ |
| FR-13.7 | 投影 DTO 9 字段：`schemaVersion, teamSessionId, blueprint, generation, generatedAt, root, templates[], members[], ledger`（v6 + `durableGeneration`, `liveToken`）；台账条目 `schemaVersion, sequence, rootSessionId, factType, payload, operationId, createdAt`；台账 8 类别 `team/member/lifecycle/message/control/policy/compatibility/progress`。 | ✅ |

**方法总表**

| 类别 | 方法 | 版本 | 读/写 | 要点 |
| --- | --- | --- | --- | --- |
| catalog | `catalog.list` | v1+ | 读 | 列蓝图 + revisions + migrationState |
| catalog | `catalog.get(blueprintId, blueprintRevision?)` | v1+ | 读 | 强解析一个 revision（真正预检） |
| intent | `intent.probe(blueprintId, environmentFacts≤10000, blueprintRevision?)` | v1+ | 读 | 兼容性评估 |
| team | `team.create(rootSessionId, blueprintId, blueprintRevision?, initialWork?)` | v1 | 写 | 绑定 fresh/cold root（v1 可内嵌初始工作） |
| team | `team.create(…, workspace?)` | v2+ | 写 | CREATE-ONLY + workspace attach，无 initialWork |
| team | `team.admitInitialWork(rootSessionId, requestToken, prompt≤200000, attachedContext?)` | v2+ | 写 | Root 初始工作准入，幂等 |
| team | `team.listRoots()` | v3+ | 读 | 宿主全部 durable 团队 roots（含 memberCount） |
| team | `team.ensureRootLive(teamSessionId)` | v3+ | 副作用 | 以 Team 模式拉起 root agent |
| team | `team.resolveControl(teamSessionId, requestId, decision allow|deny, note?)` | v4+ | 写 | 人类裁决，exactly-once（重放 `CONTROL_REQUEST_DECIDED`） |
| team | `team.prepareOrdinaryOpen(teamSessionId)` | v5+ | 进程内 | 一次性普通模式激活许可（TTL） |
| team | `team.getReadState(sessionId)` | v6+ | 读 | 会话归属 team-root / team-member / none（存储/完整性失败 typed，不静默 none） |
| team | `team.getProjection(teamSessionId)` | v1+ | 读 | 完整投影 |
| team | `team.getLedgerPage(teamSessionId, afterSequence=0, limit 1..500=50)` | v1+ | 读 | 台账分页 |
| team | `team.listCorruptControlLegs(teamSessionId)` | v9+ | 读 | corrupt legs（≤20） |
| member | `member.create(teamSessionId, caller, requestToken, delegationTemplateId xor delegationInstanceId, payload?)` | v1+ | 写 | 经 admission authority 创建 |
| member | `member.send(teamSessionId, caller, recipientInstanceId, body≤200000, requestToken, subject?≤255, payload?)` | v1+ | 写 | 消息（准入 + 投递） |
| member | `member.followup(teamSessionId, caller, targetInstanceId, requestToken, payload?)` | v1+ | 写 | 跟进 |
| member | `member.archive / restore / dispose(teamSessionId, instanceId)` | v1+ | 写 | 返回 `member, steps, drained?, residencyDropped?` |
| override | `override.get(teamSessionId, capability, scope?, targetInstanceId?)` | v1+ | 读 | 一个 override slot |
| override | `override.set(…, value, actor, expectedGeneration?)` / `override.reset(…)` | v1+/v7+ | 写 | leader/member actor 仅限 team scope |
| override | `override.mutatePermission(teamSessionId, memberInstanceId, kind grant_instance|revoke_permission, mutationId≤200, reason≤512 必填, actor, rules 1..32)` | v7+ | 写 | 权限 overlay |
| override | `override.getPermission(teamSessionId, memberInstanceId)` | v7+ | 读 | overlay authority + 审计历史 |
| override | `override.getPermissionAdministration(teamSessionId, memberInstanceId?)` | v8+ | 读 | 剥离后的权限管理投影 |
| policyState | `policyState.get / set(teamSessionId, target, actor)` | v1+ | 读/写 | PolicyState 视图 / 切换 |
| compatibility | `compatibility.get / ack(requirementId, acknowledgedBy, note?) / reprobe(trigger)` | v1+ | 读/写/写 | 兼容性 |
| handoff | `handoff.prepare(sourceSessionId)` / `handoff.create(sourceSessionId, requestToken, staged?)` | v1+ | 读/写 | Start Team from Here |
| legacy | `legacy.inspect(dshHome, workspaceCwd?, projectDir?)` | v1+ | 读 | legacy 检视 |
| intervention | `intervention.list / get(interventionId) / act(interventionId, action, note?)` | v8+ | 读/读/写 | 介入面 |

### FR-14 持久化、所有权与恢复

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-14.1 | TeamDomain 逻辑实体：`TeamSessionRecord`（root、blueprint snapshot ref、defaultWorkspace、createdAt、generation、handoffSourceSessionId?）、`MemberInstanceRecord`（instanceId、templateId、label、groupId?、childSessionId、workspace?、lifecycle、createdAt、activityVersion；Leader 记录无 childSessionId/lifecycle）、`SessionBinding`（任意 SessionId → ordinary / team-root / team-member）、治理/override 记录、兼容性/确认记录、provisioning 日志、TeamLedger。物理 store 共 10 个：`schemaMeta / teamSessions / memberInstances / sessionBindings / overrides / compatibility / operations（append-only 操作日志）/ ledger（append-only 事实台账）/ blueprintRegistry（冻结蓝图快照，只读 + freeze）/ permissionOverlays（append-only，Alpha.3 新增）`。 | ✅ |
| FR-14.2 | 建在 DSH `StorageDomain` 之上：单条写 durable、域内串行，但**无跨表事务/迁移/二级索引** ⇒ 多记录操作必须自带 journal/幂等 reconciliation（provisioning 中间态 `PROVISIONING / PROVISIONING_FAILED` 内部不可见）。 | ✅ |
| FR-14.3 | 台账 append-only 全局序列（`__ledger_sequence_counter`），每条事实推进 `team_sessions.generation`；`factType` 开放字符串但必须在 `FACT_TYPE_CATEGORY` 注册（未注册 → `TEAM_PROJECTION_SOURCE_LEDGER_CATEGORY_UNKNOWN` 整个读面失败）。 | ✅ |
| FR-14.4 | 双向完整性：`MemberInstance.childSessionId ↔ SessionBinding` 矛盾时新 Team work fail-closed，不猜测；DSH 历史读取保持可用。 | ✅ |
| FR-14.5 | 启动：`bootPhase=create-or-open` 重启安全（adopt 已有 `team_domain` 或初始化新介质）；D-1 "stamped-no-identity" 自愈三分支。 | ✅ |
| FR-14.6 | 团队会话激活围栏（0.1.7+）：Team-owned Session 只允许 Team 自己发起的 create/resume；DSH 普通 SessionController 对 Team-owned Agent 的激活在 `agent/created` barrier 中 fail-closed 并由 upstream 回滚；durable existence 用公开 `sessionPersistence.stat()`（不猜文件布局）；"以普通模式打开"需 `team.prepareOrdinaryOpen` 一次性许可。 | ✅ |
| FR-14.7 | 冷恢复：按 SessionBinding 判定 ordinary / root / member；root/member 读 TeamDomain 恢复 Team scoped 行为于首个 Team-sensitive step 之前；**重新**探测外部环境；不依赖 live 目录中的蓝图文件（frozen registry 行供给）。 | ✅ |
| FR-14.8 | 重启后不自动唤醒成员、不重放完成/审批通知；`team_collect` + `team_list_pending_control` 为恢复路径；pending leg、升级链、终态、警告确认均可重建；Admin-required case 不会重建成假 pending。 | ✅ |
| FR-14.9 | 投影读取侧恢复（2026-09-27 事故修复）：传输层抖动不再被当成 round-trip 证据（请求序 `requestSeq/lastCompletedSeq/openLossSeq/epoch`）；冷读失败不断言"无团队"；per-target-team prober（兼容性重检打对团队）；`pullProjection` 返回闭合 `ProjectionSyncAssessment`。 | ✅ |
| FR-14.10 | 所有权与多团队：一 root 一团队；一宿主多团队（`team.listRoots`）；per-team 操作串行链（共享 coordinator）保证"读/探测与准入互斥于同一团队"；成员 child session 归属索引；UI 读取**不得**自动唤醒成员。 | ✅ |
| FR-14.11 | Root fork（DSH 原生）→ 懒式 sidecar 识别：新 TeamSession、同 Blueprint snapshot、零成员、crash-safe 顺序、幂等；成员 child fork → 普通独立会话，不推断任何 Team 绑定。 | ✅ |
| FR-14.12 | Start Team from Here：`handoff.prepare` 恰好一次读取源会话公开 canonical surface，做 **非模型** 确定性摘要（title + bullets）；`handoff.create` 以 `(sourceSessionId, requestToken)` 幂等创建新团队；创建后 B 不能 history_read/search A；`handoffSourceSessionId` 仅作 provenance。 | ✅ |
| FR-14.13 | 重启实测事件：kill 后立即重启同 root 可能撞 live（`cannot prepare session while it is live`），重试一次即成功；非 directive root 冷恢复曾丢失 leader 面（REPORT F2，后续 D 系列修复）。 | 🟡 |

### FR-15 Skills 与模型路由

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-15.1 | 插件自带 2 个 Skill（Leader 操作手册、蓝图编写与预检），对 Leader/成员模型可见（受 `capabilities.skills` 治理）。 | ✅ |
| FR-15.2 | 模板 `capabilities.skills` allow/deny 治理 Team 管理的 skills；运行时 override 可收紧/放宽；外部硬策略最终否决。 | ✅ |
| FR-15.3 | 成员从首个 turn 起按 `modelPreference` 路由；无则 `staticModel`；运行时 durable override 优先；UI 通过"生效配置 → 设置覆盖（capability=model）"改模型。 | ✅ |

### FR-16 工件读取（strict-read + core-spill）

| 编号 | 细则 | 状态 |
| --- | --- | --- |
| FR-16.1 | Team 成员在 strict-read 下能读回 **自己** 产生的 DSH spill 产物（工作区外），不放松其他越界读；授权依据是运行时认证的 `(InstanceId, artifact)` 归属，不是"模型知道路径"。 | ✅ |
| FR-16.2 | 实现：Team 感知 spill provider 在 `saveText` 后向 `TeamArtifactAuthority` 记录 durable `artifact-read-granted` 事实 + 运行时 registry；读闸据此放行；非 Team 会话与上游等价。 | ✅ |
| FR-16.3 | 该事实归入台账 `control` 类别但不计入人工审批/pending 计数，并从事件面板隐藏。 | ✅ |

---

## 5. 非功能需求

| 维度 | 要求与现状 |
| --- | --- |
| 安全 | fail-closed 贯穿：未知工具 FATAL、无匹配 → deny、undetermined 吸收、成员永不 resolver、claim 不可信、`human-admin` 不可伪造、外部硬策略绝对封顶、授权 marker 绑定执行身份、allow 一次性消费、hostile listener 不可绕过 |
| 幂等与一致性 | 所有变更操作携带 `requestToken` 或 CAS（`expectedGeneration`、`baseGeneration/baseSnapshotId`）；重放零副作用；per-team 串行链 |
| 审计 | append-only TeamLedger；每个治理变更有 provenance（actor、reason、generation）；通知不是审计；corrupt 行可见 |
| 可恢复 | durable-before-ack；重启重建；通知 best-effort 但权威在 durable 事实 |
| 兼容性 | 宿主精确版本 pin；Remote v1–v9 向后兼容；Blueprint v1/v2 可列不可跑；wire 与 schema 版本正交 |
| 性能 | 投影 3 秒轮询（轻探针 + 按需全拉）；蓝图目录每请求重扫（大目录/大文件有 11 秒解析极端案例，CST-1）；无性能 SLO |
| 可观测 | 台账 + 投影 + `team_inspect_config` 纯读；`capability-runtime-event` 遥测；corrupt 警告条 |
| 可测试 | 9 包 vitest；characterization harness 对 pristine 宿主；`tests/kits` 实宿主 smoke kits（c1、rc2、F15、pr-a…pr-f、send-message、wakeup、projection-recovery、team-view-sync E2E）；`p4t6` SessionEvent 词汇扫描禁止 legacy 词汇回流；`zero-core` 检查 |
| 国际化 | zh/en |
| 平台 | Node ^22.19 || >=24；pnpm 11.7；Windows 路径（file:// 正斜杠）有专门处理 |

---

## 6. 已知限制、缺口与欠债登记

来源：`.agents/skills/*`"Known gap"、`docs/plans/memo/post-alpha4-debt-register.md`、`tests/mock/evidence/REPORT.md`、客户端代码注释。标记 [V] = 仓库协调者亲自复现，[L] = 子代理实测未复现。

### 6.1 产品能力缺口

| # | 缺口 | 影响 | 来源 |
| --- | --- | --- | --- |
| G-1 | Human Admin 无 resolver；shell 类 `allow→ask` 收紧后该命令永久不可用，无 UI 释放入口 | 治理操作可能"单向关门" | skill 文档、ADR A1-12 |
| G-2 | 兼容性"确认警告"按钮永久禁用（wire 只给聚合计数） | 创建后出现的 WARNING 只能靠重新检查，无法逐项确认 | TeamGovernance.tsx |
| G-3 | 自定义预设 id 不能满足 `standard` persona 需求（客户端按 id 表猜 kind） | 只能删除 persona 需求绕过 | skill §4.1 |
| G-4 | UI 建队路径对含必需 mcp/tool 需求的蓝图结构性阻断（客户端不构造这些域事实） | 这类蓝图只能经行配置启动 | REPORT T1.4 |
| G-5 | 声明 `permissions` 的蓝图在常规宿主预设上因 Coverage Gate 无法建队（19 个工具被判未受管） | 严格权限模板实际只能配 `minimal` 预设 | TM-4 [V]/[L] |
| G-6 | 裁决后 Leader 侧控制请求消息不清除 → Leader 反复被唤醒 | 成本与噪音；真正待裁决项被淹没 | CTL-1 [V] |
| G-7 | `team_report_progress` 非确定性挂起导致 root 死锁 | 运营禁令：成员提示词禁用该工具 | REPORT F3 |
| G-8 | 同步委派 + 审批门 = Leader 无法自决（调度限制） | 必须走异步默认 | skill §5.1 |
| G-9 | 完成/审批/权限通知均 best-effort，不重放 | 重启后依赖 collect/pending list | wakeup 架构 §9 |
| G-10 | Dock"打开团队标签页"是 no-op；设置页仍是 legacy 文案 | 可发现性与一致性 | client 代码 |
| G-11 | 无 Blueprint Web 编辑器、无 Blueprint CRUD Remote、无 revision 变化提示 | 作者面依赖 CLI + 文件 | blueprint-authoring.md |
| G-12 | `.dsh/teammates` 导入适配器未接入 | legacy 用户无 UI 迁移入口 | packages/legacy |
| G-13 | pending 控制请求无超时/撤回语义 | 由裁决 C-7 决定 | debt register §4 |
| G-14 | 成员→成员直连需要 overlay 手工授权 `messagingPeerDirect`，无 UI 入口 | 默认全部经 Leader 中转 | mediation.ts |

### 6.2 UI 质量缺陷（操作员 2026-10-12 现场）

UI-1 台账无折叠/置顶；UI-2 行排版破损与 payload 裁断；UI-3 刷新按钮跳动；UI-4 刷新长尾极慢（未定位）；UI-5 面板状态矛盾 + 悬浮面板遮挡；F5 需整页 reload 收敛；F11 非首团队 ledger 静默截断。

### 6.3 蓝图解析与身份（对抗测试 2026-10-12）

PRS-1 递归 YAML 别名导致未分类 `RangeError` 且 inspector 与 parser 结论不一致 [V]；PRS-2 非 `YAMLError` 解码失败吞诊断 [L]；ID-1 同 `blueprintId@revision` 内容可原地改写且创建协议不带 contentHash 钉 [L]；ID-3 目录中任一重复/不可读文件使整个 catalog 与 create 失败 [L]；ID-4 revision 字符串/数字双身份空间（`"01"`/`"1"`、`revision: v2` 使整个 catalog 抛错）[L]；ID-7 `revision: 1`（未加引号）因 YAML 类型强制被静默拒绝 [L]；WH-5 零宽字符造成视觉同名 [L]。

### 6.4 待操作员裁决的语义问题（debt register §4）

C-1 授权路径 Unicode trim 策略；C-2 成员 exec overlay 是否禁写 allow；C-3 无命中 fallback 是否取各层最严；C-4 文档级硬预算；C-5 Coverage Gate §7.1 不变量是否重裁（建议不重裁）；C-6 ROUTER_RULES 增条；C-7 CTL-1 终结语义；C-8 UI-1 折叠默认形态。

### 6.5 验收状态

Alpha.4：PR0–PR7 全部合入；**人工验收（Alpha.3 九步权限面）NOT_RUN**；阶段关闭 pending。全套单测存在长期基线失败集（runtime 6 文件/8 测试 + 3 collection error；client 3 个预存失败），每轮以"失败集恒等"而非"全绿"为门。

---

## 7. 版本演进与路线

| 时间 | 里程碑 | 要点 |
| --- | --- | --- |
| 2026-08-27 → 08-29 | 架构基线、兼容性设计、UI 交互设计、无人值守规范四份文档冻结 | 对象模型、67 条不变量、UI 65 条不变量 |
| 2026-08-29 → 09-04 | P0–P9（9 包骨架 → 完整实现）、T12 生产垂直 GO、P9 UI GO、upstream 0.1.2-rc.1 兼容 | 第一个可用产品 |
| 2026-09-05 | `0.1.0-rc.1` stable 冻结；plugin-bundle-form（一条命令安装）；prebuilt artifacts（零 allowBuilds）；remote-mount-race 修复 | 安装体验 |
| 2026-09-07 | tests/mock 全功能真实模型回归（REPORT 9 项 finding） | 质量基线 |
| 2026-09-11 → 09-18 | Alpha.1（能力接线）、Alpha.2 能力补全（teamTools/builtinToolDeny/skills/mcp/permissions、Coverage Gate、subtree、pwsh、外部硬 last-mile、`team_inspect_config`）、权限边界加固 | 治理基础 |
| 2026-09-17 / 09-24 / 10-03 | 宿主升级 0.1.5-rc.2 → 0.1.7-rc.1 → 0.2.0-rc.2 | 跟随 DSH |
| 2026-09-18 → 09-28 | exec 自治契约（双闸）、C1 Leader 审批可达性（`team_list_pending_control` + 通知）、multi-MCP、strict-read core-spill、work-completion wakeup、send_message liveness、模型偏好路由、**异步默认**（09-27）、投影读取侧恢复、重启激活围栏 | 无人值守能力 |
| 2026-09-30 → 10-02 | pre-Alpha.3 重构系列（PR #37–#50）：单一 authority graph、五层能力模型、persona kind、Recovery 模式、Control 泛化 | 架构收敛 |
| 2026-10-01 | Alpha.3 权限生命周期（PR #57–#61）：grant/revoke overlay、`permissionMutationEnvelope`、变更通知、`override.mutatePermission/getPermission` | durable 权限 |
| 2026-10-07 → 10-10 | Alpha.4 硬治理（PR0–PR7）：Blueprint v3 + `teamHardEnvelope`、authority 阶梯、有效 ceiling 代数、ApprovalCase/升级、Intervention v8、权限管理 UI、A1-14 消费点重校验、v3-only cutover、corrupt leg 读面 v9 | 审批规范化 |
| 2026-10-12 | post-Alpha.4 欠债登记（对抗测试 9 向量 + 两路历史盘点） | 当前 |
| 后续（登记未排期） | Human Admin resolver 或预检拒绝"单向门"声明；CTL-1 终结事件；UI-1～UI-5；TM-5/TM-8；网络能力归属（web_fetch/web_search 走 MCP）；proposal 原子性与 base-scoped dedup；`leader-approval/user-approval` carrier 清理与 `team.resolveControl`/`intervention.act` 合并；durable 通知重放/wake budget/多 recipient；设置页更新；Blueprint 编辑器 | backlog |

---

## 8. 产品评估（PM 视角观察）

**做得突出的地方**

1. **身份模型清晰**：Blueprint / Template / Session / Instance 四层分离，`instanceId` 寻址，一个模板多实例并行，解决了 legacy "一角色一激活"的根本限制。
2. **无人值守闭环完整**：异步默认 + 完成唤醒（idle→followup / running→steer 自然合并）+ 审批通知 + `requestToken` 幂等 + `team_collect` 恢复路径，是面向长时自治团队的关键设计。
3. **治理模型严谨**：能力存在性与操作权限分层；durable overlay 完整快照；两份 envelope 分别封顶 Leader 与 Human；"扩权需审批、收紧即生效"；undetermined 吸收；一次性 allow 消费并在消费点重校验。
4. **可解释性**：生效配置带 provenance / suppressed / unavailable / effectiveFrom；"团队裁决已允许 / 执行被托管策略阻止"分开显示；corrupt 记录显式可见。
5. **零 upstream 补丁 + 一条命令安装**，宿主升级成本低。

**主要风险与短板**

1. **可用性债务重**：Coverage Gate 让声明权限的蓝图在默认预设上建不起团队；UI 建队对必需 mcp 需求结构性阻断；自定义预设 persona 误判；这些使"严格治理"在真实部署中需要大量绕行。
2. **治理面"单向门"**：无 Human Admin resolver 却允许产生需要 Admin 的 case，产品上应在预检阶段拒绝或提供释放入口。
3. **团队标签页信息架构**：台账无折叠/置顶，审批裁决效率低；Dock 跳转 no-op；设置页陈旧；缺少设计文档中的 Team Header / Instance Detail 分栏。
4. **通知与唤醒**：裁决后 Leader 被重复唤醒（CTL-1）、`report_progress` 挂起死锁（F3）直接影响无人值守成本与可靠性。
5. **作者体验**：蓝图只能文件 + CLI；版本/身份字段的 YAML 类型陷阱（`revision: 1` 被静默拒绝）与目录"一坏全坏"半径。
6. **交付与验收口径**：工程纪律极严（merge ≠ acceptance），但 Alpha.4 人工验收未跑、长期存在的单测基线失败集说明产品尚处 alpha。

---

## 附录 A 术语表

| 术语 | 定义 |
| --- | --- |
| TeamBlueprint | 可复用静态团队定义及版本化语义（YAML frontmatter） |
| Blueprint snapshot | TeamSession 创建时冻结的 Blueprint 语义（`blueprintId, revision, contentHash`） |
| TeamIntent | 真实 TeamSession 创建前的 Team 拥有的 staging 对象 |
| TeamSession | Root Session 对一个 Blueprint snapshot 的 Team 绑定，id = RootSessionId |
| LeaderTemplate / MemberTemplate | 唯一 Leader 的静态定义 / 可实例化 0..N 次的成员角色模板 |
| LeaderInstance | Root Agent/Session，统一成员模型中的特殊实例，`inst-leader` |
| MemberInstance | 拥有持久 identity、child Session、workspace、context、overlay、lifecycle 的执行实体 |
| ActivationProvider | 所有 MemberInstance 创建的统一 authority/validation seam（quota、envelope、兼容性、冻结创建字段、分配 id、provision child、持久绑定） |
| TeamDomain | Team control-plane durable sidecar authority |
| TeamLedger | Team-wide 协调事实的 durable 时序台账 |
| SessionBinding | DSH SessionId 与 Team root/member 身份的 TeamDomain 关联 |
| Admission State | 是否允许新 Team work 进入执行系统 |
| Compatibility | Blueprint requirements 与当前 substrate/environment 的匹配状态 |
| PolicyState | TeamSession 级运行治理模式 |
| Autonomy Overlay / Explicit Human Override | Agent 在 envelope 内的运行时 override / 人类明确设置的 durable override |
| External Hard Policy | 宿主安全/能力上限，任何 Team actor 不可越过 |
| permissionMutationEnvelope / teamHardEnvelope | Leader 扩权上限 / Human User 扩权上限（Alpha.4 v3 必填） |
| RuntimeAuthority | `member < leader < human-user < human-admin` |
| ApprovalCase / leg | 一个逻辑审批流 / 其中一个不可变 ControlRequest 审阅段 |
| InterventionItem | 对 approval/warning/error 的统一观察与操作投影 |
| Residency | 持久成员当前是否有 live Agent 驻留进程（resident/resuming/cold） |
| Restore / Resume… | `ARCHIVED → SETTLED` 仅恢复可用性 / 向 SETTLED 成员发新工作并可能冷恢复 |
| Work unit | 一次 delegate/follow_up 准入的工作单元，身份 `(rootSessionId, requestToken)` |
| Legacy Team Session | 旧架构产生的 Team Session，vNext 中只读 |
| CORE PATCH BUDGET = 0 / CORE_SEAM_BLOCKER | 零 upstream 补丁红线 / 缺公开 seam 时的阻塞输出 |

## 附录 B 关键文件索引（相对 `dsh-agent-team/`）

| 主题 | 路径 |
| --- | --- |
| 架构 / UI 冻结基线 | `docs/plans/finished/DSH_Agent_Team_vNext_Detailed_Architecture_20260829.md`、`..._Detailed_UI_Design_20260829.md` |
| 安装与配置 | `docs/INSTALL.md`、`cordis.patch.yml`、`package.json` |
| Leader 操作手册 / 蓝图编写 | `.agents/skills/team-leader-operations/SKILL.md`、`.agents/skills/team-blueprint-authoring/SKILL.md`、`docs/blueprint-authoring.md` |
| Alpha.4 治理 | `docs/plans/active/alpha4-permission-governance/{ADR-alpha4-hard-governance,alpha4-permission-governance-spec,alpha4-implementation-plan}.md` |
| 异步唤醒 / 消息 liveness / 审批可达性 | `docs/plans/finished/dsh-agent-team-work-completion-wakeup-architecture.md`、`team_send_message_liveness_fix_guide.md`、`dsh-agent-team-c1-leader-approval-repair-plan.md` |
| 能力/权限 | `docs/plans/finished/dsh-agent-team-alpha2-capability-completion-plan.md`、`...-alpha2-permission-boundary-hardening.md`、`dsh-agent-team-exec-autonomy-contract-plan.md`、`dsh-agent-team-pre-alpha3-target-system-design.md` |
| 欠债与实测 | `docs/plans/memo/post-alpha4-debt-register.md`、`tests/mock/evidence/REPORT.md`、`docs/issues/team-persona-requirement-preset-id-bug-report.md`、`docs/repairs/team-projection-recovery-20260927.md` |
| 工具 | `packages/tools/src/{tools,guard,tool-selector,builtin-deny,tokens}.ts` |
| 领域规则 | `packages/domain/{blueprint,lifecycle,policy,authority-envelope,compatibility,member}/src/` |
| 契约 | `packages/contracts/src/{dto,projection}/`、`errors.ts` |
| 远程 API | `packages/remote/src/contracts/{catalog,params,types,version,errors}.ts`、`handlers/`、`push/` |
| 运行时 | `packages/runtime/src/plugin/{host,root,s6-remote,s6-principal,permission-plane,team-skills,team-spill-local,workspace-attach,handoff-surface}.ts`、`packages/runtime/{action-router,control,governance,messaging,work-completion-notification,member-residency,fork-reconciliation,handoff,readiness,artifact-read}/` |
| 客户端 | `packages/client/src/plugin/{client,team-mount-core}.ts`、`ui/*.tsx`、`model/*.ts`、`state/*.ts`、`ui/locales.ts` |
| legacy | `packages/legacy/`（session-reader、teammates-adapter）、`docs/migration/` |

## 附录 C 错误码速查（节选）

| 域 | 代码 |
| --- | --- |
| 契约（20） | `INVALID_SESSION_ID / INVALID_ROOT_SESSION_ID / INVALID_CHILD_SESSION_ID / INVALID_INSTANCE_ID / INVALID_TEMPLATE_ID / INVALID_BLUEPRINT_ID / INVALID_BLUEPRINT_REVISION / INVALID_BLUEPRINT_CONTENT_HASH / IDENTITY_SCOPE_MISMATCH / DUPLICATE_INSTANCE_ID / DUPLICATE_TEAM_SESSION / SESSION_ALREADY_BOUND / MEMBER_NOT_FOUND / LEGACY_MEMBER_ID_REJECTED / LEGACY_TEAM_SESSION_EVENT_REJECTED / SCHEMA_VERSION_MISMATCH / SCHEMA_VERSION_UNSUPPORTED / MALFORMED_DTO / REMOTE_VALUE_NOT_JSON / TEAM_PERSONA_COMPLETE_PRESET_CONFLICT` |
| 插件 | `TEAM_PLUGIN_CONFIG_INVALID / TEAM_PLUGIN_GLUE_UNAVAILABLE / TEAM_PLUGIN_SERVICE_MISSING / TEAM_PLUGIN_PERMISSION_AUTHORITY_UNAVAILABLE / TEAM_PLUGIN_WORKSPACE_NOT_FOUND / TEAM_PLUGIN_WORKSPACE_ATTACH_FAILED / TEAM_DOMAIN_EXISTS / SCHEMA_STAMP_MISSING / TEAM_HANDOFF_SOURCE_SURFACE_UNAVAILABLE` |
| 蓝图 | `TEAM_BLUEPRINT_REVISION_FROZEN / TEAM_BLUEPRINT_REVISION_DUPLICATE / TEAM_BLUEPRINT_FILE_UNREADABLE / BLUEPRINT_SCHEMA_VERSION_UNSUPPORTED / BLUEPRINT_MIGRATION_REQUIRED / TEAM_RUNTIME_BLUEPRINT_HASH_MISMATCH` |
| 运行时准入 | `TEAM_RUNTIME_QUOTA_EXCEEDED_* / TEAM_RUNTIME_ENVELOPE_OUT_OF_BOUNDS / TEAM_RUNTIME_INITIAL_WORK_ALREADY_ADMITTED / DELEGATION_TARGET_AMBIGUOUS / WORKSPACE_MUTATION_FORBIDDEN / COMPATIBILITY_BLOCKED` |
| 生命周期 | `LIFECYCLE_ILLEGAL_TRANSITION / LIFECYCLE_TERMINAL_STATE` |
| 工作/消息 | `WORK_DELIVERY_FAILED / DURABLE_WRITE_FAILED / MESSAGING_TARGET_NOT_LIVE / MESSAGING_*` |
| 控制 | `CONTROL_RESOLVER_NOT_AUTHORIZED / CONTROL_REQUEST_NOT_FOUND / CONTROL_REQUEST_STALE / CONTROL_REQUEST_DECIDED / INTERVENTION_NOT_FOUND`；guard 原因 `request-pending / decision-deny / request-stale / allow-consumed / scope-mismatch / target-stale` |
| 权限 | `PERMISSION_AUTHORITY_CEILING_INSUFFICIENT / PERMISSION_EXPANSION_OUTSIDE_ENVELOPE / PERMISSION_EFFECT_CONTEXT_UNAVAILABLE / PERMISSION_MUTATION_NOT_CONFIGURED / PERMISSION_LIFECYCLE_INSTANCE_UNKNOWN / OVERRIDE_GENERATION_CONFLICT / OVERRIDE_IDENTITY_CONFLICT`；pre-execute 能力失败 `alpha4-external-runtime-restriction / alpha4-host-environment-unavailable` |
| 工具层 | `TEAM_TOOL_BAD_ARGUMENTS / TEAM_TOOL_CALLER_UNRESOLVED / TEAM_TOOL_CALLER_ROOT_MISMATCH / TEAM_TOOL_PENDING_LIST_NOT_LEADER / TEAM_TOOL_ARCHIVE_NOT_LEADER / TEAM_TOOL_PERMISSION_NOT_LEADER / TEAM_TOOL_PERMISSION_UNWIRED / TEAM_TOOL_PERMISSION_CANONICALIZE_FAILED` |
| 远程边界 | `contract-version-unsupported / unknown-method / malformed-request / malformed-params / method-version-unsupported / internal-error / TEAM_REMOTE_FOREIGN_TEAM / TEAM_REMOTE_PRINCIPAL_INVALID / TEAM_REMOTE_LEDGER_PAGE_REJECTED` |
| 兼容性 reason | `CAPABILITY_UNAVAILABLE / COMPLETE_REQUIREMENT_NOT_MET / STRUCTURAL_CAPABILITY_MISSING / PERSONA_INCOMPATIBLE / TEAM_PERSONA_COMPLETE_PRESET_CONFLICT` |
