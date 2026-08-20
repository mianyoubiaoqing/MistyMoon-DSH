# 017：Governed Memory Lifecycle

状态：2026-08-20 已按 `002-p0-memory-program` 完成。本段只交付 I；未永久物理删除、迁移真实档案或启用远端 Provider。

## 结果

Memory Archive 提供版本化 Lifecycle Plan seam，提出整合、衰减、归档和恢复变更。Plan 本身无副作用；只有同一可信 Owner/scope 明确确认后才追加事务。所有变化保留历史并可从 Archive replay。

## 领域边界

- Consolidated Memory Summary 是 Owner 批准的派生 Confirmed Memory，必须保存扁平、完整、唯一的叶子 `sourceMemoryIds`。
- 任一 source 被 forgotten/superseded、越出有效时间或无法回查时，summary 不得进入 Recall Snapshot；summary 自身不能替代来源成为权威。
- `hot`、`cold`、`archived` 是 Recall Tier，不是事实状态。archive 不删除、不改写内容，restore 可恢复召回。
- decay 只调整 rank multiplier 和 hot/cold tier，不改变 content、validity、visibility、status 或冲突语义。
- `boundary`、`commitment`、`state` 永远不进入自动 decay proposal；未完成承诺和 current state 不会随时间静默消失。

## Plan 与应用

- `planLifecycle()` 只读取同一 Owner/authority/scope 内可治理记录，返回不可变 plan ID、动作、目标和预期生命周期状态。
- consolidate 至少需要两个同域 active source；visibility 采用最严格来源，summary 正文有界且不能从不同 scope 拼接。
- decay 由显式可信时间和 cold-after-days 产生确定性 proposal；同一输入得到同一目标和 multiplier。
- archive/restore 只接受显式 ID。Apply 必须携带 `ownerConfirmed: true` 和新的 governance source message ID。
- Apply 在持锁后重新校验 plan target；来源或 tier 已变化时 fail closed，不猜测修复。

## Derived View 失效

Archive 事务提交后向已注册 Derived View Provider 发送纯 ID invalidation。Provider throw/timeout 只在结果 receipt 中标记 `stale`，不能回滚已提交的 Archive 事实，也不能使 archived/invalid lineage 再次进入模型投影。新 Provider 注册不改变事实或召回能力。

## 回滚

- decay 可通过后续 Owner-confirmed restore-to-hot plan 恢复权重；archive 可通过 restore plan 恢复。
- Consolidated Summary 可沿用既有 forget/supersede 治理，不物理删除 source 或 summary。
- Derived View 可丢弃重建；Archive 始终是权威回查边界。
