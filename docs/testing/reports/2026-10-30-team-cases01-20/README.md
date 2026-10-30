# Team Case 01-20 清理后重新验收

日期：2026-10-30。结论：**本轮未通过验收**。Case 01-20 和 14A 均进行了真实页面操作，但并非每个子分支都已覆盖。确认 5 个产品问题；其余未执行、证据不足和环境限制见逐 Case 表格。不能把本报告理解为“20 个 Case 全部通过”。

本轮先删除过去 Team 配置、相关聊天和旧验收证据，再用 computer use 操作真实 Web 页面、Gateway 和模型。已有产品代码改动继续保留；本轮只增加验收脚本、报告及证据，没有修复产品代码，也没有提交 Git commit。旧报告不作为本轮通过证据。

## 1. 已确认的问题

### D1：全队空闲后编辑 Leader，原聊天下一次实际请求仍用旧配置

例如，用户把 Leader 的提示标记从 `CONFIG_UPDATED_64` 改成 `CONFIG_IDLE_NEW_91`，保存成功，全队已经空闲。原聊天的新请求却仍带旧 system prompt，正式回答也返回旧标记。运行记录中的角色字段已经更新，所以只查运行快照会误判通过。

- 原聊天：`web:s_16241076-50ef-4c6f-a63f-d2585bd9672d`；activation：`51af0dc2-9681-4acb-8e20-57a8d05c2dca`。
- 新轮次：`c27e042f-6162-4493-a2b8-80aa1a37004c`。
- [实际请求体](requests/pilotdeck_request_1793332930647.json)：system 中有旧标记、没有新标记。[编辑后运行记录](evidence/case16-idle-stale-prompt/team-runtime.json)、[页面文本](case16-idle-stale-prompt.txt)、[截图](screenshots/case16-idle-stale-prompt.jpg)。
- 更早还观察到同类模型分支：Leader 从 Opus 4.8 改成 GPT，运行字段已更新，但原聊天下一请求仍报 Anthropic/Opus 4.8 错误。[记录](runtime-after-model-edit.json)。模型渠道自身的 503 另列为环境问题。
- 影响 Case 03、16。新聊天正确使用新配置，不能代替原聊天首次新请求的验证。

### D2：Leader 自动续答显示在对应用户请求之前

用户先做发布评审，再要求测试员直接询问审查员。自动续答在页面中被排到后续用户输入之前，部分内容显示在更早回答之下；刷新后仍然错序。

- 原聊天：`web:s_cc641cdf-b7c8-4959-8ab2-3a2599f33a11`；activation：`4950802c-3967-4e8f-8556-57d72810ae63`。
- [截图](screenshots/case09-case11-wrong-order.jpg)、[刷新前页面](case09-case11-grouping-before-refresh.txt)、[刷新后页面](case09-case11-grouping-after-refresh.txt)、[持久 transcript](evidence/final/web:s_cc641cdf-b7c8-4959-8ab2-3a2599f33a11.jsonl)。
- 持久 transcript 和正式结果仍在。目前证据证明页面顺序/归属错误，没有证明聊天数据丢失或成员执行失败。影响 Case 09、13、14A。

### D3：首次发送在接纳前被拒绝，输入框清空且没有重试入口

在新聊天选中 Team 后，另一页面修改该 Team 的 Leader 提示词。首次发送被真实 Gateway 以 `TEAM_PROBE_STALE` 拒绝。页面提示重新检查，但输入框已经清空，也没有 Retry。重新选择 Team 并手动重输同一内容后，原 URL 才能继续执行。

- 原聊天：`web:s_7565495b-878b-4ab3-a5b7-72432b8731e7`；恢复后 activation：`d2101c71-9d41-4dd0-b83c-6b9e6e9bf553`。
- [失败页面](case18-real-preaccept-failure.txt)、[失败截图](screenshots/case18-real-preaccept-failure.jpg)、[同 URL 恢复截图](screenshots/case18-real-preaccept-recovered.jpg)。
- 原文仍留在失败消息行，不应表述为全部数据丢失。本结论来自真实拒绝，不依赖代理伪造的接纳前错误。影响 Case 18。

### D4：侧栏首屏之外的旧 root URL，直接打开或刷新后显示空白聊天

重启后直接打开已完成发布评审的 root URL，页面显示 `General conversation` 和空白输入区，没有 Team 身份与历史。随后展开 `release-app`，点击 `Show more (2)`，从列表打开同一个 session，历史和 Team 身份正常出现；再刷新同一 URL 又变空白。编码或不编码冒号均复现。

- 原聊天：`web:s_cc641cdf-b7c8-4959-8ab2-3a2599f33a11`。首个 Opus 失败聊天的直达地址也显示空白。
- [首屏列表](case20-project-first-page.txt)、[直接打开](case20-completed-root-direct.txt)、[编码地址](case20-completed-root-encoded.txt)、[从分页列表打开](case20-completed-root-via-pagination.txt)、[再次刷新](case20-completed-root-after-reload.txt)。
- [空白截图](screenshots/case20-completed-root-after-reload.jpg)与[列表打开成功截图](screenshots/case20-completed-root-via-pagination.jpg)。持久 transcript 仍可读取，期间没有新增模型执行。
- 成员只读直达 URL 正常恢复；首屏中的 Case14 主聊天也能直达恢复。不能扩大为“所有历史无法读取”。影响 Case 20。

### D5：删除源 Team 后，全队空闲的原聊天仍执行新的人工请求

在临时 Team 的 Leader 等待写文件权限时删除源 Team，当前权限请求继续等待，这符合当前快照保护要求。拒绝权限、等待全队空闲后发送明确新请求，系统却继续调用模型，返回 `SHOULD_NOT_RUN_DELETED_42`。文档要求源配置不存在时拒绝新工作。

- 源 Team：`8ef95834-ed57-4a19-8f5f-394b5682f9fc`，`Case07 成员固定P2`，已经从当前配置库删除。
- 原聊天：`web:s_0c7a9333-7a79-48ed-aff5-3b2d8a3e4f33`；activation：`61d1e033-b545-4906-bfdd-f0f047d4c328`。
- 新轮次：`84e05e13-5a99-44b7-9332-99e3b1a54bd0`；实际 request：`77cf1377-186f-4f63-9e62-92b143b64d94`。
- [配置已删除但当前等待仍在](evidence/case05-deleted-active/observation.json)、[新工作运行记录](evidence/case05-deleted-team-new-work/team-runtime.json)、[当时配置库](evidence/case05-deleted-team-new-work/team-library.json)、[截图](screenshots/case05-deleted-team-new-work.jpg)。
- 后续重启及旧配置请求回放没有重新创建该 Team。这一问题是原聊天错误沿用旧快照执行，不能说配置库删除失败。影响 Case 05、16。

## 2. 环境、清理与证据分层

- 工作区：`/Users/gucc1/Codes/work/modelbest/PilotDeck-lys`。Web：`http://127.0.0.1:3002`；Gateway：`ws://127.0.0.1:18789/ws`。
- 主项目 P1：`/Users/gucc1/Codes/team-mode-acceptance/release-app`；P2：`/Users/gucc1/Codes/team-mode-acceptance/release-docs`。源码/测试基准经过逐文件比较，内容未变。
- [cleanup.json](cleanup.json)：清理 126 个路径、87 份相关聊天文件，识别并删除 74 个旧运行段对应数据。删除旧 Team 配置目录、相关聊天/队列、旧测试输出和 10/23-10/29 相关报告/证据。保留凭据、通用设置、非 Team 聊天、项目登记、MCP/技能测试资源和业务样例基准。
- 使用 Node 22.23.2。Leader 主流程为 GPT 5.6 Sol，审查员为 DeepSeek V4 Pro 0813，测试员为 DeepSeek V4.1 Flash。Opus 4.8 返回 `model_not_found`/503，因此该渠道失败不能算产品协作通过。
- 页面操作全部通过 computer use。代理只用于能力目录、配置响应丢失、接纳响应丢失等明确故障分支；[代理事件](proxy-events.jsonl)保留真实上游状态和注入时刻。代理已停止。
- Gateway 辅助回放与浏览器 E2E 分开记录：配置非法输入、交互身份替换、存储位置篡改、旧请求重放不算浏览器操作。
- 最终快照包含 11 个 activation、87 轮执行、64 条内部消息、239 条实际发送记录。保存了 88 份实际 Team 请求体；这只是可获取的请求体子集，不能当作全量 provider 请求数量。
- [evidence-audit.json](evidence-audit.json)共有 45 项证据一致性检查：44 项符合、1 项无法判定、0 项核对失败。该数字不是产品需求通过数，其中还包括“缺陷具有真实发送证据”的检查。
- `qa-hidden` 有一条无法归属的 `initialize` 日志，不能断言未经授权 MCP 从未连接。[日志](qa-hidden.jsonl)。当前观察到的实际工具 schemas 不含隐藏 MCP 工具或私有技能标记，但这不足以把连接零次分支判通过。

## 3. Case 01-20 逐项结果

“已验证”只针对本行写出的分支。“部分”表示还有未执行或证据不足的分支。受控回归补充证据见下一节，不混入真实 UI 结论。

| Case | 结论 | 本轮真实操作和证据 | 未覆盖或限制 |
| --- | --- | --- | --- |
| 01 | 部分 | 从空库建立 Leader、两名 Teammate 和基准 Team；空名称/提示词、缺 Leader/成员阻止保存；内嵌创建角色返回 Team 草稿；可选标记随取消消失。临时角色两种审批模式及固定 P2/继承均保存读回；清单来源不改变继承工作区。[配置截图](screenshots/case01-saved-team.jpg)、[审批读回](case01-permission-fixed-readback.txt)、[恢复继承](case01-permission-inherit-readback.txt)、[非法请求](config-validation.json)、[旧字段/伪造 ID](config-negative-extra.json)。 | 当前模型目录未提供推理强度/速度控件；配置阶段没有模型/业务 MCP 调用的完整零计数基线未保存，不能补推。 |
| 02 | 部分 | 角色/Team 草稿刷新恢复与放弃；能力目录 503 保留工具/技能/MCP 勾选，重试恢复；Team 保存真实成功但响应被替换 503，冻结编辑并原 token 重试；Fork 同样只产生一个副本；新尝试可保存。不同 origin 的两页面独立 token 对角色/Team 先 A 后 B 均成功，旧 A 回放和真实重启后仍为 B。[故障截图](screenshots/case02-response-lost-frozen.jpg)、[独立 B](screenshots/case02-independent-team-B.jpg)、[旧 A 回放](replay-independent-saves.json)。 | 单独的角色保存响应丢失 UI 分支未做；同 origin 共享草稿 token 的冲突单列，不能当作独立 token 修订冲突。 |
| 03 | 失败且部分覆盖 | 覆盖保存保留 ID/createdAt、改变 updatedAt；角色/Team 引用按 ID，页面无版本选择；角色类型变化被拒绝。新聊天采用新提示可见。原聊天下一次实际 Leader 请求仍用旧提示/模型，见 D1。 | 尚未完整覆盖所有角色字段、所有引用、模型参数和多次重启后的“仅最新配置”存储审计。 |
| 04 | 部分 | Fork Team 保留成员 ID；Team 内 Fork Leader 替换副本引用而原 Team 不变；独立 Fork Teammate 创建 `b7f21a63-9f69-4610-8bb6-28e1bff17c07`，放弃编辑后副本仍在，另存新提示不改原角色。[截图](screenshots/case04-teammate-fork.jpg)、[当时配置](evidence/case04-case05-fork/team-library.json)。 | 未对所有字段逐一比较复制结果；没有逐目录计数证明未复制文件/聊天。临时副本后按 Case05 删除。 |
| 05 | 失败且部分覆盖 | 单引用保护；两个 Team 引用同一临时成员时拒绝删除，解除一个仍拒绝，全部解除才删除；删 Team 不连带删角色。旧保存/Fork 回放返回旧收据但不复活当前配置，预检报 TEAM_NOT_FOUND，重启后仍不存在。[双引用](case05-two-references-refused.txt)、[单引用](case05-one-reference-refused.txt)、[回放](deleted-config-replay.json)。有历史 Team 删除后历史保留，当前等待继续；全队空闲后新工作却仍执行，见 D5。 | 同名角色重新创建新 ID、普通 UI 删除取消的完整组合未逐项留证；删除后 Abort 和重启后的新工作拒绝矩阵未全部执行。 |
| 06 | 部分 | 新聊天模型菜单可选 Team；取消未执行；确认后尚未发送的选择刷新保留，runtime 尚未建立。[截图](screenshots/case06-selected-unsent.jpg)。 | empty-home 无项目引导、Team A/B 预检竞态、模型目录单独失败未做。 |
| 07 | 部分 | P1 普通聊天记录 R-17 后原处进入 Team，URL/历史/草稿保留并能复述；Leader 固定 P2 冲突阻断；通用聊天存储与 P1 执行分离。固定 P2 Teammate 实际相对读取 DOCS_WORKSPACE，Leader 读 APP_WORKSPACE。[截图](screenshots/case07-fixed-teammate-P2.jpg)、[运行记录](evidence/case07-fixed-p2-completed/observation.json)、[位置篡改回放](routing-validation.json)。 | 仅伪造 cwd、完全省略位置、通用聊天合法切到 P2 的辅助矩阵未做完。 |
| 08 | 部分 | 必需模型/技能/MCP/不存在工具逐项预检阻断，辅助直接选择也拒绝；可选技能物理移走后明确确认降级，冻结后 skills=[]，随后恢复；旧确认因配置变化被真实 Gateway 拒绝。[可选确认](screenshots/case08-optional-confirm.jpg)、[必需 MCP](screenshots/case08-required-mcp-blocked.jpg)、[辅助预检](prepare-extra.json)。 | 不存在工具不等于“已有工具外部依赖故障”；项目登记缺失、警告确认字段省略、预检零模型/业务工具调用计数未完整做。 |
| 09 | 交付正确，页面失败 | 真实三模型协作，Leader 异步发消息，成员结束后实际指定 participantId/turnId 查询正式结果，审批写出 `out/release-review.md`；报告正确指出 `>100` 漏掉 `==100`，实际测试 2 过 1 败，不能发布；源码/测试基准不变。[正式结果](screenshots/case09-final-details.jpg)、[报告副本](evidence/case09-completed/release-app/out/release-review.md)。后续自动回答错序见 D2。 | Opus 4.8 渠道失败单列，不作为成功协作证据。 |
| 10 | 核心路径已验证 | Leader 私有标记未转发；审查员后续一轮可回忆自己的随机标记；测试员 context 不含审查完整标记；同 Team 另一个聊天的审查员不知道旧标记。实际 context 与轮次对应，查询不重启成员。[最终记录](evidence/final/observation.json)、[上下文审计](evidence-audit.json)。 | 未触发压缩后的隔离与回忆；不能推导共享文件隔离。 |
| 11 | 部分 | 测试员直接问审查员，审查员直接回复；两消息发送身份/接收者及实际 dispatch 对应，Leader 查看通信，无 relay。Teammate 的同伴 turns/输出查询被拒绝；messages 按其他人过滤仅得到本人可见空列表；自己/不存在接收者、replyTo/workId 被拒绝。[直连截图](screenshots/case11-direct-route.jpg)、[非法调用记录](evidence/case11-negative/observation.json)。 | 伪造 sender、跨 activation、强制旧工具名称的真实模型/浏览器分支未做；schemas 不可见与强制调用拒绝不能混同。 |
| 12 | 部分 | 受控前台 gate 期间给同一忙成员两条有效消息，最终同一个 request `e9922784-7693-41be-90d1-d55792d77558`、原 turn 消费整批；第三条删除后未出现在 dispatch 或接收者 context，反馈恰好一次。[同轮批量](screenshots/case12-same-turn-two-messages.jpg)、[发送审计](evidence-audit.json)。 | 超容量、压缩/重试、整批全删取消空执行、边界之后到达及精确删除发送竞争未做真实 UI/模型矩阵。 |
| 13 | 部分，页面失败 | 两成员前台 gate 轮次真实重叠，同一成员各轮记录无重叠；忙时批量进入原 turn。成员流式只读页面可见，Leader 自动续答有注入标记。D2 导致轮次页面归属不正确。[运行中快照](evidence/case13-gates-running/observation.json)、[时间审计](evidence-audit.json)。 | 普通同目录会话首次调用与检查点零新增、成员不可恢复模型错误同时另一成员正常、步数上限、准备环境失败、Leader 各发送边界组合未做真实全矩阵。 |
| 14 | 部分 | 成员权限允许/拒绝及实际文件/命令结果；问题单选/多选答复与取消，刷新和真实断线后仍能处理；Plan 批准/继续讨论，批准后另经工具权限写出 PLAN_FRESH_52。Leader 权限留在普通 session。辅助替换 7 项 owner 身份均拒绝且原 pending 不变。同标签页 A 成员/B Leader 同 P1 切换、不同目录双标签页分别验证；拒绝 A 后 B 仍 pending，单独拒绝 B 才结束。三类 pending 的 Abort/重启全部实际触发。[同页 A](screenshots/case14-sametab-A-open.jpg)、[B 仍等待](screenshots/case14-sametab-B-still-pending.jpg)、[身份回放](interaction-identity.json)、[Plan 文件](evidence/case14-plan-fresh-completed/release-app/out/case14-plan-fresh.txt)。 | 普通聊天及 Leader 的问题/Plan 真模型矩阵、正确交互响应并发/成功但丢响应后的服务端次数核验、普通权限入口伪答成员请求未完成。本轮早期 Plan 因未授权 todo_write 未执行成功，已修正 fixture 后重新走完整批准和写文件流程；早期结果不能算通过。 |
| 14A | 部分，受 D2 影响 | Leader 仅消息区，成员三类交互及消息区；详情无任务/通信板块；收件归属、截断、展开、状态、系统无删除；消费前删除成功及固定反馈，已发删除失败，失效删除不唤醒。只读流、刷新、直达及错误成员地址验证。桌面深色中文、浅色英文，390x844 深色中文/浅色英文面板及 Plan，手机实际批准 Plan。[浅色移动面板](screenshots/case14a-mobile-light-en-panel.jpg)、[浅色移动 Plan](screenshots/case14a-mobile-light-en-plan.jpg)、[错误地址](case14a-wrong-participant.txt)、[只读恢复](case20-readonly-direct-after-restart.txt)。 | 未做全部主题/语言/长错误组合，响应 503、旧 revision/错误 owner 流帧重放、只读断线增量去重与分页 cursor 全矩阵、整批删除及最后发送竞争。浅色图片已补测实际面板，早先只含主聊天的浅色图片不算面板证据。 |
| 15 | 部分，存在不确定证据 | 真实 read_file/read_skill/授权 MCP 调用；Leader 排除 write_file 后通过 execute_code 导入调用，实际报 `Tool write_file does not exist` 且无文件；private-checklist 实际读取不到，schemas 不含旧 Team/agent/task/Always-On/隐藏 MCP。[桥调用拒绝](screenshots/case15-leader-bridge-denied.jpg)、[实际请求清单](request-manifest.json)。 | 真实/受控完整 Leader+Teammate 直接名/别名/桥矩阵未在浏览器执行；受控单元测试另列。qa-hidden 有一条无法归属初始化，连接零次不能判通过。 |
| 16 | 失败且部分覆盖 | 运行/交互等待中编辑配置并停止后新一代继续、外部环境变化重新检查均有操作记录；原聊天全队空闲后首次请求仍用旧 Leader prompt/model，见 D1；源 Team 删除后仍执行见 D5。 | 未完整覆盖所有角色、能力、审批、模型参数、Team 成员/说明/工作区，以及各准备/等待/通知状态下的快照保护、空闲/Abort/重启采用最新值组合。 |
| 17 | 部分 | 忙时菜单不能切换；空闲可退出 Team 回普通聊天，R-17 历史仍可问答；再进 Team 生成新 activation，旧记录保留。 | 旧模式 queued 输入与切换竞态、附件/恢复确认未完整执行。 |
| 18 | 失败且部分覆盖 | 真实接纳前 TEAM_PROBE_STALE 清空输入无 Retry，见 D3。真实接纳响应被代理丢弃/关闭 WS 后，页面恢复 RECOVERED_ONCE_74；相同 runId 仅一个 accepted_input、一个 turn、一个 dispatch。[恢复截图](screenshots/case18-real-accepted-response-recovered.jpg)、[代理时刻](proxy-events.jsonl)、[旧接纳回放](accepted-replay.json)。 | 首次导航响应丢失、内部自动续答重复提交、外部副作用严格一次的完整矩阵未做。早期 synthetic 接纳前故障和一次未命中丢响应的普通成功均不算该分支通过。 |
| 19 | 核心停止路径已验证，矩阵仍部分 | 主会话 Stop 使成员工具权限/问题/Plan 全部 cancelled；待发 Teammate 消息、成员到 Leader 消息、程序轮次通知失效不再 dispatch；失效消息仍显示可清理且不反馈唤醒。人工队列 expired 可放回输入框但未重新发送。明确新 Leader/成员消息可运行，旧 ID 仍无发送。[Leader 待发及通知](case19-leader-pending.txt)、[全部交互停止](case19-permission-plan-stopped.txt)、[失效 ID 审计](evidence-audit.json)。 | 慢清理/准备阶段 Abort、删除与发送同一临界区竞争、附件队列恢复未在真模型流程构造。 |
| 20 | 失败且部分覆盖 | 真实浏览器断线/刷新、Gateway 全进程重启；三类 pending 变 expired，轮次 interrupted/service_restart，不生成旧唤醒，明确新请求可运行。成员只读地址恢复、错误成员地址拒绝；配置 B 和已删除配置重启后保持。首屏外 root 直达/刷新空白，见 D4。[重启前](case20-permission-plan-before-restart.txt)、[重启后](case20-permission-plan-expired.txt)、[最终快照](evidence/final/observation.json)。 | 仅 bridge 重启、Leader 待发消息重启、发送入口崩溃不确定、旧操作恢复矩阵未完整做；文档 F063 仍按原文排除。 |

## 4. 辅助与隔离检查

下列结果不能替代上面的真实页面验收，也不能用来冲销 D1-D5。

| 检查 | 结果与证据 |
| --- | --- |
| 后端构建/类型编译 | 通过。[日志](build-root.log)。 |
| UI 构建 | 通过；有大分块警告。[日志](build-ui.log)。 |
| UI TypeScript | 通过。[日志](typecheck-ui.log)。 |
| 受控后端回归 | 7 个编译后测试文件，92 项全部通过。包括禁用工具直接/别名/桥、交互身份、批量/删除/容量、Abort/重启、发送边界和模型历史。使用测试模型/临时目录，非真实外部模型或浏览器全链路。[日志](isolated-backend-tests.log)。 |
| 受控前端回归 | 首跑 30 项因 localStorage 初始化失败，保留[失败日志](isolated-ui-tests.log)。明确指定 Node 22 并关闭实验性 Web Storage 后，6 文件 92 项全部通过。[复跑日志](isolated-ui-tests-node22.log)。 |
| 证据一致性 | 45 项，44 符合、1 无法判定。检查实际 messageId/turnId/requestId、无同成员轮次重叠、删除不重投、旧消息不复活、受拒/中断文件不存在、批准文件存在、基准未变等。[结果](evidence-audit.json)。 |
| 证据文件与收尾 | JSON/JSONL 解析、报告本地链接、6 个验收脚本语法、凭据模式扫描、最终只读检查不新增执行、无待处理工作、正常端口可用/代理端口关闭、定向 diff 空白检查均通过。[结果](artifact-verification.json)。该凭据检查只覆盖服务 token 和常见凭据模式，不能视为全量敏感信息分类。 |
| 辅助 RPC | [非法配置](config-validation.json)、[旧字段与不存在身份](config-negative-extra.json)、[交互身份](interaction-identity.json)、[位置校验](routing-validation.json)、[独立保存回放](replay-independent-saves.json)、[删除配置后旧请求](deleted-config-replay.json)、[接纳旧请求](accepted-replay.json)。响应结果与后续状态读回配对解释。 |

## 5. 关键身份与文件

| 用途 | 身份 |
| --- | --- |
| 基准 Team | `0833cb94-d5f7-4050-8093-6a3426fae2dd`，发布评审团队 |
| Leader | `8d6b08b2-bd95-440f-b074-cd0cc4eaab03` |
| 审查员 / 测试员 | `0cfc02bc-b099-42ff-97e7-db3c1ca49292` / `12e0d7ec-07ff-4324-a1d3-04ebd5808a7f` |
| Case14 Team | `687dac1d-3bd7-4926-aff3-f0d2fe631aa6` |
| Case14 主运行段 | `7610ca21-9e69-4a0e-aa37-1561ed24ff53`，root `web:s_278ee90e-a533-4986-b401-7e7722456a60` |
| Case14 审查员 / 测试员 | `c9445a4d-ae0a-42b9-9d51-d915dbd16c5c` / `4fdadad6-1e46-4cd7-a20f-802a519b17e9` |
| 直连两消息 | `24443a47-eb11-474e-b66e-2c3d4e89e88f` / `e29655c9-8a9e-40b6-9c9e-4b3161dcd1d0` |
| 忙时批量 | `423331df-873c-49a3-9cfa-3d29f54297db` + `16e37011-a1b8-48b2-b9b3-0941d2f41b82`，同 turn `69ba88d0-f1db-4a37-91a8-9b7fcf82dc78` |
| 消费前删除 | `211b863a-a3c3-4574-8151-bb68fc7bd5cb`；固定反馈 `81c50b98-627a-4635-83b9-86bfa7c70a4b` |
| 真实丢接纳响应 | run `ea5bbfbd-5e8b-4470-9704-c250e4a227c9`；request `d0723c3c-69bc-439d-8c05-0159298b1e2c` |
| 同标签页审批隔离 | A interaction `48bd7f47-74b0-4bae-9750-1e4e2f1a3db8`；B Leader turn `8ceb7bce-c2b6-46d4-9e08-86145f84c63d` |
| 最终保存状态 | [observation.json](evidence/final/observation.json)、[运行记录](evidence/final/team-runtime.json)、[配置库](evidence/final/team-library.json)、[真实请求清单](request-manifest.json) |

运行快照在 `evidence/<阶段>/` 下，同时保留 root transcript、成员 context 和产物副本。截图只能证明当时页面显示；请求消费、结束原因和副作用结论还须看相同身份的持久记录及文件。

验收脚本：`scripts/team-acceptance-observe-20261030.mjs`、`team-acceptance-rpc-20261030.mjs`、`team-acceptance-fault-proxy-20261030.mjs`、`team-acceptance-audit-20261030.mjs`、`team-acceptance-verify-20261030.mjs`。清理脚本 `team-acceptance-reset-20261030.mjs` 是本轮破坏性准备脚本，已增加显式环境开关保护，不能在保留本轮数据时再次执行。

## 6. 收尾状态

最终没有活跃轮次、pending 人类交互或 queued/preparing/sending 内部消息。正常 Web/Gateway 留在 3002/18789 供复查；故障代理 3003 已关闭，故障开关文件不存在。界面恢复 English、Follow System，临时移动视口已撤销。新产生的配置、聊天与证据保留用于定位本轮问题。

修复后应优先复验 D1/D5 的原聊天配置校验，再复验 D2/D4 的历史显示和 D3 的首次发送恢复；本表列出的未覆盖分支仍须独立完成，不能凭构建和受控测试通过结束完整验收。
