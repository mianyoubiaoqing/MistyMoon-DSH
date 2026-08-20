# 014：可切换预设的 Work Agent

状态：工程架构已于 2026-08-17 获用户批准。当前实现包含 Shared Baseline、固定 Preset Resolver、Compatibility Gate、path-free publication、Anchored-only fresh child Adapter、Flash/max product runtime、workspace lease gate 与 next-activation Work profile controller。版本化 preset 已在中性临时 rc.7 Home 验证；Flash/max 独立 15/15 后按 Owner 接受的 Flash-only 范围加入 bundle。后续批次取得 Pro/max 15/15，但没有扩大能力面的 Owner 决策，Pro 保持未注册；同一批 Flash 总门未通过，公开发布前需增量稳定性复核。

基线：MistyMoon `dd4506e`；DeepSeek Harness `0.1.0-rc.7`，源码固定到 `99f6f02`。RP Host、编码组合与模型路由的上层约束继续由 [011 委派设计](../011-rp-agent-delegation/SPEC.md)拥有。

## 结论

可以基于 DSH child 实现设计一个 `Switchable Work Agent`，但“切换预设”不能解释为在已有工具历史的同一个 DSH Session 上热重绑 preset。DSH rc.7 的 `agentPresets.recompose()` 仍只对尚未运行过 turn 的空 Session 安全；原生 child 又通过 `composeFrom(parent)` 固定继承 parent 当前的同一代 preset。

本设计采用两层身份：

~~~text
RP Host Agent
  └─ Logical Work Agent（稳定 workAgentId、共享基线、任务控制器）
       ├─ Activation 1：DSH child Session A + anchored-standard
       ├─ switch commit（只允许完整 turn/end 后）
       └─ Activation 2：DSH child Session B + anchored-standard-jspace
~~~

每次选择的新 preset 只用于下一个 fresh one-shot Activation，并创建全新的 DSH child Session。旧、新 Session 分别只在一个固定工具/提示组合下运行；逻辑 Work Agent 的稳定身份、profile revision 和最小工作交接由 parent DSH Session 事件重建。这样不需要修改 DSH，也不会让旧工具调用在新 preset 下被错误解释。

第一阶段只实现 **spawn-time selection**：创建一次性 child 时选择固定 Work Preset。经过日志和 A/B 验证后，第二阶段可实现 **logical profile switch**：一个 one-shot run 完整结算后，修改 logical Work Agent 的选择，下一次 submit 再创建新 Session。禁止 mid-turn、未结算工具调用期间和同 Session 热切换。若要求同一 native continuable child 在 turn boundary 更换 composition，必须先获得 DSH 上游 `CompositionRef` / switch transaction 接口。

## 术语与不变量

### Shared Baseline

共享基线是版本化、不可变的治理快照，不是父会话历史，也不是共享可变 Cordis scope：

- DSH safety、permission、Plan/协作模式和 AGENTS/skill governance 的保护规则；
- Owner Eligibility、RP/Memory 隔离和角色认证版本；
- workspace grant 约束、sandbox 上限、approval=`never` 和 `maxDepth=1`；
- parent/child 各自的工具上限与永远禁止的能力；
- 允许的 provider/model/reasoning、token/cost 上限和失败策略；
- Work Report、switch handoff 和审计事件的 schema 版本；
- baseline generation id 与 canonical fingerprint。

RP Host 和所有 Work Activation 必须记录同一 baseline fingerprint，再按角色应用不同的 restriction。任何 preset overlay 只能在基线允许的范围内缩小或替换编码行为，不能删除基线、扩张权限或改变 Owner 身份。

共享基线不包含：

- RP transcript、Persona、关系摘要或 Recall Snapshot；
- 任一 Memory 候选、私有角色卡或其他 Owner 数据；
- parent 的未完成 turn、tool call、inbox 或 mutable Session state；
- API key、DSH Home、绝对安装路径或用户 Profile 内容。

### Work Preset

`WorkPreset` 是 MistyMoon 注册表中的固定、可审核组合，不接受任意 prompt 或任意本地目录：

| profile | 固定编码层 | 用途 |
| --- | --- | --- |
| `anchored-standard` | Policy Shield → Anchored Standard → DeepSeek Request Policy | 默认编码、研究和审查 |
| `anchored-standard-jspace` | 上述组合 + J-Space Skill/Ledger | 多文件、长任务和需要恢复的复杂工作实验 |

模型 route 不伪装成 preset。首发默认使用已资格化 direct Flash/max；Owner 可以从设置页选择 DSH 已注册且接受 `max` reasoning 的其他 exact provider/model（包括已配置的 Pro），但它们在独立验收前均为 experimental，不能绕过 preset 与基线兼容检查。未来发布专用 Pro 工具仍必须独立授权和验收。

模型选择与 profile controller 正交，但它是 Owner-private 的部署默认设置，不是父 Session event。Settings Host 从 DSH live catalog 投影无凭据选项；版本化 `work-model.json` 保存 exact provider/model、固定 `max`、qualification 和连续 revision。保存非默认 pair 必须由 Owner 明确确认，重复保存同一 pair 保持 revision 不变；revision 冲突或 catalog 失效拒绝写入。publication 把 exact tuple 的 canonical SHA-256 纳入 route id 和 governance fingerprint，防止 provider/model 被交叉拼接；设置变更只被之后的 fresh activation 读取，未发布 child 在 publication recheck 发现漂移时回滚，已发布或运行中的 child 不热重绑。

每个 profile 在 rc.7 中解析为**一个完整、版本化的 DSH `nativePresetId`**，其中已经包含该 profile 所需的 baseline rows、Anchored Adapter 和可选 skill loader；v1 不把两个独立 DSH preset 在运行时叠成 composite。两个完整 preset 中的公共 rows 必须来自同一 baseline manifest/fingerprint。私有 `baseline <- overlay <- child` scope registry 仅作为 headless 结构实验，不宣称可被标准 Host、cold presenter 或 continuable resolver 恢复。

两个 profile 都必须使用真实固定上游资产，不得用重写后的相似文案冒充原项目。默认 profile 只需要 bundled Anchored Standard；J-Space 保持实验门，直到质量评测通过。

### Activation

Activation 是逻辑 Work Agent 在一个固定 Work Preset 下的一次 DSH one-shot child run。每个 Activation：

- 有独立 `sessionId`，header 记录实际 `agentPreset`、`parentSession`、`delegationDepth` 和 workspace；
- 只有一个 baseline fingerprint、一个 preset manifest fingerprint 和一个中性 Work persona；
- 不继承 RP Host transcript，默认使用 fresh spawn；
- 只接收一个 delegated owner prompt，并在一个 turn 内完成任意必要的 model/tool steps；
- 取消、失败和 dispose 都遵循 DSH `AgentHandle` / `SubagentRun` 的所有权规则。

每个 activation 还必须保留 DSH 标准 one-shot `subagent/descriptor`，以便 rc.7 原生 catalog 建立 direct-parent 地址。用户查看历史时使用 `sessions.openSubagent({ parentSessionId, childSessionId, mode: 'one-shot' })`；正文继续由 DSH Session persistence 拥有，logical profile controller 和 MistyMoon activation metadata 都不得复制 transcript。profile switch 创建的新 child 各自出现在同一父会话目录中，旧 child 保持只读且不因 logical revision 变化而被重绑或改写。

## DSH 接缝选择

### 直接复用

| DSH 能力 | 用法 |
| --- | --- |
| `ctx.subagents.registerProvider()` | Phase 1 为每个受信 profile 注册配置固定的 one-shot provider；保留 DSH start/end 生命周期 |
| `ctx.agents.create()` / `AgentSetup` | 创建 one-shot activation，并在 unpublished transaction 内异步挂载目标 preset；失败自动回滚 |
| `ctx.agentPresets.resolve()` / `mount()` | 解析并在 child creation window 挂载一个明确 preset id |
| `resolveChildDepth()` / `resolveChildAgentOptions()` | 复用深度和 model options 解析 |
| delegated sandbox/approval helpers | 在首个 await 前捕获 parent override，并写入 child 日志 |
| DSH Session、projection、persistence | 保存 activation descriptor、切换事件、request header 和模型可见 handoff |
| `tools.restrict()`、persona slot、request waterfall | 应用 child allowlist、中性 persona 与 DeepSeek route policy |
| `SubagentRun` / `AgentHandle` | 结果、取消、dispose 和 quiescence 所有权 |

### 最小复制与改造

DSH 的公开 `startInProcessRun()` 内部固定调用 `applyChildComposition(child, parent)`，后者固定 `composeFrom(parent)`；`childSessionMeta()` 也从 parent live scope 推导 preset。因此 MistyMoon 不能只包一层配置实现独立 preset。

未来 `packages/work-agent-dsh` 只适配 DSH MIT 源码中的最小 creation/drive 片段；纯合同继续留在 `packages/work-agent`：

1. `startInProcessRun` 的 child id、创建、drive、result fold 和 dispose 结构；
2. 将 `applyChildComposition` 替换为 `applyWorkActivationComposition`；
3. 将 `childSessionMeta` 替换为接受已解析 target preset 的 `workActivationMeta`；
4. 在 creation transaction 内写入 MistyMoon 版本化 activation descriptor；
5. 保留 DeepSeek copyright、MIT LICENSE/NOTICE 和清晰的 upstream commit/差异记录。

不复制 DSH 的 continuation manager、fork provider、Host preset selector、private `standing`/`bindings`/`resolvedRoots` 或 Session persistence 实现。

`SubagentStartRequest` 没有 `presetRef` 字段。Phase 1 因此把 profile 固定在 provider 实例配置中，由 RP Host 薄工具或受信 Controller 选择 provider；模型不能在 request 中传本地路径。Phase 2 只在 one-shot activation 之间更新 logical profile revision，仍复用同一个 one-shot provider contract。它不伪造原生 continuable descriptor，也不宣称兼容 DSH `send_message` / `list_agents`；原生 continuable 必须等待上游 preset-aware creation seam。

### 建议向 DSH 上游请求的公共能力

本地 Adapter 可行，但长期更理想的 DSH seam 是：

- `SubagentStartRequest` 支持受 provider 声明的 `presetRef` capability；或
- `startInProcessRun()` 接受受创建事务拥有的 `composeChild` callback；
- `agentPresets.mount()` 返回可持久化的 standing generation/fingerprint，而不只返回 preset id；
- durable subagent descriptor 提供 namespaced extension data。

这些是减少复制的上游建议，不是 014 实施的阻断条件。不得调用 DSH 私有字段来模拟它们。

## 工程模块

Phase 0 使用两个低耦合包：`packages/work-agent` 只实现 `contracts`、`baseline` 与 `presets` 三个纯合同区域；`packages/work-agent-dsh` 是唯一 DSH lifecycle Adapter。二者都不解释 Persona、不读写 Memory，也不拥有 DSH Profile。Controller/policy 保持纯合同优先，只有必须触及 DSH Context、Agent、Session 或 preset roster 的代码进入 Adapter。

~~~text
packages/work-agent/
├─ src/contracts.ts
├─ src/baseline/
│  ├─ registry.ts
│  ├─ canonicalize.ts
│  └─ apply-role-policy.ts
├─ src/presets/
│  ├─ manifest.ts
│  ├─ resolver.ts
│  ├─ compatibility-gate.ts
│  └─ publication.ts
├─ src/controller/
│  ├─ work-agent-controller.ts
│  ├─ switch-transaction.ts
│  ├─ recovery.ts
│  └─ events.ts
├─ src/policy/
│  ├─ role-gate.ts
│  ├─ tool-ceiling.ts
│  └─ deepseek-request-policy.ts
└─ tests/

packages/work-agent-dsh/
├─ src/fresh-activation.ts       # Phase 0 已实现：public creation seam
├─ src/fixed-preset-provider.ts  # Phase 0 已实现：inert one-shot provider factory
├─ src/governed-provider.ts      # Phase 0 已实现：path-free policy publication seam
├─ src/compose-activation.ts     # Phase 1，未实现
├─ src/drive-activation.ts       # Phase 1，未实现
└─ tests/
~~~

### Module：Shared Baseline Registry

唯一公共操作是按受信配置取得一个冻结快照：

~~~ts
interface SharedBaselineSnapshotV1 {
  version: 1
  generation: string
  fingerprint: string
  dshCompatibility: { version: string; commit: string }
  ownerEligibilityPolicy: string
  protectedSections: string[]
  workspacePolicy: 'parent-cwd-only'
  sandboxCeiling: 'read-only' | 'workspace-write'
  approvalPolicy: 'never'
  maxDelegationDepth: 1
  providerAllowlist: string[]
  modelAllowlist: string[]
  rolePolicies: {
    rpHost: { toolAllow: string[]; toolDeny: string[] }
    workAgent: { toolAllow: string[]; toolDeny: string[] }
  }
  contractVersions: { delegation: 1; report: 1; handoff: 1 }
}
~~~

Registry 隐藏 canonical JSON、fingerprint 算法、配置加载和代际缓存。快照一旦被某个 logical Work Agent 引用就不可修改；配置更新创建新 generation，只影响以后新建的 logical agent。运行中的 logical agent 若要升级基线，必须另走显式 baseline migration，不与 preset switch 混用。

### Module：Preset Overlay Resolver

Resolver 接受注册表 id，不接受路径：

~~~ts
interface WorkPresetRefV1 {
  version: 1
  id: 'anchored-standard' | 'anchored-standard-jspace'
  nativePresetId: string
  manifestFingerprint: string
  upstreams: Array<{
    project: 'anchored-standard' | 'j-space'
    commit: string
    checksum: string
    delivery: 'bundled' | 'external'
  }>
}
~~~

Resolver 在任何 child 创建前验证：preset discovery、固定 manifest、许可证状态、immutable provision 目录、实验 capability 和 DSH 兼容版本。返回值是已经验证但尚未挂载的 `ResolvedWorkPreset`；原始文件内容、绝对路径和 loader 细节不越过该接口。

### Module：Compatibility / Policy Gate

Gate 比较 target preset 与 baseline，并返回结构化差异：

- target 工具必须是 Work Agent ceiling 的子集；RP/Memory、final reply、再次委派、push/release 和高风险部署永远禁止；
- sandbox 不得放宽，approval 必须仍为 `never`；
- 中性 Work persona 不能被 target 替换成 RP 或“无视上级规则”内容；
- 使用 complete persona、抑制 runtime context 或清空其他 prompt sections 的 target 直接判定 incompatible；
- DSH safety、permission、Plan、AGENTS 和 skill governance 在最终请求装配中仍存在；
- provider/model/reasoning 必须在 baseline allowlist 内；
- upstream version/checksum 和兼容补丁版本必须匹配；
- capability 增加只允许发生在 baseline ceiling 内；若仍构成费用或风险提升，则要求 Owner 确认。

验证失败时返回 `not-ready` / `incompatible` / `confirmation-required`，不能静默回退到另一个 preset 后仍报告原 profile。

### Module：Switchable Child Composer

Composer 隐藏所有 DSH creation 细节。建议的窄接口：

~~~ts
interface CreateWorkActivationV1 {
  logicalWorkAgentId: string
  revision: number
  parentSessionId: string
  baseline: SharedBaselineSnapshotV1
  preset: WorkPresetRefV1
  route: 'flash-max' | 'pro-max'
  task: RpWorkDelegationV1
  handoff?: WorkHandoffV1
  signal: AbortSignal
}

interface WorkActivationRun {
  sessionId: string
  revision: number
  baselineFingerprint: string
  presetFingerprint: string
  result: Promise<{
    stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
    report?: WorkReportV1
  }>
  dispose(): Promise<void>
}
~~~

内部顺序固定为：

1. 同步捕获 parent delegated sandbox/approval 与 baseline generation；
2. 解析 target preset 并运行 compatibility gate；
3. `ctx.agents.create()` 创建 unpublished child；
4. `await ctx.agentPresets.mount(childCtx, target.nativePresetId)`；
5. 应用 delegation context、中性 persona、baseline role policy 和最终 tool restriction；
6. 写入标准 one-shot descriptor、MistyMoon activation metadata 和 delegated policy events；
7. publication commit 前同步确认受信 registry generation 未变化；
8. 发布 child，并将任务包和可选 handoff 作为 child 的真实、模型可见 user message 送入；
9. 通过 `SubagentRun.result` 收敛 stop reason / Work Report，并在所有路径 dispose。

“Policy Shield → Anchored → 可选 J-Space → Request Policy”描述逻辑决策顺序；Cordis 注册顺序有意形成包围结构：mount 前用 baseline/manifest 做 preflight，完整 Work Preset 作为 child 的 standing ancestor，最后在 exact child scope 应用 enforcement。这样 `tools.restrict()` 能过滤 ancestor tools；同层自己注册的工具不会被该 restriction 过滤，所以 exact child scope 只允许 DSH/MistyMoon 明确审计的 descriptor、report/structured-output 等最小能力，不能把 Coding overlay 直接挂到该层。`tools.restrict()` 也不替代 sandbox 和 approval 权限边界。

### Module：Work Agent Controller

Controller 是 RP Host 唯一调用面：

~~~ts
interface WorkAgentController {
  start(request: StartLogicalWorkAgentV1): Promise<WorkAgentHandle>
  submit(id: string, request: WorkTurnRequestV1): Promise<WorkReportV1>
  switchPreset(id: string, request: SwitchWorkPresetV1): Promise<SwitchResultV1>
  cancel(id: string, reason: string): Promise<void>
  dispose(id: string): Promise<void>
}

interface SwitchWorkPresetV1 {
  version: 1
  requestId: string
  expectedRevision: number
  targetPreset: WorkPresetRefV1['id']
  targetRoute?: 'flash-max' | 'pro-max'
  reason: string
  ownerConfirmationId?: string
}
~~~

普通 Work Agent tool 不暴露 `switchPreset`。模型可以在 Work Report 中建议升级到复杂 profile，实际切换只能由受认证 RP Host policy 或用户设置发起；任何 capability/cost 提升按 gate 要求 Owner 确认。

Controller 隐藏 activation id 变化、锁、幂等 request id、profile revision、当前 `SubagentRun`、flush 和 DSH lifecycle event 对接。调用者不能直接持有或 rebind child scope。

## 状态机

~~~text
NEW
  └─ start ─> READY

READY ── submit ─> RUNNING ── turn/end ─> SETTLING ─> READY
  │                    ├─ cancel/error ────────┘
  │                    └─ dispose 由 run owner 收敛
  └─ switch ─> SWITCH_VALIDATING ─> READY(new profile revision)
                         └─ failure ─> READY(old revision)

READY ── dispose ─> CLOSED
~~~

切换 admission 必须同时满足：

- 当前没有 active run；上一个 activation 已有 terminal result、完整 `turn/end` 且完成 dispose；
- 没有未结算 tool call、structured capture、Task 或 result；
- `expectedRevision` 与当前 revision 一致；
- target 与当前 baseline 兼容；
- 所需 Owner 确认存在且可验证；
- Session persistence/flush 能力满足恢复要求。

任一条件不满足都不改变当前 profile revision，也不创建 child。

## Preset Switch Transaction

这里的“切换”是 logical controller 对**下一次 one-shot activation**的选择，不是 DSH scope rebind。parent Session 是唯一 commit authority；一个 activation 已经开始后，它的 preset 永不变化。

1. 取得 logical agent 独占 switch lock，验证 `requestId` 幂等和 `expectedRevision`。
2. 解析 target 的完整、版本化 coding preset，验证 immutable manifest、external capability 和 compatibility diff；可用 `standingKeyFor()`做无 Agent 的挂载预备。
3. 若要继续同一技术任务，从最后一个 completed Work Report 生成 `WorkHandoffV1`；来源缺失或歧义时拒绝 continuation，但仍可作为全新任务选择 profile。
4. 在 parent log 追加 `mistymoon:work-switch-requested`，只含 id、revision、fingerprint 和结构化 diff，不含 prompt/私密内容。
5. 在 parent log 追加并 flush `mistymoon:work-switch-committed`，记录 old/new profile revision、baseline、preset 和可选 handoff source id。
6. 内存 selected profile 切到新 revision；下一次 `submit()` 才创建新的 one-shot child Session，并把可选 handoff 与任务一起写入该 child 日志。

崩溃恢复规则：

- 只有 requested、没有 committed：忽略 intent，继续旧 profile revision；
- 已 committed、尚未创建新 child：新 profile 已选定，下一次 submit 正常创建 activation；
- 新 activation 启动后崩溃：按 DSH repair 得到 `interrupted/error`，不得盲目重放可能已有副作用的任务；用户确认重试时创建又一个 fresh Session；
- child header、descriptor、baseline 或 preset fingerprint 不一致：该 activation 进入 `blocked-corrupt`，不得回退旧 preset 冒充成功；
- target preset/baseline fingerprint 在重启后不可解析：进入 `blocked-incompatible`，保留日志并请求用户修复依赖；
- 重复 `requestId` 返回原 profile revision，不重复提交 switch。

## Work Handoff

Preset 切换不复制旧 transcript。连续性只通过版本化、最小且可验证的模型可见交接消息：

~~~ts
interface WorkHandoffV1 {
  version: 1
  fromActivation: string
  fromPresetFingerprint: string
  completedTurnEndSeq: number
  goal: string
  constraints: string[]
  changedFiles: string[]
  checksRun: Array<{ command: string; outcome: 'passed' | 'failed' }>
  verified: string[]
  open: string[]
  next: string[]
}
~~~

handoff 由 durable Work Report / J-Space ledger 和 DSH 事件生成，不从模型隐藏状态或自由摘要猜测。它必须作为新 child Session 的 user message 落盘后才能送入模型。禁止包含 Persona、关系记忆、RP 场景文本、完整 parent transcript、凭据或其他 Owner 数据。

## 版本与指纹

Baseline 和 Work Preset 都使用 canonical JSON 后的 SHA-256 fingerprint。指纹输入只含稳定、可公开或可审计的配置标识，不把绝对路径、凭据和私有 payload 写入 manifest。

Preset provision 使用内容寻址或版本化目录，目标存在即拒绝覆盖。任何新内容生成新 manifest fingerprint 和 preset id，不把可编辑目录的原位修改当作升级。当前 DSH 的 standing generation identity 只使用进程内文件 `mtimeMs + size`，不覆盖 skill/assets，也没有公开 durable fingerprint；MistyMoon 因此在每次 activation 前重新核对 immutable manifest，checksum 不符即阻断，不能宣称被覆盖/删除的 preset 可 bit-for-bit 冷恢复。

每个 child request 必须能从 DSH 日志审计：

- logical agent id / activation revision；
- baseline generation/fingerprint；
- Work Preset id/manifest fingerprint 和三个上游版本；
- actual provider/model/reasoning effort；
- tool catalog fingerprint、sandbox/approval 和 stop reason。

不记录完整 chain-of-thought。

## 隔离与角色规则

- Work Activation 永远是 `delegationDepth>0`，统一 Owner Eligibility 必须令其不能触发 Foundation voice、Memory observation/recall 或治理工具。
- child preset 中即使含 `source.kind=user` 的 delegation prompt，也不能获得 Owner 身份。
- RP Host 不获得 shell/edit/write/patch/Git、代码执行或 browser side-effect；它保留只读 `web_search` / `web_fetch` / `read` / `grep` / `glob`。Work child 不获得 RP/Persona、Memory mutation、final reply、再次委派和公开发布能力。
- 同一 logical Work Agent 同时最多一个前台 activation；共享 workspace 写入严格串行。第二个 start 在前一个 terminal result 与 dispose 前返回 `busy`，不排队偷跑。不同 child 没有 send/list/read-other-output 通道。
- switch 不复制或改变 RP Host 的 Persona、Experience Mode、Character Scene 或 Campaign Canon。
- Work Handoff 只携技术任务状态；跑团规则分析可作为普通工作任务，但叙事和 Canon commit 仍回到 RP Host。
- preset/route 不可用时 fail loud；不修改 API key、base URL、Profile 或 DSH 安装目录。

## 失败与取消

- create/mount/compatibility 失败发生在 publication 前：回滚全部 unpublished scope，不产生可见 child。
- child publication 后启动 prompt 前取消：返回 `aborted`，dispose handle；不标记 completed。
- running 时 switch 请求：返回 `busy`，不排队偷跑；由调用者在 terminal result 与 dispose 后重试。
- parent dispose：取消当前 one-shot run，再等待 result 与 child quiescence；所有路径最终释放 handle。
- output/report 校验失败：原始 child output 只保留在 DSH-owned child transcript，父级交付收敛为不回显原载荷的中性 error；所有 completed/partial 父级结果都丢弃 reasoning blocks，invalid report 不能生成可信 handoff。

## 分阶段实施

### Phase 0：契约原型

当前进度：

- [x] `packages/work-agent` 独立合同包；零 Foundation、Memory、Settings UI 与 DSH 运行时依赖。
- [x] immutable baseline generation/fingerprint、固定 profile manifest preflight 和结构化 compatibility/confirmation decision。
- [x] Owner Eligibility 独立 P0；Foundation/Memory 已共享 fail-closed Cordis service，depth 1 child 回归通过。
- [x] 中性临时 preset 的 DSH public-seam child creation、header/tool/request 捕获与 rollback 原型。
- [x] 固定 DSH 复制片段、许可证归属和 upstream diff 测试。
- [x] baseline/resolver/gate 输出收敛为 path-free publication snapshot；Provider 构造与 DSH commit 点共享同步重校验，固定工具面和 provider/model/reasoning request header。
- [x] 在 rc.7 临时 DSH Home 中 provision 并重启发现 Anchored-only 完整 preset，验证 protected sections、runtime context、工具面、模型可见日志和 rollback。
- [x] 通过 DSH 公共 LLM seam 和官方 DeepSeek Adapter 捕获 Flash/high、Flash/max、Pro/max wire 请求，并验证 thinking 禁用与 provider 缺失在网络前 fail loud。

1. 已完成 Owner Eligibility 独立 P0；继续保持为所有真实 Work child 的前置回归门。
2. 用中性临时 preset fixture 证明 child creation 可选择与 parent 不同的 preset，header/log 与实际工具一致。
3. 证明 baseline fingerprint、tool ceiling、sandbox/approval 和 DeepSeek request header 可捕获。
4. 固定 DSH 复制片段、许可证归属和 upstream diff 测试。

### Phase 1：Spawn-time selection

只支持 one-shot foreground。对外是 011 的已资格化 Flash 薄工具，内部固定选择 `anchored-standard`，或经实验门选择 J-Space profile。无 continuable、无同逻辑 child 切换、无 fork。

### Phase 2：Logical profile switch

实现 controller、profile revision、parent commit log、Work Handoff 和幂等恢复。切换只影响下一次 fresh one-shot activation；仍不使用 fork、resume 或 continuable。

### Phase 3：DSH upstream composition plan

推动 DSH 提供 durable `CompositionRef`、preset-aware subagent descriptor、cold resolver/presenter 和 true between-turn transaction。只有这些接口与 crash tests 完成后，才另写规范考虑 native continuable child 的同 Session composition switch；不在 MistyMoon 内复制 continuation manager。

## 明确不做

- 不修改 DSH child、Agent Loop、Session 格式或 private preset cache；
- 不在已有 turn 的 Session 上调用 `recompose()`，不把 logical profile switch 宣称为 native preset recompose；
- 不把 `fork` 用于 RP Host → Work Agent；
- 不让模型任意选择本地 preset、版本、provider 或权限；
- 不把共享基线解释成共享 transcript、Memory 或 mutable state；
- 不承诺 preset 或 thinking 能“保证”代码质量；质量结论仍来自固定任务集、重复 A/B 和真实检查。

## 已批准的产品决策

用户于 2026-08-17 批准以下四项：

1. 逻辑 Work Agent id 保持稳定，profile switch 只影响下一次 fresh one-shot child Session。
2. v1 只做 spawn-time selection；logical profile switch 延后到 one-shot 原型通过之后；同 Session native switch 不在 rc.7 上实现。
3. 默认 profile 只使用 Anchored Standard，不依赖 Routing Suite；J-Space 仅在复杂任务实验门通过后可切入。
4. 任何工具面或成本提升的 preset/route switch 必须由 Owner 确认。

用户于 2026-08-18 进一步批准：RP Host preset 使用完整已发布 Persona system projection 和只读 Web；通用 preset 保留既有 final-reply delivery；Work child 始终中性且隔离。`switchProfile()` 只提交下一 activation 的 revision，`resolveNextActivation()` 在每次 fresh child publication 前取得并冻结该选择。
