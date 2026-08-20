# 004：Owner、Authority 与 Scoped Memory Records

状态：2026-08-20 已按 P0 Memory Program 完成实现并通过机械验收。本段建立可信 Owner/authority/scope、Memory Observation、kind、有效时间和 confidential 硬过滤；未实现自动抽取、冲突检测、管理页、BM25、外部索引或生命周期策略。

## 问题

当前 `MemoryRecord` 与 `MemoryCandidate` 只有正文、visibility 和来源字符串。Archive 路径隐含单 Owner，但记录不能证明 Owner、通道 authority 或 Experience scope；Character Scene 事件因此没有结构化边界可阻止进入 Companion Reality。`confidential` 仍参与词法 recall，只在投影文字中要求模型谨慎，属于提示词约束而不是数据硬过滤。

段 A 还保留 schema v1 domain events。直接给这些事件猜测 Owner、scope、kind 或事实有效时间会制造未经 Owner 确认的权威数据；它们必须 fail closed，直到通过显式、可备份的 scope migration plan/apply 赋值。

## 领域模型

### Trusted Memory Access

所有普通写入、列表和召回都必须接收由宿主代码构造的 `MemoryAccessContextV1`：

```ts
interface MemoryAccessContextV1 {
  version: 1
  ownerId: string
  authority: string
  scope: MemoryScopeV1
  channelDisclosure: 'personal-only' | 'owner-confidential'
  requestIntent: 'ordinary' | 'explicit-confidential-recall'
}
```

- `ownerId` 与 `authority` 来自 Owner Eligibility 或等价已认证 Adapter，不来自模型文本、工具参数、Provider 返回或 Persona。
- 当前默认 Web 只接受 `local-dsh-host-rpc`；其他通道没有 Adapter 时 fail closed。
- `channelDisclosure` 是部署/通道策略；`requestIntent` 是当前可信 Owner turn 的明确意图。二者必须同时允许，`confidential` 才能进入 Recall Snapshot。
- 治理 UI 使用其已验证的 loopback Owner authority；它可以跨 scope 查看候选元数据，但批准结果继承候选的 Owner/scope，不能由客户端改写。

### Memory Scope

```ts
type MemoryScopeV1 =
  | { version: 1; kind: 'companion-reality' }
  | { version: 1; kind: 'character-scene'; sceneId: string }
  | { version: 1; kind: 'campaign-branch'; campaignId: string; branchId: string }
```

Scope 使用稳定、不含路径的 opaque IDs。完全相等才可召回：Scene A 不进入 Scene B；Campaign A/Branch 1 不进入 Branch 2；虚构 scope 永不自动复制到 Companion Reality。Canon State 仍是虚构当前状态的权威来源，Memory 只保存同 scope episode/record。

### Memory Observation

每个候选与正式记忆引用一条不可变 `MemoryObservationV1`，Observation 本身不参与召回：

```ts
interface MemoryObservationV1 {
  schemaVersion: 1
  id: string
  ownerId: string
  authority: string
  scope: MemoryScopeV1
  source: {
    kind: 'dsh-message' | 'governance-operation' | 'committed-fiction-event' | 'legacy-import'
    id: string
  }
  observedAt: string
}
```

Observation 与由它产生的 candidate/record 在同一 storage transaction 中提交。幂等来源键包含 Owner、scope、source kind 与 source id；相同裸 `sourceMessageId` 在不同 Owner/scope 中不是同一来源。

### Scoped records

新 candidate 与 confirmed record 使用 domain schema v2，并要求：

- `ownerId`、`scope`、`observationId`；
- `memoryKind`: `preference | biographical | boundary | commitment | relationship | episode | state | summary`；
- `recordedAt`：系统从 Observation 得知的时间；
- `createdAt`：当前 record/candidate 版本产生时间；
- 可选 `validFrom/validTo`：事实成立区间，未知即省略，不猜测；若两者同时存在，`validTo` 不早于 `validFrom`；
- 既有 `visibility`、status 与 append-only revision 关系。

`summary` 在本段只作为可验证枚举，不生成 derived summary；自动 relationship/emotion candidate 仍留到后续段且必须人工审核。

## API 与模块边界

- 新建 `MemoryDomain` 深模块，拥有 context/scope/observation/record 校验、来源键、时间不变量和 visibility 判定。
- `MemoryArchiveStorage` 只验证/折叠 versioned domain events，不解释 Owner 意图。
- `CompanionMemoryArchive` 是 Consumer：调用者提供可信 context，Archive 创建 Observation 并把 Observation + candidate/record 作为一个 transaction 提交。
- DSH pre-step 对每条 user message调用 Owner Eligibility，构造 Companion Reality context；Work child、未认证消息和没有 scope 的调用不观察、不召回。
- 工具 schema 不包含 ownerId、authority、scope 或 confidential allow 开关；工具执行代码只从 `ToolExecution.agent` 的当前 Owner turn 取得 context。
- Settings UI 仍只调用 Memory service，不直接读 storage；客户端字段不能选择 Owner 或扩大 scope。

## Confidential 硬过滤

过滤发生在排序与模型投影之前：

1. confirmed 且 active；
2. Owner 精确匹配；
3. scope 精确匹配；
4. 时间当前有效；
5. personal 可继续；confidential 只有 `channelDisclosure=owner-confidential` 且 `requestIntent=explicit-confidential-recall` 才可继续。

任一字段缺失、未知或不匹配都排除。不得先检索 confidential 再依靠 prompt 隐藏；selection/log/receipt 不得泄漏被排除正文。

## 旧 domain event 迁移

- schema v1 domain events 保留字节和审计，但普通打开进入 `scope-migration-required`，不召回、不 mutation。
- 本机 maintenance 增加两步 scope plan/apply，绑定 exact digest、过期 token 和 exact backup。
- Owner 必须显式提供 `ownerId`、`authority`、目标 scope、默认 `memoryKind` 与 recordedAt policy；CLI 不从正文猜测。
- apply 把每个 legacy source 变为 Observation，并把对应 event 转为 schema v2；candidate resolution、supersession、forget 和来源幂等关系保持等价。
- 已有 v1 archive 可在一次 plan 中同时完成 storage v2 + scoped domain v2；已是 storage v2/domain v1 的 archive 使用 scope-only plan。
- 真实档案 apply 仍未授权；测试只使用中性临时 fixture。

## 配置与失败行为

- 默认 Owner/scope 不能硬编码到 domain parser。Bundle 只组合当前 Companion Reality Adapter 与 validated authority/disclosure defaults。
- 非法 context、scope、kind、时间、Owner mismatch、scope mismatch 和 confidential policy 缺失都以稳定代码 fail closed。
- Archive migration/quarantine/scope-migration-required 时 Memory 不投影，但不阻断 DSH Coding turn。
- 所有 inspection、CLI、错误和测试报告不含 memory 正文。

## 允许修改

- `packages/memory/src/**`、`packages/memory/tests/**`、Memory README/package
- B 所需的 `scripts/memory-maintenance.ts`、Bundle defaults/built smoke
- Settings UI 仅为消费新的稳定 Memory governance interface 所需的适配与测试；不得复制业务规则
- `CONTEXT.md`、README、architecture 与本目录规范

## 非目标与禁止

- 不实现自动候选抽取、相似/冲突发现、候选编辑/合并/批量、专用管理页、BM25、vector/graph/PageIndex、summary 生成、衰减/冷热层或永久删除。
- 不修改 DSH、Foundation、Persona、Work Agent 或真实私有数据。
- 不把 Character Scene/Campaign Canon 当作概率 Memory 的替代品。
- 不自动迁移、不自动选择 scope/kind、不允许 `--force`。

## 实施顺序

1. Pure `MemoryDomain` vocabulary/validation/source key/confidential predicate。
2. Storage domain v2 parser/fold 与 legacy `scope-migration-required` inspection。
3. Scoped Archive API、DSH pre-step/tool context Adapter、Settings governance Adapter。
4. Scope migration plan/apply、CLI、built smoke 与文档。

每层先有红灯并保持 A 的可靠性测试全绿；未经授权不 commit、push、部署或操作真实档案。
