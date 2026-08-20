# 011：RP Host / Work Agent 委派预设

状态：设计与 Flash-only 首发范围已获用户批准；Owner Eligibility、RP Host preset/完整 Persona 分流、Anchored-only product runtime、fresh child lifecycle、Work profile controller 和 rc.7 临时 Home 验证均已实现。Flash/max 曾取得独立 5×3、15/15 并按批准范围加入 bundle；后续稳定性批次取得 Pro/max 15/15，但 Flash 总门未通过且中段脱敏结果未完整保留。专用 Pro provider/tool 未获发布批准，继续不注册；Owner 仍可通过通用设置页把 DSH 已配置的 Pro exact pair 明确确认为 experimental。Flash 在公开发布前仍需可恢复的增量复核。

基线：MistyMoon `dd4506e`；DSH 行为基线 `0.1.0-rc.7`，公开源码证据固定到 `99f6f02`。

## 结论

当前正式 preset id 为 `mistymoon-rp-host-v2`；`v1` 只作为版本化更新/回滚资产保留。DSH 拓扑上的 parent 是产品语义中的 `RP Host Agent`：负责 Owner-facing RP、完整已发布 Persona 身份、只读 Web 搜索/阅读、当前 Session 工作区内的只读文件检查、澄清、风险确认、委派和最终交付；原生 spawn child 是 `Work Agent`：负责编码、文件修改、长研究、审查、规则查询与验证。

RP Host Composition 是 preset 专属策略。它占用 DSH `deployment:persona` slot，使已发布 Persona 成为唯一模型可见运行时身份，并精确隐藏 `harness:identity`；DSH 安全、权限、审批、协作模式、工具治理和 Owner 当前请求仍优先，system snapshot 由原生 `request/header` 持久化。该 preset 隐藏 final-reply 工具并直接自然结束 Owner turn。其他 preset 不采用此策略，继续沿用 001 的双阶段 output-profile/final-reply 路径。

正式 thinking 通过 DSH 官方 DeepSeek Adapter 的 model/reasoning 配置启用，不通过“逐步思考”等 prompt 技巧激活，也不向用户索取或展示完整 chain-of-thought。编码 Work Agent 的默认层固定为 Anchored Standard；Routing Suite 不属于产品依赖或 capability 前置条件，J-Space 仍作为单独受控实验层。该选择不等于对任意版本、任务或组合顺序作无条件质量保证。

## 已确认的 DSH 约束

1. Agent preset 是含 `agent.cordis.yml` 的目录，用户 root 为 `<DSH_HOME>/.agent-presets/<id>`；child 组合父级同一代 standing preset，再叠加 child persona 与 tool filter。
2. `spawn` 创建独立 Session 且不复制父对话；`fork` 复制已完成父历史。v1 只允许 spawn。
3. child persona 只替换 persona slot，其他 preset prompt sections 仍继承；因此 RP 身份不能散落到 child 继承的常驻 sections。
4. parent Agent scope 的 tool restriction 不自动成为 child 上限；preset 要包含完整能力，再分别用 parent restriction 与 child tool filter 收窄。
5. 标准 `AgentOptions` 没有 `reasoningEffort`；它属于 `LlmCallConfig`，最终记录在 `request/header`。
6. rc.7 launcher 固定 packaged preset roots，普通 bundle patch 不能可靠注册第三方 packaged root；MVP 只能经用户确认 provision 到用户 preset root。

## P0 阻断：Owner Eligibility

DSH one-shot driver 把 delegation prompt 标为 `source.kind=user`。修复前 Foundation/Memory 也只用该条件识别 Owner message；直接接入会让 Work Agent 误收 `mistymoon:turn-voice`、现实关系 recall，甚至把 child 任务中的“请记住”当成 Owner 指令。

在 preset 实现前，必须先形成一个共享的 Owner Eligibility Interface：

~~~text
source.kind == user
AND delegationDepth == 0
AND authenticated owner identity matches session/channel
~~~

Foundation voice/final-refresh、Memory observation/recall/治理工具和主动陪伴都复用这一判断。字段缺失、身份未知或 delegation depth 非零时 fail closed，不把消息当成 Owner 数据。该修复已由独立 [015 Owner Eligibility](../015-owner-eligibility/SPEC.md) 完成，并保持为 preset 实现的独立回归门。

## 深 Module 设计

### Module：RP Agent Role Gate

Interface 只接受 DSH 可认证的 session header、preset generation、delegation descriptor 和现有工具 catalog，返回角色、工具限制和模型请求策略。它隐藏 root/child 识别、Waterfall 排序、restriction 生命周期和 compaction/restart 恢复。

角色不能来自 prompt、自称、工具参数或 `delegationDepth > 0` 单一信号。无法证明是本 preset 的 RP Host/Work Agent 时不改写其他 Agent；若请求自称属于本 preset 但证明不完整，则拒绝启用扩展能力。

### Module：Work Delegation

内部只有一个版本化委派 Interface，负责验证任务包、冻结部署所选 route、启动/取消/释放 child、校验 Work Report 并持久化结果。DSH 标准工具实例不接受模型传参；Flash-only 首发只向 RP Host Agent 暴露一个已资格化薄 Adapter：

| 工具 | 固定 child | 用途 |
| --- | --- | --- |
| `mistymoon_code_flash` | `deepseek-v4-flash` / `max` | 常规编码、读取、测试和低成本迭代 |
未来的 Pro 不得在独立资格门通过前注册新工具。Owner 可以在本机设置页为同一个 Flash Work 工具选择 DSH 已注册的 provider/model，但模型和 RP Host 都不能在工具参数中任意改 route。v1 是 one-shot foreground spawn，`maxDepth=1`；不开放 fork、continuable、递归委派、list/send/interrupt。

设置页通过 DSH `listProviders()`、`listModels(provider)` 与 `resolveCallConfig(... max)` 构造无凭据 catalog，只显示实时已注册且接受 `max` reasoning 的模型。默认 route 是已资格化的 `deepseek-official + deepseek-v4-flash`；任何其他 exact provider/model 都标记为 `experimental-owner-configured`，保存按钮即 Owner confirmation。私有版本化 `work-model.json` 只保存 revision、provider、model、固定 `max` 与 qualification，不保存 URL、key、workspace、余额、账户或 DSH provider 配置。设置只影响下一次及之后的 fresh activation，已发布或运行中的 child 不重绑；保存时 catalog 已失效、revision 冲突或后续 route/region/quota/protocol 失败都 fail closed，不能 fallback。OpenCode Go 是该通用机制的一个 experimental 候选，不拥有专用命令或旁路 client。

### Module：Work Agent Coding Composition

DSH rc.7 的 native child 仍通过 `composeFrom()` 继承父级同一代 preset，不能通过标准 start request 指向另一个独立 preset。第一版按 [014 可切换 Work Agent](../014-switchable-work-agent/SPEC.md)适配 DSH in-process driver，在 child creation transaction 内挂载固定 Anchored Standard Work Preset。

其 Interface 只接受可信 child descriptor、任务类别和 durable child events，返回该请求的 prompt contributions、工具目录阶段和可选 skill context。版本校验、上游加载、顺序、冲突处理、protected sections、重启恢复与许可证 metadata 都隐藏在 Module 内。

固定处理顺序：

1. **MistyMoon Policy Shield**：先确定 Work Agent 身份、Owner 隔离、sandbox 和不可删除的 DSH safety/permission/Plan/AGENTS sections；
2. **Anchored Standard Adapter**：按上游 durable phase/promotion 逻辑计算 child 工具 catalog；只在编码 allowlist 内增减工具；
3. **J-Space Adapter**：仅在实验门开启的 full/loop 复杂任务中加载固定上游 skill 与 ledger；只贡献任务工作状态；
4. **DSH Request Policy**：最后验证设置页冻结的已注册 provider/model 与固定 `max` reasoning，并记录 request header；缺失或不兼容时不降级、不 fallback。

Anchored Standard 与可选 J-Space Adapter 使用研究报告固定的上游 commit 与 checksum；不得把其独特 prompt/脚本重新手写成“类似实现”后仍宣称使用原项目。兼容补丁必须保持最小并逐项记录：child-only activation、protected section 恢复、Owner/Memory 禁用、路径重定向和 disposer 接入。任何会改变上游编码策略的补丁都要重新跑固定质量验证。

默认 composition 为 `anchored-standard`；复杂任务只有在实验门开启后才可选择 `anchored-standard-jspace`。模型不能通过普通工具参数选择任意上游版本、启用 J-Space 或关闭 Policy Shield。

Preset profile 的选择语义由 014 单独拥有：spawn-time selection 可以在创建时选择；logical profile switch 只在上一个 one-shot run 完整结算后改变下一次 activation，并通过新 child Session 中日志化的最小 Work Handoff 延续任务。rc.7 不对同一 continuable Session 热重绑 preset；该能力等待 DSH 上游 CompositionRef/transaction seam。011 的 v1 one-shot 工具不依赖 logical switch。

### Interface：Work Report

Work Agent 返回：`status`、`summary`、`changedFiles`、`checksRun`、`risks`、`needsUserAction` 和必要的原样 artifacts。标准工具未公开 `outputSchema` 时，必须在消费边界校验固定文本/JSON envelope，不能假设 DSH 已保证结构。

v1 envelope 固定为单个纯文本 block 中的严格 JSON：`version: 1`；`status` 为 `completed|blocked|failed`；`changedFiles`、`risks`、`needsUserAction` 为有界字符串数组；`checksRun` 逐项保存原命令、`passed|failed|not-run` 和结果摘要；`artifacts` 逐项保存 `text|code|patch|command-output|citation`、标签与有界原文。DSH thinking 模型可在内部结果中附带 reasoning block，但消费边界在向 RP Host 交付 completed 或 partial `SubagentResult` 前必须全部丢弃 reasoning，且仍只接受恰好一个 text report block；其他非文本、未知字段、Markdown fence、多 text block、空必填值或超限内容均 fail closed。只有 DSH stop reason 为 `completed` 时才尝试解析；解析失败把结果收敛为中性 `error`，不得把 partial output 冒充 completed report。

RP Host Agent 可以在 Work Report 外围使用 Persona 语气，但代码、命令、规则引文、数值、测试结果和风险逐字段保持不变。

## 角色职责与工具面

### RP Host Agent

必须：

- 维持 Persona、关系与 Experience Mode；
- 使用 `web_search` / `web_fetch` 搜索和阅读当前信息，并使用只读的 `read` / `grep` / `glob` 检查当前 Session 工作区文件，保留来源；
- 澄清目标并取得高风险动作的 Owner 确认；
- 构造最小技术任务包，选择已资格化的固定 Adapter；
- 原样交付 Work Report 中的技术事实；
- 在主 Agent 自身上下文中直接完成唯一 Owner-facing 回复；Work Report 只提供事实，不替主 Agent 发言。

禁止拥有 shell、文件写入、patch、Git、任意代码执行以及会产生外部副作用的浏览器自动化。允许的 Web 能力仅为搜索和读取，文件能力仅为当前 Session 工作区内的只读检查；绝对路径、父目录跳出与符号链接的真实目标都不得越界。登录、表单提交、上传、购买、公开发布等未来能力必须由独立 capability 和 Owner confirmation gate 接入。限制必须由封闭 tool catalog 与执行 guard 强制，不能只写进 Persona。

### Work Agent

必须使用中性工程 persona、独立 Session 和 child allowlist。可见工具只包括任务所需的读取/搜索、编辑/patch、平台 shell、相关测试与受控 skill loader。

禁止看到或执行：RP/Persona 发布、长期关系记忆查询/确认/纠正/删除、最终 RP reply、公开 push/release、高风险部署和任何再次委派工具。child 继承的 sandbox 不宽于 parent 显式 override，approval 固定 `never`；权限不足只报告 blocked。

v1 进一步强制：RP Host/Work child 为星型拓扑；child 之间没有消息或输出读取通道；同一 RP Host 同时最多一个前台 Work activation；共享 workspace 的写入 activation 串行；递归委派与并行写冲突由 provider 状态和 tool gate 拒绝，而非仅靠 prompt 自律。

### Owner 查看 Work Agent 过程

借鉴 `NanmiCoder/dsh-agent-teams@763d88f` 的“从父会话成员行进入 child transcript”交互，但不采用其全 workspace 状态端点、continuable 团队、mailbox 或浏览器侧授权过滤。MistyMoon 的完整工程过程仍只存在于 DSH child Session 日志；父会话只持有可重建的 direct-child 地址和结构化 Work Report，不复制 prompt、消息、工具结果、transcript preview 或隐藏推理。

v1 优先使用 DSH rc.7 原生子 Agent 目录和只读会话页。Work provider 必须写入 `parentSession`、`origin: subagent`、`delegationDepth: 1` 和首步标准 `subagent/descriptor`，使 RP Host 下的 one-shot child 可被目录发现。客户端导航必须使用完整 `{ parentSessionId, childSessionId, mode: 'one-shot' }` 调用 `sessions.openSubagent(address)`，不得退化为裸 `sessions.open(childSessionId)` 或自建 transcript/history API。

该能力只允许 Owner 查看已经写入 DSH 日志并可正常呈现的内容，不把 child transcript 注入 RP Host、Persona、Memory、Recall Snapshot 或 final-reply，也不承诺展示 provider 未记录的内部 chain-of-thought。one-shot 子会话保持只读；查看入口不能获得 prompt、steer、continue、interrupt、send 或再次委派能力。

DSH rc.7 的 `subagent.history` 能验证 direct-parent address 和持久化 `parentSession`，但它不是多租户 Owner 身份认证。MistyMoon 不新增枚举所有 workspace/Session 的 Web route；若未来增加更显眼的 activation card，服务端必须从已认证顶层 RP Host 的 activation ledger 生成 exact address，并在返回前复核 parent preset、direct child、mode、Work preset 与 Owner authority。客户端参数和 React filter 不能充当授权。

## 来自 RP 生态的可复用设计

- Character、Owner Persona、Relationship、Scene/Campaign 分开建模，不把导入卡或世界书直接提升为 system authority。
- Worldbook 使用显式 key/regex/always-on、priority/order、position/depth 和硬预算；实际命中项与最终投影进入 DSH 日志。
- 群聊使用 `SpeakerPolicy`（manual/mention/ordered/weighted）返回 receipt；每个 request 只有一个 active speaker，其他角色只是有预算的场景上下文。
- Prompt itemization 以只读视图展示每个 Persona/Relationship/Worldbook/Memory/DSH/tool contribution 的来源、位置和预算。
- Summary/vector 是可编辑、可回滚、可删除重建的派生层；命中必须回查原始 revision 与 DSH source citation。
- 所有导入先进入 draft，preview 显示危险字段、未知扩展、预算、来源和许可证，再由 Owner 发布。

### 提示层

保留 DSH safety、permission、approval、Plan/协作模式、AGENTS、skill governance、外部副作用规则和未知 prompt section。只有 DSH 明确标记为可过滤的工具帮助 section 才能移除；rc.7 没有该标记，因此不得按 `tool:*` / `tools:*` 前缀猜测或删除。Anchored 的上游 prompt 行为只运行于 Work Agent；若其原始实现清空 context 或替换 persona，兼容层必须在同一请求恢复 protected sections，并用集成快照证明恢复后的实际 prompt。RP Host Agent 不运行这些编码 preset 逻辑。

RP Host Composition 只使用 DSH 公开 current-scope/preset/tool-restriction API 或 preset 显式注入，不遍历 Context 原型或 Symbol 猜测私有 scope。当前实现固定 DSH rc.7；scope 识别或 restriction 安装失败时 preset mount fail closed，不投影完整 Persona。每次 system-prompt assembly 都重新收敛封闭 tool catalog，monotonic execution guard 同时阻断后注册/HMR 工具，工具面不得静默扩大。

Anchored Standard 的 durable phase 和小工具目录作为必选上游逻辑运行：Work Agent 首请求只见必要编码工具，后续依据 durable tool/session events 在固定 allowlist 内 promotion；compaction 后从日志重建。它不是 thinking 的必要条件，但属于用户要求的编码质量组合。

## 最小委派任务包

~~~ts
interface RpWorkDelegationV1 {
  version: 1
  task: string
  acceptanceCriteria: string[]
  workspaceRoot: string
  allowedScope: string[]
  forbiddenScope: string[]
  relevantFiles?: string[]
  checksRequested: string[]
  userConfirmedRisks: string[]
}
~~~

任务包不得包含完整父 transcript、Persona 文档、Recall Snapshot、亲密关系摘要或其他 Owner 内容。路径解析后必须位于授权 workspace；任何高风险授权写成有来源的事实，而不是由 RP Host Agent 推断。

## DeepSeek V4 与 thinking

| 角色 | provider | model | reasoning |
| --- | --- | --- | --- |
| RP Host Agent | DSH Web UI 选定的 provider/model（不固定） | DSH Web UI 选定的 provider/model（不固定） | 由所选模型决定 |
| Flash Work Agent | `deepseek-official` | `deepseek-v4-flash` | `max` |
Pro route 暂不属于产品能力面；未来启用必须新增同等级 route 验收，不能复用 Flash 的结果。

DSH rc.7 Adapter 广告 `off | low | high | max`；Work 的固定 route 仍只使用 `max`。RP Host 不安装模型覆盖，沿用 DSH Web UI 的会话选择。Role Gate 的 `agent/request` listener 必须先 `await next()`，只对可认证的本 preset root/child 写入 `LlmCallConfig`；不能把所有 DSH child 强制路由。

首次实际请求校验 `request/header` 的 provider/model/reasoningEffort。部署把 thinking 锁为 disabled、模型不可用或 policy 拒绝 max 时，在网络 I/O 前或首次可判断点明确失败；不静默退到 high/off，也不修改 API key、base URL 或用户 Profile。

有工具调用的 thinking turn 由官方 Adapter 按要求 replay `reasoning_content`。DSH 日志记录可审计请求状态与 token 使用，但用户交付不暴露完整内部推理文本。

## 固定上游编码层

- `dsh-anchored-standard@25f21ae`：作为必选 Anchored Standard Adapter，保留上游 durable tool phase、promotion、compaction 恢复、小目录和 `includeSubagents: true` 的 child 门控。该固定点包含 Git Bash 运行时发现与无 `/bin/bash` 主机的 persistent-shell 修复；MIT + NOTICE。MistyMoon 已在 DSH rc.7 临时 Home 中重新通过 provision、restart discovery、真实 mount、prompt/tool/log surface 与失败回滚门。
- `J-Space@27e69e2`：作为真实上游 child-only Skill Adapter；复杂任务使用其 fast/full/loop gate 与 `goal / constraints / verified / open / next` ledger，但不让意识式 framing 取得 RP 身份或系统优先级。Apache-2.0。

J-Space 通过 skill loader 按需加载：fast 不加载，full 只取相关模块，loop 才启用恢复状态。其 `.jspace/` 默认输出重定向到 Owner-private task-state，禁止污染用户代码仓库。

若用户可靠验证使用的 commit、配置或组合顺序与本研究固定点不同，实施前以用户提供的可复现清单更新版本 manifest 和验收基线；不得自行猜测等价。

## 预设交付

套件可携带中性、版本化 preset 资产作为安装源，但 rc.7 不能靠 `cordis.patch.yml` 可靠增加 packaged preset root。经用户确认后，Installer 可预览并 provision 到 `<DSH_HOME>/.agent-presets/mistymoon-work-anchored-standard-v2`，同时保留旧版本用于显式回滚：

- 目标不存在才首次创建；
- 目标存在时拒绝覆盖，并展示版本/差异；
- 升级、回滚和删除分别再次确认；
- 不修改 DSH 安装目录、Profile、私有 `resolvedRoots` 或其他 preset。

长期方向是请求 DSH 提供公开的第三方 preset-root contribution Interface。

## 失败行为

- preset discovery/mount 失败：明确报告不可用，不伪装成已启用。
- Role Gate 身份不确定：不授予编码工具，不把 child 当 Owner。
- child provider/model/reasoning 不可用：返回 failed/blocked，不改 Profile。
- child 权限不足：返回所需 Owner 操作，不请求升权。
- child 取消、超限或异常：保留 stop reason 和 partial output，不标记 completed。
- 触及 commit/push/release、永久删除、权限提升或高风险部署：没有 Owner 确认就不形成授权任务包。

## 实施阶段

### Phase 0：前置契约与 headless 原型

1. [x] 独立修复 Owner Eligibility，并验证 child prompt 不触发 voice/recall/候选或治理工具。
2. [x] 固定并校验 Anchored 与 J-Space 的 commit、checksum 和许可证 metadata；默认 manifest 只含 Anchored，J-Space 保持 `experimental-disabled`。
3. [x] 用最小实验 preset 证明独立 composition、child tool filter、spawn 日志隔离、权限固定和失败回滚。
4. [x] 挂载 Anchored-only preset 并验证 protected sections、runtime context、首轮工具面、request header、模型可见日志与回滚。
5. [x] 捕获官方 Adapter 的真实请求，验证 Flash/high、Flash/max、Pro/max 和 disabled fail-loud。
6. [x] 在中性临时 DSH Home 验证真实 preset provision、restart discovery、mount 与失败回滚。

### Phase 1：one-shot Work Agent

在固定编码任务集的 Flash/max 5×3 通过后，实现一个固定工具、最小任务/结果 envelope，以及默认 `anchored-standard` 产品 provider；J-Space Adapter 只在显式复杂任务实验中启用。不使用 fork 或 continuable。Pro 或其他 DSH provider 作为未来独立增量验收。

### Phase 2：复杂任务账本

将固定 J-Space Skill Adapter 从实验开关提升为复杂任务默认层，前提是验证长任务恢复、跨文件一致性、质量收益和工作树无污染。

### Phase 3：可继续 Work Agent

只有 A/B 证明多轮收益且产品需要后台工作后，另写 Spec 引入 continuable、list/send/interrupt/report、冷恢复和孤儿清理。

## 已确认与发布前待办

Owner 已确认 Flash-only 首发、RP Host 沿用 DSH Web UI 会话模型、Work child 固定 `max`、首次 preset provision/升级均需确认，并已把 Owner Eligibility 作为独立 P0 前置。发布前仍需把固定编码评测任务集、重复次数和通过阈值记录为可复现清单。
