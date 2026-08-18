# 012：RP 长期记忆目标架构

状态：2026-08-18 Owner 已接受为下一会话的 Memory 目标架构，并授权在仓库代码与中性 fixture 上实施。仍不授权迁移真实档案、启用远端 Provider、永久物理删除、部署或发布。

基线：MistyMoon `dd4506e`；外部项目评估固定于 2026-08-17。

## 与既有 Memory Program 的关系

本规范不替代 `002-p0-memory-program`。它描述各叶子段共同收敛的目标架构；实施按 `003` 存储可靠性 → scoped record/observation → 候选抽取 → 冲突治理 → 审核 UI → 召回 seam → 外部索引 → 生命周期的停止门推进。`004`–`010` 用于中间阶段；`011`–`016` 已被其他规范占用，因此 Lifecycle 使用 `017`。

## 问题陈述

RP 连续性需要记住身份偏好、关系边界、共同经历、未完成承诺和时间变化。单纯向量 top-k 会混淆候选与事实、旧值与现值、现实关系与虚构剧情；把档案交给外部 memory 框架又会丢失 Owner、来源消息、审核与 DSH 模型可见日志。

MistyMoon 因此需要一个深的治理 Module：调用者只提交有来源的观察、审核决定或受限召回请求，Module 隐藏版本、替代、时间、派生索引、重排、预算与失败降级。删除该 Module 会让同一套隐私和历史规则重新散落到工具、设置页、抽取器与每个 Provider 中。

## 决策摘要

1. MistyMoon 的版本化追加档案是唯一事实来源；向量、图、全文索引和摘要都是 `Derived Memory View`。
2. 自动抽取、导入和冲突发现只能创建 `Memory Candidate`；未确认内容在任何 Provider 中都不可召回。
3. 检索先硬过滤 Owner、状态、可见性和虚构范围，再并联生成候选；任何命中都回查权威档案。
4. 纠正追加新版本并替代旧版本；衰减只改变检索权重或冷热层，不改变真值和审计历史。
5. 每次实际模型可见内容形成 `Recall Snapshot` 并写入 DSH 会话；外部 Provider 的私有副本不能成为不可重建上下文。
6. Companion Reality、Character Scene fiction 与 Tabletop Campaign canon 使用互不混召回的范围。

## 目标

- 对“过去成立、现在失效、系统何时得知”给出确定语义。
- 让关系、事件、边界和短期状态采用不同审核与召回规则。
- 在 Provider 超时、损坏或删除失败时保持 Owner turn 可完成，并保证敏感内容不投影。
- 允许 Graphiti、Mem0、Cognee 等实现可替换 Adapter，而不把其 schema 泄漏给调用者。
- 建立中性中文 RP 评测，衡量关键边界召回、连续性、错误泄漏和解释完整率。

## 非目标

- 不把 Persona 的身份、价值观或表达规则复制进 Memory。
- 不让模型自行确认关系阶段、心理标签或敏感推断。
- 不把会话全文、Work Agent transcript 或代码任务结果自动写成长时陪伴记忆。
- 不把 Character Scene/Campaign 的当前角色表和世界状态降格成概率召回记忆。
- 不在本规范中选择默认 embedding、图数据库或远端服务。

## 范围隔离

| 范围 | 可保存内容 | 权威当前状态 | 禁止跨入 |
| --- | --- | --- | --- |
| Companion Reality | Owner 偏好、边界、现实关系事实、共同经历和承诺 | Confirmed Memory 的活动投影 | 未确认虚构事件、Work Agent transcript |
| Character Scene | 角色场景事件、场景内关系和分支经历 | 该 Story/Scene 的 Canon State | Companion Reality、其他角色故事 |
| Tabletop Campaign | 战役事件、角色经历和已发生裁定 | Campaign Branch 的 Canon State | 其他战役/分支、现实关系 |

所有写入与召回请求都必须携带由宿主建立的 Owner scope 和 fiction scope。模型文本、工具参数或 Provider 返回值不能声明或扩大 scope。

## 权威记录模型

| 记录 | 语义 | 参与召回 |
| --- | --- | --- |
| Memory Observation | 对一条 DSH 消息或已提交事件的不可变来源锚点 | 否 |
| Memory Candidate | 抽取、导入或冲突发现形成的待审草稿 | 否 |
| Confirmed Memory | Owner 或已配置的明确记忆策略确认的跨会话记录 | 仅活动版本 |
| Memory Episode | 带参与者和发生时间的共同经历 | 按范围与相关性 |
| Revision/Tombstone | 替代、遗忘或失效的追加记录 | 否，但保留审计 |
| Derived Summary | 从活动 Confirmed Memory 生成且带完整 lineage 的摘要 | 只能在来源仍活动时 |

建议 `memoryKind` 至少区分：`preference`、`biographical`、`boundary`、`commitment`、`relationship`、`episode`、`state` 与 `summary`。

### 时间与修订

每条权威记录区分：

- `validFrom/validTo`：事实在现实或叙事中何时成立；
- `recordedAt`：系统何时从来源得知；
- `createdAt`：当前记录版本何时产生。

无法确认的时间保持未知，模型不得补猜。纠正必须以一个原子事务追加新 confirmed 版本、`supersedes` 关系和旧版本失效；逻辑遗忘追加 tombstone。永久删除是单独的高风险流程，必须覆盖备份、派生索引、远端副本和诊断缓存并由用户确认。

### RP 敏感语义

- 身份：只保存 Owner 明确陈述的称呼、背景和身份偏好；companion 身份仍归 Foundation。
- 关系：共同约定和有来源的关系事件可进入候选；不得从语气自动推断关系阶段。
- 事件：以参与者、发生时间和来源表达；图关系只能帮助找回记录。
- 情绪：明确自述可成为短期 state；自动情绪识别只能提议候选，默认短有效期且不能固化为人格标签。

## 写入与审核流

~~~text
DSH owner message / committed fictional event
  -> trusted identity + scope
  -> Memory Observation
  -> explicit remember under approved policy?
       yes -> confirmed transaction
       no  -> Memory Candidate
  -> extraction/import/conflict discovery
       always -> Memory Candidate
  -> Owner review
       approve -> confirmed/supersession transaction
       reject  -> resolution only
~~~

抽取器输入仅包含当前获准的 source message IDs。模型超时、schema 无效或 Provider 不可用时，不生成半确认记录，也不使原会话失败。Work Agent 输出只有在 Owner 明确要求记住且通过对应 scope 治理时才可进入候选队列。

## 召回 Interface 与流水线

对调用者只暴露一个受治理 Recall Interface：输入可信 scope、查询意图和预算，输出 `Recall Snapshot` 或可降级错误。其后隐藏以下行为：

1. 硬过滤 Owner、可见性、fiction scope 和活动状态；
2. 使用词法/BM25、向量、实体和图关系并联生成 memory IDs；
3. 回查追加档案，拒绝未知、已替代、已遗忘或越权 ID；
4. 按相关度、时间有效性、显式重要性、关系连续性和多样性重排；
5. 在 token 预算内去重，同一替代链只保留当前版本；
6. 生成带 source IDs、版本和命中理由的最小必要投影；
7. 以 DSH 原生模型可见消息持久化精确快照。

`boundary` 只在相关意图下获得优先级；通道不允许披露时必须硬过滤，不能只靠 sensitivity penalty。记忆中的命令式文本始终作为引用数据，不获得提示词权限。

## Provider seam

只定义两个窄 seam：

- `CandidateExtractionProvider`：接收可信 scope 与选定来源，返回不可信候选草稿；不能写档案。
- `RecallIndexProvider`：只索引 confirmed projection，并返回 memory ID、分数和理由；不能返回绕过档案的权威正文。

两者必须声明 schema、能力、超时、取消和重建语义。Adapter 故障只能降低召回质量。默认基线为本地词法/BM25；外部 Adapter 全部默认关闭。

## RP 生态复用约束

- 采用 Character / Owner Persona / Relationship / fiction scope 分离的信息架构；任何导入对象先成为私有 draft。
- Worldbook 是带触发条件、优先级、位置、深度和硬 token budget 的 projection policy，不是 Confirmed Memory；实际选择 receipt 和模型可见文本必须写入 DSH Session。
- Summary、向量和图索引是 `Derived Memory View`，支持编辑、暂停、回滚和删除重建；每个 claim 保留 source memory/message citation，召回正文回查权威档案。
- Provider 通过 capability/receipt interface 接入，不得直接返回绕过 Owner scope、revision 与 approval 的权威正文。

## 外部项目取舍

- Graphiti `v0.29.1`：优先用于只读 shadow graph；其 episode lineage、有效时间和多路检索值得验证，但 `group_id` 不替代 Owner ACL。
- Mem0 `v1.0.2`：只考虑候选抽取、向量或重排 Adapter；其 direct-ID 读取和 canonical update/delete 不能暴露或反写治理档案。
- LangMem：参考 profile/collection、热路径与后台归纳的分离，不直接拥有治理。
- Cognee：作为未来重型 opt-in 服务，先验证 ACL、Windows 运维与删除传播。
- Letta Code、Memary、A-MEM：仅参考局部机制，不作为治理 Provider。

上述项目为 Apache-2.0 或 MIT；采用代码、prompt、schema 或二进制前仍需固定版本与 NOTICE/分发审查。

## 归纳、衰减与遗忘

- Summary 记录所有 `sourceMemoryIds`、生成版本和时间；任一来源失效时 summary 失效或重建。
- 重复来源只增加可解释的 reinforcement，不把模型复述当作事实强度。
- 衰减降低非关键 episode 的默认排名或移入冷层；boundary、未完成 commitment 和当前 state 不按提及次数自动消失。
- Provider 删除失败时将派生副本标记 stale；权威回查仍保证内容不被投影。

## 失败与隐私

- 未建立可信 Owner/channel identity 时禁用跨会话长期召回。
- 远端 embedding、LLM 抽取和图服务默认关闭；启用前说明数据驻留、日志、加密和删除语义。
- Python sidecar 只停止自身启动并持有句柄的进程，具备 health check、timeout、cancel 和 disposer。
- Quarantine、迁移和锁语义由 `003-memory-storage-reliability` 先行解决；本规范不绕过该前置门。

## 分阶段路线

1. 完成 `003`：版本化事务档案、跨进程写入和恢复。
2. 按 Program 段 B 建立 trusted Owner/channel/fiction scope、Memory Observation 与 domain record。
3. 按段 C–F 完成候选、冲突、治理和管理页。
4. 按段 G 建立词法/BM25 baseline、权威回查、解释和中性中文 RP 评测。
5. 按段 H 依次试验 Graphiti shadow、Mem0 shadow；达到隔离、删除、重建、延迟和质量门槛后才允许 opt-in。
6. 按段 I 引入带 lineage 的归纳、冷层和衰减。

## 已确认的默认决策

1. Character Scene episode 永不自动复制到 Companion Reality；未来只有 Owner 显式提出后，才能以带双重来源的候选进入审核。
2. Relationship 与 emotion 候选全部强制人工审核，不能由抽取器自动确认。
3. 外部 Provider 第一轮只做默认关闭的 shadow/opt-in Adapter；不得发送真实私有内容或成为事实来源。
4. 永久物理删除属于 P0 之外的独立高风险数据生命周期 Spec，仍须 Owner 单独确认。
