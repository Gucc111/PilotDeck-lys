# Team 模式功能详解 · 模块 1：团队创建与配置

> 面向用户的功能说明。本文只描述当前已实现、用户可以实际使用的功能。
> 上级文档：[Team 模式用户功能清单](../team-mode-user-features.md)

---

## 1. 这个模块解决什么问题

一个团队从"想法"到"可以开始干活"要经过两步：

1. **定义团队**：写一份蓝图文件，描述团队有哪些角色、各自是什么性格、能用什么工具、受什么限制。蓝图可以反复使用，一份蓝图可以建很多个团队。
2. **创建团队**：在界面上选一份蓝图，选工作目录和运行预设，系统检查环境是否满足要求，然后创建出一个带 Leader 的团队会话。

本模块覆盖这两步的全部用户可配置项和界面操作。

---

## 2. 团队蓝图：用户能为团队定义什么

### 2.1 蓝图文件长什么样

蓝图是一个 YAML 文件，整个文件被两行 `---` 包起来，中间全是字段，**不能有正文**。一个最小可用的蓝图：

```yaml
---
schemaVersion: 3
blueprintId: my-research-team
revision: "1"
displayName: "研究团队"
description: "一个 Leader 带两类成员的研究团队。"

leader:
  templateId: leader
  persona: |
    你是这个团队的领队。
    你负责拆解任务、分派给成员、汇总结果。

members:
  - templateId: researcher
    displayName: "研究员"
    persona: "你是团队的研究员，负责资料调研。"
  - templateId: writer
    displayName: "撰稿人"
    persona: "你是团队的撰稿人，负责把调研结果写成文章。"

requirements:
  - domain: persona
    name: standard

teamEnvelope:
  allow: [assign-task, create-member, send-message, report-progress, request-control, resolve-control, archive-member, restore-member]
  deny: []

memberEnvelopes:
  - templateId: researcher
    envelope:
      allow: [send-message, report-progress, request-control]
      deny: []
  - templateId: writer
    envelope:
      allow: [send-message, report-progress, request-control]
      deny: []

policyStates:
  - id: default
    description: "默认状态。"

quotas:
  team:
    maxInstances: 12
    maxConcurrent: 12
  members:
    maxInstances: 4
    maxConcurrent: 4

permissionMutationEnvelope:
  rules: []
teamHardEnvelope:
  rules: []

metadata: {}
---
```

### 2.2 字段总览

蓝图顶层只允许下面这些字段，多写任何一个字段整份蓝图都会被拒绝。

| 字段 | 必填 | 作用 |
| --- | --- | --- |
| `schemaVersion` | 必填 | 蓝图格式版本，当前必须写 `3` |
| `blueprintId` | 必填 | 蓝图的唯一标识，机器用 |
| `revision` | 必填 | 修订号，同一个蓝图改动后递增 |
| `displayName` | 可选 | 界面上显示的团队名称 |
| `description` | 可选 | 团队的一段说明 |
| `leader` | 必填 | 领队角色的定义，恰好一个 |
| `members` | 可选 | 成员角色模板列表，可以为空 |
| `requirements` | 可选 | 团队运行需要环境提供的能力 |
| `teamRequirements` | 可选 | 结构化写法的团队级能力需求 |
| `teamEnvelope` | 可选 | 团队内 AI 自己能做哪些协作动作 |
| `memberEnvelopes` | 可选 | 按角色收窄协作动作范围 |
| `policyStates` | 可选 | 团队的运行治理模式定义 |
| `quotas` | 可选 | 成员数量上限 |
| `capabilityPolicy` | 可选 | 团队级一刀切地关掉某类能力 |
| `permissionMutationEnvelope` | **v3 必填** | Leader 给成员放宽权限时的上限 |
| `teamHardEnvelope` | **v3 必填** | 人类给成员放宽权限时的上限 |
| `metadata` | 可选 | 自由的键值对备注 |

下面逐个说明。

### 2.3 身份字段

| 字段 | 规则 | 用户要注意 |
| --- | --- | --- |
| `schemaVersion` | 只接受 `3`。写 `1` 或 `2` 的旧蓝图会在列表中显示为"需要迁移"，但不能用来建队 | 旧蓝图不会被自动升级，需要手工改成 v3 格式并补齐两个权限上限字段 |
| `blueprintId` | 1 到 128 个字符，不能有空格、不能有 `@`、不能有控制字符 | 这是机器标识，改名不会改变它。界面显示用 `displayName` |
| `revision` | 一个正整数，**建议加引号写成字符串** `"1"` | 不加引号写 `1` 在部分情况下会被当成数字而解析失败，文件会从列表中静默消失 |
| `displayName` | 最长 128 字符，单行 | 界面下拉框里显示的名字；缺省时显示 `blueprintId` |
| `description` | 最长 4096 字符，可以多行 | 在创建面板的蓝图详情里显示 |

**修订号的含义**：已经创建的团队永远绑定创建时的那一版蓝图。要改团队设计，新建一个同 `blueprintId`、更高 `revision` 的文件；新建的团队用新版，老团队不受影响。直接改老文件对已有团队无效，还可能导致建队时报内容不一致。

### 2.4 角色定义：`leader` 与 `members`

`leader` 是一个角色对象，`members` 是角色对象的列表。两者格式完全相同，区别只在位置：写在 `leader` 下的是领队，写在 `members` 下的是成员模板。

| 字段 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- |
| `templateId` | 必填 | 小写字母开头，只能用小写字母、数字、连字符，最长 64 | 角色的机器标识，整份蓝图内不能重复（领队和成员一起算） |
| `displayName` | 可选 | 最长 128，单行 | 界面上显示的角色名 |
| `description` | 可选 | 最长 4096，可多行 | 角色说明 |
| `persona` | **必填** | 非空，最长 32768，可多行 | 这个角色的"人设"：它是谁、负责什么、怎么工作。会成为该角色 AI 的身份提示。写长文本用 YAML 的 `|` 块写法 |
| `modelPreference` | 可选 | `厂商/模型名` 或只写 `模型名` | 让这个角色从第一轮就使用指定模型。只写模型名时沿用部署默认的厂商。不写则用部署默认模型 |
| `contextPolicy` | 可选 | `persistent` 或 `fresh_per_delegation` | 见 2.5 |
| `capabilities` | 可选 | 见 2.6 | 这个角色能用什么工具、技能、外部服务，以及文件和命令的权限 |
| `requirements` | 可选 | 见 2.7 的结构化写法 | 这个角色运行所需的环境能力 |

**领队必须有非空的 `persona`**，这是最常见的建队失败原因。一个只定义成员、不定义领队的蓝图是无效的。

### 2.5 工作模式：`contextPolicy`

决定 Leader 多次把任务派给同一个角色时，是复用同一个成员还是新建成员。

| 值 | 行为 | 适合 |
| --- | --- | --- |
| `persistent`（默认） | Leader 向这个角色派新任务时，优先续用已有的、空闲的那个成员，它记得之前所有对话 | 需要上下文延续的角色，例如长期跟进一个方向的研究员 |
| `fresh_per_delegation` | Leader 每次向这个角色派新任务都创建一个全新成员，彼此互不干扰 | 可并行、彼此独立的任务，例如同时处理多个数据文件 |

两种模式下，Leader 如果明确指定"给成员 A 继续派活"，都会续用 A，不会新建。

界面提示：在"创建成员实例"对话框里，`fresh_per_delegation` 模板会显示一行提示"新的委派会创建新实例。"

### 2.6 角色能力：`capabilities`

不写 `capabilities` 时，这个角色处于"宽松模式"：拿到全部团队协作工具，不做文件和命令级权限管理。

一旦写了 `capabilities`，下面四个子字段**都必须写**，第五个可选：

```yaml
capabilities:
  teamTools:
    kind: allow
    items: [team_report_progress, team_send_message, team_request_control]
  builtinToolDeny: [subagent_fork]
  skills:
    kind: allow
    items: []
  mcp:
    kind: allow
    items: [my_search_server]
  permissions:          # 可选
    default: ask
    allow:
      - { tool: read,  resource: { kind: subtree, path: ./docs } }
      - { tool: write, resource: { kind: exact,   path: ./out/report.md } }
    ask:
      - { tool: bash,  resource: { kind: any } }
    deny:
      - { tool: read,  resource: { kind: exact,   path: ./secrets.env } }
```

#### `teamTools`：这个角色能用哪些团队协作工具

- `{ kind: allow, items: [...] }`：只给列出的工具。
- `{ kind: deny }`：一个团队协作工具都不给。
- 可填的工具名共 15 个，见模块 3 文档。常见搭配：
  - 领队：全部 15 个，或至少 `team_list_templates`、`team_delegate`、`team_collect`、`team_follow_up`、`team_send_message`、`team_list_pending_control`、`team_resolve_control`
  - 成员：`team_report_progress`、`team_send_message`、`team_request_control`
- 列表里写了不认识的名字会被忽略，不报错。
- 工具只决定"AI 看得见这个工具"，不等于"有权执行"。例如给成员 `team_archive_member`，它调用时仍会被拒。

#### `builtinToolDeny`：禁掉哪些系统自带工具

- 一个字符串数组，写系统内置工具的准确名字，例如 `bash`、`write`、`edit`、`subagent_fork`。
- 被列出的工具从这个角色的 AI 面前消失。
- 每个条目 1 到 128 字符。注意条目不会去掉首尾空格，写成 `"bash "` 会静默失效。
- 系统预设自带的 `subagent` 工具用这个方式禁不掉，列出来会导致建队失败。

#### `skills`：能用哪些团队技能

- 格式同 `teamTools`。
- 当前随插件附带两个技能：领队操作手册、蓝图编写手册。

#### `mcp`：能连哪些外部服务（MCP 服务器）

- 格式同 `teamTools`。
- `items` 里写部署配置中声明的服务器名；`*` 表示全部。
- `allow` 列表是这个角色的**初始授权**：团队创建后立即可用，无需再在界面上开。
- `deny`、空 `items`、或根本不写 `capabilities`，都等于不连任何外部服务。

#### `permissions`：文件和命令级的细粒度权限

这是最精细的一层。写了它，系统会对这个角色每一次读写文件、执行命令做检查。

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `default` | 必填 | `ask` 或 `deny`。没有任何规则命中时的兜底。**不允许写 `allow`** |
| `allow` | 必填 | 规则列表，命中即放行（可为空 `[]`） |
| `ask` | 必填 | 规则列表，命中即发起审批（可为空） |
| `deny` | 必填 | 规则列表，命中即拒绝（可为空） |

优先级：`deny` 高于 `ask` 高于 `allow`，都没命中走 `default`。

每条规则两个字段：

| 字段 | 可选值 |
| --- | --- |
| `tool` | `read`、`read_image`、`write`、`edit`、`lsp`（文件类）；`bash`、`pwsh`（命令类） |
| `resource` | `{ kind: exact, path: 某个文件 }`、`{ kind: subtree, path: 某个目录 }`（目录本身及其下所有文件）、`{ kind: any }`（整个工具） |

命令类工具（`bash`、`pwsh`）有特殊限制：

- 只能用 `{ kind: any }`，不能写 `exact` 或 `subtree`。
- **成员**角色不能把命令类工具放进 `allow`，只能放 `ask` 或 `deny`。成员要执行命令，每次都要 Leader 批准。
- **领队**可以把命令类工具放进 `allow`，但只有当 `teamEnvelope` 里同时写了 `bash` 或 `pwsh` 这个令牌时才真正自动放行；否则每次都转为人类审批。见 2.8。
- `bash` 和 `pwsh` 互不覆盖，要分别写。

路径写法：最长 1024 字符，相对路径以团队工作区为基准。

写了 `permissions` 的角色，建队时会多一道检查：这个角色 AI 面前的**每一个**工具都必须能被权限体系管到。系统自带的搜索、网络访问、子代理等工具目前管不到，会导致建队失败。实际使用中，严格权限的角色需要搭配工具最少的"最小"运行预设，或者把这些工具写进 `builtinToolDeny`。

### 2.7 环境要求：`requirements`

声明"这个团队要正常工作，环境里必须有什么"。创建团队前系统会逐项核对。

**简单写法**（顶层 `requirements`）：

```yaml
requirements:
  - domain: persona
    name: standard
  - domain: mcp
    name: my_search_server
    optional: true
```

| 字段 | 规则 |
| --- | --- |
| `domain` | `tool`、`skill`、`mcp`、`model`、`persona` 之一 |
| `name` | 能力的名字，小写字母开头，可含数字、`.`、`_`、`-`，最长 128 |
| `optional` | 默认 `false`。`false` = 缺了就不能建队；`true` = 缺了弹警告，用户确认后可以降级建队 |

同一个 `domain` + `name` 不能重复出现。

**结构化写法**（顶层 `teamRequirements` 或角色下的 `requirements`）：

```yaml
teamRequirements:
  - requirementId: req-search
    type: mcpServer
    subjects: [my_search_server]
    complete: false
```

| 字段 | 规则 |
| --- | --- |
| `requirementId` | 唯一标识，小写 slug |
| `type` | `tool`、`skill`、`mcpServer`、`modelRoute`、`persona`、`teamStructure` |
| `subjects` | 非空列表，每项小写 slug，不重复 |
| `complete` | 默认 `false`。`true` = 必需，缺了不能建队 |

**关于 `persona` 类要求**：`name` 或 `subjects` 只能写 `standard`，意思是"运行预设要提供可组合的标准人格"。它不是预设的名字。写别的值会直接解析失败。

### 2.8 协作动作范围：`teamEnvelope` 与 `memberEnvelopes`

这两个字段限制团队内的 AI **自己**能发起哪些团队协作动作。人类操作员不受此限制。

```yaml
teamEnvelope:
  allow: [assign-task, create-member, send-message, report-progress, request-control, resolve-control, archive-member, restore-member, bash]
  deny: [dispose-member]

memberEnvelopes:
  - templateId: researcher
    envelope:
      allow: [send-message, report-progress, request-control]
      deny: []
```

可用的动作令牌：

| 令牌 | 含义 |
| --- | --- |
| `assign-task` | 派任务、跟进任务 |
| `create-member` | 创建成员 |
| `send-message` | 发消息 |
| `report-progress` | 报告进度 |
| `request-control` | 发起审批请求 |
| `resolve-control` | 裁决审批请求 |
| `archive-member` | 归档成员 |
| `restore-member` | 恢复成员 |
| `dispose-member` | 处置成员 |
| `bash` / `pwsh` | 特殊令牌：允许领队**自动**执行命令（见 2.6） |

规则：

- 同一个 envelope 里，一个令牌不能同时出现在 `allow` 和 `deny`。
- `memberEnvelopes` 里的 `templateId` 必须是蓝图里定义过的角色，每个角色最多一条。
- **成员的实际范围 = `teamEnvelope.allow` 与该角色 `memberEnvelopes.allow` 的交集，再去掉两边的 `deny`。** 只给成员加、不给团队加是无效的。
- 领队的实际范围 = `teamEnvelope.allow` 去掉 `deny`；如果 `memberEnvelopes` 里也给领队写了一条，再与之求交。
- 不写 `teamEnvelope` 等于团队内 AI 什么协作动作都不能做。
- 写了但不认识的令牌会被接受但没有效果。

### 2.9 运行治理模式：`policyStates`

定义团队可以切换的几种"运行模式"。每种模式可以锁定一组能力开关。

```yaml
policyStates:
  - id: default
    description: "默认状态。"
  - id: locked-review
    description: "评审期：禁止改动工具配置。"
    fields: [teamEnvelope, capabilityPolicy]
```

| 字段 | 规则 |
| --- | --- |
| `id` | 小写字母开头，可含数字和连字符，最长 64，不重复 |
| `description` | 最长 4096，可多行 |
| `fields` | 这个模式关注的蓝图字段，只能从 `leader`、`members`、`requirements`、`teamEnvelope`、`memberEnvelopes`、`policyStates`、`quotas`、`capabilityPolicy`、`metadata`、`displayName`、`description` 中选，不重复 |

简单团队只写一个 `default` 即可。治理模式表达的是"现在允许怎样改配置"，**不是任务进度**，不要把"调研→开发→评审"写成治理模式。

切换治理模式在团队视图的"治理 → 策略状态"卡片里操作，见模块 5。

### 2.10 数量上限：`quotas`

```yaml
quotas:
  team:
    maxInstances: 12
    maxConcurrent: 8
  members:
    maxInstances: 4
    maxConcurrent: 2
```

| 字段 | 含义 |
| --- | --- |
| `team.maxInstances` | 整个团队累计创建过的成员总数上限（含已归档、已处置） |
| `team.maxConcurrent` | 整个团队同时处于"已创建"或"运行中"的成员数上限 |
| `members.maxInstances` | **每个角色模板**累计创建的成员数上限 |
| `members.maxConcurrent` | **每个角色模板**同时活跃的成员数上限 |

规则：

- 都是正整数，`maxConcurrent` 不能大于同一块的 `maxInstances`。
- 不写某一项等于不限制。
- `members` 下的两个值是**按角色各自计算**的，不是全部成员加起来。例如 `members.maxInstances: 4` 表示研究员最多 4 个、撰稿人也最多 4 个。
- 超限时 Leader 创建成员会收到明确的拒绝原因。

### 2.11 团队级能力开关：`capabilityPolicy`

```yaml
capabilityPolicy:
  mcp: deny
  skills: deny
```

- 键只能是 `model`、`tools`、`permissions`、`skills`、`mcp`。
- 值只能是 `allow` 或 `deny`。
- 实际效果：写 `deny` 的能力对整个团队关闭；写 `allow` 没有额外效果（具体授权仍看角色的 `capabilities`）。
- 用途：快速对整个团队禁掉某类能力，无需逐个角色改。

### 2.12 权限放宽上限：`permissionMutationEnvelope` 与 `teamHardEnvelope`

团队运行后，Leader 可以给成员临时放宽文件或命令权限，人类也可以。这两个字段分别规定 **Leader** 和 **人类** 最多能放宽到哪。v3 蓝图必须写，不能省。

```yaml
permissionMutationEnvelope:      # Leader 的上限
  rules:
    - operationClass: read
      matcher: { kind: subtree, path: ./data }
      maximumEffect: allow
    - operationClass: write
      matcher: { kind: subtree, path: ./out }
      maximumEffect: ask

teamHardEnvelope:                # 人类的上限
  rules:
    - operationClass: read
      matcher: { kind: subtree, path: . }
      maximumEffect: allow
    - operationClass: write
      matcher: { kind: subtree, path: . }
      maximumEffect: allow
```

每条规则：

| 字段 | 可选值 |
| --- | --- |
| `operationClass` | `read`、`read_image`、`write`、`edit`、`lsp`、`bash`、`pwsh` |
| `matcher` | 文件类：`{ kind: exact, path }` 或 `{ kind: subtree, path }`；命令类：只能 `{ kind: fingerprint, fingerprint: "..." }`（最长 256） |
| `maximumEffect` | `allow`、`ask`、`deny`，表示"最多能放宽到这个程度" |

理解方式：

- `rules: []` 表示"这个角色不能放宽任何权限"。对于只靠蓝图静态权限、运行中从不放宽的团队，写空数组是诚实且安全的。
- 一个放宽请求落在某条规则范围内时，放宽后的效果不能超过该规则的 `maximumEffect`。多条规则同时命中取最严的。
- 请求落在任何规则之外时，Leader 一侧视为"无权放宽"，直接拒绝。
- 收紧权限（例如把 allow 改成 deny）不受这两个字段限制，随时可做。
- 已知陷阱：如果用 Leader 工具把一条命令类权限从 `allow` 收紧到 `ask`，这条命令会永久无法执行，因为当前版本没有能批准它的更高层审批人，而且界面上没有解开的入口。要限制成员执行命令，用 `deny` 而不是 `ask`。

### 2.13 备注：`metadata`

```yaml
metadata:
  owner: "张三"
  purpose: "季度报告"
```

- 键：字母开头，可含字母、数字、`.`、`_`、`-`，最长 64。
- 值：字符串，最长 4096。
- 纯备注，系统不解释它。

### 2.14 蓝图文件放在哪、怎么生效

- 蓝图放在部署配置指定的蓝图目录里，一个文件一份蓝图（一个 `blueprintId` + 一个 `revision`）。
- 文件名随意，但不能包含路径分隔符。文件名和 `blueprintId` 没有关系。
- 后缀 `.yaml` 或 `.yml`。以 `.draft.yaml` / `.draft.yml` 结尾的是草稿，不会出现在列表里。
- 目录没有缓存：保存文件后，在"新建团队"面板点"刷新蓝图目录"立即可见；删除文件后下次刷新即消失。
- 两份文件写了同一个 `blueprintId` 和 `revision` 会让整个目录暂时无法列出，直到删掉其中一份。
- 部署没有配置蓝图目录时，只有部署内置的那一份蓝图可选。

本地辅助工具：

```bash
node scripts/blueprint-authoring.mjs stage <blueprintId> --dir <蓝图目录>
```

生成 `<blueprintId>.draft.yaml` 草稿供编辑，然后：

```bash
node scripts/blueprint-authoring.mjs validate-save <草稿路径> --dir <蓝图目录>
```

做格式检查后写成正式文件。注意这一步只检查结构和身份，更深的语义错误（例如领队 `persona` 为空）会在创建面板里选中该蓝图时才报出来。

### 2.15 蓝图常见错误

| 现象 | 原因 |
| --- | --- |
| 整份蓝图被拒 | 任何一处违规都会拒绝整份文件，不会"部分生效" |
| 文件根本不出现在列表里 | `revision` 没加引号被当成数字；`blueprintId` 含 `@` 或空格；两行 `---` 缺失 |
| 列表里有，选中后报错 | 结构通过但语义不通过：领队没有 `persona`、`templateId` 重复、envelope 里一个令牌同时出现在 allow 和 deny、`permissions.default` 写了 `allow`、成员的 `bash` 放进了 `allow` 等 |
| 列表里显示"需要迁移" | `schemaVersion` 是 1 或 2 |
| 建队时报"内容不一致" | 已有团队绑定的那一版蓝图文件被原地改动了。改设计请新建 revision |
| 成员要做某个协作动作被拒 | `teamEnvelope.allow` 里没有这个令牌，或者该角色的 `memberEnvelopes` 没有 |
| 严格权限的角色建队失败，提示若干工具"未受管" | 运行预设带了权限体系管不到的工具。换"最小"预设，或把这些工具写进 `builtinToolDeny` |

---

## 3. 创建团队：界面操作

### 3.1 两个入口

| 入口 | 位置 | 区别 |
| --- | --- | --- |
| **新建团队** | 侧边栏底部按钮。侧边栏展开时显示图标加文字，收起时只显示图标，悬停有提示 | 打开一个弹窗式创建面板 |
| **从此处开始团队** | 任何普通会话的"团队"标签页里 | 在当前标签页内展开创建面板，并带上"上下文交接"选项，可以把当前会话的内容摘要带给新团队的 Leader |

两个入口打开的面板内容相同，区别只在是否带交接。

点击入口不会创建任何会话。关闭面板也不会在侧边栏留下任何痕迹。

### 3.2 创建面板的每个字段

面板标题"新建团队"，从上到下：

**团队蓝图**（下拉框，必选）

- 列出蓝图目录里所有可用蓝图，每行显示 `displayName (rev N)`，没有 `displayName` 的显示 `blueprintId (rev N)`。
- 加载中显示"正在加载蓝图目录…"；目录为空显示"没有可用蓝图"；加载失败在下方显示"蓝图目录加载失败：具体原因"。
- 首次加载完成后出现"刷新蓝图目录"按钮。点它重新扫描目录。如果刷新后当前选中的蓝图不在了，选择会被清空。
- 选中后下方展开蓝图详情：显示名、来源、说明、角色模板数量。

**修订**（下拉框，选中蓝图后出现）

- 同一个 `blueprintId` 有多个 `revision` 时在这里选。默认选最新。

**默认工作区**（下拉框）

- 列出系统已登记的工作区，选一个作为团队的默认工作目录。
- 从"从此处开始团队"进入时会预填当前会话的工作区。
- 只能选已登记的工作区，面板不会替你新建目录。
- 系统没有登记任何工作区时这个下拉框不显示。

**运行时预设**（下拉框）

- 列出系统已配置的运行预设。预设决定团队 AI 的基础工具集和人格叠加方式。
- 下方提示文字："选择团队运行的 Agent 预设；切换会重新运行兼容性检查。"
- 预设列表为空时显示空状态。

**初始任务（可选）**（多行文本框）

- 占位提示："交给 Leader 的初始任务…"
- 填了之后主按钮会变成"创建并发送"，创建完成后立即把这段话作为第一条消息发给 Leader。

**上下文交接**（只在"从此处开始团队"入口出现）

- 显示"源会话："当前会话 ID""。
- 复选框"生成一次性摘要"，默认勾选。勾选后系统读取当前会话内容，生成一份摘要。
- 生成中显示"正在生成摘要…"；完成后显示"摘要已就绪"和"预览"按钮，点预览可以看到标题和要点列表。
- 生成失败显示"上下文交接失败：原因"，并给出三个按钮：**重试**、**不带交接继续**、**取消**。选"不带交接继续"后复选框变灰，这次创建不再带交接。
- 摘要是一次性的：新团队拿到的是这份摘要文本，不会获得读取原会话的能力。

**兼容性**（状态区，自动运行）

选中蓝图和预设后自动检查，显示以下之一：

| 显示 | 含义 | 对创建按钮的影响 |
| --- | --- | --- |
| 正在检查兼容性… | 检查中 | 禁用 |
| ✓ 就绪 | 环境满足全部要求 | 可用 |
| 警告列表 + 复选框 | 有可选能力缺失，逐项列出"需求 xxx 不可用 yyy"。下方复选框"我已了解上述降级，继续创建"，**默认不勾**，每次检查结果变化后自动取消勾选 | 勾选前禁用，勾选后主按钮变成"确认警告并创建" |
| ✕ 团队无法创建 | 有必需能力缺失，逐项列出原因 | 禁用，无法绕过 |
| 已按确认降级运行 | 之前已确认过的降级状态 | 可用 |

两种 ✕ 的常见文案：

- "该运行时预设拥有完整的系统人格，无法承载此团队蓝图的 Leader/Member 身份"：所选预设的人格是"完整型"，不能和团队角色人格叠加。换一个预设。
- "该运行时预设未提供团队所需的可组合标准人格 — 请选择具备标准人格（或不附加人格）的运行时预设以继续"：所选预设没有可叠加的标准人格。换一个预设。

已知限制：自定义名字的预设即使人格可叠加，也会被判为 ✕。这是当前版本的缺陷，解法是换用系统自带名字的预设，或从蓝图里删掉 `persona` 类要求。

### 3.3 按钮

| 按钮 | 出现条件 | 作用 |
| --- | --- | --- |
| **创建团队** | 没填初始任务，兼容性 ✓ | 创建团队，打开 Leader 会话，不发任何消息 |
| **创建并发送** | 填了初始任务，兼容性 ✓ | 创建团队，打开 Leader 会话，把初始任务发给 Leader，Leader 开始第一轮 |
| **确认警告并创建** | 兼容性为警告且已勾选确认 | 同上两者之一，带降级标记 |
| **正在创建…** | 创建进行中 | 按钮禁用 |
| **重试** | 创建失败后 | 见 3.5 |
| **取消** | 始终 | 关闭面板，丢弃草稿 |

### 3.4 创建成功后

- 面板自动关闭。
- 侧边栏出现新的会话，这就是团队的 Leader 会话。
- PilotDeck 当前在会话状态条提供“团队详情”和“团队交互”入口；Teammate 人类交互在交互面板按待处理/历史记录展示，Leader 不代为裁决。
- 如果填了初始任务，Leader 会立刻开始回应。

### 3.5 创建失败与重试

创建分三步，每一步失败都会在面板里显示错误并保留"重试"按钮：

| 失败阶段 | 显示 | 重试行为 |
| --- | --- | --- |
| 创建团队本身 | "创建失败：原因" + "Root 会话 ID 已保留；团队创建失败，可重试（重试复用同一 ID）。" | 从头再创建一次 |
| 打开会话 | 同上 | 从头再创建一次 |
| 发送初始任务 | "初始任务发送失败：原因" + "团队已创建且 Root 已打开；初始任务未投递，可重试（重试复用同一任务令牌，Root 保持打开）。" | **团队已经创建成功**，只重发初始任务，不会重复建队 |

面板只在整个流程成功后才关闭；任何失败都保持打开，方便重试。

### 3.6 创建时系统还会做什么

用户看不到但会影响结果的几件事：

- 再次读取所选蓝图并核对环境要求。面板里显示 ✓ 到点击创建之间如果环境变了，仍可能被拒。
- 检查蓝图里两个权限上限字段是否自相矛盾。有矛盾时团队会被创建但 Leader 不启动，团队视图里出现一条治理警告，确认后 Leader 才启动。
- 把所选工作区绑定到 Leader 会话。工作区未登记会直接失败。

---

## 4. 创建之后还能改什么

创建成功后，蓝图里的大部分内容就冻结了。下表区分"冻结"和"可改"：

| 项目 | 创建后 | 在哪改 |
| --- | --- | --- |
| 绑定的蓝图及其 revision | 冻结，不能换 | 需要新设计就新建团队 |
| 角色列表、人设、工作模式 | 冻结 | 同上 |
| 协作动作范围（envelope） | 冻结 | 同上 |
| 数量上限 | 冻结 | 同上 |
| 团队默认工作区 | 冻结 | 创建成员时可以给单个成员指定别的工作区 |
| 治理模式（policyState） | **可切换** | 团队视图 → 治理 → 策略状态 |
| 每个成员的模型、工具、技能、外部服务 | **可覆盖**（人类设置或重置） | 团队视图 → 治理 → 生效配置 |
| 每个成员的文件/命令权限 | **可放宽或收紧**（受两个上限字段约束） | Leader 用工具操作；人类在治理面板查看 |
| 环境要求的兼容性 | 可重新检查 | 团队视图 → 治理 → 兼容性 |

---

## 5. 快速核对表

写完一份蓝图，按顺序检查：

1. 文件以 `---` 开头和结尾，中间没有正文。
2. `schemaVersion: 3`；`blueprintId` 无空格无 `@`；`revision` 加了引号。
3. `leader` 存在且 `persona` 非空。
4. 所有 `templateId` 唯一（含领队），全小写。
5. 写了 `capabilities` 的角色，四个子字段齐全；`permissions.default` 是 `ask` 或 `deny`；成员的 `bash`/`pwsh` 没放进 `allow`。
6. `requirements` 里 `persona` 的 `name` 是 `standard`。
7. 每个 envelope 的 `allow` 和 `deny` 没有重叠；成员需要的动作在 `teamEnvelope.allow` 和自己的 `memberEnvelopes.allow` 里都有。
8. `quotas` 都是正整数，`maxConcurrent ≤ maxInstances`。
9. `permissionMutationEnvelope` 和 `teamHardEnvelope` 都写了（至少 `rules: []`）。
10. 保存到蓝图目录，在创建面板点"刷新蓝图目录"，选中后看蓝图详情是否正常展开、兼容性是否 ✓。
