# 001：互斥双阶段输出画像，兼顾短对话与长程最终回复

## 2026-08-18 适用范围修订

本规范继续完整约束**除 `mistymoon-rp-host-v1` 外的通用 Agent preset**。RP 专用 preset 改用完整已发布 Persona 的受保护 `deployment:persona` system projection，并由 DSH `request/header` 记录实际模型所见 system 文本；它不生成 turn-voice/final-voice-refresh，也不暴露 `mistymoon_prepare_final_reply`。该例外按精确 preset identity 和顶层 Owner Eligibility 判定，不能由 prompt、自称或普通配置字符串启用。

这不是全局替换：Coding、Standard、Minimal 及其他既有 preset 继续使用本文的互斥双阶段 delivery 与 final-reply 工具。Foundation 必须在同一 public seam 上测试两条策略，保证 RP Host 的新行为不会让通用 preset 回退。

状态：已由用户于 `2026-08-16` 验收通过并授权提交 PR。旧版“每请求固定 anchor”“仅靠模型主动 prepare、跳过则无人格”，以及双层实现中“初始画像与最终 refresh 同时生效”的语义均因实际验收暴露产品缺口而撤回。

诊断基线：MistyMoon 产品代码基线 `f21afb2256865af2344a3b9422be9e296788dd95`；当前未提交工作区包含上一轮实施 Agent 的方案，全部视为用户所有；DSH 官方 `master` 核对基线为 `47f943859bef60e4160492346772ded9b24f765a`；修订日期 `2026-08-16`。实施开始前必须重新只读核对 DSH 官方远端最新版本。

## 问题陈述

rc2 为避免长程任务最终回复失去人格，在每个 assistant-producing step 前追加完整人格或 continuation。第一次修复把重复内容缩成常驻 system anchor，但人格仍进入每次 Anchored Standard 推理。第二次方案改为由模型调用 `mistymoon_prepare_final_reply` 后才注入人格；它在已验证的长程任务中能在最终回复前刷新人格，达到长程验收效果，但日常短对话常直接结束而不调用该工具，导致最终回复完全没有人格。

产品需要同时满足两条路径：

1. 每个启用 RP 的真实 owner turn，在真实 user message 后记录一次轻量 `Turn Voice Capsule`，为一步式短对话提供人格兜底。
2. 长程任务完成后，保留现有 `mistymoon_prepare_final_reply` 协议，在下一次无工具 final request 前记录一次更完整、更新鲜的 `Final Voice Refresh`，对抗初始 capsule 在长工具链中的稀释。

该方案不再宣称严格 final-only。初始 capsule 会被同一 owner turn 的工作请求看见，但只记录一次、保持轻量且位于 user message 末端；不得在每个 assistant/tool continuation 前重新投影。其作用域必须明确限定为“仅当本次响应无 tool call 并结束 owner turn 时约束输出呈现”，不能要求模型在工具调用或工程推理中扮演身份。长程 refresh 仍只在显式 prepare 后出现一次，且启用 refresh 前必须先把初始 capsule 替换为非指令性的 lifecycle record，任何 provider request 最多只能有一个 active voice profile。

## 实际行为与预期行为

### 已确认的失败行为

- rc2：每个 owner turn 追加完整 persona，同 turn 每个工具续步追加 continuation。
- 固定 anchor 方案：普通 preset 的每个 provider request 都包含人格 system section，干扰 Anchored Standard 推理并浪费 token。
- prepare-only 方案：长任务在模型选择 prepare 时表现良好；短对话直接自然结束时没有任何人格兜底。
- 当前双层实现会让 prepared final request 同时看见 active `turn-voice` 与 active `final-voice-refresh`；下一 owner turn 还能看见两条包含 `no persona or voice instructions apply now` 的 expired replacement。真实 Agent Loop 最小复现已稳定观察到这两个冲突源。
- 当前初始 renderer 使用 `Companion identity`、`Relationship with the owner`、`Expression guidance` 和任意 `style.instructions`，要求 Coding 模型先解决身份/roleplay 冲突；其预算实现还可能在任意字符处截断控制文本。
- 当前 prepare implementation 的 armed 状态和工具 restriction 主要依赖进程内状态，重启恢复声明尚未由等价测试证明。

### 修订后的预期行为

- 每个启用 RP 的 owner turn 恰好追加一条 `mistymoon:turn-voice` user context，紧随真实 owner message，使用 DSH `user/message` 持久化。
- `turn-voice` 是受预算约束的 output-presentation profile，不是完整角色卡：框架控制文本使用 `Speaker label`、`Relationship register`、`Voice traits` 和明确的 final activation；不得使用 `roleplay`、`persona`、`Companion identity` 或 `Expression guidance` 等会触发身份仲裁的控制措辞。
- 初始 profile 只在当前 response **无 tool call 且结束 owner turn** 时约束面向 owner 的表达；含 tool call 的 response 不应用任何呈现变化。它不得包含任意 `style.instructions` 或 reference dialog。
- 同一 owner turn 的后续业务工具请求可以在历史中继续看见同一条 capsule，但 Foundation 不再创建新 capsule、continuation 或 system anchor。其 event/source identity 必须保持唯一且可追踪。
- 模型可在全部工作完成、下一条自然语言即为 owner-facing final 时，以唯一 tool call 调用 `mistymoon_prepare_final_reply`。
- 合法 prepare 后，Foundation 必须先以 neutral lifecycle record 替换 active `turn-voice` surface，再记录恰好一条 `mistymoon:final-voice-refresh`，并把该 Agent 的下一步有效工具集合限制为空；下一请求只使用这个 active voice profile 生成 final reply。
- 模型未调用 prepare 而直接结束时，不二次生成、不事后改写；该回复由初始 `turn-voice` 提供 best-effort 人格。
- final assistant 完成或 turn 被取消/终止后，当前 surface 上的 active profile 必须替换为 neutral lifecycle record，下一 owner turn 不继承任何上一轮 active voice instruction；raw events 仍可审计。
- `off` 模式两条路径都关闭。

## 可重复的最小复现

### 短对话缺失

在当前 prepare-only 实现中，以 deterministic Adapter 让第一次请求直接返回自然语言，不调用任何工具。当前行为只有一个模型请求且没有 persona context；新期望仍只有一个模型请求，但 messages 中真实 owner message 后存在一条 `mistymoon:turn-voice`，最终回复随后正常完成。

### 旧重复注入

旧测试：

```powershell
pnpm exec vitest run packages/foundation/tests/agent-loop-persona.spec.ts -t "sends one snapshot and one byte-stable anchor across ten requests" --reporter=dot
```

其逐请求断言 system 含固定 anchor。新期望是：system 中永远没有 MistyMoon persona/anchor；十个工作请求只引用同一条 owner-tail capsule，不产生十条人格投影事件。

### 长程刷新

Deterministic 序列：真实 owner message、九次中性业务工具调用、第十次 sole `mistymoon_prepare_final_reply`、第十一次无工具 final。请求 1–10 只能看到同一条 active 初始 capsule；prepare 后先使其 inactive，请求 11 只能看到一条 active final refresh 且 tools 为空。当前已由用户在真实长程任务中观察到 prepare 路径具备有效人格效果，但自动验收仍须证明请求结构、日志和恢复。

### 画像冲突与跨 turn 禁令残留

使用真实 DSH Agent Loop 和 deterministic Adapter：第一 owner turn 走 legal prepare + final，随后在同一 session 开始第二 owner turn。当前实现的第二次请求可同时派生 active `turn-voice`，以及两条正文为 `MistyMoon turn-voice context expired. The owner turn finished; no persona or voice instructions apply now.` 的旧 replacement；prepared final request 则同时含 active initial 与 active refresh。新期望是：任一请求 active voice profile 数量不超过一；所有 consumed/superseded replacement 只陈述投影生命周期事实，不含 `no persona`、`ignore persona`、`do not roleplay` 或任何当前/全局指令。

### 初始 renderer 截断

用超过预算的中性 persona 字段渲染 initial profile。当前实现可能在任意字符处 slice，留下半句控制文本。新期望是 mandatory activation/priority block 始终完整，optional field 按整行加入或整行丢弃；不得用省略号或半句控制指令满足预算。

## 根因与证据

### 已确认事实

1. 固定 `SystemPrompt.section()` 会使人格内容参与每个请求，不适合作为 Anchored Standard 的 delivery voice。
2. DSH 只有在 assistant message 生成后才能确定该 step 是否含工具调用并自然结束；插件不能在同一次生成前可靠预测 finality。
3. 模型主动 prepare 是可跳过的软协议；它不能独自保证一步式短对话具有人格。
4. 用户已验证 prepare 路径在真实长程任务中的最终人格效果达到预期，因此本修订保留该路径而不是替换为隐藏式 revoice。
5. DSH 公开 Tools、Agent、`agent/pre-step`、`agent/turn-stopping`、session `user/message` 和 surface replacement seam 足以表达一次性 owner-tail context、显式 prepare、下一步空工具和过期。
6. 模型可见内容必须通过 DSH session log 重建；只在 provider request 中临时拼接不合格。
7. DSH session surface 目前只有 append/replace，没有删除；因此旧投影退出 active surface 时仍会留下模型可见 replacement，replacement 的措辞本身属于 prompt 设计。
8. 真实 Agent Loop 复现已证明第二 owner turn 同时可见 active profile 与两个旧的全局否定句；这不是私有 persona 内容导致的测试偶然性。

### 有证据支持的推断

- 小型 user-tail capsule 比完整 system persona 更少占用 token，且不会在每个 step 新增日志消息；它仍会影响同 turn 推理，只能称为低干扰兜底。
- capsule 作为稳定历史前缀可改善重复请求的缓存复用，但真实命中取决于 DeepSeek provider，必须实测，不能写成保证。
- 长程 refresh 位于最新上下文尾部并清空工具，比自动按 step/token 刷新更能避免中间推理污染。
- 初始 profile 与 final refresh 同时 active 会给模型两个可能不同的呈现指令；prepare 应被设计为一次显式状态转移，而不是叠加第二层指令。
- 使用 output-presentation 与 conditional activation 的控制措辞，比要求 Coding Agent 解决 companion/persona 身份冲突更可能降低 Anchored Standard 的推理扰动；真实稳定性仍须 A/B 验证。

### 尚未确认的问题

- 不同 DeepSeek 模型在不同长任务中选择 prepare 的稳定率；跳过时只能依赖可能已稀释的初始 capsule。
- user-tail capsule 对 Anchored Standard 推理稳定性的实际影响，需要真实模型 A/B，而 mock 只能证明输入结构。
- Code Mode 嵌套工具是否能建立与 Native 相同的 sole-call、durable resume 和空工具 final gate；不能证明时必须安全降级为只有初始 capsule。
- DSH 官方远端更新后相关 public seam 是否变化。

## 问题分类

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| MistyMoon 产品逻辑 | 主要原因 | 单一投影策略无法同时覆盖短对话和长任务 |
| DSH 接口使用错误 | 次要原因 | system-prompt section 被误用于 delivery voice |
| 插件组合或加载顺序 | 排除 | 单一 Foundation 即可复现 |
| 配置或安装问题 | 排除 | 自动测试与重启后实测均指向投影语义 |
| 数据格式或迁移问题 | 非根因、有兼容影响 | 旧 session 仍可能含 legacy persona |
| UI/Host/RPC 问题 | 排除 | 时间线展示真实模型输入事件 |
| 上游 DSH 缺陷 | 排除 | 本方案只使用公开生命周期 |

## 受影响模块

- `packages/foundation/src/index.ts`：组合 coordinator、prepare tool 与生命周期 Adapter；不得注册常驻 persona system section。
- `packages/foundation/src/roleplay.ts`：保留 mode folding 和两种 capsule renderer，删除旧 snapshot/continuation/anchor 语义。
- `packages/foundation/src/final-reply.ts`（可重命名）：deep `PersonaTurnDeliveryCoordinator` Module，拥有 owner-tail、prepare refresh、tool restriction、过期和恢复。
- Foundation、installer、built smoke、必要 UI/RPC 测试与直接相关文档。

Memory、Importer、Settings 和 Bundle 不拥有该状态机，不增加跨包依赖。

## 目标与非目标

### 目标

- 短对话即使跳过 prepare，最终回复也能看到一次轻量人格兜底。
- 长任务保留已验证有效的 prepare refresh，对抗上下文稀释。
- 每个 owner turn 最多一条初始 capsule、最多一条合法 final refresh；没有每 step 新投影。
- 任一 provider request 最多一条 active voice profile；prepare 是 `turn-voice active -> turn-voice consumed -> final-voice-refresh active` 的原子状态转移。
- 完整 MistyMoon Persona 只进入受认证 RP Host preset 的 `deployment:persona` system slot；其他 preset 仍不接收完整 Persona system section。Coding、Plan、工具、权限、审批和安全规则在两条策略中都保持优先。
- 所有模型可见 capsule、prepare call/result、restriction 生命周期和过期结果可由 DSH 日志重建。
- Foundation 通过一个小 Interface 隐藏投影、去重、恢复、cleanup 和失败规则。

### 非目标

- 不承诺人格完全不进入中间推理。
- 不把 user-tail profile 描述为模型不可见；conditional activation 只能约束用途，不能形成强隔离。
- 不保证模型一定调用 prepare，也不以 step、时间、token、工具名或自然语言猜测 finality。
- 不在自然回复后发起隐藏 revoice、steer 或第二份 assistant 回复。
- 不修改 DSH 源码、preset、Profile、Agent Loop 或公开接口。
- 不改变 PersonaDocument、Memory、Character Card、Settings RPC 或私有文件格式。
- 不自动清理旧 append-only session events。

## Module、Interface、seam 和 Adapter 设计

### Module：`PersonaTurnDeliveryCoordinator`

Foundation 内部提供一个小 Interface，语义可等价为：

```ts
beginOwnerTurn(agent, ownerMessage): Promise<TurnProjectionResult>
prepareFinal(execution): Promise<PrepareResult>
finishTurn(agent, outcome): Promise<void>
```

具体方法名不是公开要求。Implementation 必须隐藏：识别真实 owner turn、读取 durable RP mode、加载/校验 persona、渲染受预算约束的 turn capsule、创建带来源 message、sole prepare 校验、final refresh、Agent-scoped restriction、exactly-once、surface expiry、取消/dispose、并发隔离和 resume。

Call site 不得扫描 event log、拼 persona 文本、管理 disposer 或自行判断是否长任务。Tests 通过真实 seam 的 session events、provider requests、tool lists 和 cleanup 结果验证，不直接断言内部 `Map`。

### `Turn Voice Capsule`

- section：`mistymoon:turn-voice`；来源必须标识 `mistymoon-foundation`、owner turn 和已发布 persona version/hash，metadata 不含私密正文。
- 在真实 owner message 已落盘后、该 turn 首次 provider request 前，以单独的 sourced `user/message` 紧随 owner message。
- renderer-owned 文本使用 `MistyMoon output presentation profile`、`Activation`、`Operational behavior`、`Speaker label`、`Relationship register`、`Voice traits` 等中性字段；不得使用 `roleplay`、`persona`、`Companion identity` 或 `Expression guidance`。Profile 必须明确不改变 DSH Agent 的角色或身份；`Speaker label` 只用于合法 final 的称谓/自称呈现，不要求模型在工程推理中声称另一身份。用户字段本身不因恰含某个单词而被静默改写。
- `Activation` 必须完整表达：仅当本 response 无 tool call 且结束当前 owner turn 时应用；tool-calling response 不做 presentation changes。
- `Operational behavior` 必须完整表达：DSH 的问题理解、事实、代码、命令、计划、诊断、工具、权限、审批与安全决定不变。
- `companion` 与 `immersive` 的初始 profile 都只读取已发布 persona 的结构化 display/speaker label、relationship register 和 voice traits；不得读取或投影任意 `style.instructions`、reference dialog 或完整角色卡。
- 预算按字段构造：mandatory header/activation/operational block 必须完整；optional 字段只允许整项加入或整项省略，不得对最终字符串任意字符 slice。Config 的最小值必须足以容纳 mandatory block，否则插件加载时明确失败。
- 同一 owner turn 不因 assistant step、tool result、retry、compaction 或 HMR 自动新增第二条。
- 同一条 capsule可随历史进入该 turn 的后续请求；验收统计 projection event，而不是误称后续请求完全看不见它。

### Tool：`mistymoon_prepare_final_reply`

- 无业务参数；schema/output/UI 不包含 persona 内容。
- 只在全部业务工作完成、下一条回复应交付 owner 时调用，且必须是该 assistant message 的唯一 tool call。
- active RP 的合法调用建立 exactly-once final gate；`off` 返回关闭结果，不建立 gate。
- sibling、duplicate、missing/disposed agent、取消、persona 校验失败或 restriction 安装失败时明确失败，不产生半 armed 状态。
- 工具不负责判断任务是否“足够长”；短任务调用也必须安全，但产品不要求短任务一定调用。

### `Final Voice Refresh`

- section：`mistymoon:final-voice-refresh`，不得复用旧 anchor/continuation 名称。
- 合法 prepare 的状态转移必须先以带来源的 neutral lifecycle record 替换 initial surface，再把 refresh 作为带来源 `user/message` 排队到最近下一步；companion 可比初始 profile 更完整，immersive 可包含当前允许的完整 persona/reference dialog。
- 明确只适用于紧随其后的一个 owner-facing reply，并服从 DSH system/task/Coding/Plan/权限/安全和工具结果。
- 下一 request 的有效 tools 必须为空；refresh request 不能继续业务工具。
- final assistant 完成后通过 logged surface replacement 过期。原始事件保留。

### 生命周期与过期

- direct final 时，`turn-voice` 在完成后替换为 neutral consumed record；legal prepare 时则必须在 append refresh **之前**替换为 neutral superseded record。
- `final-voice-refresh` 在 prepared final 完成、取消或无法继续时替换为 neutral consumed record并清理 restriction。
- lifecycle replacement 只陈述历史事实，例如 `MistyMoon projection lifecycle record: owner-turn output profile consumed.`；不得包含现在或未来适用的命令、禁止、persona/roleplay 判定或 `no persona or voice instructions apply now` 一类全局否定句。
- surface 可保留多个 neutral lifecycle record，但任一 provider request 中 active `turn-voice` 与 active `final-voice-refresh` 的合计必须不超过一。
- provider retry 必须复用同一 logged refresh，不得重复 append。
- prepare 已记录而进程重启时，只能根据 durable tool call/result、message 和 assistant events恢复；不能仅靠进程内 `Map`。歧义时 fail closed：撤销/不恢复 refresh gate，但保留 DSH 正常能力。
- 过期不得删除或改写 raw events。

### Service Definition / Provider / Consumer seam

1. **Owner-tail seam**：DSH typed pre-step/session message 是 Service Definition；Coordinator 是 Provider；Agent Loop/LLM 是 Consumer；Foundation listener 是 Adapter。
2. **Finalization tool seam**：DSH Tools registry 是 Service Definition；Foundation tool 是 Provider；模型是 Consumer；tool registration 是 Adapter。
3. **Final refresh seam**：session `user/message` 是 Service Definition；Coordinator 是 Provider；下一 LLM request 是 Consumer。
4. **Restriction seam**：DSH Agent-scoped tools restriction/assembly 是 Service Definition；Coordinator 是 Provider；request assembly 是 Consumer。
5. **Expiry seam**：turn lifecycle与 surface replacement 是 Service Definition；Coordinator 是 Provider；后续 `deriveMessages()` 是 Consumer。

Bundle 只组合插件和默认配置。Settings、Memory、Importer 不访问 Foundation implementation。

## 数据流和生命周期

```text
owner message
  -> DSH logs real owner message
  -> Foundation logs exactly one compact mistymoon:turn-voice after it
  -> first request sees owner message + compact capsule

short path
  -> model returns natural final without prepare
  -> no extra model call
  -> final reply uses capsule best-effort
  -> turn capsule expires

long path
  -> same logged turn capsule remains in history; no new per-step projection
  -> ordinary Coding/Plan/tools continue
  -> sole mistymoon_prepare_final_reply call
  -> Foundation replaces turn-voice with a neutral superseded record
  -> Foundation logs one final-voice-refresh and installs empty-tool gate
  -> next request sees one active fresh refresh; tools = []
  -> final assistant completes
  -> refresh becomes a neutral consumed record; restriction disposes

next owner turn
  -> ordinary tools restored
  -> previous turn persona surfaces absent
  -> one new turn capsule is created for the new owner message
```

## 配置、持久化和迁移影响

- `defaultRoleplayMode`、`/rp` 和 PersonaDocument schema 不变。
- 不新增私有文件、数据库 schema 或 DSH session event type。
- 两种 profile 和 consumed/superseded replacement 使用 DSH 现有 session events。
- 初始 profile 预算必须是 Foundation validated Config，不硬编码部署可变值；默认值应保守并在 README 说明，最小值必须容纳不可截断的 mandatory block。Renderer 必须按字段预算，不能对已组装文本作字符级裁切。
- 不新增自动 step/token refresh 阈值。
- 旧 rc2/anchor/prepare-only raw events 不删除；新实现停止生成旧 section。严格验证使用新会话或中性迁移 fixture。

## 隐私、安全及失败行为

- 只读取当前 owner、已发布、active persona；不得读取 draft、其他 owner、真实测试外数据或 memory internals。
- 测试使用中性生成 persona和临时目录；Spec、fixture、snapshot、日志和报告不得含真实人格、记忆、角色卡、凭据或会话。
- 初始 capsule渲染失败：明确记录中性诊断并继续 DSH turn，不使用 stale/template；该 turn 可能无人格，但不得阻断 Coding。
- prepare refresh失败：返回明确工具失败，保留初始 capsule和普通工具能力，不进入半 restricted 状态。
- tool output、UI card、lifecycle marker和 metadata不显示 persona正文；marker 不能成为新的 active prompt 指令。
- `off` 不加载/渲染 persona，不产生两种 capsule。
- Persona 不能授权工具、改变权限、绕过审批、安全或 Plan，也不能覆盖技术事实。

## 兼容性要求

- 只使用 DSH 官方远端最新版本的公开 seam；不得修改 `<DSH_REPO>`。
- Anchored Standard/普通 Native 是必须支持的主要组合。
- Standard、Plan、permission、安全、approval、模型路由和业务工具不因初始 capsule改变结构；允许 messages 在 owner 后增加唯一 capsule。
- complete/minimal 若运行正常 owner turn，应获得相同初始 capsule；能合法调用 prepare 时支持 refresh，不能时仍以初始 capsule安全完成。
- Code Mode 不得改变 `run_code`、权限或工具执行；无法证明 nested prepare 等价语义时只启用 owner-tail capsule，并明确支持矩阵。
- Settings Host/RPC、Memory、PersonaDocument 和 Character Card 格式不变。

## 允许修改的文件或模块

- `packages/foundation/src/index.ts`
- `packages/foundation/src/roleplay.ts`
- `packages/foundation/src/final-reply.ts` 或同职责内部文件
- `packages/foundation/package.json` 与仅因直接依赖变化需要的 `pnpm-lock.yaml` importer
- `packages/foundation/tests/**`
- 必要的 `packages/installer/tests/**`
- `scripts/smoke-built.mjs`
- `README.md`、`docs/architecture.md`、`AGENTS.md` 的直接相关事实
- 测试命令确需暴露时的根 `package.json`

当前未提交实现可在上述范围就地修正；不得 reset/checkout 覆盖用户修改。

## 明确禁止修改的内容

- `<DSH_REPO>` 的任何源码、文档、配置、测试、lockfile 或 Git 状态
- DSH shipped preset/Profile、用户 DSH Home、MistyMoon 私有目录
- `packages/memory/**`、`packages/settings-ui/**`、Importer、PersonaDocument schema、Bundle 业务逻辑和 `cordis.patch.yml`
- DSH Coding、tools、Plan、permission、approval、安全、模型路由或 Agent Loop
- 私有人格、记忆、角色卡、凭据、会话或日志
- 无关重构、依赖升级、commit、push、PR、Release、发布或远端操作
- `.research/**` 的现有研究材料
- 用户批准后的三个 Spec 文件

## 部署与回滚

验收后仅在用户另行授权时构建、安装或发布候选版本。首次部署使用新会话验证短路径和长路径；旧会话限制必须在 release notes 中说明。

回滚为安装 `0.0.1-rc2` 或上一已知版本。回滚会恢复 rc2 的每步 continuation；新 tool/message events 作为普通历史保留。安装、回滚、合并和发布均由用户决定。

## 风险

- 初始 capsule仍会进入同一 turn 的推理；这是短对话可靠人格与严格推理隔离之间的已接受权衡。
- conditional activation 不能从技术上阻止模型在 CoT 中讨论该 profile；中性字段、移除任意 freeform instruction 与单 active profile 只能降低冲突面，不能保证零扰动。
- 模型可能在长任务中跳过 prepare，最终只能依赖已稀释的 capsule。
- prepare 多一次模型 step，增加延迟和成本。
- immersive refresh 可能较大；必须只出现一次并受已发布 persona mode约束。
- 重启恢复和 Code Mode 是高风险生命周期路径，mock 绿灯不能替代 built/真实组合测试。

## 尚待用户决定的问题

1. 是否批准“互斥双阶段输出画像”的产品语义，并接受初始 profile 会被同 turn 中间请求看见、但仅对无工具终答激活。本 Spec 推荐批准。
2. 是否接受模型跳过 prepare 时以初始 capsule best-effort 完成，不做隐藏 revoice或第二份回复。本 Spec 推荐批准。
3. 是否接受 Code Mode 无法证明 durable final gate 时仅使用初始 capsule，保留全部 Coding 能力。本 Spec 推荐批准。
4. 是否接受旧会话不做破坏性清理，新会话作为严格验收前提。本 Spec 推荐批准。
5. 是否接受初始 profile 只使用结构化 speaker/relationship/voice traits，任意 `style.instructions` 与 reference dialog 仅允许进入 final refresh。本 Spec 推荐批准。

用户明确批准本 Spec 即表示接受以上五项。实施 Agent 不得自行恢复常驻 system persona、每 step continuation、自动 step/token refresh、双 active profile 或 post-hoc revoice。
